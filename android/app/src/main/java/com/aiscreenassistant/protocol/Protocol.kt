package com.aiscreenassistant.protocol

import kotlinx.serialization.Serializable

/**
 * Kotlin mirror of shared/src/protocol.ts — keep in sync.
 * Version 1.0.0
 */

@Serializable
data class HealthResponse(
    val status: String,
    val version: String,
    val uptime: Long,
    val timestamp: String,
    val checks: HealthChecks
)

@Serializable
data class HealthChecks(
    val server: String,
    val openrouter: String
)

@Serializable
data class ChatMessage(
    val role: String, // "user" | "assistant" | "system"
    val content: String,
    val imageBase64: String? = null,
    val imageUrl: String? = null
)

@Serializable
data class ChatRequest(
    val messages: List<ChatMessage>,
    val model: String? = null,
    val maxTokens: Int? = null,
    val temperature: Double? = null
)

@Serializable
data class ChatResponse(
    val id: String,
    val model: String,
    val message: ChatMessage,
    val usage: TokenUsage? = null,
    val finishReason: String? = null
)

@Serializable
data class TokenUsage(
    val promptTokens: Int,
    val completionTokens: Int,
    val totalTokens: Int
)

@Serializable
data class VisionAnalyzeResponse(
    val id: String,
    val model: String,
    val answer: String,
    val usage: TokenUsage? = null
)

@Serializable
data class ModelsResponse(
    val models: List<ModelInfo>
)

@Serializable
data class ModelInfo(
    val id: String,
    val name: String,
    val contextLength: Int? = null
)

@Serializable
data class ApiError(
    val error: String,
    val code: String? = null,
    val requestId: String? = null
)

object ApiRoutes {
    const val HEALTH = "/health"
    const val MODELS = "/api/models"
    const val CHAT = "/api/chat"
    const val CHAT_STREAM = "/api/chat/stream"
    const val VISION_ANALYZE = "/api/vision/analyze"
}
