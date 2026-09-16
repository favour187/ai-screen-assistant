package com.aiscreenassistant.overlay

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Optional standalone service for floating overlay.
 * Currently ScreenCaptureService hosts FloatingOverlayManager directly.
 * This service exists to satisfy manifest and for future split if needed.
 */
class FloatingOverlayService : Service() {
    private var manager: FloatingOverlayManager? = null
    override fun onCreate() {
        super.onCreate()
        manager = FloatingOverlayManager(this)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "SHOW") manager?.show()
        if (intent?.action == "HIDE") manager?.hide()
        return START_NOT_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() { manager?.hide(); super.onDestroy() }
}
