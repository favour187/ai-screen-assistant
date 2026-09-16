# Server — AI Screen Assistant Backend (Production)

Node.js + TypeScript + Express + Pino. **OPENROUTER_API_KEY lives only here** (never in Android/desktop). All clients proxy through this server.

## What it does

- Receives **authorized screen images + context** (`imageBase64` or `multipart image` + `prompt` + optional `history`) from Android (MediaProjection) and Windows (desktopCapturer)
- Determines relevant content and builds **multimodal OpenRouter messages** (text + `image_url`)
- Supports **vision analysis**, **question/context extraction**, **coding tasks / large code generation (1000+ lines)**
- Streams via **SSE** (`text/event-stream` with `meta/delta/done/continuation/error`) or returns JSON
- Handles **continuation** of truncated `finish_reason: length` responses (auto-continue or manual `/continue` endpoint)
- Returns **structured metadata** (`metadata: {durationMs, usage, finishReason, truncated, continuationAvailable, ...}`)

## Endpoints (shared protocol `shared/src/protocol.ts`)

- `GET /health`, `GET /health/live`, `GET /health/ready` — liveness/readiness with `limits` and `models` info
- `GET /` — info + limits + security note
- `POST /api/chat` — `{messages, model?, maxTokens?, temperature?, autoContinue?, maxContinuations?}` → `{message, usage, metadata, continuation?}` — supports **large codegen** (maxTokens up to 16384, auto-continue 0–5 times)
- `POST /api/chat/stream` — SSE streaming, same body → `event: meta/delta/done/continuation/error` with `truncated` hint
- `POST /api/chat/continue` — `{previousContent, messages, model?, maxTokens?}` → continuation chunk
- `POST /api/vision/analyze` — **JSON** `{prompt, imageBase64|imageUrl, model?, maxTokens?, history?, stream?, autoContinue?, task: vision|extract|code}` **or** `multipart/form-data` `{prompt, image: file, ...}` → `{answer, usage, metadata, continuation?}` — **?stream=true for SSE**
- `POST /api/vision/continue` — continuation for vision
- `POST /api/vision/extract` — dedicated extraction (`{prompt, imageBase64}` → `{extraction}`) with system prompt for structured `summary/question/context/codeBlocks`
- `GET /api/models` — proxied + cached 60s (`X-Cache: HIT/MISS`)

## Production features

- **Configurable models**: `OPENROUTER_MODEL` default, per-request `model` override, optional `OPENROUTER_ALLOWED_MODELS` allowlist
- **Large responses**: `MAX_TOKENS_MAX=16384` (1000+ lines), `autoContinue` loops with `buildContinuationMessages()` until `finish_reason != length`
- **Retries**: `OPENROUTER_MAX_RETRIES=3` exponential backoff on 429/5xx (via `lib/retry.ts`), logs attempt
- **Rate limits** (tiered): general `80/min`, vision `30/min`, stream `40/min` (`express-rate-limit`, skip `/health`)
- **Timeouts**: `OPENROUTER_TIMEOUT_MS=120s` (non-stream), `STREAM_TIMEOUT_MS=180s`, `req.setTimeout(180s)`, `AbortController` on client disconnect
- **Logging**: `pino` + `pino-http` structured (requestId, duration, model, tokens), `morgan` in dev, redacts `authorization`, never logs key. `LOG_LEVEL`, `LOG_PRETTY`
- **Request-size limits**: `express.json 15mb`, `multer image 10MB`, 413 handling with friendly message
- **Security**: `helmet`, `cors` allowlist, `requestId` (`X-Request-Id`), never leak `sk-or-*`, `helmet` + `pino redact`

## Quick start

```bash
cp .env.example .env  # set OPENROUTER_API_KEY
npm install
npm run dev    # http://localhost:3000/health
npm run build && npm start
# Docker (Render): docker build -f Dockerfile -t server . && docker run -p 10000:10000 --env-file .env server
```

## Example — vision codegen 1000+ lines with auto-continue

```bash
curl -X POST http://localhost:3000/api/vision/analyze \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Generate a full-stack Next.js app with auth, DB, tests — 1500 lines","imageBase64":"data:image/jpeg;base64,...","model":"anthropic/claude-3.5-sonnet","maxTokens":16384,"autoContinue":true,"task":"code","stream":false}' | jq
# -> { answer: "<1500 lines>...", metadata: {truncated:false, continuationCount:2}, usage: {totalTokens:...} }

# Streaming
curl -N -X POST http://localhost:3000/api/vision/analyze?stream=true \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain this screen","imageBase64":"data:image/jpeg;base64,...","stream":true}' 
# -> event: meta ... event: delta ... event: done {truncated:false} ...

# Continuation if truncated
curl -X POST http://localhost:3000/api/chat/continue \
  -d '{"previousContent":"<truncated>","messages":[{"role":"user","content":"Write a 2000 line file"}]}'
```

## OpenRouter key safety

- Only `server/.env` and Render secret `OPENROUTER_API_KEY` (sync:false). **Never** in `desktop/.env.example` or `android/` (grep `sk-or-` blocked).
- `src/lib/openrouter.ts` adds `Authorization: Bearer ...` + `HTTP-Referer`/`X-Title` server-side only. Error messages redact `sk-or-`.

## Deploy (Render)

`render.yaml` sets `OPENROUTER_API_KEY` sync:false, `PORT 10000`, healthCheck `/health`. See root `render.yaml`.

## Observability

- `GET /health` includes `limits` and `models`
- Logs include `requestId` (also `X-Request-Id` header), `durationMs`, `model`, `usage`, `finishReason`
- `pino-http` auto logs `req/res` with level by status

## Limits & tuning

Env: `JSON_LIMIT`, `IMAGE_MAX_BYTES`, `MAX_TOKENS_MAX`, `RATE_LIMIT_*`, `LOG_LEVEL`. For 1000+ lines, set `maxTokens:16384` and `autoContinue:true,maxContinuations:3`.
