package com.aiscreenassistant.ui

import com.aiscreenassistant.BuildConfig

import android.content.Context
import android.graphics.Bitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.aiscreenassistant.capture.CaptureConfig
import com.aiscreenassistant.network.ApiClient
import com.aiscreenassistant.network.DirectAiPrefs
import com.aiscreenassistant.service.ScreenCaptureService
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Holds UI state and bridges to ScreenCaptureService singleton flows.
 * Survives rotation and activity recreation.
 */
class AssistantViewModel : ViewModel() {

    // Editable UI state
    private val _backendUrl = MutableStateFlow(BuildConfig.BACKEND_URL)
    val backendUrl: StateFlow<String> = _backendUrl

    private val _prompt = MutableStateFlow("Describe what's on this screen and help the user concisely.")
    val prompt: StateFlow<String> = _prompt

    private val _model = MutableStateFlow("")
    val model: StateFlow<String> = _model

    private val _config = MutableStateFlow(CaptureConfig())
    val config: StateFlow<CaptureConfig> = _config

    // Direct AI fallback (bypasses backend when 404) — user can set Featherless/OpenRouter key directly in app
    private val _directEnabled = MutableStateFlow(false)
    val directEnabled: StateFlow<Boolean> = _directEnabled
    private val _directBaseUrl = MutableStateFlow(DirectAiPrefs.DEFAULT_BASE_URL)
    val directBaseUrl: StateFlow<String> = _directBaseUrl
    private val _directApiKey = MutableStateFlow("")
    val directApiKey: StateFlow<String> = _directApiKey
    private val _directModel = MutableStateFlow(DirectAiPrefs.DEFAULT_MODEL_FEATHERLESS)
    val directModel: StateFlow<String> = _directModel

    // Service-backed state — delegates to ScreenCaptureService companion flows when service alive,
    // otherwise local fallback.
    val isCapturing: StateFlow<Boolean> get() = ScreenCaptureService.isCapturingFlow
    val isPaused: StateFlow<Boolean> get() = ScreenCaptureService.isPausedFlow
    val previewBitmap: StateFlow<Bitmap?> get() = ScreenCaptureService.previewBitmapFlow
    val streamingText: StateFlow<String> get() = ScreenCaptureService.streamingTextFlow
    val isStreaming: StateFlow<Boolean> get() = ScreenCaptureService.isStreamingFlow
    val lastDiff: StateFlow<Float> get() = ScreenCaptureService.lastDiffFlow
    val queueSize: StateFlow<Int> get() = ScreenCaptureService.queueSizeFlow
    val skipped: StateFlow<Int> get() = ScreenCaptureService.skippedFlow
    val fps: StateFlow<Float> get() = ScreenCaptureService.fpsFlow
    val error: StateFlow<String?> get() = ScreenCaptureService.errorFlow
    val health: StateFlow<String> get() = ScreenCaptureService.healthFlow

    // Local health fallback when service not running
    private val _localHealth = MutableStateFlow("Checking...")
    val localHealth: StateFlow<String> = _localHealth

    fun setBackendUrl(url: String) {
        _backendUrl.value = url
        ScreenCaptureService.backendUrlFlow.value = url
        // Also update service if bound
        ScreenCaptureService.instance?.updateBackendUrl(url)
        checkHealth(url)
    }

    fun setPrompt(p: String) {
        _prompt.value = p
        ScreenCaptureService.instance?.updatePrompt(p)
    }

    fun setModel(m: String) {
        _model.value = m
        ScreenCaptureService.instance?.updateModel(m.ifBlank { null })
    }

    fun setConfig(c: CaptureConfig) {
        _config.value = c.validate()
        ScreenCaptureService.instance?.updateConfig(_config.value) ?: run {
            // Cache for next start
            ScreenCaptureService.isCapturingFlow.value // just to keep reference
        }
    }

