package com.aiscreenassistant.network

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.directDataStore by preferencesDataStore(name = "direct_ai")

object DirectAiPrefs {
    private val KEY_BASE_URL = stringPreferencesKey("direct_base_url")
    private val KEY_API_KEY = stringPreferencesKey("direct_api_key")
    private val KEY_MODEL = stringPreferencesKey("direct_model")
    private val KEY_ENABLED = stringPreferencesKey("direct_enabled") // "true"/"false"

    // Defaults
    const val DEFAULT_BASE_URL = "https://api.featherless.ai/v1"
    const val DEFAULT_MODEL_FEATHERLESS = "Qwen/Qwen2-VL-72B-Instruct"
    const val DEFAULT_MODEL_OPENROUTER = "anthropic/claude-3.5-sonnet"

    fun baseUrlFlow(context: Context): Flow<String> = context.directDataStore.data.map { it[KEY_BASE_URL] ?: DEFAULT_BASE_URL }
    fun apiKeyFlow(context: Context): Flow<String> = context.directDataStore.data.map { it[KEY_API_KEY] ?: "" }
    fun modelFlow(context: Context): Flow<String> = context.directDataStore.data.map { it[KEY_MODEL] ?: DEFAULT_MODEL_FEATHERLESS }
    fun enabledFlow(context: Context): Flow<Boolean> = context.directDataStore.data.map { it[KEY_ENABLED] == "true" }

    suspend fun setBaseUrl(context: Context, v: String) { context.directDataStore.edit { it[KEY_BASE_URL] = v } }
    suspend fun setApiKey(context: Context, v: String) { context.directDataStore.edit { it[KEY_API_KEY] = v } }
    suspend fun setModel(context: Context, v: String) { context.directDataStore.edit { it[KEY_MODEL] = v } }
    suspend fun setEnabled(context: Context, v: Boolean) { context.directDataStore.edit { it[KEY_ENABLED] = if (v) "true" else "false" } }

    // Sync getters for service (blocking not ideal but ok for immediate)
    suspend fun getSnapshot(context: Context): DirectConfig {
        val data = context.directDataStore.data.first()
        return DirectConfig(
            baseUrl = data[KEY_BASE_URL] ?: DEFAULT_BASE_URL,
            apiKey = data[KEY_API_KEY] ?: "",
            model = data[KEY_MODEL] ?: DEFAULT_MODEL_FEATHERLESS,
            enabled = data[KEY_ENABLED] == "true"
        )
    }

    data class DirectConfig(val baseUrl: String, val apiKey: String, val model: String, val enabled: Boolean)
}
