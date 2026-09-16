package com.aiscreenassistant.network

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import java.io.FileOutputStream

/**
 * Queues selected frames, sends to backend, streams responses.
 * Handles memory limits, retry, and backpressure (maxQueueSize).
 * Falls back to direct Featherless/OpenRouter when backend is 404/not deployed and Direct AI is enabled.
 */
class AnalysisRepository(
    private val apiClientProvider: () -> ApiClient, // lambda so baseUrl can change live
    private val scope: CoroutineScope,
    private val directConfigProvider: (() -> DirectAiPrefs.DirectConfig)? = null,
    private val onFallbackUsed: (() -> Unit)? = null
) {
    companion object { private const val TAG = "AnalysisRepo" }

    private val _streamingText = MutableStateFlow("")
    val streamingText: StateFlow<String> = _streamingText.asStateFlow()

    private val _isStreaming = MutableStateFlow(false)
    val isStreaming: StateFlow<Boolean> = _isStreaming.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private var streamingJob: Job? = null

    /**
     * Analyze frame — streaming preferred, fallback to non-stream.
     * Caller ensures jpeg not too large (engine guarantees <1.8MB).
     */
    fun analyze(
        jpegBytes: ByteArray,
        prompt: String,
        model: String? = null,
        onDelta: (String) -> Unit = {},
        onDone: (String) -> Unit = {}
    ) {
        // Cancel previous stream if still running — we serialize
        if (_isStreaming.value) {
            Log.d(TAG, "already streaming, queueing new request after current")
            streamingJob?.cancel()
        }
        streamingJob = scope.launch {
            _isStreaming.value = true
            _streamingText.value = ""
            _lastError.value = null
            var full = ""
            // Helper to check if backend error is 404/not deployed and direct is available
            suspend fun shouldFallback(e: Exception): Boolean {
                val msg = e.message ?: ""
                val isBackend404 = msg.contains("vision 404", ignoreCase = true) || msg.contains("backend not deployed", ignoreCase = true) || (msg.contains("Cannot POST", ignoreCase = true) && msg.contains("/api/vision")) || msg.contains("HTML", ignoreCase = true) && msg.contains("404", ignoreCase = true)
                if (!isBackend404) return false
                val cfg = try { directConfigProvider?.invoke() } catch (_: Exception) { null } ?: return false
                return cfg.enabled && cfg.apiKey.isNotBlank()
            }
            suspend fun runDirect(b64: String, effectivePrompt: String, effectiveModel: String?): Boolean {
                val cfg = directConfigProvider?.invoke() ?: return false
                if (!cfg.enabled || cfg.apiKey.isBlank()) return false
                return try {
                    Log.i(TAG, "backend 404 — falling back to direct AI ${cfg.baseUrl} model=${effectiveModel ?: cfg.model}")
                    onFallbackUsed?.invoke()
                    _streamingText.value = "(Direct AI fallback: ${cfg.model})…"
                    val direct = DirectAiClient(cfg.baseUrl, cfg.apiKey)
                    val directModel = effectiveModel?.ifBlank { null } ?: cfg.model
                    // Try streaming direct first
                    try {
                        direct.visionAnalyzeStream(effectivePrompt, b64, directModel).collect { delta ->
                            full += delta
                            _streamingText.value = full
                            onDelta(delta)
                        }
                        Log.i(TAG, "direct stream done, ${full.length} chars")
                        onDone(full)
                        true
                    } catch (se: Exception) {
                        Log.w(TAG, "direct stream failed, fallback to direct non-stream", se)
                        val res = direct.visionAnalyze(effectivePrompt, b64, directModel)
                        full = res
                        _streamingText.value = full
                        onDone(full)
                        true
                    }
                } catch (de: Exception) {
                    Log.e(TAG, "direct fallback also failed", de)
                    _lastError.value = "Direct AI failed: ${de.message} (backend also 404: ${de.message?.take(60)})"
                    _streamingText.value = "Error: backend 404 and Direct AI failed: ${de.message}\n\nTip: Check Direct AI key/baseUrl/model in Settings → Direct AI"
                    onDone(_streamingText.value)
                    true // handled (don't rethrow backend error)
                }
            }
            try {
                val client = apiClientProvider()
                val b64 = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
                val dataUrl = "data:image/jpeg;base64,$b64"
                val effectivePrompt = prompt.ifBlank { "Describe what's on this screen concisely. Be helpful." }
                // Try streaming first
                try {
                    client.visionAnalyzeStream(effectivePrompt, dataUrl, model)
                        .collect { delta ->
                            full += delta
                            _streamingText.value = full
                            onDelta(delta)
                        }
                    Log.i(TAG, "stream done, ${full.length} chars")
                    onDone(full)
                } catch (e: Exception) {
                    // Check if backend 404 and direct available — fallback before non-stream
                    if (shouldFallback(e)) {
                        val b64bare = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
                        if (runDirect(b64bare, effectivePrompt, model)) return@launch
                    }
                    Log.w(TAG, "stream failed, falling back to non-stream", e)
                    // Fallback: multipart temp file
                    val tmp = File.createTempFile("frame_", ".jpg", File(System.getProperty("java.io.tmpdir")))
                    FileOutputStream(tmp).use { it.write(jpegBytes) }
                    try {
                        val res = client.visionAnalyze(prompt, imageFile = tmp, model = model)
                        full = res.answer
                        _streamingText.value = full
                        onDone(full)
                    } catch (ne: Exception) {
                        if (shouldFallback(ne)) {
                            val b64bare = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
                            if (runDirect(b64bare, effectivePrompt, model)) return@launch
                        }
                        throw ne
                    } finally {
                        tmp.delete()
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                // Final catch — check fallback once more if not already
                if (shouldFallback(e)) {
                    val b64bare = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
                    val effectivePrompt = prompt.ifBlank { "Describe what's on this screen concisely. Be helpful." }
                    if (runDirect(b64bare, effectivePrompt, model)) return@launch
                }
                Log.e(TAG, "analyze failed", e)
                _lastError.value = e.message
                _streamingText.value = "Error: ${e.message}"
                onDone("Error: ${e.message}")
            } finally {
                _isStreaming.value = false
            }
        }
    }

    fun cancel() {
        streamingJob?.cancel()
        _isStreaming.value = false
    }

    fun clear() {
        cancel()
        _streamingText.value = ""
        _lastError.value = null
    }
}
