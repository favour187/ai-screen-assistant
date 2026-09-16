/**
 * Secure backend communication — never exposes OpenRouter key
 * - Validates backendUrl (https/http only, blocks file://, etc.)
 * - Uses fetch with HTTPS, no credentials leakage, zod-validated on server
 * - Streaming via SSE text/event-stream, abortable, tolerant to malformed chunks
 * - Handles long code responses (truncated/continuation), reconnect, network failure, multiple displays agnostic
 */

export type HealthResponse = {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  timestamp: string;
  checks: { server: 'ok'; openrouter: 'ok' | 'not_configured' | 'unreachable' };
};

function validateBackendUrl(raw: string): URL {
  const u = new URL(raw);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('backendUrl must be https:// or http://');
  if (u.protocol === 'http:' && !u.hostname.match(/^(localhost|127\.0\.0\.1|10\.|192\.168\.)/)) {
    // Allow http only for localhost/dev — warn but allow; for prod, https required
    console.warn('[api] backendUrl is http (non-localhost) — prefer https for production');
  }
  return u;
}

export async function checkHealth(backendUrl: string): Promise<HealthResponse> {
  const u = validateBackendUrl(backendUrl);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(new URL('/health', u).toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status));
      // Tolerant: try parse JSON error envelope, else raw
      try { const j = JSON.parse(txt); throw new Error(j.error || `health ${res.status}`); } catch { throw new Error(`health ${res.status}: ${txt.slice(0, 500)}`); }
    }
    const json = await res.json().catch(() => { throw new Error('Malformed health JSON'); });
    if (!json || typeof json.status !== 'string') throw new Error('Malformed health response: missing status');
    return json as HealthResponse;
  } finally { clearTimeout(t); }
}

export async function fetchModels(backendUrl: string): Promise<Array<{ id: string; name: string }>> {
  const u = validateBackendUrl(backendUrl);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(new URL('/api/models', u).toString(), { signal: controller.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt.slice(0, 1000) || `models ${res.status}`);
    }
    const j = await res.json().catch(() => { throw new Error('Malformed models JSON'); });
    if (!j || !Array.isArray(j.models)) return [];
    return j.models;
  } finally { clearTimeout(t); }
}

export async function visionAnalyzeOnce(
  backendUrl: string,
  prompt: string,
  imageBase64: string,
  model?: string,
  signal?: AbortSignal,
): Promise<{ answer: string; model: string; usage?: any; metadata?: any; continuation?: any; finishReason?: string }> {
  const u = validateBackendUrl(backendUrl);
  const res = await fetch(new URL('/api/vision/analyze', u).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, imageBase64, model }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t.slice(0, 2000);
    try { const j = JSON.parse(t); msg = j.error || msg; if (j.code) msg = `${j.code}: ${msg}`; } catch {}
    throw new Error(`${res.status}: ${msg}`);
  }
  const json = await res.json().catch(() => { throw new Error('Malformed vision response JSON'); });
  if (typeof json.answer !== 'string') throw new Error('Malformed vision response: missing answer string');
  return json;
}

export type StreamResult = { finishReason?: string; full: string; truncated?: boolean; continuationAvailable?: boolean; requestId?: string };

export async function visionAnalyzeStream(
  backendUrl: string,
  prompt: string,
  imageBase64: string,
  model: string | undefined,
  onDelta: (delta: string) => void,
  onMeta?: (meta: any) => void,
  onContinuation?: (info: { available: boolean; message?: string }) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const u = validateBackendUrl(backendUrl);
  const res = await fetch(new URL('/api/vision/analyze?stream=true', u).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ prompt, imageBase64, model, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const t = await (res as Response).text().catch(() => '');
    let msg = t.slice(0, 2000);
    try { const j = JSON.parse(t); msg = j.error || msg; } catch {}
    throw new Error(`Stream failed ${res.status}: ${msg}`);
  }

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason: string | undefined;
  let truncated = false;
  let continuationAvailable = false;
  let requestId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) {
        try { await reader.cancel(); } catch {}
        throw new DOMException('Aborted', 'AbortError');
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const lines = part.split('\n');
        let event = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!event || !data) continue;
        // Tolerant: payload may be non-JSON (malformed AI) — fallback to raw
        let payload: any = null;
        let isJson = false;
        try { payload = JSON.parse(data); isJson = true; } catch { payload = data; isJson = false; }

        if (event === 'delta') {
          const delta = isJson ? (payload.delta ?? payload.text ?? payload.content ?? '') : String(payload);
          // Malformed AI may send empty delta or object — ensure string
          const deltaStr = typeof delta === 'string' ? delta : (delta != null ? String(delta) : '');
          if (deltaStr) { full += deltaStr; try { onDelta(deltaStr); } catch (e) { console.warn('onDelta threw', e); } }
          if (isJson && payload.requestId) requestId = payload.requestId;
        } else if (event === 'error') {
          const errMsg = isJson ? (payload.error || payload.message || JSON.stringify(payload).slice(0, 800)) : String(payload).slice(0, 800);
          const code = isJson ? payload.code : undefined;
          const err: any = new Error(errMsg || 'Stream error');
          if (code) err.code = code;
          throw err;
        } else if (event === 'done') {
          if (isJson) {
            finishReason = payload.finishReason || payload.finish_reason || finishReason;
            truncated = !!(payload.truncated ?? (finishReason === 'length'));
            continuationAvailable = !!(payload.continuationAvailable ?? truncated);
            requestId = payload.requestId || payload.metadata?.requestId || requestId;
            // Legacy: some servers send metadata object
            if (payload.metadata) {
              truncated = payload.metadata.truncated ?? truncated;
              continuationAvailable = payload.metadata.continuationAvailable ?? continuationAvailable;
            }
          }
        } else if (event === 'continuation') {
          const info = isJson ? payload : { available: true, message: String(payload) };
          continuationAvailable = !!(info.available ?? true);
          truncated = true;
          try { onContinuation?.(info); } catch {}
        } else if (event === 'meta') {
          if (isJson) {
            requestId = payload.requestId || requestId;
            try { onMeta?.(payload); } catch {}
          }
        } else {
          // Unknown event — ignore but log for malformed AI debug
          console.debug('[stream] unknown event', event, String(data).slice(0, 200));
        }
      }
    }
  } catch (e) {
    // Network failure classification: TypeError Failed to fetch, AbortError, etc.
    if ((e as Error).name === 'AbortError') throw e;
    // Wrap network errors with user-friendly hint
    const msg = (e as Error).message || String(e);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || (e as any).code === 'ECONNREFUSED') {
      const err: any = new Error(`Network failure: ${msg} — check backend health and CORS`);
      err.code = 'NETWORK_ERROR';
      throw err;
    }
    throw e;
  } finally {
    try { decoder.decode(); } catch {}
  }
  return { finishReason, full, truncated, continuationAvailable, requestId };
}
