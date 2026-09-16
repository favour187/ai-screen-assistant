# Desktop — Windows Client (Electron + TypeScript)

Production-grade, OS-authorized capture. **No DLL injection, no hooks, no browser extensions, no code in viewed app.**

## Isolation Guarantee

- **Only** `desktopCapturer.getSources()` → OS picker → `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`
- User must **explicitly pick** window/screen every session — no silent capture
- Pixels from OS compositor → canvas at configurable scale → JPEG. Capture client is independent `Electron` process, never loads library into target.
- `contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true`, CSP `default-src 'self'`, `setWindowOpenHandler` denies new windows.

## Features — Complete

| Requirement | Implementation |
|---|---|
| **OS-authorized, independent** | `desktopCapturer` (main) + `getUserMedia` (renderer) — see `src/main/index.ts` IPC + `src/renderer/captureEngine.ts`. No `webContents.executeJavaScript` in target, no `BrowserWindow` hook. |
| **Frame-change detection** | `src/renderer/diff.ts` — 32×32 luma, Δ>15 per pixel, % vs `diffThresholdPercent` (0.5–20%). `CaptureEngine` skips duplicates, tracks `skipped`, `lastDiff%`. Tunable live via slider. |
| **Configurable capture** | `CaptureEngineConfig{ intervalMs 500–5000, scaleFactor 0.3–1.0, jpegQuality 40–95, diffThreshold 0.5–20, maxQueue 1–5, autoAnalyze }` — sliders in `index.html`, persisted via `electron-store` (`store:get/set` IPC validated), applies live via `engine.updateConfig()`. |
| **Efficient compression** | Canvas `toDataURL('image/jpeg', quality/100)` → base64, capped `<1.8MB`, scale reduces pixels, `maxQueue` prevents flood, low-memory throttle (skip if queue full). |
| **Secure backend** | `src/renderer/api.ts` validates `backendUrl` (`new URL`, https/http only), `fetch` over HTTPS, no `OPENROUTER_API_KEY` in renderer/preload/env — only `POST /api/vision/analyze` on backend (which adds `Authorization: Bearer` server-side). `electron-store` persists url securely. |
| **Streaming** | `visionAnalyzeStream()` → `fetch …?stream=true` with `Accept: text/event-stream`, parses `event: delta/done/meta/error` via `ReadableStream`, `AbortController` cancellable, mirrors to both main and overlay. Fallback `visionAnalyzeOnce()` if SSE fails. |
| **Movable always-on-top overlay** | Second `BrowserWindow` (`alwaysOnTop:true, frame:false, transparent:false, skipTaskbar:false, resizable:true`) created in `src/main/index.ts` (`createOverlayWindow()`), `setVisibleOnAllWorkspaces(true)`, draggable via `-webkit-app-region:drag` header in `overlay.html`. Independent `ComposeView`? No — plain HTML/JS (`overlay.ts`) listening via `ipcRenderer.on('overlay:update')`. Toggle via button, persists bounds (`store.overlay.bounds`) and `alwaysOnTop`. IPC `overlay:update` forwards streaming text from main to overlay. |

## Architecture

```
Main (src/main/index.ts, electron-store)
  ├─ desktopCapturer.getSources() ──IPC──▶ Preload (contextBridge) ──▶ Renderer (captureEngine.ts)
  │                                                      │                      ├─ getUserMedia → video → canvas@scale → diff → JPEG
  │                                                      │                      └─ POST /api/vision/analyze → SSE stream
  │                                                      │
  ├─ BrowserWindow main (1180×780, sandbox) ◀─── IPC store/overlay ──────┘
  └─ BrowserWindow overlay (360×420, frame:false, alwaysOnTop, movable)
         overlay.html + overlay.ts  ←─ipc─  main:updateOverlay()  ←─ renderer streaming
```

- `VITE_API_BASE_URL` / `store.backendUrl` points to backend (e.g., `https://…onrender.com`). No key.
- `electron-store` defaults: `intervalMs:1500, scale:0.6, quality:75, diff:3%, autoAnalyze:false`

## Dev

```bash
cd desktop
npm install
cp .env.example .env  # VITE_API_BASE_URL=http://localhost:3000 (or Render URL)
npm run dev          # Vite 5173 + tsc watch + electron . (dev)
npm run build        # tsc + vite (produces dist/renderer/index.html + overlay.html)
npm start            # electron . (after build)
npm run dist:win     # electron-builder --win (NSIS installer in release/)
```

## Packaging — Windows NSIS + Signing via GitHub Secrets

`electron-builder` in `package.json`:
- `target: nsis (x64, ia32)`, `artifactName: ${productName}-Setup-${version}-${arch}.${ext}`, `allowElevation`
- Signing: **never commit cert** — set repo Secrets:
  - `WIN_CSC_LINK` — base64 of `.pfx` (e.g., `base64 -w 0 cert.pfx`) or URL, exposed as `CSC_LINK` env
  - `WIN_CSC_KEY_PASSWORD` — pfx password (`CSC_KEY_PASSWORD`)
  - See `.github/workflows/desktop.yml` — job `build` on `windows-latest` decodes to `cert.pfx`, runs `electron-builder`, then `rm cert.pfx`.
- Icon: `build/icon.png` (512×512) — add before release (placeholder in repo).

CI: `.github/workflows/desktop.yml` + `.github/workflows/android.yml` + `ci.yml` (fast checks). Artifacts uploaded (`windows-installer`, `android-*`).

## Security Checklist

- [x] `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`
- [x] CSP headers via `session.webRequest.onHeadersReceived`
- [x] `setWindowOpenHandler` deny → `shell.openExternal`, `will-navigate` allow only localhost/file
- [x] `store` IPC whitelist (`backendUrl`, `captureConfig`, `overlay` only), URL validation
- [x] No OpenRouter key in client (grep confirms), only backend URL
- [x] Capture requires user gesture + picker; `track.onended` → re-select, `isRunning` guard
- [x] Overlay `frame:false` draggable, `alwaysOnTop` toggle, bounds persisted, no injection
```

