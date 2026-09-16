package com.aiscreenassistant.service

import com.aiscreenassistant.BuildConfig

import android.app.*
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.util.Log
import androidx.core.app.NotificationCompat
import com.aiscreenassistant.capture.*
import com.aiscreenassistant.network.AnalysisRepository
import com.aiscreenassistant.network.ApiClient
import com.aiscreenassistant.overlay.FloatingOverlayManager
import com.aiscreenassistant.util.MemoryManager
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Foreground service that HOLDS the MediaProjection token and continuous capture.
 * - OS-authorized per-session grant (user saw system dialog in MainActivity)
 * - Continues when user switches apps (foregroundServiceType=mediaProjection)
 * - Holds CaptureEngine, handles rotation, reconnection, memory limits, frame diff
 * - Hosts AnalysisRepository for streaming to backend
 * - Manages floating overlay (WindowManager) for results while in other apps
 *
 * Does NOT inject into viewed app — pixels only via ImageReader VirtualDisplay.
 */
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "ScreenCaptureService"
        const val CHANNEL_ID = "screen_capture"
        const val NOTIF_ID = 1001

        const val ACTION_START = "START"
        const val ACTION_STOP = "STOP"
        const val ACTION_UPDATE_CONFIG = "UPDATE_CONFIG"
        const val ACTION_CAPTURE_NOW = "CAPTURE_NOW"
        const val ACTION_TOGGLE_OVERLAY = "TOGGLE_OVERLAY"
        const val ACTION_PAUSE = "PAUSE"
        const val ACTION_RESUME = "RESUME"

        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        const val EXTRA_PROMPT = "prompt"
        const val EXTRA_BACKEND_URL = "backendUrl"
        const val EXTRA_MODEL = "model"

        // Singleton flows for UI binding without Binder complexity — service updates them
        val isCapturingFlow = MutableStateFlow(false)
        val isPausedFlow = MutableStateFlow(false)
        val previewBitmapFlow = MutableStateFlow<Bitmap?>(null)
        val streamingTextFlow = MutableStateFlow("")
        val isStreamingFlow = MutableStateFlow(false)
        val lastDiffFlow = MutableStateFlow(0f)
        val queueSizeFlow = MutableStateFlow(0)
        val skippedFlow = MutableStateFlow(0)
        val fpsFlow = MutableStateFlow(0f)
        val errorFlow = MutableStateFlow<String?>(null)
        val healthFlow = MutableStateFlow("unknown")
        val backendUrlFlow = MutableStateFlow(BuildConfig.BACKEND_URL)

        // For binder-less access
        var instance: ScreenCaptureService? = null
            private set
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var mediaProjection: MediaProjection? = null
    private var mediaProjectionManager: MediaProjectionManager? = null
    private var captureEngine: CaptureEngine? = null
    private var projectionHelper: MediaProjectionHelper? = null
    private var analysisRepo: AnalysisRepository? = null
    private var overlayManager: FloatingOverlayManager? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    private var currentConfig = CaptureConfig()
    private var currentPrompt: String = "Describe what's on this screen and help the user concisely."
    private var currentModel: String? = null

    private var isPaused = false
    private val binder = LocalBinder()

    inner class LocalBinder : Binder() {
        fun getService(): ScreenCaptureService = this@ScreenCaptureService
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        mediaProjectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionHelper = MediaProjectionHelper(this)
        overlayManager = FloatingOverlayManager(this).apply {
            onStopCapture = { stopCapture() }
        }
        analysisRepo = AnalysisRepository(
            apiClientProvider = { ApiClient(backendUrlFlow.value.trimEnd('/')) },
            scope = serviceScope
        )
        createChannel()
        registerDisplayListener()
        // Observe repo flows and forward to singleton flows + overlay
        serviceScope.launch {
            analysisRepo!!.streamingText.collect { txt ->
                streamingTextFlow.value = txt
                overlayManager?.updateContent(txt, isStreamingFlow.value)
            }
        }
        serviceScope.launch {
            analysisRepo!!.isStreaming.collect {
                isStreamingFlow.value = it
                updateNotification()
                overlayManager?.isStreaming = it
            }
        }
        Log.i(TAG, "service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        Log.i(TAG, "onStartCommand $action")
        when (action) {
            ACTION_START -> {
                val rc = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
                val prompt = intent.getStringExtra(EXTRA_PROMPT)
                val backend = intent.getStringExtra(EXTRA_BACKEND_URL)
                val model = intent.getStringExtra(EXTRA_MODEL)
                if (prompt != null) currentPrompt = prompt
                if (backend != null) backendUrlFlow.value = backend
                currentModel = model
                if (rc == Activity.RESULT_OK && data != null) startCapture(rc, data) else {
                    errorFlow.value = "Missing MediaProjection data — re-authorize"
                }
            }
            ACTION_STOP -> stopCapture()
            ACTION_PAUSE -> pauseCapture()
            ACTION_RESUME -> resumeCapture()
            ACTION_CAPTURE_NOW -> triggerSingleCapture()
            ACTION_UPDATE_CONFIG -> {
                // Config via intent extras as JSON? For simplicity, binder method used from Activity, but handle broadcast
                // no-op here — Activity calls service.updateConfig directly via binder
            }
            ACTION_TOGGLE_OVERLAY -> toggleOverlay()
            else -> {
                // If restarted by system with no action but was capturing, try to keep foreground
                if (isCapturingFlow.value) startForegroundWithNotification("Capture active")
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        stopCaptureInternal()
        serviceScope.cancel()
        try { displayListener?.let { (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(it) } } catch (_:Exception){}
        overlayManager?.hide()
        instance = null
        super.onDestroy()
    }

    // Public API for Activity via binder
    fun updateConfig(newConfig: CaptureConfig) {
        currentConfig = newConfig.validate()
        captureEngine?.updateConfig(currentConfig)
        Log.i(TAG, "config updated $currentConfig")
        updateNotification()
    }

    fun updatePrompt(prompt: String) { currentPrompt = prompt }
    fun updateBackendUrl(url: String) { backendUrlFlow.value = url.trimEnd('/'); checkHealth() }
    fun updateModel(model: String?) { currentModel = model?.ifBlank { null } }

    fun getConfig(): CaptureConfig = currentConfig

    fun toggleOverlay() {
        if (overlayManager?.isVisible() == true) overlayManager?.hide() else {
            if (overlayManager?.canShow() == true) {
                overlayManager?.show()
                overlayManager?.updateContent(streamingTextFlow.value, isStreamingFlow.value)
            } else {
                errorFlow.value = "Overlay permission needed — grant in Settings"
            }
        }
    }

    fun isOverlayVisible(): Boolean = overlayManager?.isVisible() == true
    fun canShowOverlay(): Boolean = overlayManager?.canShow() == true

    private fun startCapture(resultCode: Int, data: Intent) {
        if (isCapturingFlow.value) {
            Log.w(TAG, "already capturing — restarting")
            stopCaptureInternal()
        }
        try {
            mediaProjection = mediaProjectionManager?.getMediaProjection(resultCode, data)
            if (mediaProjection == null) {
                errorFlow.value = "Failed to obtain MediaProjection"
                return
            }
            // Register stop callback
            mediaProjection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.w(TAG, "MediaProjection stopped by OS")
                    serviceScope.launch(Dispatchers.Main) {
                        errorFlow.value = "Capture ended — please re-authorize (OS revoked)"
                        stopCaptureInternal()
                    }
                }
            }, Handler(Looper.getMainLooper()))

            startForegroundWithNotification("Capture starting…")

            captureEngine = CaptureEngine(
                context = this,
                mediaProjection = mediaProjection!!,
                config = currentConfig,
                projectionHelper = projectionHelper!!,
                scope = serviceScope
            ).apply {
                onFrameReady = { jpeg, w, h, diff ->
                    queueSizeFlow.value = this@apply.queueSize.value
                    // Forward to analysis if autoAnalyze enabled, else just preview
                    serviceScope.launch {
                        if (currentConfig.autoAnalyze) {
                            // Send to backend
                            // Decrement queue after send
                            analysisRepo?.analyze(jpeg, currentPrompt, currentModel,
                                onDelta = {},
                                onDone = { result ->
                                    streamingTextFlow.value = result
                                    overlayManager?.updateContent(result, false)
                                    queueSizeFlow.value = this@apply.queueSize.value
                                    fpsFlow.value = this@apply.fps.value
                                }
                            )
                            // We track queue internally; engine's queueSize flow drives UI, but analysis is async
                            // To keep engine queueSize accurate, mark consumed after dispatch (optimistic)
                            // Better: mark consumed after analysis finishes — for now immediate
                            // We'll let engine's markQueueConsumed called after analysis dispatch
                            // Simulate:
                            delay(50)
                            this@apply.markQueueConsumed()
                        } else {
                            // Not auto — keep preview but not send; still mark consumed to free queue
                            this@apply.markQueueConsumed()
                        }
                    }
                }
                onPreviewFrame = { bmp ->
                    // Keep preview throttled — post to flow (recycle previous)
                    val prev = previewBitmapFlow.value
                    try { prev?.recycle() } catch (_:Exception){}
                    previewBitmapFlow.value = bmp
                }
            }

            // Collect engine flows
            serviceScope.launch {
                captureEngine!!.fps.collect { fpsFlow.value = it; updateNotification() }
            }
            serviceScope.launch {
                captureEngine!!.lastDiffPercent.collect { lastDiffFlow.value = it }
            }
            serviceScope.launch {
                captureEngine!!.skippedFrames.collect { skippedFlow.value = it }
            }
            serviceScope.launch {
                captureEngine!!.queueSize.collect { queueSizeFlow.value = it }
            }
            serviceScope.launch {
                captureEngine!!.lastError.collect { errorFlow.value = it }
            }

            val started = captureEngine!!.start()
            if (!started) {
                errorFlow.value = "Failed to start capture engine"
                stopCaptureInternal()
                return
            }

            isCapturingFlow.value = true
            isPausedFlow.value = false
            errorFlow.value = null
            startForegroundWithNotification(buildNotificationText())
            checkHealth()
            Log.i(TAG, "capture started ${currentConfig.intervalMs}ms scale ${currentConfig.scaleFactor}")

        } catch (e: Exception) {
            Log.e(TAG, "startCapture failed", e)
            errorFlow.value = e.message
            stopCaptureInternal()
        }
    }

    private fun stopCapture() {
        serviceScope.launch(Dispatchers.Main) { stopCaptureInternal(); stopSelf() }
    }

    private fun stopCaptureInternal() {
        captureEngine?.stop()
        captureEngine = null
        try { mediaProjection?.stop() } catch (_:Exception){}
        mediaProjection = null
        isCapturingFlow.value = false
        isPausedFlow.value = false
        fpsFlow.value = 0f
        // Keep preview bitmap? Clear after stop? Keep last
        // Don't hide overlay automatically — user may want results visible
        stopForeground(STOP_FOREGROUND_REMOVE)
        updateNotification(isClear = true)
        Log.i(TAG, "capture stopped")
    }

    private fun pauseCapture() {
        if (!isCapturingFlow.value || isPaused) return
        isPaused = true
        isPausedFlow.value = true
        captureEngine?.stop() // pause by stopping loop but keeping MediaProjection alive?
        // Alternative: keep engine but skip captures? For simplicity stop engine, keep projection.
        // We keep projection token alive.
        // To resume we recreate engine with same projection.
        startForegroundWithNotification("Paused — tap Resume")
        Log.i(TAG, "paused")
    }

    private fun resumeCapture() {
        if (!isCapturingFlow.value || !isPaused) return
        isPaused = false
        isPausedFlow.value = false
        // Recreate engine
        mediaProjection?.let { mp ->
            captureEngine = CaptureEngine(this, mp, currentConfig, projectionHelper!!, serviceScope).apply {
                onFrameReady = captureEngine?.onFrameReady
                onPreviewFrame = captureEngine?.onPreviewFrame
            }
            // Re-collect?
            serviceScope.launch { captureEngine!!.fps.collect { fpsFlow.value = it } }
            captureEngine?.start()
            startForegroundWithNotification(buildNotificationText())
        }
        Log.i(TAG, "resumed")
    }

    private fun triggerSingleCapture() {
        if (!isCapturingFlow.value) {
            errorFlow.value = "Not capturing — start capture first"
            return
        }
        serviceScope.launch {
            try {
                val helper = projectionHelper ?: return@launch
                val mp = mediaProjection ?: return@launch
                val jpeg = helper.captureSingleFrame(mp, currentConfig.scaleFactor, currentConfig.jpegQuality)
                // Direct analyze regardless of diff
                analysisRepo?.analyze(jpeg, currentPrompt, currentModel)
            } catch (e: Exception) {
                errorFlow.value = "Single capture failed: ${e.message}"
            }
        }
    }

    fun analyzeCurrentFrame(prompt: String? = null, jpegBytes: ByteArray? = null) {
        val p = prompt ?: currentPrompt
        val jpeg = jpegBytes ?: run {
            // If no jpeg provided, trigger single capture then analyze
            triggerSingleCapture()
            return
        }
        analysisRepo?.analyze(jpeg, p, currentModel)
    }

    fun cancelAnalysis() { analysisRepo?.cancel() }
    fun clearAnalysis() { analysisRepo?.clear(); streamingTextFlow.value = "" }

    private fun checkHealth() {
        serviceScope.launch {
            try {
                val client = ApiClient(backendUrlFlow.value)
                val h = client.health()
                healthFlow.value = "${h.status} · OpenRouter:${h.checks.openrouter}"
            } catch (e: Exception) {
                healthFlow.value = "unreachable: ${e.message?.take(40)}"
            }
        }
    }

    private fun buildNotificationText(): String {
        val cfg = currentConfig
        val fps = "%.1f".format(fpsFlow.value)
        val diff = "%.1f%%".format(lastDiffFlow.value)
        val pause = if (isPaused) "Paused · " else ""
        return pause + "Capturing ${cfg.intervalMs}ms · ${cfg.scaleFactor*100}% · diff $diff · ${fps}fps"
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Screen Capture", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Holds OS-authorized screen capture (MediaProjection)"
                setShowBadge(false)
            }
            (getSystemService(NotificationManager::class.java)).createNotificationChannel(ch)
        }
    }

    private fun startForegroundWithNotification(content: String, isClear: Boolean = false) {
        if (isClear) return
        val notif = buildNotification(content)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(content: String): Notification {
        val stopIntent = PendingIntent.getService(this, 1, Intent(this, ScreenCaptureService::class.java).apply { action = ACTION_STOP }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val pauseIntent = PendingIntent.getService(this, 2, Intent(this, ScreenCaptureService::class.java).apply { action = if (isPaused) ACTION_RESUME else ACTION_PAUSE }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val captureNowIntent = PendingIntent.getService(this, 3, Intent(this, ScreenCaptureService::class.java).apply { action = ACTION_CAPTURE_NOW }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val mainIntent = PendingIntent.getActivity(this, 0, Intent(this, com.aiscreenassistant.MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AI Screen Assistant — Capturing")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(mainIntent)
            .addAction(android.R.drawable.ic_media_pause, if (isPaused) "Resume" else "Pause", pauseIntent)
            .addAction(android.R.drawable.ic_menu_camera, "Capture Now", captureNowIntent)
            .addAction(android.R.drawable.ic_delete, "Stop", stopIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }

    private fun updateNotification(isClear: Boolean = false) {
        if (!isCapturingFlow.value || isClear) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try { nm.notify(NOTIF_ID, buildNotification(buildNotificationText())) } catch (_:Exception){}
    }

    private fun registerDisplayListener() {
        val dm = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) {
                Log.i(TAG, "display changed $displayId")
                // Rotation/size changed -> tell engine to recreate
                captureEngine?.handleRotation()
            }
        }
        displayListener = listener
        dm.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
    }

    // Memory trim callback — throttle quality if system low
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            Log.w(TAG, "onTrimMemory $level — low memory, throttling")
            if (currentConfig.jpegQuality > 55) {
                updateConfig(currentConfig.copy(jpegQuality = 55))
                errorFlow.value = "Low memory — quality throttled to 55"
            }
            MemoryManager.logMemory(TAG)
        }
    }
}
