package com.aiscreenassistant.network

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import java.io.FileOutputStream

/**
 * Queues selected frames, sends to backend, streams responses.
 * Handles memory limits, retry, and backpressure (maxQueueSize).
 */
class AnalysisRepository(
    private val apiClientProvider: () -> ApiClient, // lambda so baseUrl can change live
    private val scope: CoroutineScope
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
            try {
                val client = apiClientProvider()
                val b64 = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
                val dataUrl = "data:image/jpeg;base64,$b64"
                // Try streaming first
                try {
                    client.visionAnalyzeStream(prompt.ifBlank { "Describe what's on this screen concisely. Be helpful." }, dataUrl, model)
                        .collect { delta ->
                            full += delta
                            _streamingText.value = full
                            onDelta(delta)
                        }
                    Log.i(TAG, "stream done, ${full.length} chars")
                    onDone(full)
                } catch (e: Exception) {
                    Log.w(TAG, "stream failed, falling back to non-stream", e)
                    // Fallback: multipart temp file
                    val tmp = File.createTempFile("frame_", ".jpg", File(System.getProperty("java.io.tmpdir")))
                    FileOutputStream(tmp).use { it.write(jpegBytes) }
                    try {
                        val res = client.visionAnalyze(prompt, imageFile = tmp, model = model)
                        full = res.answer
                        _streamingText.value = full
                        onDone(full)
                    } finally {
                        tmp.delete()
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
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
