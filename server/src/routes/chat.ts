import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { createChatCompletion, createChatCompletionStream, toOpenRouterMessages, buildContinuationMessages } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';

export const chatRouter = Router();

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(config.limits.maxPromptChars),
  imageBase64: z.string().optional(),
  imageUrl: z.string().url().optional(),
});

const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(config.limits.maxMessages),
  model: z.string().optional(),
  maxTokens: z.number().int().min(1).max(config.limits.maxTokensMax).optional(),
  temperature: z.number().min(0).max(2).optional(),
  includeReasoning: z.boolean().optional(),
  // Production additions:
  autoContinue: z.boolean().optional(), // if true, server auto-continues truncated (length) responses
  maxContinuations: z.number().int().min(0).max(5).optional(), // how many auto continuations allowed (for 1000+ lines)
  stream: z.boolean().optional(), // alias for /stream endpoint
});

function ensureConfigured(res: any) {
  if (!config.openrouter.apiKey) {
    res.status(503).json({ error: 'OpenRouter not configured', code: 'NOT_CONFIGURED' });
    return false;
  }
  return true;
}

// POST /api/chat  (non-streaming) — supports large codegen + auto-continuation + structured metadata
chatRouter.post('/', async (req, res, next) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId, endpoint: 'chat' });
  const startMs = Date.now();
  try {
    if (!ensureConfigured(res)) return;
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { messages, model, maxTokens, temperature, autoContinue, maxContinuations } = parsed.data;
    const orMessages = toOpenRouterMessages(messages);

    log.info({ model: model || config.openrouter.model, messages: messages.length, maxTokens, autoContinue }, 'chat request');

    // Support AbortSignal from client disconnect
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    let fullContent = '';
    let lastResult: any = null;
    let continuationCount = 0;
    const maxCont = autoContinue ? (maxContinuations ?? 3) : 0;
    let currentMessages = orMessages;

    // Initial + auto-continuations for large responses
    do {
      const result = await createChatCompletion(
        {
          model,
          messages: currentMessages,
          max_tokens: maxTokens ?? config.limits.maxTokensDefault,
          temperature,
          signal: abortController.signal,
        },
        requestId
      );
      const choice = result.choices[0];
      const delta = choice?.message?.content ?? '';
      fullContent += delta;
      lastResult = result;

      const finishReason = choice?.finish_reason;
      const isTruncated = finishReason === 'length';
      log.info({ finishReason, continuationCount, deltaLength: delta.length, totalLength: fullContent.length }, 'chunk done');

      if (isTruncated && continuationCount < maxCont) {
        continuationCount++;
        log.info({ continuationCount }, 'auto-continuing truncated response');
        currentMessages = buildContinuationMessages(currentMessages, fullContent);
        continue;
      }
      break;
    } while (true);

    const durationMs = Date.now() - startMs;
    const lastChoice = lastResult.choices[0];
    const finishReason = lastChoice?.finish_reason;
    const truncated = finishReason === 'length';

    res.json({
      id: lastResult.id,
      model: lastResult.model,
      message: { role: 'assistant', content: fullContent },
      usage: lastResult.usage
        ? {
            promptTokens: lastResult.usage.prompt_tokens,
            completionTokens: lastResult.usage.completion_tokens,
            totalTokens: lastResult.usage.total_tokens,
          }
        : undefined,
      finishReason,
      // Structured metadata for production clients
      metadata: {
        durationMs,
        requestId,
        model: lastResult.model,
        finishReason,
        truncated,
        continuationAvailable: truncated,
        continuationCount,
        autoContinued: continuationCount > 0,
        usage: lastResult.usage,
        maxTokens: maxTokens ?? config.limits.maxTokensDefault,
      },
      // For client to continue manually if truncated and autoContinue was false
      continuation: truncated
        ? {
            available: true,
            message: 'Response was truncated (1000+ lines). Call POST /api/chat/continue with { previousContent, messages } or retry with autoContinue:true',
            continuationMessages: buildContinuationMessages(orMessages, fullContent),
          }
        : undefined,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/chat/continue — continue a truncated response
chatRouter.post('/continue', async (req, res, next) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId, endpoint: 'chat/continue' });
  try {
    if (!ensureConfigured(res)) return;
    const schema = z.object({
      previousContent: z.string().min(1).max(1000000),
      messages: z.array(chatMessageSchema).min(1).max(config.limits.maxMessages),
      model: z.string().optional(),
      maxTokens: z.number().int().min(1).max(config.limits.maxTokensMax).optional(),
      temperature: z.number().min(0).max(2).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    const { previousContent, messages, model, maxTokens, temperature } = parsed.data;
    const baseMessages = toOpenRouterMessages(messages);
    const continued = buildContinuationMessages(baseMessages, previousContent);
    log.info({ previousLength: previousContent.length }, 'continuation request');
    const result = await createChatCompletion({ model, messages: continued, max_tokens: maxTokens, temperature }, requestId);
    const choice = result.choices[0];
    res.json({
      id: result.id,
      model: result.model,
      message: { role: 'assistant', content: choice?.message?.content ?? '' },
      usage: result.usage,
      finishReason: choice?.finish_reason,
      metadata: { requestId, truncated: choice?.finish_reason === 'length', continuation: true },
    });
  } catch (e) { next(e); }
});

// POST /api/chat/stream  (SSE) — large streaming with metadata and continuation hints
chatRouter.post('/stream', async (req, res, next) => {
  const requestId = (req as any).requestId;
  const log = logger.child({ requestId, endpoint: 'chat/stream' });
  const startMs = Date.now();
  try {
    if (!ensureConfigured(res)) return;
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    const { messages, model, maxTokens, temperature } = parsed.data;
    const orMessages = toOpenRouterMessages(messages);

    log.info({ model: model || config.openrouter.model, messages: messages.length, maxTokens }, 'stream request');

    // SSE headers
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

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    send('meta', { model: model || config.openrouter.model, id: `stream_${Date.now()}`, requestId, maxTokens: maxTokens ?? config.limits.maxTokensDefault });

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await createChatCompletionStream(
        {
          model,
          messages: orMessages,
          max_tokens: maxTokens,
          temperature,
          signal: abortController.signal,
        },
        requestId
      );
    } catch (err) {
      send('error', { error: (err as Error).message, code: (err as any).code || 'UPSTREAM_ERROR', requestId });
      res.end();
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let finishReason: string | undefined;
    let usage: any = undefined;

    const abortOnClose = () => {
      try { reader.cancel(); } catch {}
    };
    req.on('close', abortOnClose);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === 'data: [DONE]') {
            // OpenRouter stream done
            const truncated = finishReason === 'length';
            send('done', {
              finishReason: finishReason || 'stop',
              usage,
              requestId,
              durationMs: Date.now() - startMs,
              truncated,
              continuationAvailable: truncated,
              metadata: {
                requestId,
                durationMs: Date.now() - startMs,
                truncated,
                continuationAvailable: truncated,
                totalLength: fullContent.length,
                model: model || config.openrouter.model,
              },
            });
            if (truncated) {
              send('continuation', {
                available: true,
                message: 'Response truncated. Call POST /api/chat/continue with previousContent to continue.',
                previousLength: fullContent.length,
              });
              log.warn({ finishReason, length: fullContent.length }, 'stream truncated - continuation available');
            }
            continue;
          }
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const payload = JSON.parse(jsonStr);
              const delta = payload.choices?.[0]?.delta?.content;
              const finish = payload.choices?.[0]?.finish_reason;
              const u = payload.usage
                ? {
                    promptTokens: payload.usage.prompt_tokens,
                    completionTokens: payload.usage.completion_tokens,
                    totalTokens: payload.usage.total_tokens,
                  }
                : undefined;
              if (u) usage = u; // keep latest
              if (delta) {
                fullContent += delta;
                send('delta', { delta });
              }
              if (finish) {
                finishReason = finish;
                // Don't send done here yet — wait for [DONE] or stream end
                if (finish === 'length') {
                  log.warn({ finish, fullLength: fullContent.length }, 'detected truncation during stream');
                }
              }
            } catch {
              // ignore malformed
            }
          }
        }
      }
      // If no explicit done was sent (e.g., stream ended without [DONE])
      if (!res.writableEnded) {
        const truncated = finishReason === 'length';
        send('done', {
          finishReason: finishReason || 'stop',
          usage,
          requestId,
          durationMs: Date.now() - startMs,
          truncated,
          continuationAvailable: truncated,
        });
      }
      log.info({ finishReason, durationMs: Date.now() - startMs, totalLength: fullContent.length }, 'stream completed');
    } catch (err) {
      if (!res.writableEnded) send('error', { error: (err as Error).message, requestId });
      log.error({ error: (err as Error).message }, 'stream error');
    } finally {
      req.off('close', abortOnClose);
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) return next(e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message, requestId: (req as any).requestId })}\n\n`);
      res.end();
    } catch {}
  }
});
