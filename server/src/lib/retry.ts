import { logger } from './logger.js';
import { config } from '../config.js';

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (status: number, error: Error) => boolean;
};

const DEFAULT_RETRY_ON = (status: number) => status === 429 || status >= 500;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
  requestId?: string
): Promise<T> {
  const maxRetries = opts.maxRetries ?? config.openrouter.maxRetries;
  const baseDelay = opts.baseDelayMs ?? config.openrouter.retryBaseDelayMs;
  const maxDelay = opts.maxDelayMs ?? 15000;
  const retryOn = opts.retryOn ?? ((s) => DEFAULT_RETRY_ON(s));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.random() * 200, maxDelay);
        logger.warn({ requestId, attempt, delay }, `retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
      return await fn(attempt);
    } catch (e) {
      lastError = e as Error;
      const status = (e as any)?.status || (e as any)?.statusCode || 0;
      const shouldRetry = attempt < maxRetries && (retryOn(status, e as Error) || status === 0);
      logger.warn({ requestId, attempt, status, shouldRetry, error: (e as Error).message }, `openrouter attempt ${attempt} failed`);
      if (!shouldRetry) throw e;
    }
  }
  throw lastError;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 529;
}
