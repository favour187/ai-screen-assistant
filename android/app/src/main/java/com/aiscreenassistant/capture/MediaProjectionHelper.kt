package com.aiscreenassistant.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * OS-authorized capture only: uses MediaProjection (requires per-session user consent dialog).
 * No injection, no AccessibilityService, no instrumentation of the viewed app.
 * Pixels come solely from the OS compositor via ImageReader + VirtualDisplay.
 *
 * This helper now supports both single-frame (legacy) and continuous CaptureEngine usage.
 */
class MediaProjectionHelper(private val context: Context) {

    private val projectionManager =
        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

    fun createScreenCaptureIntent(): Intent = projectionManager.createScreenCaptureIntent()

    fun getMediaProjection(resultCode: Int, data: Intent): MediaProjection =
        projectionManager.getMediaProjection(resultCode, data)

    data class DisplayInfo(val width: Int, val height: Int, val densityDpi: Int, val rotation: Int)

    fun getDisplayInfo(): DisplayInfo {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                val bounds = wm.currentWindowMetrics.bounds
                val density = context.resources.displayMetrics.densityDpi
                @Suppress("DEPRECATION")
                val rotation = wm.defaultDisplay.rotation
                val w = if (bounds.width() > 0) bounds.width() else context.resources.displayMetrics.widthPixels
                val h = if (bounds.height() > 0) bounds.height() else context.resources.displayMetrics.heightPixels
                DisplayInfo(w, h, density, rotation)
            } else {
                val metrics = DisplayMetrics()
                @Suppress("DEPRECATION")
                wm.defaultDisplay.getMetrics(metrics)
                @Suppress("DEPRECATION")
                val rotation = wm.defaultDisplay.rotation
                DisplayInfo(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi, rotation)
            }
        } catch (e: Exception) {
            val dm = context.resources.displayMetrics
            @Suppress("DEPRECATION")
            val rot = wm.defaultDisplay.rotation
            DisplayInfo(dm.widthPixels, dm.heightPixels, dm.densityDpi, rot)
        }
    }

    fun getScaledInfo(scale: Float): DisplayInfo {
        val base = getDisplayInfo()
        return base.copy(
            width = (base.width * scale).toInt().coerceAtLeast(320),
            height = (base.height * scale).toInt().coerceAtLeast(480)
        )
    }

    /**
     * Captures a single JPEG frame from a MediaProjection session.
     * Caller must hold a valid MediaProjection (user-authorized).
     * The VirtualDisplay is released after the first frame.
     * Kept for manual "Capture Now" and fallback.
     */
    suspend fun captureSingleFrame(
        mediaProjection: MediaProjection,
        scaleFactor: Float = 0.7f,
        jpegQuality: Int = 82
    ): ByteArray = suspendCancellableCoroutine { cont ->
        val info = getScaledInfo(scaleFactor)
        val imageReader = ImageReader.newInstance(info.width, info.height, PixelFormat.RGBA_8888, 2)
        var virtualDisplay: VirtualDisplay? = null
        val handler = Handler(Looper.getMainLooper())

        imageReader.setOnImageAvailableListener({ reader ->
            var image: android.media.Image? = null
            try {
                image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                val planes = image.planes
                val buffer: ByteBuffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val rowPadding = rowStride - pixelStride * info.width

                val bitmap = Bitmap.createBitmap(
                    info.width + rowPadding / pixelStride,
                    info.height,
                    Bitmap.Config.ARGB_8888
                )
                bitmap.copyPixelsFromBuffer(buffer)
                val cropped = Bitmap.createBitmap(bitmap, 0, 0, info.width, info.height)

                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
                val jpeg = out.toByteArray()

                cropped.recycle()
                bitmap.recycle()

                if (cont.isActive) cont.resume(jpeg)
            } catch (e: Exception) {
                if (cont.isActive) cont.resumeWithException(e)
            } finally {
                image?.close()
                try { virtualDisplay?.release() } catch (_: Exception) {}
                try { imageReader.close() } catch (_: Exception) {}
            }
        }, handler)

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "AIScreenAssistantSingle",
            info.width, info.height, info.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.surface, null, null
        )

        cont.invokeOnCancellation {
            try { virtualDisplay?.release() } catch (_: Exception) {}
            try { imageReader.close() } catch (_: Exception) {}
        }

        handler.postDelayed({
            if (cont.isActive) {
                cont.resumeWithException(RuntimeException("Capture timeout — no frame from ImageReader"))
                try { virtualDisplay?.release() } catch (_: Exception) {}
                try { imageReader.close() } catch (_: Exception) {}
            }
        }, 3000)
    }
}

fun isMediaProjectionGranted(resultCode: Int): Boolean = resultCode == Activity.RESULT_OK
