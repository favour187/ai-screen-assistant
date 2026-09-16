package com.aiscreenassistant.capture

import kotlinx.serialization.Serializable

/**
 * Configurable capture parameters — persisted via DataStore and tunable live in UI.
 * All limits are safety-capped for memory / battery / OS restrictions.
 */
@Serializable
data class CaptureConfig(
    /** Interval between captures in ms (500 = 2fps, 5000 = 0.2fps). Throttled to avoid battery + thermal. */
    val intervalMs: Long = 1500L,
    /** Resolution scale factor applied to physical display (0.3–1.0). Lower = less memory / bandwidth. */
    val scaleFactor: Float = 0.6f,
    /** JPEG quality (40–95). Lower = smaller payload, faster upload. */
    val jpegQuality: Int = 75,
    /** Whether to send only when screen changed (saves backend calls). */
    val enableFrameDiff: Boolean = true,
    /** Percent of pixels that must change to consider frame different (1–20). */
    val diffThresholdPercent: Float = 3.0f,
    /** Max frames queued for analysis at once (prevents flood). */
    val maxQueueSize: Int = 2,
    /** Max memory (MB) allowed for capture pipeline before throttling quality. */
    val maxMemoryMB: Int = 40,
    /** Auto-send every changed frame after interval (if false, only manual Analyze). */
    val autoAnalyze: Boolean = false,
    /** Whether to keep capturing when app in background (requires foreground service, which we have). */
    val captureInBackground: Boolean = true
) {
    fun validate(): CaptureConfig {
        return copy(
            intervalMs = intervalMs.coerceIn(500L, 10_000L),
            scaleFactor = scaleFactor.coerceIn(0.3f, 1.0f),
            jpegQuality = jpegQuality.coerceIn(40, 95),
            diffThresholdPercent = diffThresholdPercent.coerceIn(0.5f, 25f),
            maxQueueSize = maxQueueSize.coerceIn(1, 5),
            maxMemoryMB = maxMemoryMB.coerceIn(20, 80)
        )
    }

    val fpsLabel: String get() = if (intervalMs >= 1000) "${1000f/intervalMs} fps" else "${1000/intervalMs.toInt()} fps"
    val resLabel: String get() = "${(scaleFactor*100).toInt()}% scaled · q$jpegQuality"
}
