# AI Screen Assistant — Monorepo

Production-ready AI Screen Assistant with **OS-authorized screen capture only**, **no injection / instrumentation** of the viewed app, and **OpenRouter proxied exclusively through the backend**. Portable backend (reads `PORT`), runtime-switchable clients, and signed CI builds.

```
┌─────────────┐      ┌─────────────┐      ┌──────────────────────┐
│  Android    │      │   Windows   │      │  Node.js Backend     │
│ Kotlin+     │─────▶│ Electron+TS │─────▶│  TypeScript +        │
│ Compose +   │ https│ desktopCap- │ https│  Express + OpenRouter│
│ MediaProj.  │      │ turer       │      │  (key never leaves)  │
└─────────────┘      └─────────────┘      └──────────────────────┘
         ▲                    ▲                     │
         └────────────────────┴─────────────────────┘
              Shared API Protocol (/shared)
```

> **Security & Isolation Guarantee**
> - Capture clients use **only** OS-provided, user-authorized APIs: `MediaProjection` (Android) and `desktopCapturer` + `getUserMedia` (Electron/Windows).
> - Clients **never** inject code, hook, instrument, or IPC with the foreground app. They capture pixels via the OS compositor and send them to the backend for analysis.
> - OpenRouter API key lives **only** in `server/.env` / Render env var, never shipped to clients.
> - We do **not** implement evasion of monitoring/security controls — see `docs/SETUP.md` §12.

---

## Monorepo Layout

```
/ (root)
├── shared/                 # Single source of truth for API protocol (TS)
│   └── src/protocol.ts
├── server/                 # Node.js + TypeScript + Express backend (portable, reads PORT)
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   ├── lib/openrouter.ts
│   │   └── middleware/
│   ├── Dockerfile          # multi-stage, 0.0.0.0:$PORT, HEALTHCHECK /health
│   └── package.json
├── desktop/                # Electron + TypeScript Windows client (runtime backendUrl)
│   ├── src/main/           # singleInstanceLock, quit-on-close, overlay alwaysOnTop
│   ├── src/preload/
│   ├── src/renderer/       # CaptureEngine, SSE streaming, queue guard
│   └── package.json
├── android/                # Kotlin + Jetpack Compose + MediaProjection (foreground service)
│   ├── app/src/main/
│   └── build.gradle.kts
├── .github/workflows/      # ci.yml (fast) + android.yml + desktop.yml (signed)
├── render.yaml             # Render BluePrint (PORT=10000, health /health)
└── docs/SETUP.md           # full GitHub/Render/OpenRouter/env/local dev guide
```

---

## Shared API Protocol

