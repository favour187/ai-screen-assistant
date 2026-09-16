package com.aiscreenassistant

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.lifecycle.lifecycleScope
import com.aiscreenassistant.capture.CaptureConfig
import com.aiscreenassistant.capture.MediaProjectionHelper
import com.aiscreenassistant.service.ScreenCaptureService
import com.aiscreenassistant.ui.AppUi
import com.aiscreenassistant.ui.AssistantViewModel
import com.aiscreenassistant.util.PermissionUtils
import kotlinx.coroutines.launch

/**
 * MainActivity — Jetpack Compose + MediaProjection + Foreground Service + Floating Overlay
 *
 * Security/isolation:
 * - Only OS-provided MediaProjection (system dialog per session) — no injection into viewed app
 * - Capture via CaptureEngine (VirtualDisplay + ImageReader) independent from target app
 * - Foreground service continues when user switches apps (OS-controlled lifetime)
 * - Floating overlay uses WindowManager TYPE_APPLICATION_OVERLAY — requires Settings.canDrawOverlays()
 * - OpenRouter key never in APK — all AI via backend (backendUrl)
 */
class MainActivity : ComponentActivity() {

    private val viewModel: AssistantViewModel by viewModels()
    private lateinit var projectionHelper: MediaProjectionHelper
    private var captureService: ScreenCaptureService? = null
    private var isBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as ScreenCaptureService.LocalBinder
            captureService = binder.getService()
            isBound = true
            viewModel.onServiceConnected(captureService!!)
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            captureService = null
            isBound = false
        }
    }

    private val captureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val prompt = viewModel.prompt.value
            val backend = viewModel.backendUrl.value
            val model = viewModel.model.value.ifBlank { null }
            val startIntent = Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_START
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_DATA, result.data)
                putExtra(ScreenCaptureService.EXTRA_PROMPT, prompt)
                putExtra(ScreenCaptureService.EXTRA_BACKEND_URL, backend)
                putExtra(ScreenCaptureService.EXTRA_MODEL, model)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(startIntent) else startService(startIntent)
            // Bind to get updates
            bindToService()
            Toast.makeText(this, "Capture authorized — starting foreground service", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "Screen capture permission denied", Toast.LENGTH_SHORT).show()
        }
    }

    private val overlayLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (PermissionUtils.canDrawOverlays(this)) {
            captureService?.toggleOverlay()
            Toast.makeText(this, "Overlay permission granted", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "Overlay permission required for floating results", Toast.LENGTH_LONG).show()
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // No-op — foreground service will still work, but notification may be hidden on Android 13+ if denied
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        projectionHelper = MediaProjectionHelper(this)
        // Load Direct AI prefs (Featherless/OpenRouter fallback) — stored locally
        viewModel.loadDirectPrefs(this)

        // Request notification permission on Android 13+
        if (Build.VERSION.SDK_INT >= 33) {
            notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            MaterialTheme {
                AppUi(
                    viewModel = viewModel,
                    onRequestCapture = { requestCapture() },
                    onStopCapture = { stopCapture() },
                    onPauseResume = { togglePause() },
                    onCaptureNow = { triggerCaptureNow() },
                    onAnalyze = { viewModel.analyzeCurrentFrame() },
                    onRequestOverlay = { requestOverlay() },
                    onToggleOverlay = { captureService?.toggleOverlay() ?: Toast.makeText(this, "Start capture first", Toast.LENGTH_SHORT).show() },
                    onConfigChange = { newConfig -> viewModel.setConfig(newConfig) }
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        bindToService()
        viewModel.checkHealth()
    }

    override fun onStop() {
        super.onStop()
        // Keep service alive when user switches apps (foreground service) — only unbind, don't stop
        if (isBound) {
            try { unbindService(serviceConnection) } catch (_: Exception) {}
            isBound = false
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Don't stop service here — let user explicitly stop via Stop button or notification.
        // Service will continue when app is in background (foreground).
    }

    private fun bindToService() {
        try {
            val intent = Intent(this, ScreenCaptureService::class.java)
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        } catch (_: Exception) {}
    }

    private fun requestCapture() {
        // Ensure notification permission before starting? Not blocking
        try {
            captureLauncher.launch(projectionHelper.createScreenCaptureIntent())
        } catch (e: Exception) {
            Toast.makeText(this, "Failed to launch capture dialog: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun stopCapture() {
        val intent = Intent(this, ScreenCaptureService::class.java).apply { action = ScreenCaptureService.ACTION_STOP }
        startService(intent)
        Toast.makeText(this, "Capture stopped", Toast.LENGTH_SHORT).show()
    }

    private fun togglePause() {
        val svc = captureService ?: return
        val action = if (ScreenCaptureService.isPausedFlow.value) ScreenCaptureService.ACTION_RESUME else ScreenCaptureService.ACTION_PAUSE
        startService(Intent(this, ScreenCaptureService::class.java).apply { this.action = action })
    }

    private fun triggerCaptureNow() {
        startService(Intent(this, ScreenCaptureService::class.java).apply { action = ScreenCaptureService.ACTION_CAPTURE_NOW })
    }

    private fun requestOverlay() {
        if (PermissionUtils.canDrawOverlays(this)) {
            captureService?.toggleOverlay()
        } else {
            try {
                overlayLauncher.launch(PermissionUtils.overlayPermissionIntent(packageName))
            } catch (e: Exception) {
                // Fallback to settings
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
            }
        }
    }
}
