import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId || 'unknown';
  const status = (err as any)?.status || (err as any)?.statusCode || 500;
  const code = (err as any)?.code || 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : 'Internal server error';

  // Log structured error
  logger.error({ requestId, status, code, error: message, stack: (err as Error)?.stack, path: req.path, method: req.method }, 'request error');

  if (res.headersSent) return;
  // Never leak OPENROUTER_API_KEY
  const safeMessage = message.includes('sk-or-') ? 'Upstream error' : message;
  res.status(status).json({
    error: safeMessage,
    code,
    requestId,
  });
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// For payload too large
export function handlePayloadTooLarge(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Payload too large. Image must be under 10MB, JSON under 15MB. Try lower JPEG quality/scale.', code: 'PAYLOAD_TOO_LARGE' });
  }
  next(err);
}
