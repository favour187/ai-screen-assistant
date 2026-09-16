package com.aiscreenassistant.network

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Direct AI client — calls OpenRouter/Featherless/OpenAI-compatible API directly from device.
 * Bypasses our Node backend. Use when backend is down (404) or user prefers direct.
 * Key is stored locally (DataStore) and never committed.
 *
 * Supports vision via chat/completions with image_url.
 * Works with:
 * - OpenRouter: baseUrl https://openrouter.ai/api/v1, key sk-or-..., model anthropic/claude-3.5-sonnet
 * - Featherless: baseUrl https://api.featherless.ai/v1, key ..., model e.g. Qwen/Qwen2-VL-72B-Instruct or meta-llama/...
 * - Any OpenAI-compatible (OpenAI, Groq, etc)
 */
class DirectAiClient(
    private val baseUrl: String, // e.g. https://api.featherless.ai/v1 or https://openrouter.ai/api/v1
    private val apiKey: String,
    private val appName: String = "AI Screen Assistant",
    private val appUrl: String = "https://github.com/favour187/ai-screen-assistant"
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun headers(): Map<String, String> {
        val h = mutableMapOf(
            "Authorization" to "Bearer $apiKey",
            "Content-Type" to "application/json"
        )
        // OpenRouter wants these for ranking, Featherless doesn't need but harmless to send for OpenRouter only
        if (baseUrl.contains("openrouter.ai")) {
            h["HTTP-Referer"] = appUrl
            h["X-Title"] = appName
        }
        return h
    }

    private fun isVisionModel(model: String): Boolean {
        val m = model.lowercase()
        // Common vision-capable substrings
        return m.contains("vision") || m.contains("vl") || m.contains("claude-3") || m.contains("gpt-4o") || m.contains("gpt-4-v") || m.contains("gemini") || m.contains("qwen2-vl") || m.contains("llava") || m.contains("pixtral") || m.contains("sonnet")
    }

    suspend fun visionAnalyze(
        prompt: String,
        imageBase64: String, // data:image/jpeg;base64,... or bare base64
        model: String
    ): String {
        if (apiKey.isBlank()) throw ApiException("Direct API key not set — enter in Settings → Direct AI")
        val dataUrl = if (imageBase64.startsWith("data:")) imageBase64 else "data:image/jpeg;base64,$imageBase64"
        val payload = buildPayload(prompt, dataUrl, model, stream = false)
        val reqBuilder = Request.Builder().url("${baseUrl.trimEnd('/')}/chat/completions").post(payload.toRequestBody("application/json".toMediaType()))
        headers().forEach { (k, v) -> reqBuilder.header(k, v) }
        val req = reqBuilder.build()
        Log.i("DirectAi", "direct visionAnalyze model=$model base=${baseUrl.take(30)}")
        client.newCall(req).execute().use { res ->
            val body = res.body?.string() ?: ""
            if (!res.isSuccessful) {
                Log.e("DirectAi", "direct error ${res.code}: ${body.take(400)}")
                throw ApiException("Direct AI ${res.code}: ${body.take(300)} — check key/model/baseUrl")
            }
            try {
                val obj = JSONObject(body)
                val choices = obj.getJSONArray("choices")
                if (choices.length() == 0) throw ApiException("Direct AI: no choices")
                val msg = choices.getJSONObject(0).getJSONObject("message")
                // content can be string or array
                val content = msg.opt("content")
                return when (content) {
                    is String -> content
                    is JSONArray -> {
                        // array of parts
                        val sb = StringBuilder()
                        for (i in 0 until content.length()) {
                            val part = content.getJSONObject(i)
                            if (part.optString("type") == "text") sb.append(part.optString("text"))
                        }
                        sb.toString()
                    }
                    else -> content?.toString() ?: ""
                }
            } catch (e: ApiException) { throw e }
            catch (e: Exception) {
                throw ApiException("Direct AI parse error: ${e.message}: ${body.take(300)}")
            }
        }
    }

    fun visionAnalyzeStream(
        prompt: String,
        imageBase64: String,
        model: String
    ): Flow<String> = flow {
        if (apiKey.isBlank()) throw ApiException("Direct API key not set — enter in Settings → Direct AI")
        val dataUrl = if (imageBase64.startsWith("data:")) imageBase64 else "data:image/jpeg;base64,$imageBase64"
        val payload = buildPayload(prompt, dataUrl, model, stream = true)
        val reqBuilder = Request.Builder().url("${baseUrl.trimEnd('/')}/chat/completions")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .header("Accept", "text/event-stream")
        headers().forEach { (k, v) -> reqBuilder.header(k, v) }
        val req = reqBuilder.build()
        Log.i("DirectAi", "direct stream model=$model")
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful || res.body == null) {
                val body = res.body?.string() ?: ""
                throw ApiException("Direct stream ${res.code}: ${body.take(300)}")
            }
            val source = res.body!!.source()
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (line.isBlank()) continue
                if (line.startsWith("data:")) {
                    val data = line.removePrefix("data:").trim()
                    if (data == "[DONE]") break
                    if (data.isEmpty()) continue
                    try {
                        val obj = JSONObject(data)
                        val choices = obj.optJSONArray("choices") ?: continue
                        if (choices.length() == 0) continue
                        val delta = choices.getJSONObject(0).optJSONObject("delta") ?: continue
                        val content = delta.optString("content")
                        if (content.isNotEmpty()) emit(content)
                        val finish = choices.getJSONObject(0).optString("finish_reason")
                        if (finish.isNotEmpty() && finish != "null") {
                            // done
                        }
                    } catch (_: Exception) {
                        // ignore malformed chunk
                    }
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    private fun buildPayload(prompt: String, dataUrl: String, model: String, stream: Boolean): String {
        val obj = JSONObject()
        obj.put("model", model)
        obj.put("stream", stream)
        obj.put("max_tokens", 4096)
        val messages = JSONArray()
        // System prompt for better vision
        val sys = JSONObject()
        sys.put("role", "system")
        sys.put("content", "You are a helpful vision assistant. Describe and answer concisely. If asked to code, provide complete code.")
        messages.put(sys)
        val user = JSONObject()
        user.put("role", "user")
        val contentArr = JSONArray()
        val textPart = JSONObject()
        textPart.put("type", "text")
        textPart.put("text", prompt)
        contentArr.put(textPart)
        val imgPart = JSONObject()
        imgPart.put("type", "image_url")
        val urlObj = JSONObject()
        urlObj.put("url", dataUrl)
        imgPart.put("image_url", urlObj)
        contentArr.put(imgPart)
        user.put("content", contentArr)
        messages.put(user)
        obj.put("messages", messages)
        if (stream) obj.put("stream_options", JSONObject().put("include_usage", true))
        return obj.toString()
    }
}
