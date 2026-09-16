# Android — Kotlin + Jetpack Compose + MediaProjection (Complete)

Production-grade, OS-authorized screen assistant. **No injection, no hooking, no AccessibilityService.**

## Isolation Guarantee

- **Only** `MediaProjectionManager.createScreenCaptureIntent()` → system consent dialog (per-session) → `MediaProjection` → `ImageReader` + `VirtualDisplay` (pixels from OS compositor).
- No `AccessibilityService`, no overlay injection into target app, no app-internal IPC.
- All AI via `POST /api/vision/analyze` on backend — `OPENROUTER_API_KEY` never in APK.
- Verified: `AndroidManifest.xml` requests only `INTERNET` + `FOREGROUND_SERVICE*` + optional `SYSTEM_ALERT_WINDOW` for floating results.

## Architecture — Continues When User Switches Apps

```
MainActivity (Compose) ──bind──▶ ScreenCaptureService (foreground, type=mediaProjection)
      │                               │  ├── MediaProjection (user grant, hold token)
      │                               │  ├── CaptureEngine (VirtualDisplay + ImageReader @ scale)
      │                               │  │     ├─ ticker at config.intervalMs (500–5000ms)
      │                               │  │     ├─ FrameDiffer (32×32 luma, threshold %)
      │                               │  │     ├─ BitmapUtils (scale + JPEG q40–95, <1.8MB, OOM-safe)
      │                               │  │     └─ rotation listener → recreate display
      │                               │  ├── AnalysisRepository → ApiClient → backend SSE stream
      │                               │  ├── FloatingOverlayManager (WindowManager TYPE_APPLICATION_OVERLAY)
      │                               │  ├── DisplayManager.DisplayListener (rotation)
      │                               │  └── Notification (Pause/Resume/Capture Now/Stop)
      │                               │
      └─ AssistantViewModel ◀──────────┘  (StateFlows: fps/diff/queue/skipped/preview/stream)
              │
         AppUi (Compose)
           ├─ Live preview (throttled 2fps)
           ├─ Tuning: interval, scale, quality, diff threshold, frame-diff toggle, auto-analyze
           ├─ Floating overlay toggle + permission
           └─ Streaming response card + stats
```

**Lifecycle:** `MainActivity` binds `ScreenCaptureService` on `onStart()`, unbinds on `onStop()` — service stays foreground when app in background, so capture continues after app switch. `MediaProjection.Callback.onStop()` triggers re-auth prompt. `onTrimMemory()` throttles quality.

## Complete Feature List

| Requirement | Implementation |
|---|---|
| **MediaProjection + user authorization + foreground service** | `MediaProjectionHelper.createScreenCaptureIntent()` → `registerForActivityResult` → `ScreenCaptureService.ACTION_START` with `resultCode+data` → `startForeground(..., FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)` |
| **Capture independent from viewed app** | `VirtualDisplay` flag `AUTO_MIRROR` + `ImageReader` surface; no target-app package checks, no hooking. Commented in every file. |
| **Frame-change detection** | `FrameDiffer` downscales to 32×32, luma diff >15 per pixel, percent vs `diffThresholdPercent` (0.5–20%). Skips duplicates, updates `skippedFlow`, exposes `lastDiff%`. Tunable in UI. |
| **Configurable capture rate/resolution** | `CaptureConfig(intervalMs 500–10000, scaleFactor 0.3–1.0, jpegQuality 40–95)` — sliders live-update `CaptureEngine` (recreates display on scale change, interval picked on next tick). |
| **Efficient image compression** | `BitmapUtils.compressJpeg()` caps at 1.8MB, adaptive fallback quality, pooling `ByteArrayOutputStream`, `scale()` with Matrix, `recycle()` intermediates. |
| **Reconnection** | `MediaProjection.Callback.onStop()` → `errorFlow` → UI re-auth banner; `CaptureEngine.recreateDisplay()` with exponential backoff (500→4000ms, 3 tries) on `consecutiveErrors>=5` or rotation. |
| **Lifecycle handling** | Service `onCreate`/`onDestroy` manages `serviceScope`, `DisplayListener`, overlay; Activity `ServiceConnection` syncs config on `onServiceConnected`; `isCapturingFlow` survives rotation via ViewModel. |
| **Rotation handling** | `DisplayManager.DisplayListener.onDisplayChanged` → `captureEngine.handleRotation()` → `releaseDisplay()` → `delay(350)` → `createDisplay()` with new `DisplayMetrics`. `Activity.configChanges=orientation|screenSize|density` avoids recreate. |
| **Memory limits** | `MemoryManager.shouldThrottleCapture()` checks `availMem <120MB` or `heapUsed>85% max`; `BitmapUtils` estimate + `onTrimMemory(TRIM_MEMORY_RUNNING_LOW)` auto-drops quality to 55, `ImageReader` maxImages=2, `queueSize` capped (1–5), bitmap `recycle()` after compress, preview throttled. |
| **Floating result interface** | `FloatingOverlayManager` uses `WindowManager` `TYPE_APPLICATION_OVERLAY` (requires `Settings.canDrawOverlays()` permission). Draggable bubble (56dp) ↔ expandable card (340dp) with streaming text, `LinearProgressIndicator`, minimize/stop. Works when user in other apps. Permission flow via `Settings.ACTION_MANAGE_OVERLAY_PERMISSION`. |
| **Send selected frames + stream back** | `CaptureEngine.onFrameReady` → `AnalysisRepository.analyze()` (base64 data URL → `ApiClient.visionAnalyzeStream()` SSE `Flow<String>` → collector appends `delta`). Auto mode sends every changed frame; manual via “Analyze” button. Fallback to `visionAnalyze(multipart)` if SSE fails. |
| **Continue when switching apps** | Foreground service (`stopWithTask=false`, ongoing notification with actions) keeps `MediaProjection` alive. Test: start capture → press Home → open other app → notification stays, overlay shows stream, frames keep flowing until OS revokes or user stops. Respects OS limits (MediaProjection revoked on screen off/user switch profile). |

## Build

```bash
./gradlew :app:assembleDebug      # or assembleRelease (minify + proguard keeps protocol)
# In Android Studio: Open android/ folder, Sync Gradle, Run on device (API 26+, grant overlay if desired)
# backendUrl default https://ai-screen-assistant.onrender.com — change in UI or use 10.0.2.2:3000 for emulator
```

`minSdk 26`, `compileSdk 34`, Kotlin 1.9.22, Compose BOM 2024.06.00, OkHttp 4.12, Coroutines 1.8, Serialization 1.7.

## Permissions

Required: `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS` (Android 13+).  
Optional: `SYSTEM_ALERT_WINDOW` (only if user enables floating overlay; app works without it).

## Backend Contract

Mirrors `shared/src/protocol.ts` (Kotlin `protocol/Protocol.kt`): `POST /api/vision/analyze` JSON `{"prompt","imageBase64":"data:image/jpeg;base64,...","model","stream":true}` → SSE `event: delta {delta} → done`. Health `GET /health`.

## Testing Isolation

1. Grant capture → open Banking app → assistant captures pixels but cannot read view hierarchy (try with Layout Inspector — no cross-app nodes).
2. Switch apps → capture continues (notification + overlay).
3. Rotate device → preview updates, VirtualDisplay recreates (logcat `CaptureEngine VirtualDisplay created`).
4. Lock screen or revoke → `errorFlow` shows “MediaProjection stopped — re-authorize”.

<!-- trigger ci Wed Sep 16 00:41:01 UTC 2026 -->
