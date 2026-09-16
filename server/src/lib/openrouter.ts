/**
 * OpenRouter client — server-side only. OPENROUTER_API_KEY never leaves server.
 * Production: retries, timeouts, large-token support, continuation, structured metadata.
 */
import { config, isModelAllowed } from '../config.js';
import { logger } from './logger.js';
import { withRetry, isRetryableStatus } from './retry.js';

export type OpenRouterMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};

export interface OpenRouterChatParams {
  model?: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  // Optional for internal continuation
  signal?: AbortSignal;
}

function headers() {
  if (!config.openrouter.apiKey) {
    const err: any = new Error('OPENROUTER_API_KEY not configured');
    err.status = 503;
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return {
    Authorization: `Bearer ${config.openrouter.apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.openrouter.appUrl,
    'X-Title': config.openrouter.appName,
  } as Record<string, string>;
}

function resolveModel(requested?: string): string {
  const m = requested || config.openrouter.model;
  if (requested && !isModelAllowed(requested)) {
    const err: any = new Error(`Model not allowed: ${requested}`);
    err.status = 400;
    err.code = 'MODEL_NOT_ALLOWED';
    throw err;
  }
  return m;
}

function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error(`Timeout after ${ms}ms`)), ms);
  const signal = controller.signal as AbortSignal & { _clear?: () => void };
  (signal as any)._clear = () => clearTimeout(t);
  if (parent) {
    parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
  }
  return signal;
}

export type ChatCompletionResult = {
  id: string;
  model: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  created?: number;
};

/**
 * Non-streaming chat completion with retries + timeout + large-token support
 */
export async function createChatCompletion(
  params: OpenRouterChatParams,
  requestId?: string
): Promise<ChatCompletionResult> {
  const model = resolveModel(params.model);
  const maxTokens = params.max_tokens ?? config.limits.maxTokensDefault;
  if (maxTokens > config.limits.maxTokensMax) {
    const err: any = new Error(`max_tokens ${maxTokens} exceeds limit ${config.limits.maxTokensMax}`);
    err.status = 400;
    err.code = 'MAX_TOKENS_EXCEEDED';
    throw err;
  }

  const log = requestId ? logger.child({ requestId }) : logger;
  const start = Date.now();

  return withRetry(
    async () => {
      const signal = timeoutSignal(config.openrouter.timeoutMs, params.signal);
      try {
        log.info({ model, messages: params.messages.length, maxTokens }, 'openrouter chat start');
        const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            model,
            messages: params.messages,
            max_tokens: maxTokens,
            temperature: params.temperature,
            stream: false,
          }),
          signal,
        });
        (signal as any)._clear?.();
        if (!res.ok) {
          const text = await res.text();
          const err: any = new Error(`OpenRouter error ${res.status}: ${text.slice(0, 2000)}`);
          err.status = res.status;
          err.code = `OPENROUTER_${res.status}`;
          if (isRetryableStatus(res.status)) log.warn({ status: res.status }, 'retryable openrouter error');
          throw err;
        }
        let json: any;
        try {
          json = await res.json();
        } catch (e) {
          const err: any = new Error(`Malformed OpenRouter JSON: ${(e as Error).message}`);
          err.status = 502;
          err.code = 'MALFORMED_UPSTREAM';
          throw err;
        }
        // Guard malformed AI: ensure choices array and message content are strings
        if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
          const err: any = new Error(`Malformed OpenRouter response: missing choices`);
          err.status = 502;
          err.code = 'MALFORMED_UPSTREAM';
          logger.warn({ jsonKeys: json ? Object.keys(json) : [] }, 'malformed choices');
          throw err;
        }
        const ch = json.choices[0];
        if (ch && ch.message && typeof ch.message.content !== 'string') {
          // Coerce non-string content (some models return array) to string
          try {
            if (Array.isArray(ch.message.content)) ch.message.content = ch.message.content.map((c: any) => c.text || JSON.stringify(c)).join('');
            else ch.message.content = String(ch.message.content ?? '');
          } catch {}
        }
        if (typeof ch.message?.content !== 'string') {
          logger.warn({ contentType: typeof ch.message?.content }, 'malformed content type');
          ch.message.content = String(ch.message?.content ?? '');
        }
        log.info({ requestId, durationMs: Date.now() - start, usage: json.usage, finish: json.choices?.[0]?.finish_reason, contentLength: ch.message?.content?.length }, 'openrouter chat done');
        return json as ChatCompletionResult;
      } catch (e) {
        (signal as any)._clear?.();
        if ((e as any)?.name === 'AbortError') {
          const err: any = new Error(`OpenRouter timeout after ${config.openrouter.timeoutMs}ms`);
          err.status = 504;
          err.code = 'TIMEOUT';
          throw err;
        }
        throw e;
      }
    },
    { retryOn: (status) => isRetryableStatus(status) },
    requestId
  );
}

/**
 * Streaming chat completion — returns ReadableStream with timeout and retry? For stream, we don't retry whole stream; we just start with timeout for initial connection.
 */
export async function createChatCompletionStream(
  params: OpenRouterChatParams,
  requestId?: string
): Promise<ReadableStream<Uint8Array>> {
  const model = resolveModel(params.model);
  const maxTokens = params.max_tokens ?? config.limits.maxTokensDefault;
  if (maxTokens > config.limits.maxTokensMax) {
    const err: any = new Error(`max_tokens ${maxTokens} exceeds limit ${config.limits.maxTokensMax}`);
    err.status = 400;
    err.code = 'MAX_TOKENS_EXCEEDED';
    throw err;
  }

  const log = requestId ? logger.child({ requestId }) : logger;
  log.info({ model, messages: params.messages.length, maxTokens }, 'openrouter stream start');

  // Single attempt with timeout for connection; streaming retries are handled by client re-requesting continuation
  const signal = timeoutSignal(config.openrouter.streamTimeoutMs, params.signal);
  let res: Response;
  try {
    res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model,
        messages: params.messages,
        max_tokens: maxTokens,
        temperature: params.temperature,
        stream: true,
      }),
      signal,
    });
  } catch (e) {
    (signal as any)._clear?.();
    if ((e as any)?.name === 'AbortError') {
      const err: any = new Error(`OpenRouter stream timeout after ${config.openrouter.streamTimeoutMs}ms`);
      err.status = 504;
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  }
  // Don't clear timeout immediately for stream - keep it for initial headers, but stream itself has its own keepalive
  // Clear after we got headers
  (signal as any)._clear?.();

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => String(res.status));
    const err: any = new Error(`OpenRouter stream error ${res.status}: ${text.slice(0, 2000)}`);
    err.status = res.status;
    throw err;
  }
  log.info({ requestId, status: res.status }, 'openrouter stream connected');
  return res.body as unknown as ReadableStream<Uint8Array>;
}

export async function listModels(requestId?: string): Promise<Array<{ id: string; name: string; contextLength?: number; pricing?: unknown }>> {
  const log = requestId ? logger.child({ requestId }) : logger;
  return withRetry(
    async () => {
      const signal = timeoutSignal(10000);
      try {
        const res = await fetch(`${config.openrouter.baseUrl}/models`, {
          headers: headers(),
          signal,
        });
        (signal as any)._clear?.();
        if (!res.ok) {
          const text = await res.text();
          const err: any = new Error(`OpenRouter models error ${res.status}: ${text.slice(0, 1000)}`);
          err.status = res.status;
          throw err;
        }
        const json = (await res.json()) as { data: Array<{ id: string; name: string; context_length?: number; pricing?: unknown }> };
        log.debug({ count: json.data.length }, 'models fetched');
        return json.data.map((m) => ({
          id: m.id,
          name: m.name,
          contextLength: m.context_length,
          pricing: m.pricing,
        }));
      } catch (e) {
        (signal as any)._clear?.();
        throw e;
      }
    },
    { maxRetries: 1 },
    requestId
  );
}

export async function checkOpenRouter(): Promise<'ok' | 'not_configured' | 'unreachable'> {
  if (!config.openrouter.apiKey) return 'not_configured';
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.openrouter.baseUrl}/models`, {
      headers: headers(),
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Normalize ChatMessage[] (with optional imageBase64) to OpenRouter multimodal format
 * Supports vision: imageBase64 or imageUrl
 */
export function toOpenRouterMessages(
  messages: Array<{ role: string; content: string; imageBase64?: string; imageUrl?: string }>
): OpenRouterMessage[] {
  return messages.map((m) => {
    const hasImage = !!(m.imageBase64 || m.imageUrl);
    if (hasImage) {
      const imageUrl = m.imageBase64
        ? m.imageBase64.startsWith('data:')
          ? m.imageBase64
          : `data:image/jpeg;base64,${m.imageBase64}`
        : m.imageUrl!;
      return {
        role: m.role as OpenRouterMessage['role'],
        content: [
          { type: 'text' as const, text: m.content },
          { type: 'image_url' as const, image_url: { url: imageUrl } },
        ],
      };
    }
    return {
      role: m.role as OpenRouterMessage['role'],
      content: m.content,
    };
  });
}

/**
 * Build a continuation prompt for large responses that were truncated (finish_reason === 'length')
 * The model is instructed to continue exactly where it left off.
 */
export function buildContinuationMessages(
  originalMessages: OpenRouterMessage[],
  previousContent: string
): OpenRouterMessage[] {
  // Append assistant's truncated content and ask to continue
  return [
    ...originalMessages,
    { role: 'assistant' as const, content: previousContent },
    {
      role: 'user' as const,
      content:
        'Continue exactly where you left off. Do not repeat already generated content. Maintain formatting and code blocks. If you were in the middle of a code block, continue inside it. Complete the remaining answer fully.',
    },
  ];
}
