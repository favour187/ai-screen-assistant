package com.aiscreenassistant.util

import android.app.ActivityManager
import android.content.Context
import android.os.Debug

/**
 * Guards against OOM in capture pipeline.
 * - Checks available memory before allocating bitmap
 * - Provides adaptive throttle hint
 */
object MemoryManager {

    fun availableMB(context: Context): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.availMem / (1024*1024)
    }

    fun isLowMemory(context: Context): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.lowMemory
    }

    fun heapUsedMB(): Long {
        val runtime = Runtime.getRuntime()
        return (runtime.totalMemory() - runtime.freeMemory()) / (1024*1024)
    }

    fun heapMaxMB(): Long = Runtime.getRuntime().maxMemory() / (1024*1024)

    fun shouldThrottleCapture(context: Context, configMaxMB: Int): Boolean {
        return isLowMemory(context) || heapUsedMB() > configMaxMB * 0.85 || availableMB(context) < 120
    }

    fun logMemory(tag: String) {
        android.util.Log.d(tag, "heapUsed=${heapUsedMB()}MB heapMax=${heapMaxMB()}MB availSystem=${Debug.getNativeHeapAllocatedSize()/1024/1024}MB")
    }
}
