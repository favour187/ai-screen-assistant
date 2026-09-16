import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import pinoHttpModule from 'pino-http';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, assertConfig } from './config.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { visionRouter } from './routes/vision.js';
import { modelsRouter } from './routes/models.js';
import { errorHandler, notFound, handlePayloadTooLarge } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { logger } from './lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// pino-http ESM interop
const pinoHttp: any = (pinoHttpModule as any).default || pinoHttpModule;

assertConfig();

const app = express();

// Security + logging
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // mobile / curl / Electron
      if (config.cors.allowedOrigins.includes('*') || config.cors.allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      logger.warn({ origin }, 'CORS blocked');
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'X-Cache'],
  })
);

// Structured pino http logging (also keep morgan for dev)
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req: any, res: any, err: any) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  })
);
if (config.nodeEnv !== 'production') {
  app.use(morgan('dev'));
}
app.use(requestId);

// Body parsers with production limits
app.use(express.json({ limit: config.limits.jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: config.limits.urlencodedLimit }));
// Handle payload too large before rate limit
app.use(handlePayloadTooLarge);

// Rate limits — tiered
const baseLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health'),
  message: { error: 'Too many requests — slow down', code: 'RATE_LIMITED' },
  handler: (req, res, _next, options) => {
    logger.warn({ requestId: (req as any).requestId, ip: req.ip, path: req.path }, 'rate limited');
    res.status(options.statusCode).json(options.message);
  },
});
const visionLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.visionMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many vision requests — try lower capture interval', code: 'RATE_LIMITED_VISION' },
});
const streamLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.streamMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many streaming requests', code: 'RATE_LIMITED_STREAM' },
});

app.use(baseLimiter);
app.use('/api/vision', visionLimiter);
app.use('/api/chat/stream', streamLimiter);
app.use('/api/vision/analyze', (req, _res, next) => {
  // Count stream vs non-stream? simple
  if (req.query.stream === 'true' || (req.body && req.body.stream === true)) {
    return streamLimiter(req, _res, next);
  }
  next();
});

// Timeout for all requests — 180s for large codegen streaming, 120s default
app.use((req, _res, next) => {
  req.setTimeout(180000);
  next();
});

// Static dashboard — polished, responsive, token-driven, no account
const dashboardPath = path.join(__dirname, '../public/dashboard');
const publicPath = path.join(__dirname, '../public');
app.use('/dashboard', express.static(dashboardPath, { fallthrough: false }));
app.use(express.static(publicPath, { fallthrough: true }));
// Serve dashboard as SPA fallback for /dashboard/*
// Also expose at / for convenience via redirect if html requested
app.get('/dashboard', (_req, res) => res.sendFile(path.join(dashboardPath, 'index.html')));

// Routes — single shared protocol (see /shared/src/protocol.ts)
app.use('/health', healthRouter);
app.use('/api/chat', chatRouter);
app.use('/api/vision', visionRouter);
app.use('/api/models', modelsRouter);

// Root info with production hints
app.get('/', (_req, res) => {
  res.json({
    name: 'AI Screen Assistant Server',
    version: config.version,
    protocol: '1.0.0',
    env: config.nodeEnv,
    endpoints: {
      health: 'GET /health (GET /health/live, /health/ready)',
      chat: 'POST /api/chat {messages, model?, maxTokens?, temperature?, autoContinue?} -> {message, usage, metadata, continuation}',
      chatStream: 'POST /api/chat/stream (SSE) -> events meta/delta/done/continuation/error',
      chatContinue: 'POST /api/chat/continue {previousContent, messages}',
      visionAnalyze: 'POST /api/vision/analyze (JSON {prompt,imageBase64} or multipart image, ?stream=true, autoContinue, task: vision|extract|code) -> {answer, metadata}',
      visionContinue: 'POST /api/vision/continue',
      visionExtract: 'POST /api/vision/extract {prompt,imageBase64} -> {extraction}',
      models: 'GET /api/models (cached 60s)',
    },
    limits: {
      json: config.limits.jsonLimit,
      imageMaxBytes: config.limits.imageMaxBytes,
      maxTokensMax: config.limits.maxTokensMax,
    },
    security: 'OPENROUTER_API_KEY is server-only, never exposed. CORS allowlist, rate limits, helmet, request-id.',
    docs: 'See /shared/src/protocol.ts for full contract',
  });
});

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port, env: config.nodeEnv }, `listening on 0.0.0.0:${config.port}`);
  console.log(`[server] listening on 0.0.0.0:${config.port} env=${config.nodeEnv}`);
  console.log(`[server] health -> http://localhost:${config.port}/health`);
});

// Graceful shutdown + keepalive tuning for large responses
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Handle large streaming backpressure
server.on('clientError', (err, socket) => {
  logger.error({ err: (err as Error).message }, 'clientError');
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  console.log(`[server] ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
  // Don't crash on prod if possible, but exit to let Render restart
  setTimeout(() => process.exit(1), 1000);
});

export default app;
