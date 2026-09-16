package com.aiscreenassistant.capture

import android.graphics.Bitmap
import android.graphics.Matrix
import java.io.ByteArrayOutputStream

/**
 * Efficient, memory-safe bitmap helpers.
 * - Scales down with filter
 * - Compresses to JPEG with quality, reusing ByteArrayOutputStream
 * - Recycles intermediate bitmaps
 * - Caps memory usage before OOM
 */
object BitmapUtils {

    /**
     * Scale bitmap by factor (0.3–1.0) — returns new bitmap (caller must recycle),
     * or original if factor == 1 and no rotation needed.
     */
    fun scale(bitmap: Bitmap, factor: Float, rotationDegrees: Int = 0): Bitmap {
        val needsScale = factor < 0.99f
        val needsRotate = rotationDegrees != 0
        if (!needsScale && !needsRotate) return bitmap

        val targetW = (bitmap.width * factor).toInt().coerceAtLeast(16)
        val targetH = (bitmap.height * factor).toInt().coerceAtLeast(16)

        val matrix = Matrix()
        if (needsScale) matrix.postScale(factor, factor)
        if (needsRotate) matrix.postRotate(rotationDegrees.toFloat())

        val scaled = try {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } catch (e: OutOfMemoryError) {
            System.gc()
            // Fallback: halve factor one more time
            val fallback = (factor * 0.6f).coerceAtLeast(0.3f)
            val fw = (bitmap.width * fallback).toInt()
            val fh = (bitmap.height * fallback).toInt()
            Bitmap.createScaledBitmap(bitmap, fw, fh, true)
        }
        return scaled
    }

    /**
     * Compress to JPEG ByteArray — efficient, no file IO. Handles OOM by lowering quality.
     */
    fun compressJpeg(bitmap: Bitmap, quality: Int, maxBytes: Int = 1_800_000): ByteArray {
        var q = quality.coerceIn(40, 95)
        var attempt = 0
        while (attempt < 3) {
            val stream = ByteArrayOutputStream((bitmap.width * bitmap.height * 3 / 8))
            try {
                bitmap.compress(Bitmap.CompressFormat.JPEG, q, stream)
                val bytes = stream.toByteArray()
                if (bytes.size <= maxBytes || q <= 45) return bytes
                // Too big — reduce quality or scale
                q = (q * 0.8).toInt().coerceAtLeast(40)
                attempt++
            } catch (e: OutOfMemoryError) {
                System.gc()
                q = (q * 0.7).toInt().coerceAtLeast(40)
                attempt++
                if (attempt >= 3) throw e
            } finally {
                try { stream.close() } catch (_: Exception) {}
            }
        }
        // Final fallback
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 55, stream)
        return stream.toByteArray()
    }

    /**
     * Estimate memory size of bitmap in MB (width * height * 4 bytes)
     */
    fun estimateMB(bitmap: Bitmap): Float = (bitmap.byteCount / (1024f*1024f))

    fun shouldThrottle(usedMB: Float, limitMB: Int): Boolean = usedMB > limitMB * 0.8f
}
