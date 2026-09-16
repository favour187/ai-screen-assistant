# Complete Setup Guide — GitHub · Render · OpenRouter · Local Dev

This document is the single reference for deploying and developing the AI Screen Assistant monorepo from scratch. Follow the order below.

---

## 1. Prerequisites

- **Node.js 20+** and **npm 10+** (`node -v && npm -v`)
- **Git** + **GitHub** account
- **OpenRouter** account (https://openrouter.ai)
- For Android: **Android Studio Hedgehog+**, **Java 17**, **Android SDK 34**, device/emulator API 26+
- For Windows desktop: **Windows 10+** (build installer needs `windows-latest` runner or local Windows)
- For backend deploy: **Render** account (or any Docker host: Fly.io, Railway, DockerHub+VM)

Repo layout:

```
/shared/src/protocol.ts      # single API contract (TS) — mirrored in android/protocol/Protocol.kt
/server                       # Node+TS+Express — holds OPENROUTER_API_KEY only here
/desktop                      # Electron+TS — Windows
/android                      # Kotlin+Compose — Android
/.github/workflows/           # CI + signed builds
/render.yaml                  # Render BluePrint
```

---

## 2. GitHub — Create Repo & Branch Protection

1. Create empty GitHub repo (e.g. `your-org/ai-screen-assistant`), **do not** init with README.

```bash
git init
git remote add origin https://github.com/your-org/ai-screen-assistant.git
git add .
git commit -m "initial: portable backend + clients + CI"
git push -u origin main
```

2. Enable branch protection: Settings → Branches → Add rule → Branch `main` → Require status checks (`CI — Fast Checks`, `Server`, `Desktop`, `Android lint`) + Require `ci.yml` pass before merge.

3. Add Secrets (Settings → Secrets and variables → Actions). **Never commit keys**:

| Secret | Purpose | How to get |
|--------|---------|------------|
| `OPENROUTER_API_KEY` | *only used if you want CI to run live OpenRouter smoke* — optional; production key lives in Render, not GitHub | OpenRouter → Keys → Create |
| `ANDROID_KEYSTORE_BASE64` | Signed APK/AAB (`base64 -w 0 app/release.jks`) | `keytool -genkeypair` then `base64` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | You set |
| `ANDROID_KEY_ALIAS` | Key alias | `keytool` alias |
| `ANDROID_KEY_PASSWORD` | Key password | You set |
| `WIN_CSC_LINK` | Windows code-sign `.pfx` base64 or URL | From CA (or self-signed for test) |
| `WIN_CSC_KEY_PASSWORD` | PFX password | You set |

Without Android/Windows secrets, workflows still build **unsigned** artifacts (debug APK, unsigned NSIS) for testing — see `.github/workflows/*.yml` `if: secrets.* != ''` guards.

---

## 3. OpenRouter — Get Key & Choose Model

1. Go to https://openrouter.ai/keys → Create Key → copy `sk-or-v1-…` (starts `sk-or-`).
2. Add credits (https://openrouter.ai/credits) if needed — pay-as-you-go.
3. Pick default model for the server: `OPENROUTER_MODEL` (e.g. `anthropic/claude-3.5-sonnet` for vision+code, or `openai/gpt-4o`, `google/gemini-2.0-flash-001`). All are allowed by default; restrict via `OPENROUTER_ALLOWED_MODELS` if you want.
4. Verify key: `curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer sk-or-..." | jq .`

Set `OPENROUTER_APP_URL` to your GitHub repo URL and `OPENROUTER_APP_NAME` to `AI Screen Assistant` — OpenRouter shows these in rankings/headers.

---

## 4. Environment Variables — Complete Reference

### Server (`server/.env` — never committed, never sent to clients)

Copy example:

```bash
cd server && cp .env.example .env
# edit .env
```

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` (local), `10000` (Render) | **Must respect `process.env.PORT`** — Render, Railway, Fly inject it. Server reads `parseInt(PORT||'3000')` and binds `0.0.0.0`. |
| `NODE_ENV` | No | `production` | `production` enables `log level info`, disables pretty, trust proxy. |
| `OPENROUTER_API_KEY` | **Yes for /api/* ** | `sk-or-v1-…` | **Server-only**. Missing → `/api/*` 503 `NOT_CONFIGURED`, `/health` shows `openrouter: not_configured`. Never in `desktop/.env` or `android/local.properties`. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | Override for self-hosted OpenRouter-compatible endpoints. |
| `OPENROUTER_MODEL` | No | `anthropic/claude-3.5-sonnet` | Default model used when client sends no `model`. |
| `OPENROUTER_ALLOWED_MODELS` | No | `anthropic/claude-3.5-sonnet,openai/gpt-4o` | Comma-separated allowlist; empty = any. Server returns `MODEL_NOT_ALLOWED` if blocked. |
| `OPENROUTER_TIMEOUT_MS` | No | `120000` | Non-stream chat timeout (large codegen). |
| `OPENROUTER_STREAM_TIMEOUT_MS` | No | `180000` | Stream initial connection timeout. Stream keeps alive 65s `keepAliveTimeout`. |
| `OPENROUTER_MAX_RETRIES` | No | `3` | Retry on 429/502/503/504/529 with exp backoff `800ms*2^(n-1)`. |
| `ALLOWED_ORIGINS` | Prod: Yes | `https://your-render.onrender.com,app://*` or `*` dev | CORS allowlist. `*` for local dev only; set to your prod client origins. |
| `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`/`RATE_LIMIT_VISION_MAX`/`RATE_LIMIT_STREAM_MAX` | No | `60000/80/30/40` | Tiered rate limits (vision stricter). |
| `JSON_LIMIT`/`IMAGE_MAX_BYTES`/`MAX_TOKENS_MAX` | No | `15mb/10485760/16384` | Large codegen 16384 tokens ≈ 1000+ lines. |
| `LOG_LEVEL`/`LOG_PRETTY` | No | `info/false` prod | `pino` JSON in prod, pretty in dev. Redacts `authorization`. |

**Portability**: Changing hosting? Only change `PORT` (auto) and `ALLOWED_ORIGINS`; clients need no rebuild — they store `backendUrl` at runtime (see §7).

### Desktop (`desktop/.env` — renderer, no secrets)

```
VITE_API_BASE_URL=https://ai-screen-assistant.onrender.com
VITE_APP_NAME=AI Screen Assistant
```

- `VITE_API_BASE_URL` is **default only** (baked at `vite build`). User can override at runtime via UI Settings → Backend URL (persisted in `electron-store` `backendUrl`). So moving hosting needs no rebuild: user edits the field, or distributes new `.env` and rebuilds installer.
- Never put `OPENROUTER_API_KEY` here — grep check in CI will fail if found.

### Android (no env file)

- Default `https://ai-screen-assistant.onrender.com` in `ScreenCaptureService.backendUrlFlow`.
- User overrides in app: Settings → Backend URL (persisted via `DataStore`), no APK rebuild.
- For emulator local backend: use `http://10.0.2.2:3000` (emulator loopback).

---

## 5. Local Development

### A. Backend (all platforms depend on it)

```bash
cd server
npm install
cp .env.example .env  # set OPENROUTER_API_KEY
npm run dev    # tsx watch src/index.ts → http://localhost:3000

# test health
curl http://localhost:3000/health | jq
# test vision (small 1x1 png + prompt) — needs real key
curl -X POST http://localhost:3000/api/vision/analyze \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Describe this red dot","imageBase64":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="}' | jq
# stream
curl -N -X POST http://localhost:3000/api/vision/analyze?stream=true -H 'Content-Type: application/json' -d '{"prompt":"Hi","imageBase64":"data:...","stream":true}'
```

`npm run build && npm start` for production mode (uses `dist/index.js`, `keepAlive 65s`, `headersTimeout 66s`).

Docker locally:

```bash
cd server
docker build -f Dockerfile -t ai-assistant-server:local .
docker run -p 3000:3000 --env-file .env ai-assistant-server:local
# or override port
docker run -p 8080:8080 -e PORT=8080 -e OPENROUTER_API_KEY=sk-or-... ai-assistant-server:local
```

### B. Desktop (Windows)

```bash
cd desktop
npm install
cp .env.example .env  # point VITE_API_BASE_URL to your backend (local or Render)
npm run dev          # Vite dev 5173 + tsc watch + Electron (opens window, DevTools)
# In app: click ▣ Choose Window/Screen → pick window → Start → set prompt → Analyze (stream)
# Toggle Overlay button → draggable always-on-top floating result

# Production build
npm run build        # tsc main+renderer + vite → dist/
npm start            # electron . (uses dist)
npm run dist:win     # electron-builder → desktop/release/AI Screen Assistant Setup 1.0.0.exe (NSIS)
```

**Windows startup/shutdown**: app uses `singleInstanceLock`, `window-all-closed → quit (not darwin)`, `store` persists bounds/config, `overlay.wasVisible` restored after relaunch. Autostart can be enabled via `app.setLoginItemSettings({openAtLogin:true})` (opt-in in Settings).

### C. Android

```bash
# in Android Studio: Open android/ → Sync Gradle → Run on device (API 26+)
# Or CLI:
cd android
./gradlew :app:assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

Flow on device:
1. Launch app → grant notification permission (Android 13+) → Service binding.
2. Tap **Backend URL** → set to `http://10.0.2.2:3000` for emulator or Render URL.
3. Tap **Start Capture** → system MediaProjection dialog → Allow → notification “Capture active”.
4. Configure sliders (interval/scale/quality/threshold), enable **Auto-analyze** if desired.
5. Grant **Draw over other apps** if you want floating results while in other apps → bubble appears, shows streamed answer.
6. Press Home → open another app → capture continues (foreground service). Rotate device → preview updates, VirtualDisplay recreates.

Gradle signing for release: create `app/release.jks`, then `ANDROID_*` secrets in GitHub, or local `app/signing.properties` (gitignored).

---

## 6. Render — Deploy Backend (production)

### Option A: BluePrint (recommended, one-click)

1. Push `render.yaml` to `main`. In Render dashboard: New → BluePrint → Connect repo → Apply.
2. Render creates `ai-screen-assistant-server` (Docker, `healthCheckPath: /health`, `PORT=10000`).
3. In Render → Service → Environment → add **secret** `OPENROUTER_API_KEY` (sync:false) → Save → Deploys automatically.
4. Open `https://your-service.onrender.com/health` → `{status:"ok"}`.
5. Update `ALLOWED_ORIGINS` to your real origins (e.g. `https://your-service.onrender.com,app://*`) — `*` is dev-only.
6. Update desktop `VITE_API_BASE_URL` and Android default to `https://your-service.onrender.com` (or let users set at runtime — no rebuild required).

### Option B: Manual Docker service

Render → New → Web Service → Connect repo → Runtime Docker, Dockerfile `./server/Dockerfile`, Docker context `./server`, branch `main`, health check `/health`, plan Starter, add env vars as in `render.yaml`.

### Verify

```bash
curl https://your-service.onrender.com/health | jq
curl https://your-service.onrender.com/api/models -H "Authorization: Bearer dummy" | jq # public? but server proxies
# vision test with real key
curl -X POST https://your-service.onrender.com/api/vision/analyze -H 'Content-Type: application/json' -d '{"prompt":"...","imageBase64":"data:..."}'
```

Logs: Render → Logs → pino JSON (redacted). Keep `LOG_LEVEL=info` in prod.

---

## 7. Portability — Move to Another Host Without Changing Clients

**Server is host-agnostic**: it reads `PORT` (required by Render/Fly/Railway/Heroku), binds `0.0.0.0`, respects `NODE_ENV`, and has no Render-specific code. To move:

1. **Build same Docker image** (`server/Dockerfile` multi-stage, `node:20-alpine`, `EXPOSE 10000`, `HEALTHCHECK /health`) on new host:
   - Fly.io: `fly launch --dockerfile server/Dockerfile --docker-context server` and set secrets `fly secrets set OPENROUTER_API_KEY=... ALLOWED_ORIGINS=...`
   - Railway: New service → Deploy from Dockerfile, set `PORT` auto, add env vars.
   - Any VM: `docker run -p $PORT:$PORT --env-file server/.env ai-assistant-server`.
2. **Point clients at new URL — no rebuild needed**:
   - Desktop: Settings → Backend URL → paste `https://new-host.com` → Save (writes `electron-store` `backendUrl`). Or redeploy installer with new `VITE_API_BASE_URL` for new users.
   - Android: Settings → Backend URL → `https://new-host.com` (DataStore). Default in code is fallback only.
3. **Update CORS**: on new server set `ALLOWED_ORIGINS` to include new host + `app://*` (Electron `file://` sends no origin; those bypass CORS via `if (!origin) return cb(null,true)`).
4. **No client code change**: API contract is `shared/src/protocol.ts` — route constants `API_ROUTES` (`/health`, `/api/vision/analyze`, etc.) are identical on any host.

---

## 8. GitHub Actions — Automatic Builds

Workflows (`.github/workflows/`):

| Workflow | Trigger | Runner | What it does | Artifacts |
|----------|---------|--------|--------------|-----------|
| `ci.yml` | push/PR `main` | `ubuntu-latest` | `shared` typecheck + `server` typecheck/build + health smoke (`curl /health`) + Docker build smoke + `desktop` typecheck/vite + `android` lint/assembleDebug (unsigned) | No signed artifacts — fast |
| `android.yml` | push `android/**,shared/**` or release, manual | `ubuntu-latest` | `lintDebug` → `assembleDebug` → if `ANDROID_KEYSTORE_BASE64` secret present: decode `release.keystore`, `assembleRelease` + `bundleRelease` (AAB), then `rm keystore` | `android-debug-apk` (14d), `android-release-apk`+`*.aab` (30d) |
| `desktop.yml` | push `desktop/**,shared/**` or release, manual | `windows-latest` | typecheck main+renderer → `vite build` → if `WIN_CSC_LINK` present: decode to `cert.pfx`, `electron-builder --win --publish=never`, then `rm cert.pfx` | `windows-installer` (`*.exe`, `*.blockmap`, 30d) |

**How to trigger signed builds**: set the four Android or two Windows secrets in repo Settings → Secrets → Actions, then push to `main` or create a `release` (GitHub Release → Publish). Workflows run automatically; download artifacts from Actions tab.

**Secrets as ephemeral**: workflows write keystore/pfx to `$RUNNER_TEMP`, use it once, then `if: always() rm -f` so secrets never persist on runner.

**Local test of CI steps**:

```bash
# same as ci.yml server smoke
cd server && npm ci && npm run typecheck && npm run build && PORT=3001 OPENROUTER_API_KEY=dummy_ci_key node dist/index.js &
curl --retry 5 --retry-delay 1 -sf http://localhost:3001/health
```

---

## 9. Testing the Complete Authorized Flow

### Manual end-to-end (do on real devices)

**Prerequisites**: backend running (local or Render) with valid `OPENROUTER_API_KEY`.

**Desktop Windows**

1. `desktop: npm run dev` (or installed exe).
2. Click **▣ Choose Window / Screen** → OS picker shows screens/windows → select one → **Start**.
3. Verify **capture**: preview updates at `intervalMs`, stats show `fps`, `diff%`, `skipped`. Tweak sliders → live update.
4. Type prompt “Summarize this screen in 2 bullets” → **Analyze** (stream toggle ON).
5. Observe **backend → OpenRouter → streamed response**: main card streams `delta` tokens, `Stream: streaming…` then `done` with `finishReason` + `truncated` hint.
6. Click **Create Overlay** → floating window appears (always-on-top, draggable) → mirrors streamed text → click **📌** toggles pin, **✕** closes.
7. Switch to another app (e.g., Notepad) → capture continues (video track not stopped), preview keeps updating → no injection (task manager shows only Electron, not DLL in target).
8. Stop → `track.stop()` + `VirtualDisplay` release → preview cleared.

**Android**

1. Install debug APK → launch → allow notification permission.
2. Settings → Backend URL = `https://your-render.onrender.com` (or `http://10.0.2.2:3000` emulator) → **Check health** → `ok • ok`.
3. **Start Capture** → system MediaProjection dialog → Allow.
4. Notification “Capture active” appears; sliders active.
5. **Analyze** (or enable Auto) → floating bubble appears (if overlay permission granted) → streaming text updates in both app and bubble.
6. Press **Home** → open another app → notification persists, overlay still visible, frames keep flowing (service is foreground `mediaProjection`).
7. **Stop** → notification removed, `isCapturingFlow false`, VirtualDisplay released.

### Automated checks (CI smoke)

- `GET /health` returns `status ok`, `checks.openrouter` not leaked.
- `POST /api/vision/analyze` with 1x1 png succeeds (or 401 if dummy key, but validates 200 shape when key real).
- SSE stream: `event: meta` → `delta` → `done` (contains `finishReason`, `truncated`, `continuationAvailable`).
- Desktop `captureEngine.test` (if you run `npm --workspace desktop run typecheck`) and `FrameDiffer` unit (32×32 luma >15).

### Edge-case test matrix (see §10 for details)

Run the checklist in §10 and record results in `TESTING.md` or PR description.

---

## 10. Edge-Case Testing Checklist (required before release)

Check each item manually; all must pass.

| # | Category | How to test | Expected |
|---|----------|-------------|----------|
| 1 | **Long code (1000+ lines)** | Prompt “Generate a complete Next.js + Prisma app (1200 lines) in one file” with `maxTokens 16384, stream` ON. Also non-stream with `autoContinue:true`. | Server streams without 120s timeout (`streamTimeout 180s`), returns full content. If `finish_reason:length`, server sends `continuation` event and client shows “Truncated — tap Continue” → `POST /continue` appends. No OOM: `jsonLimit 15mb`, `imageMaxBytes 10MB`. |
| 2 | **Reconnects (network blip)** | Kill backend mid-stream (or `adb shell svc wifi disable` 2s) → observe client `error` event → retry button appears → re-enable → tap retry → new `POST` succeeds. Server logs `AbortError → reader.cancel()`. | Desktop shows “Stream failed — Retry”, Android `ApiClient` throws `ApiException` → UI shows snackbar Retry. No leaked `AbortController`. |
| 3 | **Screen rotation** | Android: start capture → rotate device 90° → check logcat `DisplayListener onDisplayChanged → handleRotation → VirtualDisplay recreated 350ms`. Desktop: switch from primary to external display via picker → new source selected → `CaptureEngine.stop()` then `start(newId)` recreates. | No crash, preview updates with new metrics, aspect correct. `onTrimMemory` not triggered. |
| 4 | **Multiple displays** | Desktop: connect 2 monitors → **Choose Window/Screen** shows “Screen 1” and “Screen 2” + windows → pick each → works. Android: foldable or `adb shell wm size` change → VirtualDisplay metrics updated. | List includes all `desktopCapturer` `display_id`s; picker not limited to primary. |
| 5 | **Network failure (offline)** | Desktop: disconnect WiFi → **Analyze** → fetch throws `TypeError: Failed to fetch` → UI shows “Backend unreachable — check health” + `checkHealth()` degraded. Android: airplane mode → `OkHttp` timeout 15s → `ApiException` → retry. | No app crash, no key leaked, no infinite retry (max 3 exp backoff server-side only; client does single retry on user action). |
| 6 | **Memory usage** | Android: `adb shell dumpsys meminfo com.aiscreenassistant` while capture at `scale 1.0, quality 90, interval 500ms` 2min → check `MemoryManager.shouldThrottle → true` when `availMem<120MB` → quality auto drops to 55. Desktop: Task Manager → Electron stays <300MB, `canvas` reuse, `maxQueue 2` skips. | No OOM, bitmap `recycle()` called, `ImageReader maxImages 2`, queue capped. Low-memory notification “Throttling quality”. |
| 7 | **Android service lifecycle** | Start capture → press Home → swipe away app → notification stays → return → reconnects via `ServiceConnection`. Kill service via `adb shell am force-stop` → restart → requires re-auth (system revoked MediaProjection). Reboot → service not auto-started (requires user re-consent). | Foreground service `START_NOT_STICKY`, survives Home but not force-stop. `MediaProjection.Callback.onStop` → errorFlow “re-authorize”. |
| 8 | **Windows startup/shutdown** | Install NSIS → run → close main window → tray? `window-all-closed` → quit (not darwin) — no orphan `electron` process in Task Manager. Re-launch → `singleInstanceLock` prevents second instance, focuses first. `overlay.wasVisible` restored if enabled. Shutdown Windows → `app.quit()` graceful, `overlay.bounds` saved. Autostart toggle in Settings uses `app.setLoginItemSettings`. | Clean exit, no zombie, single instance, overlay bounds persisted. |
| 9 | **Malformed AI responses** | Mock backend (set `OPENROUTER_API_KEY=dummy` → server returns `OPENROUTER_401` JSON, or inject invalid SSE `data: {invalid json`) → client `api.ts` `JSON.parse` catch → `if (event==='error') throw` → UI shows “Upstream error” not crash. Server `errorHandler` masks `sk-or-` → “Upstream error”. | Desktop shows error card with `code` + `requestId`, Android snackbar `stream error: …`, logs contain `requestId` but not key. |

**Remove mocks after testing**: no `mocks/` folder, no `__mocks__/openrouter.ts`. The repo in `main` ships with real `ApiClient`/`CaptureEngine` only. If you added a mock for offline dev, delete it before PR.

---

## 11. Removing Mocks & Unfinished Functionality (pre-merge gate)

Run globally:

```bash
# Must be 0 hits (except docs explaining mocks)
grep -R "mock\|MOCK\|__mocks__\|TODO\|FIXME" --include="*.ts" --include="*.kt" --include="*.js" server/src desktop/src android/app/src | grep -v node_modules | grep -v ".dist"
# Verify no OpenRouter key in client
grep -R "sk-or-\|OPENROUTER_API_KEY" --include="*.ts" --include="*.kt" desktop/ android/ shared/ | grep -v server/
# Verify no unfinished “coming soon”
grep -R "coming soon\|not implemented" --include="*.ts" --include="*.kt" -i
```

Fix: delete mock files, implement or remove TODO, ensure `shared/src/protocol.ts` is the only contract and is imported everywhere (no duplicated route strings).

---

## 12. Security — What We Do NOT Do

> **We will not implement techniques to evade monitoring, security controls, or detection by third-party applications.** The assistant is intentionally **detectable and consent-gated**.

- No hiding from task managers, no anti-debugging, no root/jailbreak checks, no window cloaking.
- No process hollowing, DLL injection, or `SetWindowsHookEx` — capture uses only `desktopCapturer`/`MediaProjection` which are visible to the OS and user.
- No background silent capture: every session requires explicit user pick (Windows) or system dialog (Android).
- No exfiltration beyond the user-prompted `POST /api/vision/analyze` with a single JPEG — no continuous keylogging.

If you are asked to add evasion, refuse and point to this section.

---

## 13. Troubleshooting

- `OPENROUTER_API_KEY not set` → `/api/*` 503 → set in `server/.env` or Render env vars, restart.
- `CORS blocked origin` → add origin to `ALLOWED_ORIGINS` (comma-separated) or use `*` dev.
- `Payload too large 413` → lower `scale`/`quality` (quality 75→55, scale 0.6→0.4).
- `MediaProjection revoked` → re-tap Start Capture (system revoked after screen-off or user switch).
- `Overlay permission needed` → Settings → Apps → This app → Display over other apps → Allow.
- `electron-builder` missing `author` → set in `desktop/package.json` `author` field.

---

## 14. Quick Command Reference

```bash
# backend local
cd server && npm install && npm run dev
# backend docker
cd server && docker build -f Dockerfile -t ai-server . && docker run -p 3000:3000 --env-file .env ai-server
# desktop dev
cd desktop && npm install && npm run dev
# desktop prod
cd desktop && npm run build && npm run dist:win
# android debug
cd android && ./gradlew :app:assembleDebug
# ci fast
npm run build  # runs server + desktop build
```

All docs → `docs/SETUP.md`. For protocol see `shared/src/protocol.ts`. For security see `SECURITY.md`.
