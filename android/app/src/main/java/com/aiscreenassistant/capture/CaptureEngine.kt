package com.aiscreenassistant.capture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.aiscreenassistant.util.MemoryManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Continuous capture engine — OS-authorized, independent from viewed app.
 *
 * - Holds one VirtualDisplay + ImageReader for the lifetime of the session
 * - Polls frames at configurable interval (500ms–10s)
 * - Frame-change detection via FrameDiffer (saves bandwidth/backend)
 * - Adaptive scaling/compression, memory caps, rotation handling, reconnection
 * - Exposes StateFlows for UI and callback for selected frames
 *
 * Does NOT inject into target app — pixels from compositor only.
 */
class CaptureEngine(
    private val context: Context,
    private val mediaProjection: MediaProjection,
    private var config: CaptureConfig,
    private val projectionHelper: MediaProjectionHelper,
    private val scope: CoroutineScope
) {
    companion object { private const val TAG = "CaptureEngine" }

    private var imageReader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null

    private val differ = FrameDiffer(config.diffThresholdPercent)
    private val isRunning = AtomicBoolean(false)
    private var captureJob: Job? = null

    // Stats for UI
    private val _fps = MutableStateFlow(0f)
    val fps: StateFlow<Float> = _fps
    private val _lastDiffPercent = MutableStateFlow(0f)
    val lastDiffPercent: StateFlow<Float> = _lastDiffPercent
    private val _skippedFrames = MutableStateFlow(0)
    val skippedFrames: StateFlow<Int> = _skippedFrames
    private val _queueSize = MutableStateFlow(0)
    val queueSize: StateFlow<Int> = _queueSize
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private var consecutiveErrors = 0
    private var framesThisSecond = 0
    private var secondStartMs = System.currentTimeMillis()

    // Callback for frames that passed diff + memory checks
    var onFrameReady: ((jpegBytes: ByteArray, width: Int, height: Int, diffPercent: Float) -> Unit)? = null
    var onPreviewFrame: ((bitmap: Bitmap) -> Unit)? = null // for live preview (throttled)

    private var currentWidth = 0
    private var currentHeight = 0
    private var currentDensity = 0

    @Volatile private var needsRecreate = false

    fun updateConfig(newConfig: CaptureConfig) {
        val validated = newConfig.validate()
        val scaleChanged = validated.scaleFactor != config.scaleFactor
        val intervalChanged = validated.intervalMs != config.intervalMs
        config = validated
        differ.setThreshold(config.diffThresholdPercent)
        if (scaleChanged && isRunning.get()) {
            Log.i(TAG, "config scale changed ${validated.scaleFactor} -> recreating display")
            scope.launch { recreateDisplay() }
        }
        if (intervalChanged) {
            // capture loop will pick up new interval on next iteration
        }
    }

    fun start(): Boolean {
        if (isRunning.getAndSet(true)) {
            Log.w(TAG, "already running")
            return false
        }
        try {
            createDisplay()
            startCaptureLoop()
            Log.i(TAG, "started ${currentWidth}x${currentHeight} @${config.intervalMs}ms scale=${config.scaleFactor}")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "start failed", e)
            _lastError.value = e.message
            isRunning.set(false)
            return false
        }
    }

    fun stop() {
        if (!isRunning.getAndSet(false)) return
        captureJob?.cancel()
        captureJob = null
        releaseDisplay()
        differ.reset()
        _fps.value = 0f
        Log.i(TAG, "stopped")
    }

    fun handleRotation() {
        if (!isRunning.get()) return
        Log.i(TAG, "rotation detected -> recreate")
        scope.launch { recreateDisplay() }
    }

    private fun createDisplay() {
        val info = projectionHelper.getScaledInfo(config.scaleFactor)
        currentWidth = info.width
        currentHeight = info.height
        currentDensity = info.densityDpi

        handlerThread = HandlerThread("CaptureEngineReader").apply { start() }
        handler = Handler(handlerThread!!.looper)

        // Use maxImages 2 to keep memory low — we acquireLatest
        imageReader = ImageReader.newInstance(currentWidth, currentHeight, PixelFormat.RGBA_8888, 2).apply {
            // We'll poll via acquireLatestImage in loop, not via listener, to control rate.
            // Listener optional for wake-up, but we poll by interval.
        }

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "AIScreenAssistant",
            currentWidth, currentHeight, currentDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface, null, handler
        )
        Log.i(TAG, "VirtualDisplay created ${currentWidth}x${currentHeight} dpi=$currentDensity")

        // Register callback for projection stop (reconnection)
        try {
            mediaProjection.registerCallback(object: MediaProjection.Callback() {
                override fun onStop() {
                    Log.w(TAG, "MediaProjection onStop -> needs re-auth")
                    _lastError.value = "MediaProjection stopped — re-authorize"
                    scope.launch { stop() }
                }
            }, handler)
        } catch (e: Exception) { Log.w(TAG, "registerCallback failed", e) }
    }

    private fun releaseDisplay() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try {
            handlerThread?.quitSafely()
            handlerThread?.join(1000)
        } catch (_: Exception) {}
        handlerThread = null
        handler = null
    }

    private suspend fun recreateDisplay() {
        releaseDisplay()
        // Brief delay for display to settle after rotation
        delay(350)
        if (!isRunning.get()) return
        try {
            createDisplay()
            consecutiveErrors = 0
            _lastError.value = null
        } catch (e: Exception) {
            Log.e(TAG, "recreate failed", e)
            _lastError.value = e.message
            // Exponential backoff retry (max 3)
            if (consecutiveErrors++ < 3) {
                delay((500L shl consecutiveErrors).coerceAtMost(4000L))
                if (isRunning.get()) recreateDisplay()
            }
        }
    }

    private fun startCaptureLoop() {
        captureJob = scope.launch(Dispatchers.Default) {
            var lastPreviewMs = 0L
            while (isActive && isRunning.get()) {
                val interval = config.intervalMs
                try {
                    // Memory guard — throttle if low
                    if (MemoryManager.shouldThrottleCapture(context, config.maxMemoryMB)) {
                        Log.w(TAG, "low memory — throttling capture, skipping frame")
                        _lastError.value = "Low memory — throttled"
                        delay(interval * 2)
                        continue
                    }

                    val jpeg = captureOneFrame() // may return null if no new image
                    if (jpeg != null) {
                        // FPS stats
                        framesThisSecond++
                        val now = System.currentTimeMillis()
                        if (now - secondStartMs >= 1000) {
                            _fps.value = framesThisSecond * 1000f / (now - secondStartMs)
                            framesThisSecond = 0
                            secondStartMs = now
                        }

                        // Differ check on decoded bitmap (we already have bitmap for diff)
                        // captureOneFrame returns jpeg + diff already evaluated; but we delegate diff to inside captureOneFrame for efficiency
                        // Instead captureOneFrame does diff and returns null if not changed (when enabled)
                        // So if we have jpeg, it's passed.

                        // Queue size guard
                        if (_queueSize.value >= config.maxQueueSize) {
                            Log.d(TAG, "queue full (${config.maxQueueSize}) — drop frame")
                            _skippedFrames.value += 1
                        } else {
                            _queueSize.value += 1
                            // Preview throttled to ~2fps to save UI
                            if (now - lastPreviewMs > 500) {
                                lastPreviewMs = now
                                // Decode small preview bitmap for UI (avoid holding jpeg decode twice)
                                try {
                                    val previewBmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
                                    if (previewBmp != null) {
                                        onPreviewFrame?.invoke(previewBmp)
                                        // Caller should not recycle; we manage? Let caller copy or display then recycle? We'll not recycle here.
                                    }
                                } catch (_: Exception) {}
                            }
                            onFrameReady?.invoke(jpeg, currentWidth, currentHeight, _lastDiffPercent.value)
                            // queueSize decremented by consumer (AnalysisRepository) after send
                        }
                        consecutiveErrors = 0
                        _lastError.value = null
                    } else {
                        // No new image or diff skipped — still count as skipped?
                        // not error, just no change
                    }
                } catch (e: CancellationException) { throw e }
                catch (e: OutOfMemoryError) {
                    Log.e(TAG, "OOM during capture", e)
                    System.gc()
                    _lastError.value = "Out of memory — lowering quality"
                    // Auto-lower quality temporarily
                    config = config.copy(jpegQuality = (config.jpegQuality - 10).coerceAtLeast(45))
                    differ.reset()
                    delay(2000)
                } catch (e: Exception) {
                    Log.e(TAG, "capture iteration failed", e)
                    _lastError.value = e.message
                    consecutiveErrors++
                    if (consecutiveErrors >= 5) {
                        Log.e(TAG, "too many consecutive errors — recreating display")
                        withContext(Dispatchers.Main) { delay(500); recreateDisplay() }
                        consecutiveErrors = 0
                    }
                }

                delay(interval)
            }
        }
    }

    /**
     * Acquires latest image, converts to bitmap, handles padding, scales, runs differ, compresses.
     * Returns jpeg bytes if frame should be sent, else null (no change / no image).
     */
    private suspend fun captureOneFrame(): ByteArray? = suspendCancellableCoroutine { cont ->
        val reader = imageReader
        if (reader == null) {
            cont.resume(null); return@suspendCancellableCoroutine
        }

        // Try acquireLatestImage immediately (non-blocking) — we control rate via loop
        var image: android.media.Image? = null
        try {
            // We try to get image; if none, we wait up to 80ms for one via listener-style wait
            image = reader.acquireLatestImage()
            if (image == null) {
                // No new frame yet — return null (not an error)
                cont.resume(null); return@suspendCancellableCoroutine
            }

            val planes = image.planes
            val buffer: ByteBuffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * currentWidth

            // Create bitmap from buffer (handle stride)
            val fullWidth = currentWidth + rowPadding / pixelStride
            val bitmap = Bitmap.createBitmap(fullWidth, currentHeight, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(buffer)
            val cropped = if (fullWidth != currentWidth) {
                val c = Bitmap.createBitmap(bitmap, 0, 0, currentWidth, currentHeight)
                bitmap.recycle()
                c
            } else bitmap

            // Frame diff check (before heavy JPEG compress) — use cropped
            var shouldSend = true
            var diffPercent = 100f
            if (config.enableFrameDiff) {
                val (send, diff) = differ.shouldSend(cropped)
                shouldSend = send
                diffPercent = diff
                _lastDiffPercent.value = diff
                if (!shouldSend) {
                    _skippedFrames.value += 1
                    cropped.recycle()
                    image.close()
                    cont.resume(null); return@suspendCancellableCoroutine
                }
            } else {
                _lastDiffPercent.value = 100f
            }

            // Scale already done via display size; but handle rotation correction if needed (display rotation already baked)
            // Compress efficiently with BitmapUtils (handles OOM and size cap)
            val jpeg = try {
                BitmapUtils.compressJpeg(cropped, config.jpegQuality)
            } finally {
                cropped.recycle()
            }

            // Memory check after compress
            image.close()
            cont.resume(jpeg)

        } catch (e: Exception) {
            try { image?.close() } catch (_: Exception) {}
            cont.resumeWithException(e)
        } catch (e: OutOfMemoryError) {
            try { image?.close() } catch (_: Exception) {}
            System.gc()
            cont.resumeWithException(RuntimeException("OOM capture: ${e.message}", e))
        }
    }

    fun markQueueConsumed() {
        // Called by repository after frame sent (success or fail) to decrement queueSize
        _queueSize.value = (_queueSize.value - 1).coerceAtLeast(0)
    }

    fun resetStats() {
        _skippedFrames.value = 0
        _lastDiffPercent.value = 0f
        _fps.value = 0f
        differ.reset()
    }
}
