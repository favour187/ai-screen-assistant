import { Router } from 'express';
import { listModels } from '../lib/openrouter.js';
import { logger } from '../lib/logger.js';

export const modelsRouter = Router();

// Simple in-memory cache 60s
let cache: { data: any; at: number } | null = null;
const TTL = 60_000;

modelsRouter.get('/', async (req, res, next) => {
  const requestId = (req as any).requestId;
  try {
    if (cache && Date.now() - cache.at < TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.json({ models: cache.data, cached: true });
    }
    const models = await listModels(requestId);
    cache = { data: models, at: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=60');
    logger.info({ requestId, count: models.length }, 'models served');
    res.json({ models });
  } catch (e) {
    next(e);
  }
});
