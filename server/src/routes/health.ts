import { Router } from 'express';
import { config } from '../config.js';
import { checkOpenRouter } from '../lib/openrouter.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const openrouter = await checkOpenRouter();
  const status = openrouter === 'unreachable' ? 'degraded' : 'ok';
  const body = {
    status,
    version: config.version,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      server: 'ok' as const,
      openrouter,
    },
    limits: {
      jsonLimit: config.limits.jsonLimit,
      imageMaxBytes: config.limits.imageMaxBytes,
      maxTokensMax: config.limits.maxTokensMax,
    },
    models: {
      default: config.openrouter.model,
      allowed: config.openrouter.allowedModels.length ? config.openrouter.allowedModels : 'any',
    },
  };
  // Always 200 for liveness; use `status` field for degraded
  res.json(body);
});

// Kubernetes / Render liveness probe (fast, no upstream check)
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness probe (checks openrouter if configured)
healthRouter.get('/ready', async (_req, res) => {
  const openrouter = await checkOpenRouter();
  if (openrouter === 'not_configured') {
    return res.status(200).json({ status: 'ok', openrouter: 'not_configured', message: 'Configure OPENROUTER_API_KEY' });
  }
  if (openrouter === 'unreachable') {
    return res.status(503).json({ status: 'degraded', openrouter });
  }
  res.json({ status: 'ok', openrouter });
});