Defined once in [`shared/src/protocol.ts`](shared/src/protocol.ts) and imported by `server` and `desktop`. Android has a 1:1 Kotlin data-class mirror at `android/app/src/main/java/com/aiscreenassistant/protocol/Protocol.kt`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` + `/health/live` + `/health/ready` | GET | Liveness/readiness (no auth, cached) |
| `/api/models` | GET | List OpenRouter models (proxied, X-Cache) |
| `/api/chat` | POST | Non-streaming chat (`maxTokens`≤16384, `autoContinue`) |
| `/api/chat/stream` | POST | **SSE streaming** chat (`meta/delta/done/continuation/error`) |
| `/api/chat/continue` | POST | Continue truncated length response |
| `/api/vision/analyze` | POST | Screenshot+prompt→AI (JSON or `multipart image`, `?stream=true`, `task:vision|extract|code`, autoContinue) |
| `/api/vision/continue` + `/api/vision/extract` | POST | Continuation & structured extraction |

All JSON validated with `zod`. Streaming `text/event-stream` events: `meta/delta/done/continuation/error`. See protocol for full types.

---

## Quick Start

### Prerequisites
- Node 20+, npm 10+
- Java 17 + Android Studio Hedgehog+ (for Android)
- Windows 10+ with Electron support
- OpenRouter account (https://openrouter.ai/keys)

### 1. Backend

```bash
cd server
cp .env.example .env   # set OPENROUTER_API_KEY and optionally OPENROUTER_MODEL
npm install
npm run dev            # http://localhost:3000  (GET /health)
```

Env vars (never commit `.env`) — full table in `docs/SETUP.md` §4:

```env
PORT=3000
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
```

Portability: server binds `0.0.0.0:${PORT}` — Render/Fly/Railway inject `PORT` automatically; no code change.

### 2. Desktop (Windows)

```bash
cd desktop
cp .env.example .env   # VITE_API_BASE_URL=http://localhost:3000 (default; override at runtime via UI)
npm install
npm run dev            # launches Electron with Vite HMR
npm run build          # electron-builder → installer in release/
```

Screen capture flow: user clicks **▣ Choose Window/Screen** → OS picker (`desktopCapturer`) → user selects window/screen → frame captured via `getUserMedia` → JPEG sent to `POST /api/vision/analyze`. Multiple displays appear as “Screen 1”, “Screen 2”. Settings → Backend URL changes host without rebuild (stored in `electron-store`).

### 3. Android

```bash
# Open android/ in Android Studio
# Add local.properties: sdk.dir=/path/to/Android/Sdk
# Sync Gradle, then Run on device/emulator (API 26+)
```

Capture flow: tap **Start Capture** → system MediaProjection permission dialog (OS-authorized) → `MediaProjection` + `ImageReader` captures virtual display → JPEG → `POST /api/vision/analyze` with user prompt. Service is foreground (`mediaProjection` type) so capture continues when switching apps; rotation recreates `VirtualDisplay`; memory throttles on low `availMem`. Backend URL edited in app Settings without rebuild.

---

## Security Model

| Concern | Mitigation |
|---------|------------|
| **OpenRouter key exposure** | Key only in server env. Clients call backend; backend adds `Authorization: Bearer` header. `grep` guard in CI. |
| **Isolation from viewed app** | No `AccessibilityService` instrumentation, no overlay injection, no hooking. OS compositor pixels only. |
| **User consent** | Android: explicit MediaProjection consent per session. Windows: Electron `desktopCapturer` picker — no silent capture, no `screen` without prompt. |
| **Transport** | Helmet, CORS allowlist, rate-limit (tiered 80/30/40), zod validation, multer 10MB+ mime, no raw key logging (pino redact). |
| **Portability** | Clients store `backendUrl` at runtime (electron-store/DataStore); moving hosting needs only server env + client Settings change, no rebuild. |

No evasion techniques — see `docs/SETUP.md` §12.

---

## Deployment

### Render (Backend) — 2 minutes

`render.yaml` is ready for BluePrint. Detailed steps in `docs/SETUP.md` §6:

- Docker build from `server/Dockerfile`, health check `GET /health`
- Env: `OPENROUTER_API_KEY` (secret, sync:false), `PORT=10000`, `ALLOWED_ORIGINS`
- Auto-deploy on `main`, `keepAlive 65s` for streaming

Or manual/other hosts (Fly/Railway/any VM — same `PORT`):

```bash
docker build -f server/Dockerfile -t ai-assistant-server ./server
docker run -p 10000:10000 --env-file server/.env ai-assistant-server
# moving host? only change PORT + ALLOWED_ORIGINS + client Backend URL (no client rebuild)
```

### GitHub Actions — `docs/SETUP.md` §8

- `ci.yml` (ubuntu): `shared` typecheck + `server` typecheck/build/health+Docker smoke + `desktop` vite + `android` lint/debug — required check.
- `android.yml` (ubuntu): `lintDebug` → `assembleDebug` + signed `assembleRelease/bundleRelease` if `ANDROID_*` secrets present — artifacts `android-debug-apk`/`android-release-apk`.
- `desktop.yml` (windows-latest): typecheck → `vite build` → `electron-builder --win` (+ code-sign if `WIN_CSC_*` secrets) — artifact `windows-installer`.

---

## Health Checks & Streaming

- `GET /health` → `{ status, uptime, version, checks: { openrouter: "ok"|"not_configured"|"unreachable" }, limits, models }` — used by Render and GitHub Actions.
- `GET /health/ready` → subset for K8s readiness.
- `POST /api/chat/stream` & `POST /api/vision/analyze?stream=true` → SSE: client uses `fetch` streaming + `ReadableStream`. Desktop renderer uses `ReadableStream.getReader()` + line buffer; Android uses `OkHttp` SSE flow. Server proxies OpenRouter streaming with backpressure, `AbortController` on `req close` → `reader.cancel()`, timeouts 120s/180s, retries 3×.

See [`server/README.md`](server/README.md), [`desktop/README.md`](desktop/README.md), [`android/README.md`](android/README.md), and **`docs/SETUP.md`** for deeper docs and the full edge-case test matrix (long code, reconnects, rotation, multi-display, offline, memory, lifecycle, shutdown, malformed).

---

## License

MIT
