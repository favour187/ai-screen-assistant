# Security — AI Screen Assistant

## 1. OpenRouter Key Protection
- Key is **never** bundled to Android APK or Electron renderer.
- Only `server/.env` and Render secret env var `OPENROUTER_API_KEY` hold it.
- Backend injects `Authorization: Bearer <key>` server-side in `src/lib/openrouter.ts`.
- Clients call `POST /api/*` on the backend; 403 if key missing is returned as 503 with `NOT_CONFIGURED`.
- Logs mask key—no `console.log(process.env.OPENROUTER_API_KEY)`.

## 2. OS-Authorized Capture Only
| Client | OS API | Consent |
|--------|--------|---------|
| Android | `MediaProjectionManager.createScreenCaptureIntent()` → `MediaProjection` → `ImageReader` + `VirtualDisplay` | System dialog per session |
| Windows | `desktopCapturer.getSources()` → user picker → `getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId })` | Electron picker, no silent capture |

No `AccessibilityService`, no window hooking, no DLL injection, no `BroadcastReceiver` spying, no polling of viewed app's internals.

## 3. Isolation Verification
- `android/app/src/main/AndroidManifest.xml` requests only `INTERNET` + `FOREGROUND_SERVICE*`. No accessibility or overlay.
- `desktop/src/main/index.ts` has `contextIsolation: true, sandbox: true, nodeIntegration: false` + CSP.
- Capture → JPEG → `ApiClient` → backend. Single frame, tracks stopped; VirtualDisplay released.

## 4. Transport & Server Hardening
- `helmet`, `cors` allowlist (`ALLOWED_ORIGINS`), `express-rate-limit`, `zod` validation, `multer` 8MB limit + mime check.
- `GET /health` is public liveness; `/api/*` rate-limited and validated.
- SSE streams respect `req.on('close')` → `reader.cancel()` to avoid leaks.

## 5. Reporting
File issues privately; rotate `OPENROUTER_API_KEY` in Render if compromised.

