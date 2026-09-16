import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { createChatCompletion, createChatCompletionStream, toOpenRouterMessages, buildContinuationMessages } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';

export const visionRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.imageMaxBytes },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed (jpeg, png, webp)'));
  },
});

const historySchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(config.limits.maxPromptChars),
});

const jsonSchema = z.object({
  prompt: z.string().min(1).max(config.limits.maxPromptChars),
  imageBase64: z.string().optional(),
  imageUrl: z.string().url().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().min(1).max(config.limits.maxTokensMax).optional(),
  history: z.array(historySchema).optional(),
  stream: z.boolean().optional(),
  // Production: auto-continue for large codegen
  autoContinue: z.boolean().optional(),
  maxContinuations: z.number().int().min(0).max(5).optional(),
  // Task hints for model
  task: z.enum(['vision', 'extract', 'code', 'general']).optional(),
  // Context extraction hint
  extractMode: z.enum(['question', 'context', 'both']).optional(),
});

function toDataUrl(mime: string, base64: string) {
  if (base64.startsWith('data:')) return base64;
  return `data:${mime};base64,${base64}`;
}

function ensureConfigured(res: any) {
  if (!config.openrouter.apiKey) {
    res.status(503).json({ error: 'OpenRouter not configured', code: 'NOT_CONFIGURED' });
    return false;
  }
  return true;
}

function buildSystemPrompt(task?: string, extractMode?: string): string | null {
  if (task === 'code') {
    return 'You are an expert coding assistant. Provide complete, runnable code. Support large generations (1000+ lines). Use proper formatting with markdown code blocks. If you are truncated, you will be asked to continue exactly where you left off.';
  }
  if (task === 'extract' || extractMode) {
    return 'You are a precise context extraction assistant. Extract the relevant question, context, and key details from the image. Return structured output: summary, question, context, and actionable next steps. Be concise but complete.';
  }
  return null;
}

/**
 * POST /api/vision/analyze
 * Accepts JSON {prompt, imageBase64} OR multipart {prompt, image: file}
 * Query ?stream=true or body stream:true triggers SSE.
 * Production: handles vision analysis, question/context extraction, coding tasks, large codegen, auto-continuation, metadata, timeouts.
 */
