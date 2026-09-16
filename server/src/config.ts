import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
    appUrl: process.env.OPENROUTER_APP_URL || 'https://github.com/ai-screen-assistant',
    appName: process.env.OPENROUTER_APP_NAME || 'AI Screen Assistant',
    // Timeouts and retries for production
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS || '120000', 10), // 120s for large codegen
    streamTimeoutMs: parseInt(process.env.OPENROUTER_STREAM_TIMEOUT_MS || '180000', 10), // 180s streaming
    maxRetries: parseInt(process.env.OPENROUTER_MAX_RETRIES || '3', 10),
    retryBaseDelayMs: parseInt(process.env.OPENROUTER_RETRY_DELAY_MS || '800', 10),
    // Model allowlist: empty means allow any; comma-separated to restrict
    allowedModels: (process.env.OPENROUTER_ALLOWED_MODELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  limits: {
    jsonLimit: process.env.JSON_LIMIT || '15mb',
    urlencodedLimit: process.env.URLENCODED_LIMIT || '15mb',
    imageMaxBytes: parseInt(process.env.IMAGE_MAX_BYTES || `${10 * 1024 * 1024}`, 10), // 10 MB
    maxTokensDefault: parseInt(process.env.MAX_TOKENS_DEFAULT || '4096', 10),
    maxTokensMax: parseInt(process.env.MAX_TOKENS_MAX || '16384', 10), // support 1000+ lines
    maxMessages: parseInt(process.env.MAX_MESSAGES || '50', 10),
    maxPromptChars: parseInt(process.env.MAX_PROMPT_CHARS || '20000', 10),
  },
  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '80', 10),
    visionMax: parseInt(process.env.RATE_LIMIT_VISION_MAX || '30', 10), // stricter for vision
    streamMax: parseInt(process.env.RATE_LIMIT_STREAM_MAX || '40', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    pretty: process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV !== 'production',
  },
  version: process.env.npm_package_version || '1.0.0',
};

export function assertConfig() {
  if (!config.openrouter.apiKey) {
    console.warn(
      '[config] OPENROUTER_API_KEY not set — /api/* will return 503 until configured. Health check will report degraded.'
    );
  }
  if (config.openrouter.apiKey && config.openrouter.apiKey.length < 20) {
    console.warn('[config] OPENROUTER_API_KEY looks short/invalid');
  }
}

export function isModelAllowed(model: string): boolean {
  if (config.openrouter.allowedModels.length === 0) return true;
  return config.openrouter.allowedModels.includes(model);
}
