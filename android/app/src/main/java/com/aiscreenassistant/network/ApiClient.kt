package com.aiscreenassistant.network

import com.aiscreenassistant.protocol.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Backend client — never holds OpenRouter key.
 * All calls go to Node backend which proxies to OpenRouter.
 */
class ApiClient(
    private val baseUrl: String // e.g. https://your-backend.onrender.com
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = false }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun health(): HealthResponse {
        // Try /health first, then fallback to / (deployed minimal backend on Render returns {status:ok} at /)
        val candidates = listOf("$baseUrl${ApiRoutes.HEALTH}", "$baseUrl/", "$baseUrl/health/live")
        var lastErr: Exception? = null
        for (url in candidates) {
            try {
                val req = Request.Builder().url(url).get().build()
                client.newCall(req).execute().use { res ->
                    val bodyStr = res.body?.string() ?: ""
                    if (!res.isSuccessful) {
                        // 404 HTML from Express — try next candidate if this is HTML 404
                        val isHtml = bodyStr.trimStart().startsWith("<", ignoreCase = true)
                        if (isHtml && res.code == 404) {
                            lastErr = ApiException("health ${res.code} at $url")
                            return@use
                        }
                        if (isHtml) {
                            throw ApiException("health ${res.code}: backend returned HTML (is BACKEND_URL correct? $baseUrl) — expected JSON at ${ApiRoutes.HEALTH}")
                        }
                        throw ApiException("health ${res.code}: ${bodyStr.take(200)}")
                    }
                    if (bodyStr.trimStart().startsWith("<!DOCTYPE", ignoreCase = true) || bodyStr.trimStart().startsWith("<html", ignoreCase = true)) {
                        lastErr = ApiException("health: HTML at $url")
                        return@use
                    }
                    try {
                        // Try full HealthResponse
                        return json.decodeFromString(bodyStr)
                    } catch (e: Exception) {
                        // Fallback: if body is minimal {"status":"ok", "service":...} from old deploy at /
                        if (bodyStr.contains("\"status\"") && bodyStr.contains("ok")) {
                            // Map minimal to HealthResponse
                            return HealthResponse(
                                status = "ok",
                                version = "0.0.0",
                                uptime = 0,
                                timestamp = "",
                                checks = HealthChecks(server = "ok", openrouter = "unknown")
                            )
                        }
                        throw ApiException("health: invalid JSON (${e.message}) from $url: ${bodyStr.take(200)}")
                    }
                }
            } catch (e: Exception) {
                lastErr = e
                // try next candidate if this one failed with HTML/404
                if (e.message?.contains("health") == true && e.message?.contains("404") == true) continue
                if (e.message?.contains("HTML") == true) continue
                throw e
            }
            // if we reached here without return, try next
        }
        throw lastErr ?: ApiException("health: all candidates failed for $baseUrl")
    }

    suspend fun visionAnalyze(
        prompt: String,
        imageFile: File? = null,
        imageBase64: String? = null,
        model: String? = null,
        history: List<ChatMessage>? = null
    ): VisionAnalyzeResponse {
        // Multipart if file provided, else JSON with base64
        val request = if (imageFile != null) {
            val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("prompt", prompt)
            if (model != null) multipart.addFormDataPart("model", model)
            if (history != null) multipart.addFormDataPart("history", json.encodeToString(kotlinx.serialization.builtins.ListSerializer(ChatMessage.serializer()), history))
            multipart.addFormDataPart(
                "image", imageFile.name,
                imageFile.asRequestBody("image/jpeg".toMediaType())
            )
            Request.Builder().url("$baseUrl${ApiRoutes.VISION_ANALYZE}").post(multipart.build()).build()
        } else {
            val bodyJson = buildString {
                append("{")
                append("\"prompt\":${json.encodeToString(kotlinx.serialization.serializer<String>(), prompt)},")
                if (imageBase64 != null) {
                    val b64 = if (imageBase64.startsWith("data:")) imageBase64 else "data:image/jpeg;base64,$imageBase64"
                    append("\"imageBase64\":${json.encodeToString(kotlinx.serialization.serializer<String>(), b64)},")
                }
                if (model != null) append("\"model\":${json.encodeToString(kotlinx.serialization.serializer<String>(), model)},")
                if (history != null) append("\"history\":${json.encodeToString(kotlinx.serialization.builtins.ListSerializer(ChatMessage.serializer()), history)},")
                append("\"stream\":false}")
            }.replace(",}", "}")
            Request.Builder()
                .url("$baseUrl${ApiRoutes.VISION_ANALYZE}")
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()
        }

        client.newCall(request).execute().use { res ->
            val body = res.body?.string() ?: ""
            if (!res.isSuccessful) {
                val isHtml = body.trimStart().startsWith("<", ignoreCase = true)
                if (isHtml && body.contains("Cannot POST") && body.contains("/api/vision")) {
                    throw ApiException("vision 404: backend not deployed — /api/vision/analyze missing on $baseUrl. Redeploy server on Render (push to main triggers autoDeploy) or enable Direct AI fallback in Settings → Direct AI (Featherless/OpenRouter).")
                }
                if (isHtml) throw ApiException("vision ${res.code}: backend returned HTML — is BACKEND_URL correct? $baseUrl")
                // Handle 503 not_configured from server when OPENROUTER_API_KEY missing
                if (res.code == 503 && body.contains("NOT_CONFIGURED")) {
                    throw ApiException("AI not configured: set OPENROUTER_API_KEY or FEATHERLESS_API_KEY on Render → Environment → Save → Manual Deploy, or use Direct AI fallback in app Settings")
                }
                throw ApiException("vision ${res.code}: ${body.take(300)}")
            }
            // Even on 200, check for HTML
            if (body.trimStart().startsWith("<!DOCTYPE", ignoreCase = true) || body.trimStart().startsWith("<html", ignoreCase = true)) {
                throw ApiException("vision: backend returned HTML not JSON — wrong URL? $baseUrl")
            }
            try {
                return json.decodeFromString(body)
            } catch (e: Exception) {
                throw ApiException("vision: invalid JSON (${e.message}): ${body.take(300)}")
            }
        }
    }

    /**
     * Streaming vision analyze — returns Flow of delta strings.
     * Uses SSE: POST /api/vision/analyze?stream=true with same body, parses text/event-stream.
     */
    fun visionAnalyzeStream(
        prompt: String,
        imageBase64: String,
        model: String? = null
    ): Flow<String> = flow {
        val b64 = if (imageBase64.startsWith("data:")) imageBase64 else "data:image/jpeg;base64,$imageBase64"
        val payload = buildString {
            append("{")
            append("\"prompt\":${json.encodeToString(kotlinx.serialization.serializer<String>(), prompt)},")
            append("\"imageBase64\":${json.encodeToString(kotlinx.serialization.serializer<String>(), b64)},")
            if (model != null) append("\"model\":${json.encodeToString(kotlinx.serialization.serializer<String>(), model)},")
            append("\"stream\":true}")
        }.replace(",}", "}")

        val req = Request.Builder()
            .url("$baseUrl${ApiRoutes.VISION_ANALYZE}?stream=true")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .header("Accept", "text/event-stream")
            .build()

        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                val body = res.body?.string() ?: ""
                val isHtml = body.trimStart().startsWith("<", ignoreCase = true)
                if (isHtml && body.contains("Cannot POST")) {
                    throw ApiException("vision stream 404: backend not deployed — redeploy server on Render or enable Direct AI fallback in Settings")
                }
                if (isHtml) throw ApiException("stream ${res.code}: HTML — wrong BACKEND_URL? $baseUrl")
                if (res.code == 503) throw ApiException("AI not configured: set OPENROUTER_API_KEY on Render")
                throw ApiException("stream ${res.code}: ${body.take(300)}")
            }
            val source = res.body!!.source()
            var buffer = ""
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (line.isBlank()) continue
                if (line.startsWith("event:")) {
                    val event = line.removePrefix("event:").trim()
                    val dataLine = source.readUtf8Line() ?: ""
                    val data = dataLine.removePrefix("data:").trim()
                    // blank line consumed implicitly by loop
                    source.readUtf8Line() // consume empty line if present (tolerant)

                    when (event) {
                        "delta" -> {
                            try {
                                val obj = json.parseToJsonElement(data)
                                val delta = obj.let {
                                    // expect {"delta":"..."} or {"delta":"..."} wrapper
                                    try { json.decodeFromString<Map<String,String>>(data)["delta"] } catch (_: Exception) { data }
                                }
                                if (delta != null) emit(delta)
                            } catch (_: Exception) {
                                if (data.isNotEmpty()) emit(data)
                            }
                        }
                        "error" -> throw ApiException("stream error: $data")
                        "done" -> return@flow
                        "meta" -> { /* ignore */ }
                    }
                } else if (line.startsWith("data:")) {
                    // fallback without explicit event
                    buffer += line.removePrefix("data:").trim()
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    fun chatStream(messages: List<ChatMessage>, model: String? = null): Flow<String> = flow {
        val payload = json.encodeToString(ChatRequest.serializer(), ChatRequest(messages, model))
        val req = Request.Builder()
            .url("$baseUrl${ApiRoutes.CHAT_STREAM}")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .header("Accept", "text/event-stream")
            .build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException("chat stream ${res.code}: ${res.body?.string()}")
            val source = res.body!!.source()
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (line.startsWith("event: delta")) {
                    val data = source.readUtf8Line()?.removePrefix("data:")?.trim() ?: ""
                    source.readUtf8Line() // blank
                    try {
                        val m = json.decodeFromString<Map<String,String>>(data)
                        emit(m["delta"] ?: data)
                    } catch (_: Exception) { emit(data) }
                } else if (line.contains("event: done")) break
                else if (line.contains("event: error")) throw ApiException(line)
            }
        }
    }.flowOn(Dispatchers.IO)
}

class ApiException(message: String) : Exception(message)
