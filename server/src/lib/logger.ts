import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logging.level,
  transport: config.logging.pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  base: { service: 'ai-screen-assistant-server', version: config.version },
  // Never log OPENROUTER_API_KEY
  redact: {
    paths: ['req.headers.authorization', 'res.headers.authorization', 'openrouter.apiKey', '*.apiKey', '*.authorization'],
    censor: '[REDACTED]',
  },
});

export function childLogger(requestId: string) {
  return logger.child({ requestId });
}
