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
        val req = Request.Builder().url("$baseUrl${ApiRoutes.HEALTH}").get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException("health ${res.code}: ${res.body?.string()}")
            return json.decodeFromString(res.body!!.string())
        }
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
            if (!res.isSuccessful) throw ApiException("vision ${res.code}: $body")
            return json.decodeFromString(body)
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
            if (!res.isSuccessful) throw ApiException("stream ${res.code}: ${res.body?.string()}")
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