    fun checkHealth(url: String = _backendUrl.value) {
        viewModelScope.launch {
            try {
                val client = ApiClient(url.trimEnd('/'))
                val h = client.health()
                _localHealth.value = "${h.status} · OpenRouter:${h.checks.openrouter}"
                ScreenCaptureService.healthFlow.value = _localHealth.value
            } catch (e: Exception) {
                val msg = e.message ?: "unknown"
                val friendly = when {
                    msg.contains("<!DOCTYPE", ignoreCase = true) || msg.contains("<html", ignoreCase = true) -> "backend not deployed"
                    msg.contains("404", true) -> "unreachable (404) — verify BACKEND_URL"
                    msg.contains("Unable to resolve host", true) -> "no network"
                    else -> "unreachable"
                }
                _localHealth.value = friendly
                ScreenCaptureService.healthFlow.value = friendly
            }
        }
    }

    fun clearError() { ScreenCaptureService.errorFlow.value = null }

    // Delegated actions
    fun toggleOverlay(context: Context) { ScreenCaptureService.instance?.toggleOverlay() }
    fun analyzeCurrentFrame() {
        val svc = ScreenCaptureService.instance
        if (svc != null) {
            val bmp = previewBitmap.value
            if (bmp != null) {
                // Convert current preview bitmap to jpeg for analysis (if engine has bytes we use them, else encode)
                viewModelScope.launch {
                    try {
                        val jpeg = bmpToJpeg(bmp, _config.value.jpegQuality)
                        svc.analyzeCurrentFrame(prompt.value, jpeg)
                    } catch (e: Exception) {
                        ScreenCaptureService.errorFlow.value = e.message
                    }
                }
            } else {
                // No preview — trigger single capture inside service
                svc.analyzeCurrentFrame(prompt.value, null)
            }
        }
    }

    private fun bmpToJpeg(bmp: Bitmap, quality: Int): ByteArray {
        val stream = java.io.ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, stream)
        return stream.toByteArray()
    }

    // Direct AI prefs - load/save
    fun loadDirectPrefs(context: android.content.Context) {
        viewModelScope.launch {
            try {
                val cfg = DirectAiPrefs.getSnapshot(context)
                _directEnabled.value = cfg.enabled
                _directBaseUrl.value = cfg.baseUrl
                _directApiKey.value = cfg.apiKey
                _directModel.value = cfg.model
            } catch (_: Exception) {}
            // Also collect flows for live updates
            launch { DirectAiPrefs.enabledFlow(context).collect { _directEnabled.value = it } }
            launch { DirectAiPrefs.baseUrlFlow(context).collect { _directBaseUrl.value = it } }
            launch { DirectAiPrefs.apiKeyFlow(context).collect { _directApiKey.value = it } }
            launch { DirectAiPrefs.modelFlow(context).collect { _directModel.value = it } }
        }
    }

    fun setDirectEnabled(context: android.content.Context, v: Boolean) {
        _directEnabled.value = v
        viewModelScope.launch { DirectAiPrefs.setEnabled(context, v) }
    }
    fun setDirectBaseUrl(context: android.content.Context, v: String) {
        _directBaseUrl.value = v
        viewModelScope.launch { DirectAiPrefs.setBaseUrl(context, v) }
    }
    fun setDirectApiKey(context: android.content.Context, v: String) {
        _directApiKey.value = v
        viewModelScope.launch { DirectAiPrefs.setApiKey(context, v) }
    }
    fun setDirectModel(context: android.content.Context, v: String) {
        _directModel.value = v
        viewModelScope.launch { DirectAiPrefs.setModel(context, v) }
    }

    // Service lifecycle helpers
    fun onServiceConnected(service: ScreenCaptureService) {
        // Sync config and url to service
        service.updateConfig(_config.value)
        service.updateBackendUrl(_backendUrl.value)
        service.updatePrompt(_prompt.value)
        service.updateModel(_model.value.ifBlank { null })
    }
}
