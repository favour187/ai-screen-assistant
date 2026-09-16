package com.aiscreenassistant.overlay

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry

/**
 * Manages the floating result window (WindowManager overlay).
 * Shown when user switches apps — OS permission Settings.canDrawOverlays().
 * Draggable bubble that expands to show streaming assistant output.
 *
 * Independent from target app — uses WindowManager TYPE_APPLICATION_OVERLAY
 * which is OS-provided and requires explicit user grant in Settings.
 */
class FloatingOverlayManager(private val context: Context) {

    private var windowManager: WindowManager? = null
    private var overlayView: FrameLayout? = null
    private var composeView: ComposeView? = null
    private var lifecycleOwner: LifecycleOwner? = null
    private var isShowing = false
    private var isExpanded = false

    // Live state updated from service
    var streamingText by mutableStateOf("")
    var isStreaming by mutableStateOf(false)
    var backendStatus by mutableStateOf("...")
    var onClose: (() -> Unit)? = null
    var onExpandToggle: (() -> Unit)? = null
    var onStopCapture: (() -> Unit)? = null

    private var params: WindowManager.LayoutParams? = null
    private var initialX = 0
    private var initialY = 0
    private var initialTouchX = 0f
    private var initialTouchY = 0f

    fun canShow(): Boolean = Settings.canDrawOverlays(context)

    fun show() {
        if (isShowing) return
        if (!canShow()) return
        try {
            windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val layoutParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.END
                x = 16
                y = 120
                width = WindowManager.LayoutParams.WRAP_CONTENT
                height = WindowManager.LayoutParams.WRAP_CONTENT
            }
            params = layoutParams

            val frame = FrameLayout(context)
            val lifecycle = LifecycleRegistry(object : LifecycleOwner {
                override val lifecycle = LifecycleRegistry(this)
            })
            val owner = object : LifecycleOwner {
                override val lifecycle = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
            }
            lifecycleOwner = owner
            // Setup ComposeView with proper owners for Compose to work in overlay
            val cv = ComposeView(context).apply {
                setViewTreeLifecycleOwner(owner)
                // SavedStateRegistry owner stub — overlay doesn't need saved state, but Compose requires it for some APIs
                // We skip setting it to keep lightweight; most composables work without it.
                setContent {
                    OverlayContent()
                }
            }
            composeView = cv
            frame.addView(cv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))

            // Drag handling on the whole frame
            frame.setOnTouchListener { v, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = params!!.x
                        initialY = params!!.y
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        params!!.x = initialX - (event.rawX - initialTouchX).toInt()
                        params!!.y = initialY + (event.rawY - initialTouchY).toInt()
                        try { windowManager?.updateViewLayout(frame, params) } catch (_: Exception) {}
                        true
                    }
                    else -> false
                }
            }

            overlayView = frame
            windowManager?.addView(frame, layoutParams)
            isShowing = true
        } catch (e: Exception) {
            android.util.Log.e("FloatingOverlay", "show failed", e)
        }
    }

    fun hide() {
        if (!isShowing) return
        try {
            overlayView?.let { windowManager?.removeView(it) }
        } catch (_: Exception) {}
        overlayView = null
        composeView = null
        isShowing = false
        isExpanded = false
    }

    fun updateContent(text: String, streaming: Boolean) {
        streamingText = text
        isStreaming = streaming
        // Compose recomposes automatically via state
    }

    @Composable
    private fun OverlayContent() {
        MaterialTheme(colorScheme = lightColorScheme()) {
            if (!isExpanded) {
                // Collapsed bubble — 56dp draggable
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable { isExpanded = true },
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Filled.Visibility, contentDescription = "Assistant", tint = Color.White)
                    if (isStreaming) {
                        Box(
                            Modifier
                                .size(12.dp)
                                .align(Alignment.TopEnd)
                                .clip(CircleShape)
                                .background(Color(0xFF22C55E))
                        )
                    }
                }
            } else {
                // Expanded card — 320dp width
                Card(
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.cardElevation(8.dp),
                    modifier = Modifier
                        .width(340.dp)
                        .wrapContentHeight()
                        .padding(8.dp)
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("AI Assistant", style = MaterialTheme.typography.titleSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (isStreaming) LinearProgressIndicator(Modifier.width(40.dp).height(3.dp))
                                IconButton(onClick = { isExpanded = false }, modifier = Modifier.size(24.dp)) {
                                    Icon(Icons.Filled.Close, contentDescription = "Collapse", modifier = Modifier.size(16.dp))
                                }
                            }
                        }
                        if (streamingText.isBlank() && !isStreaming) {
                            Text("No response yet. Capture will stream here when you stay in another app.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 280.dp)
                                    .verticalScroll(rememberScrollState())
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant)
                                    .padding(10.dp)
                            ) {
                                Text(streamingText.ifBlank { "Streaming…" }, style = MaterialTheme.typography.bodySmall, lineHeight = MaterialTheme.typography.bodySmall.lineHeight)
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedButton(onClick = { isExpanded = false }, modifier = Modifier.weight(1f)) { Text("Minimize", style = MaterialTheme.typography.labelSmall) }
                            Button(onClick = { onStopCapture?.invoke() }, modifier = Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) {
                                Text("Stop", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        Text(backendStatus, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }

    fun isVisible(): Boolean = isShowing
}