visionRouter.post('/analyze', upload.single('image'), async (req, res, next) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId, endpoint: 'vision/analyze' });
  const startMs = Date.now();
  try {
    if (!ensureConfigured(res)) return;

    let prompt: string | undefined;
    let imageBase64: string | undefined;
    let imageUrl: string | undefined;
    let model: string | undefined;
    let maxTokens: number | undefined;
    let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined;
    let streamRequested = false;
    let autoContinue = false;
    let maxContinuations: number | undefined;
    let task: string | undefined;
    let extractMode: string | undefined;

    const isMultipart = req.is('multipart/form-data');

    if (isMultipart) {
      prompt = (req.body.prompt as string) || '';
      model = req.body.model as string | undefined;
      maxTokens = req.body.maxTokens ? parseInt(req.body.maxTokens, 10) : undefined;
      if (req.body.history) { try { history = JSON.parse(req.body.history); } catch {} }
      streamRequested = req.body.stream === 'true' || req.query.stream === 'true';
      autoContinue = req.body.autoContinue === 'true';
      maxContinuations = req.body.maxContinuations ? parseInt(req.body.maxContinuations, 10) : undefined;
      task = req.body.task as string | undefined;
      extractMode = req.body.extractMode as string | undefined;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file?.buffer) {
        imageBase64 = toDataUrl(file.mimetype, file.buffer.toString('base64'));
        log.info({ imageBytes: file.size, mime: file.mimetype }, 'multipart image received');
      } else if (req.body.imageBase64) {
        imageBase64 = req.body.imageBase64 as string;
      } else if (req.body.imageUrl) {
        imageUrl = req.body.imageUrl as string;
      }
    } else {
      const parsed = jsonSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
      }
      ({ prompt, imageBase64, imageUrl, model, maxTokens, history, stream: streamRequested, autoContinue, maxContinuations, task, extractMode } = parsed.data as any);
      streamRequested = !!streamRequested || req.query.stream === 'true';
      autoContinue = !!autoContinue;
    }

    if (!prompt) return res.status(400).json({ error: 'prompt is required', code: 'VALIDATION_ERROR' });
    if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'image (imageBase64/imageUrl or file) is required', code: 'VALIDATION_ERROR' });
    if (imageBase64 && imageBase64.length > config.limits.imageMaxBytes * 1.4) {
      return res.status(413).json({ error: `Image too large (${Math.round(imageBase64.length / 1024)} KB). Max ${Math.round(config.limits.imageMaxBytes / 1024)} KB. Lower scale/quality.`, code: 'IMAGE_TOO_LARGE' });
    }

    const imageDataUrl = imageBase64
      ? imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
      : imageUrl!;

    // Validate base64 sanity for data URL
    if (imageDataUrl.length < 100) {
      return res.status(400).json({ error: 'Invalid image data', code: 'INVALID_IMAGE' });
    }

    // Build messages with optional system prompt for task specialization
    const systemPrompt = buildSystemPrompt(task, extractMode);
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; imageBase64?: string }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (history) for (const h of history) messages.push({ role: h.role, content: h.content });
    messages.push({ role: 'user', content: prompt, imageBase64: imageDataUrl });

    const orMessages = toOpenRouterMessages(messages as any);
    const resolvedMaxTokens = maxTokens ?? config.limits.maxTokensDefault;

    log.info({ promptChars: prompt.length, hasImage: !!imageDataUrl, task, extractMode, model: model || config.openrouter.model, maxTokens: resolvedMaxTokens, stream: streamRequested, autoContinue }, 'vision request');

    const abortController = new AbortController();
    req.on('close', () => { if (!res.writableEnded) abortController.abort(); });

    if (streamRequested) {
      // SSE vision streaming with continuation hint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      send('meta', { model: model || config.openrouter.model, id: `vision_${Date.now()}`, requestId, task, extractMode });

      let fullContent = '';
      let finishReason: string | undefined;
      let usage: any;

      try {
        const stream = await createChatCompletionStream({ model, messages: orMessages, max_tokens: resolvedMaxTokens, signal: abortController.signal }, requestId);
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (t === 'data: [DONE]') {
              const truncated = finishReason === 'length';
              send('done', {
                finishReason: finishReason || 'stop',
                usage,
                requestId,
                durationMs: Date.now() - startMs,
                truncated,
                continuationAvailable: truncated,
                metadata: { requestId, truncated, totalLength: fullContent.length, task },
              });
              if (truncated) {
                send('continuation', { available: true, message: 'Truncated. Call POST /api/vision/continue or retry with autoContinue:true', previousLength: fullContent.length });
              }
              continue;
            }
            if (t.startsWith('data: ')) {
              try {
                const payload = JSON.parse(t.slice(6));
                const delta = payload.choices?.[0]?.delta?.content;
                const finish = payload.choices?.[0]?.finish_reason;
                const u = payload.usage;
                if (u) usage = u;
                if (delta) { fullContent += delta; send('delta', { delta }); }
                if (finish) finishReason = finish;
              } catch {}
            }
          }
        }
        if (!res.writableEnded) {
          const truncated = finishReason === 'length';
          send('done', { finishReason: finishReason || 'stop', usage, requestId, durationMs: Date.now() - startMs, truncated, continuationAvailable: truncated });
        }
        log.info({ finishReason, durationMs: Date.now() - startMs, totalLength: fullContent.length }, 'vision stream done');
        res.end();
      } catch (err) {
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message, code: (err as any).code, requestId })}\n\n`);
          res.end();
        }
        log.error({ error: (err as Error).message }, 'vision stream error');
      }
      return;
    }

    // Non-stream with optional auto-continuation for large codegen (1000+ lines)
    let fullContent = '';
    let lastResult: any = null;
    let continuationCount = 0;
    const maxCont = autoContinue ? (maxContinuations ?? 3) : 0;
    let currentMessages = orMessages;
    let truncated = false;

    do {
      const result = await createChatCompletion(
        { model, messages: currentMessages, max_tokens: resolvedMaxTokens, signal: abortController.signal },
        requestId
      );
      const choice = result.choices[0];
      const delta = choice?.message?.content ?? '';
      fullContent += delta;
      lastResult = result;
      const finish = choice?.finish_reason;
      truncated = finish === 'length';
      log.info({ finish, deltaLength: delta.length, totalLength: fullContent.length, continuationCount }, 'vision chunk');
      if (truncated && continuationCount < maxCont) {
        continuationCount++;
        currentMessages = buildContinuationMessages(currentMessages, fullContent);
        continue;
      }
      break;
    } while (true);

    const durationMs = Date.now() - startMs;
    const lastChoice = lastResult.choices[0];
    res.json({
      id: lastResult.id,
      model: lastResult.model,
      answer: fullContent,
      usage: lastResult.usage
        ? { promptTokens: lastResult.usage.prompt_tokens, completionTokens: lastResult.usage.completion_tokens, totalTokens: lastResult.usage.total_tokens }
        : undefined,
      finishReason: lastChoice?.finish_reason,
      metadata: {
        requestId,
        durationMs,
        model: lastResult.model,
        finishReason: lastChoice?.finish_reason,
        truncated,
        continuationAvailable: truncated,
        continuationCount,
        autoContinued: continuationCount > 0,
        task,
        extractMode,
        maxTokens: resolvedMaxTokens,
      },
      continuation: truncated
        ? {
            available: true,
            message: 'Response truncated. Call POST /api/vision/continue with { previousContent, prompt, imageBase64 } or use autoContinue:true',
            previousLength: fullContent.length,
          }
        : undefined,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/vision/continue — continue truncated vision answer
visionRouter.post('/continue', upload.none(), async (req, res, next) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId, endpoint: 'vision/continue' });
  try {
    if (!ensureConfigured(res)) return;
    const schema = z.object({
      previousContent: z.string().min(1).max(1000000),
      prompt: z.string().min(1).max(config.limits.maxPromptChars),
      imageBase64: z.string().optional(),
      imageUrl: z.string().url().optional(),
      history: z.array(historySchema).optional(),
      model: z.string().optional(),
      maxTokens: z.number().int().min(1).max(config.limits.maxTokensMax).optional(),
      task: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    const { previousContent, prompt, imageBase64, imageUrl, history, model, maxTokens, task } = parsed.data;
    const systemPrompt = buildSystemPrompt(task, undefined);
    const messages: any[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (history) for (const h of history) messages.push({ role: h.role, content: h.content });
    // Reconstruct original vision message
    const imageDataUrl = imageBase64
      ? imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
      : imageUrl;
    if (imageDataUrl) messages.push({ role: 'user', content: prompt, imageBase64: imageDataUrl });
    else messages.push({ role: 'user', content: prompt });

    const baseOrMessages = toOpenRouterMessages(messages);
    const continued = buildContinuationMessages(baseOrMessages, previousContent);
    log.info({ prevLength: previousContent.length }, 'vision continuation');
    const result = await createChatCompletion({ model, messages: continued, max_tokens: maxTokens }, requestId);
    const choice = result.choices[0];
    res.json({
      id: result.id,
      model: result.model,
      answer: choice?.message?.content ?? '',
      usage: result.usage,
      finishReason: choice?.finish_reason,
      metadata: { requestId, truncated: choice?.finish_reason === 'length', continuation: true },
    });
  } catch (e) { next(e); }
});

// POST /api/vision/extract — dedicated question/context extraction (structured)
visionRouter.post('/extract', upload.single('image'), async (req, res, next) => {
  const requestId = (req as any).requestId;
  try {
    if (!ensureConfigured(res)) return;
    // Reuse analyze but force extract mode
    req.body.task = 'extract';
    req.body.extractMode = req.body.extractMode || 'both';
    // Delegate to analyze handler by re-dispatching? Instead we implement extraction prompt
    const prompt = req.body.prompt || 'Extract the question, context, and key details from this screen. Return JSON with fields: summary, question, context, codeBlocks, actionableSteps.';
    let imageBase64: string | undefined;
    let imageUrl: string | undefined;
    const isMultipart = req.is('multipart/form-data');
    if (isMultipart) {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file?.buffer) imageBase64 = toDataUrl(file.mimetype, file.buffer.toString('base64'));
      else if (req.body.imageBase64) imageBase64 = req.body.imageBase64;
      else if (req.body.imageUrl) imageUrl = req.body.imageUrl;
    } else {
      imageBase64 = req.body.imageBase64;
      imageUrl = req.body.imageUrl;
    }
    if (!imageBase64 && !imageUrl) return res.status(400).json({ error: 'image required', code: 'VALIDATION_ERROR' });
    const imageDataUrl = imageBase64
      ? imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
      : imageUrl!;
    const systemPrompt = buildSystemPrompt('extract', 'both')!;
    const messages = toOpenRouterMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt, imageBase64: imageDataUrl },
    ]);
    const result = await createChatCompletion({ model: req.body.model, messages, max_tokens: 4096 }, requestId);
    res.json({
      id: result.id,
      model: result.model,
      extraction: result.choices[0]?.message?.content ?? '',
      usage: result.usage,
      metadata: { requestId, task: 'extract' },
    });
  } catch (e) { next(e); }
});
