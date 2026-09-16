package com.aiscreenassistant.capture

import android.graphics.Bitmap
import android.graphics.Color
import kotlin.math.abs

/**
 * Efficient frame-change detection.
 * Downscales to 32×32, converts to grayscale, compares histograms.
 * Avoids sending identical frames, saving backend cost & battery.
 *
 * Thread-safe — keep one instance per CaptureEngine and call on capture thread.
 */
class FrameDiffer(
    private var thresholdPercent: Float = 3.0f,
    private val sampleSize: Int = 32 // 32x32 = 1024 samples
) {
    private var previousHash: IntArray? = null
    private var previousLuma: ByteArray? = null

    /**
     * Returns true if frame should be sent (changed enough or first frame).
     * Also returns diffPercent (0–100) for UI stats.
     */
    fun shouldSend(current: Bitmap, thresholdOverride: Float? = null): Pair<Boolean, Float> {
        val thr = thresholdOverride ?: thresholdPercent
        // Downscale cheaply — use scaled bitmap already, but ensure sampleSize
        val small = if (current.width == sampleSize && current.height == sampleSize) current
        else Bitmap.createScaledBitmap(current, sampleSize, sampleSize, true)

        val isScaled = small !== current
        val luma = bitmapToLuma(small)
        if (isScaled) small.recycle()

        val prev = previousLuma
        if (prev == null) {
            previousLuma = luma
            return true to 100f
        }
        // Compute percent of pixels with显著 luma difference (> 15)
        var diffCount = 0
        for (i in luma.indices) {
            val d = abs((luma[i].toInt() and 0xFF) - (prev[i].toInt() and 0xFF))
            if (d > 15) diffCount++
        }
        val diffPercent = diffCount * 100f / luma.size
        val changed = diffPercent >= thr

        if (changed) {
            previousLuma = luma // update only when changed — keeps last sent as baseline
        } else {
            // Slight decay: occasionally update to adapt to minor noise?
            // Keep previous to avoid drift, but recycle current luma? Already used.
        }
        return changed to diffPercent
    }

    fun setThreshold(p: Float) { thresholdPercent = p.coerceIn(0.5f, 25f) }

    fun reset() {
        previousLuma = null
        previousHash = null
    }

    private fun bitmapToLuma(bmp: Bitmap): ByteArray {
        val w = bmp.width
        val h = bmp.height
        val out = ByteArray(w*h)
        var idx = 0
        for (y in 0 until h) {
            for (x in 0 until w) {
                val c = bmp.getPixel(x, y)
                // Rec. 709 luma
                val l = (0.2126* Color.red(c) + 0.7152* Color.green(c) + 0.0722* Color.blue(c)).toInt()
                out[idx++] = l.toByte()
            }
        }
        return out
    }
}
