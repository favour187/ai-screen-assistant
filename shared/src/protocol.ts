/**
 * Shared API Protocol — Single Source of Truth
 * Imported by server and desktop (TypeScript).
 * Android mirrors these shapes in Protocol.kt — keep in sync.
 *
 * Version: 1.0.0
 * Base path: /  (server mounts routes under /api)
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number; // seconds
  timestamp: string; // ISO
  checks: {
    server: 'ok';
    openrouter: 'ok' | 'not_configured' | 'unreachable';
  };
}

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------
export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: Role;
  content: string;
  // Optional image for vision — base64 data URL or pending upload
  // Backend accepts either content + imageBase64 or multimodal array forwarded to OpenRouter
  imageBase64?: string; // e.g. "data:image/jpeg;base64,..."
  imageUrl?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  pricing?: unknown;
}

// ---------------------------------------------------------------------------
// POST /api/chat  (non-streaming)
// Request
export interface ChatRequest {
  messages: ChatMessage[];
  model?: string; // defaults to server's OPENROUTER_MODEL
  maxTokens?: number;
  temperature?: number;
  // When true, server may include reasoning traces if model supports it
  includeReasoning?: boolean;
}

// Response (non-streaming)
export interface ChatResponse {
  id: string;
  model: string;
  message: ChatMessage; // assistant message
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  // Raw OpenRouter finish reason
  finishReason?: string;
}

// ---------------------------------------------------------------------------
// POST /api/chat/stream  (SSE)
// Request: same as ChatRequest
// Response: text/event-stream with events below
// ---------------------------------------------------------------------------
export type StreamEventType = 'delta' | 'done' | 'error' | 'meta';

export interface StreamDeltaEvent {
  type: 'delta';
  delta: string; // incremental text
}

export interface StreamMetaEvent {
  type: 'meta';
  model: string;
  id: string;
}

export interface StreamDoneEvent {
  type: 'done';
  finishReason?: string;
  usage?: ChatResponse['usage'];
}

export interface StreamErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export type StreamEvent =
  | StreamDeltaEvent
  | StreamMetaEvent
  | StreamDoneEvent
  | StreamErrorEvent;

// SSE wire format helpers
export const SSE_EVENT_NAMES = {
  delta: 'delta',
  done: 'done',
  error: 'error',
  meta: 'meta',
} as const;

// ---------------------------------------------------------------------------
// POST /api/vision/analyze  (multipart or JSON)
// Vision: screenshot + prompt → AI answer
// ---------------------------------------------------------------------------
export interface VisionAnalyzeRequest {
  prompt: string; // what to ask about the screenshot
  // Exactly one of these must be provided
  imageBase64?: string; // data URL or raw base64
  imageUrl?: string;
  model?: string;
  maxTokens?: number;
  // Optional: include prior conversation for context
  history?: ChatMessage[];
  stream?: boolean; // if true, server responds with SSE instead of JSON
}

export interface VisionAnalyzeResponse {
  id: string;
  model: string;
  answer: string;
  usage?: ChatResponse['usage'];
}

// Multipart variant: clients may POST as multipart/form-data with fields:
//   - prompt: string
//   - model?: string
//   - history?: JSON stringified ChatMessage[]
//   - image: File/Blob (field name "image")
// Server normalizes both JSON and multipart to same handler.

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------
export interface ModelsResponse {
  models: ModelInfo[];
}

// ---------------------------------------------------------------------------
// Error envelope (all endpoints)
// ---------------------------------------------------------------------------
export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Route constants — use these, never hardcode strings in clients
// ---------------------------------------------------------------------------
export const API_ROUTES = {
  health: '/health',
  models: '/api/models',
  chat: '/api/chat',
  chatStream: '/api/chat/stream',
  visionAnalyze: '/api/vision/analyze',
} as const;

// ---------------------------------------------------------------------------
// Validation helpers (lightweight, zod lives server-side)
// ---------------------------------------------------------------------------
export function isValidChatRequest(body: unknown): body is ChatRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b.messages) && b.messages.length > 0;
}

// ---------------------------------------------------------------------------
// SSE parsing helper for clients (desktop/android)
// Usage: parse SSE lines "event: delta\ndata: {...}\n\n"
// ---------------------------------------------------------------------------
export function parseSSEChunk(chunk: string): StreamEvent | null {
  // chunk like "event: delta\ndata: {\"delta\":\"hello\"}\n"
  const lines = chunk.split('\n');
  let event: string | null = null;
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    const payload = JSON.parse(data);
    return { type: event as StreamEventType, ...payload } as StreamEvent;
  } catch {
    // fallback: raw delta string
    if (event === 'delta') return { type: 'delta', delta: data } as StreamDeltaEvent;
    return null;
  }
}
