import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id =
    (req.headers['x-request-id'] as string) ||
    `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  (req as any).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
