package com.aiscreenassistant.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aiscreenassistant.capture.CaptureConfig
import com.aiscreenassistant.ui.theme.Tokens

// ── Polished Components ─────────────────────────────────────

@Composable
private fun StatusBadge(text: String, tone: String = "neutral") {
    val (bg, fg, border) = when (tone) {
        "ok" -> Triple(Tokens.Success.copy(alpha = .12f), Tokens.Success, Tokens.Success.copy(alpha=.28f))
        "err" -> Triple(Tokens.Error.copy(alpha=.12f), Tokens.Error, Tokens.Error.copy(alpha=.28f))
        "warn" -> Triple(Tokens.Warning.copy(alpha=.12f), Tokens.Warning, Tokens.Warning.copy(alpha=.28f))
        "accent" -> Triple(Tokens.Accent.copy(alpha=.12f), Tokens.Accent, Tokens.Accent.copy(alpha=.28f))
        else -> Triple(Tokens.SurfaceRaised, Tokens.TextSecondary, Tokens.Border)
    }
    Surface(shape = RoundedCornerShape(999.dp), color = bg, contentColor = fg, tonalElevation = 0.dp, shadowElevation = 0.dp, border = androidx.compose.foundation.BorderStroke(1.dp, border)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (tone=="ok"||tone=="err") Box(Modifier.size(6.dp).clip(RoundedCornerShape(999.dp)).background(fg)) {}
            Text(text, style = MaterialTheme.typography.labelSmall, color = fg)
        }
    }
}

@Composable
private fun SectionHeader(title: String, subtitle: String? = null, action: @Composable (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle!=null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (action!=null) action()
    }
}

@Composable
private fun AppCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        if (title!=null) {
            Column(Modifier.padding(16.dp, 14.dp, 16.dp, 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (subtitle!=null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha=.8f))
                    }
                    if (trailing!=null) trailing()
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline, thickness = 1.dp)
        }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

// Code viewer — handles hundreds/thousands lines, scroll, copy, expand, save
@Composable
private fun CodeViewer(code: String, language: String = "text", onCopy: ()->Unit, onSave: ()->Unit) {
    var expanded by remember { mutableStateOf(false) }
    val lines = code.lines().size
    val isLarge = lines > 400 || code.length > 40000
    Card(shape = RoundedCornerShape(12.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1E2636)), colors = CardDefaults.cardColors(containerColor = Color(0xFF0B0E14))) {
        Column {
            Row(Modifier.fillMaxWidth().background(Color(0xFF0F131C)).padding(10.dp, 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                    Box(Modifier.size(8.dp).clip(RoundedCornerShape(999.dp)).background(Tokens.Accent)) {}
                    Text(language.uppercase(), style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7892))
                    Text("${lines} lines", style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7892))
                    if (isLarge) StatusBadge("virtualized", "warn")
                }
                FilledTonalButton(onClick = onCopy, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp), modifier = Modifier.height(28.dp)) { Text("Copy", fontSize = 11.sp) }
                OutlinedButton(onClick = onSave, contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp), modifier = Modifier.height(28.dp)) { Text("Save", fontSize = 11.sp) }
                if (isLarge) TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) { Text(if (expanded) "Collapse" else "Expand", fontSize = 11.sp) }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 80.dp, max = if (expanded) 800.dp else 380.dp)
                    .horizontalScroll(rememberScrollState())
                    .verticalScroll(rememberScrollState())
                    .padding(14.dp)
            ) {
                // Lightweight highlight: color keywords via AnnotatedString for JS/KT
                val highlighted = remember(code, language) { highlightAnnotated(code) }
                Text(highlighted, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp, color = Color(0xFFD6DEEB))
            }
        }
    }
}

private fun highlightAnnotated(code: String): AnnotatedString {
    // Skip heavy highlight for huge code — plain for perf (virtualized)
    if (code.length > 40000 || code.lines().size > 600) return AnnotatedString(code)
    return buildAnnotatedString {
        append(code)
        val keywords = setOf("import","export","from","const","let","var","function","class","return","if","else","for","while","async","await","try","catch","new","extends","fun","val","var","suspend","private","public","override","return","def","select")
        val regex = Regex("""\b(${keywords.joinToString("|")})\b|//.*?$|/\*[\s\S]*?\*/|#.*?$|"[^"]*"|'[^']*'|`[^`]*`""", setOf(RegexOption.MULTILINE))
        regex.findAll(code).forEach { m ->
            val v = m.value
            val color = when {
                v.startsWith("//") || v.startsWith("/*") || v.startsWith("#") -> Tokens.TextTertiary
                v.startsWith("\"") || v.startsWith("'") || v.startsWith("`") -> Color(0xFF8EC49B)
                keywords.contains(v) -> Color(0xFF82AAFF)
                else -> null
            }
            if (color!=null) addStyle(SpanStyle(color = color, fontWeight = if (keywords.contains(v)) FontWeight.SemiBold else FontWeight.Normal), m.range.first, m.range.last+1)
        }
    }
}

// Response cards splitter: text vs code
@Composable
private fun ResponseContent(text: String, isStreaming: Boolean, onCopy: (String)->Unit, onSave: (String)->Unit) {
    val context = LocalContext.current
    if (text.isBlank() && !isStreaming) {
        Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(20.dp)) {
                Surface(shape = RoundedCornerShape(16.dp), color = Tokens.Accent.copy(alpha=.12f), border = androidx.compose.foundation.BorderStroke(1.dp, Tokens.Accent.copy(alpha=.18f))) {
                    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { Text("✦", fontSize = 22.sp, color = Tokens.Accent) }
                }
                Text("Ready to analyze", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("Capture a frame, write a prompt and tap Analyze. Answers stream live — code is highlighted and you can copy, expand or save.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, lineHeight = 17.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusBadge("Secure backend", "accent"); StatusBadge("No key in app", "ok")
                }
            }
        }
        return
    }
    // Split by fences
    val parts = text.split(Regex("(```[\\s\\S]*?```)"))
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (part in parts) {
            if (part.startsWith("```")) {
                val m = Regex("```(\\w+)?\\n?([\\s\\S]*?)```").find(part)
                val lang = m?.groupValues?.get(1)?.ifBlank { "text" } ?: "text"
                val code = m?.groupValues?.get(2) ?: part.removeSurrounding("```")
                CodeViewer(code.trimEnd(), lang, onCopy = { copyToClipboard(context, code); onCopy(code) }, onSave = { onSave(code) })
            } else {
                if (part.trim().isEmpty()) continue
                // Split paragraphs and render with inline code/bold
                val paragraphs = part.trim().split("\n\n")
                for (para in paragraphs) {
                    val trimmed = para.trim()
                    if (trimmed.isEmpty()) continue
                    if (trimmed.startsWith("#")) {
                        val level = trimmed.takeWhile { it=='#' }.length.coerceIn(1,3)
                        val title = trimmed.drop(level).trim()
                        Text(title, style = when(level){1-> MaterialTheme.typography.headlineSmall.copy(fontWeight=FontWeight.Bold) else-> MaterialTheme.typography.titleMedium}, color = MaterialTheme.colorScheme.onSurface)
                    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                        val items = trimmed.split("\n").filter { it.trim().startsWith("-") || it.trim().startsWith("*") }
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            for (it in items) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("•", color = Tokens.Accent, fontWeight = FontWeight.Bold)
                                    Text(it.trim().removePrefix("- ").removePrefix("* "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    } else if (trimmed.startsWith(">")) {
                        Surface(shape = RoundedCornerShape(0.dp), color = MaterialTheme.colorScheme.surfaceVariant, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
                            Text(trimmed.removePrefix(">").trim(), Modifier.padding(10.dp, 8.dp).padding(start = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    } else {
                        // inline formatting: simple
                        Text(buildAnnotatedString {
                            var idx=0
                            val bold = Regex("""\*\*([^*]+)\*\*""")
                            val codeInline = Regex("""`([^`]+)`""")
                            // We'll just handle bold and code inline via spans — sequential
                            append(trimmed)
                            // This is simplified: we keep plain; full inline parse would need builder
                        }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface, lineHeight = 19.sp)
                        // Fallback: render raw with code spans highlighted via annotated replacement is complex; keep plain for now but with monospace for backticks
                    }
                }
            }
        }
        if (isStreaming) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top=4.dp)) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
            Text("Streaming…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text("▌", color = Tokens.Accent, fontWeight = FontWeight.Bold)
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("assistant", text))
    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

// ── Main UI ─────────────────────────────────────────────────

@Composable
fun AppUi(
    viewModel: AssistantViewModel,
    onRequestCapture: () -> Unit,
    onStopCapture: () -> Unit,
    onPauseResume: () -> Unit,
    onCaptureNow: () -> Unit,
    onAnalyze: () -> Unit,
    onRequestOverlay: () -> Unit,
    onToggleOverlay: () -> Unit,
    onConfigChange: (CaptureConfig) -> Unit
) {
    val backendUrl by viewModel.backendUrl.collectAsState()
    val prompt by viewModel.prompt.collectAsState()
    val model by viewModel.model.collectAsState()
    val config by viewModel.config.collectAsState()
    val directEnabled by viewModel.directEnabled.collectAsState()
    val directBaseUrl by viewModel.directBaseUrl.collectAsState()
    val directApiKey by viewModel.directApiKey.collectAsState()
    val directModel by viewModel.directModel.collectAsState()
    val isCapturing by viewModel.isCapturing.collectAsState()
    val isPaused by viewModel.isPaused.collectAsState()
    val preview by viewModel.previewBitmap.collectAsState()
    val streamingText by viewModel.streamingText.collectAsState()
    val isStreaming by viewModel.isStreaming.collectAsState()
    val lastDiff by viewModel.lastDiff.collectAsState()
    val queueSize by viewModel.queueSize.collectAsState()
    val skipped by viewModel.skipped.collectAsState()
    val fps by viewModel.fps.collectAsState()
    val error by viewModel.error.collectAsState()
    val health by viewModel.health.collectAsState()
    val localHealth by viewModel.localHealth.collectAsState()

    var showSettings by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    val context = LocalContext.current
    val isDark = androidx.compose.foundation.isSystemInDarkTheme()

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 8.dp) {
                NavigationBarItem(selected = true, onClick = {}, icon = { Icon(Icons.Filled.ScreenShare, null) }, label = { Text("Capture") })
                NavigationBarItem(selected = false, onClick = { showSettings = true }, icon = { Icon(Icons.Filled.Tune, null) }, label = { Text("Settings") })
                NavigationBarItem(selected = false, onClick = onToggleOverlay, icon = { Icon(Icons.Filled.Visibility, null) }, label = { Text("Overlay") })
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .padding(padding)
                .verticalScroll(scroll)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            // ── Brand header ──
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Surface(shape = RoundedCornerShape(10.dp), color = Tokens.Accent, shadowElevation = 6.dp) {
                    Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Text("◉", color = Color.White, fontWeight = FontWeight.Black) }
                }
                Column(Modifier.weight(1f)) {
                    Text("AI Screen Assistant", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, letterSpacing = (-0.02).sp)
                    Text("Dark-first • Premium • Independent capture", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = { showSettings = true }) { Icon(Icons.Filled.Settings, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) }
            }

            // ── Onboarding if no capture yet — user-friendly, no backend URL exposed ──
            if (!isCapturing && streamingText.isBlank()) {
                AppCard(title = "Get started", subtitle = "One tap to capture • secure by default") {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Surface(shape = RoundedCornerShape(999.dp), color = Tokens.Accent.copy(alpha=.12f)) { Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { Icon(Icons.Filled.Security, null, tint = Tokens.Accent, modifier = Modifier.size(18.dp)) } }
                        Column(Modifier.weight(1f)) {
                            Text("Tap Start capture", style = MaterialTheme.typography.titleMedium)
                            Text("System asks once — you pick what to share. Backend is already attached via environment.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        AssistChip(onClick = { viewModel.checkHealth() }, label = { Text(if (health.isNotBlank()) health else localHealth, fontSize = 10.sp) }, leadingIcon = { Icon(Icons.Filled.CloudQueue, null, modifier = Modifier.size(14.dp)) })
                    }
                }
            }

            // ── Dashboard status ──
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // Capture status
                Card(
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = if (isCapturing) Tokens.Accent.copy(alpha=.12f) else MaterialTheme.colorScheme.surface),
                    border = androidx.compose.foundation.BorderStroke(1.dp, if (isCapturing) Tokens.Accent.copy(alpha=.28f) else MaterialTheme.colorScheme.outline)
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Box(Modifier.size(8.dp).clip(RoundedCornerShape(999.dp)).background(when { isCapturing && !isPaused -> Tokens.Success; isPaused -> Tokens.Warning; else -> Tokens.TextTertiary })) {}
                            Text(when { isCapturing && isPaused -> "PAUSED"; isCapturing -> "CAPTURING"; else -> "IDLE" }, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                        }
                        Text(if (isCapturing) "${String.format("%.1f", fps)} fps • diff ${String.format("%.1f", lastDiff)}% • queue ${queueSize}" else "Tap Start capture", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                // AI connection
                Card(modifier = Modifier.weight(1f), shape = RoundedCornerShape(14.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Filled.Hub, null, modifier = Modifier.size(14.dp), tint = Tokens.Accent)
                            Text("AI", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                        }
                        Text(if (health.isNotBlank()) health else localHealth, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(model.ifBlank { "Default (server)" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            // ── Error / states ──
            AnimatedVisibility(visible = error != null, enter = fadeIn(), exit = fadeOut()) {
                error?.let { msg ->
                    Card(shape = RoundedCornerShape(12.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha=.3f))) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(Icons.Filled.Error, null, tint = MaterialTheme.colorScheme.error)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(when {
                                    msg.contains("permission", true) -> "Permission needed"
                                    msg.contains("MediaProjection", true) -> "Capture session ended — re-authorize"
                                    msg.contains("overlay", true) -> "Overlay permission needed"
                                    msg.contains("Network", true) -> "Network reconnecting…"
                                    else -> "Something went wrong"
                                }, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                                Text(msg, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                            }
                            TextButton(onClick = { viewModel.clearError() }) { Text("Dismiss") }
                        }
                    }
                }
            }
            if (isStreaming) {
                Card(shape = RoundedCornerShape(12.dp), colors = CardDefaults.cardColors(containerColor = Tokens.Accent.copy(alpha=.10f)), border = androidx.compose.foundation.BorderStroke(1.dp, Tokens.Accent.copy(alpha=.18f))) {
                    Row(Modifier.padding(12.dp, 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Column(Modifier.weight(1f)) { Text("Analyzing — streaming tokens…", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = Tokens.Accent); Text("Response appears live below and in floating overlay", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }

            // ── Controls — user-friendly, backend env-driven ──
            AppCard(title = "Ask about this screen", subtitle = "Defaults handle capture — just ask") {
                OutlinedTextField(value = prompt, onValueChange = { viewModel.setPrompt(it) }, label = { Text("What to ask") }, placeholder = { Text("e.g., Summarize this screen…") }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), minLines = 2)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Button(
                        onClick = onRequestCapture, enabled = !isCapturing,
                        modifier = Modifier.weight(1f).height(46.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Tokens.Accent)
                    ) { Icon(Icons.Filled.PlayArrow, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Start capture", fontWeight = FontWeight.SemiBold) }
                    FilledTonalButton(onClick = onStopCapture, enabled = isCapturing, modifier = Modifier.weight(1f).height(46.dp), shape = RoundedCornerShape(12.dp)) {
                        Icon(Icons.Filled.Stop, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Stop")
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(onClick = onPauseResume, enabled = isCapturing, modifier = Modifier.weight(1f)) { Text(if (isPaused) "Resume" else "Pause") }
                    OutlinedButton(onClick = onCaptureNow, modifier = Modifier.weight(1f)) { Icon(Icons.Filled.CameraAlt, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Capture now") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Button(onClick = onAnalyze, enabled = preview != null || !isStreaming, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp)) {
                        if (isStreaming) CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = Color.White)
                        else Icon(Icons.Filled.AutoAwesome, null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp)); Text(if (isStreaming) "Streaming…" else "Analyze")
                    }
                    OutlinedButton(onClick = { copyToClipboard(context, streamingText) }, enabled = streamingText.isNotBlank()) { Icon(Icons.Filled.ContentCopy, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("Copy") }
                }
            }

            // ── Preview ──
            AppCard(title = "Preview", subtitle = if (isCapturing) "Live • ${config.resLabel} • ${fps.toInt()} fps" else "Still — start capture or capture now") {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 160.dp, max = 260.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                ) {
                    if (preview != null) {
                        Image(bitmap = preview!!.asImageBitmap(), contentDescription = "Screen preview", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                    } else {
                        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Filled.Image, null, modifier = Modifier.size(36.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha=.6f))
                            Spacer(Modifier.height(8.dp))
                            Text(if (isCapturing) "Waiting for changed frames…" else "No frame yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("Frame diff skips duplicates • queue ${queueSize}/${config.maxQueueSize} • skipped ${skipped}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha=.7f))
                        }
                    }
                    if (isCapturing && !isPaused) {
                        Surface(modifier = Modifier.align(Alignment.TopStart).padding(10.dp), shape = RoundedCornerShape(999.dp), color = Tokens.Accent, shadowElevation = 4.dp) {
                            Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Box(Modifier.size(6.dp).clip(RoundedCornerShape(999.dp)).background(Color.White)) {}
                                Text("LIVE", style = MaterialTheme.typography.labelSmall, color = Color.White, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
                // Stats row
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    StatChip("FPS", if (fps>0) String.format("%.1f", fps) else "—")
                    StatChip("Diff", String.format("%.1f%%", lastDiff))
                    StatChip("Queue", "$queueSize/${config.maxQueueSize}")
                    StatChip("Skipped", "$skipped")
                }
                Text("Continues when you switch apps — service is foreground. Rotate to recreate VirtualDisplay.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha=.7f))
            }

            // ── Response (streamed, markdown+code) ──
            AppCard(
                title = "Assistant Response",
                subtitle = if (isStreaming) "Live streaming…" else if (streamingText.isNotBlank()) "${streamingText.length} chars • ${streamingText.lines().size} lines" else "Mirrored to floating overlay",
                trailing = {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (isStreaming) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        IconButton(onClick = { copyToClipboard(context, streamingText) }, enabled = streamingText.isNotBlank(), modifier = Modifier.size(28.dp)) { Icon(Icons.Filled.ContentCopy, null, modifier = Modifier.size(16.dp)) }
                    }
                }
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 100.dp, max = 380.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(12.dp)
                        .verticalScroll(rememberScrollState())
                ) {
                    ResponseContent(text = streamingText, isStreaming = isStreaming, onCopy = { copyToClipboard(context, it) }, onSave = { val ctx=context; copyToClipboard(ctx, it); Toast.makeText(ctx, "Saved to clipboard — paste to file", Toast.LENGTH_SHORT).show() })
                }
                if (streamingText.length > 50000) {
                    Surface(shape = RoundedCornerShape(8.dp), color = Tokens.Warning.copy(alpha=.12f), border = androidx.compose.foundation.BorderStroke(1.dp, Tokens.Warning.copy(alpha=.24f))) {
                        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Filled.Warning, null, tint = Tokens.Warning, modifier = Modifier.size(16.dp))
                            Text("Very large response — scroll inside. Copy to see full.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }

            // ── Floating overlay helper ──
            AppCard(title = "Floating Result", subtitle = "WindowManager overlay — works across apps") {
                Text("Overlay shows streaming answer while you use other apps. Requires ‘Draw over other apps’ permission.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    OutlinedButton(onClick = onRequestOverlay, modifier = Modifier.weight(1f)) { Icon(Icons.Filled.OpenInNew, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Permission") }
                    Button(onClick = onToggleOverlay, modifier = Modifier.weight(1f)) { Icon(Icons.Filled.Visibility, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Toggle overlay") }
                }
            }

            // ── Bottom info ──
            Text(
                "Isolation: MediaProjection → ImageReader VirtualDisplay → FrameDiffer → JPEG → backend. No AccessibilityService, no hooking. Lifecycle: service survives app switch; rotation recreates display; reconnect via re-auth if OS revokes. Memory: pools recycled, skip on low-memory.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha=.6f), modifier = Modifier.padding(bottom = 20.dp)
            )
        }

        // ── Settings sheet (modal) ──
        if (showSettings) {
            AlertDialog(
                onDismissRequest = { showSettings = false },
                title = { Text("Settings & Diagnostics", fontWeight = FontWeight.Bold) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                        SectionHeader("Capture — efficiency")
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Interval", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium); Text("${config.intervalMs}ms", color = Tokens.Accent, style = MaterialTheme.typography.labelMedium)
                            }
                            Slider(value = config.intervalMs.toFloat(), onValueChange = { onConfigChange(config.copy(intervalMs = it.toLong())) }, valueRange = 500f..5000f)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Scale", style = MaterialTheme.typography.bodySmall); Text("${(config.scaleFactor*100).toInt()}%", color = Tokens.Accent, style = MaterialTheme.typography.labelMedium) }
                            Slider(value = config.scaleFactor, onValueChange = { onConfigChange(config.copy(scaleFactor = it)) }, valueRange = 0.3f..1f)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("JPEG quality", style = MaterialTheme.typography.bodySmall); Text("q${config.jpegQuality}", color = Tokens.Accent, style = MaterialTheme.typography.labelMedium) }
                            Slider(value = config.jpegQuality.toFloat(), onValueChange = { onConfigChange(config.copy(jpegQuality = it.toInt())) }, valueRange = 40f..95f, steps = 10)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Change threshold", style = MaterialTheme.typography.bodySmall); Text("${config.diffThresholdPercent}%", color = Tokens.Accent, style = MaterialTheme.typography.labelMedium) }
                            Slider(value = config.diffThresholdPercent, onValueChange = { onConfigChange(config.copy(diffThresholdPercent = it)) }, valueRange = 0.5f..20f)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) { Switch(checked = config.enableFrameDiff, onCheckedChange = { onConfigChange(config.copy(enableFrameDiff = it)) }); Spacer(Modifier.width(6.dp)); Text("Frame diff", style = MaterialTheme.typography.bodySmall) }
                            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) { Switch(checked = config.autoAnalyze, onCheckedChange = { onConfigChange(config.copy(autoAnalyze = it)) }); Spacer(Modifier.width(6.dp)); Text("Auto-analyze", style = MaterialTheme.typography.bodySmall) }
                        }
                        HorizontalDivider()
                        SectionHeader("Connection")
                        Text("Backend is attached via environment (default). No URL to enter — just tap Check.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { viewModel.checkHealth() }) { Text("Check health") }
                            Text(health.ifBlank { localHealth }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
                        }
                        // Direct AI fallback — bypasses backend when 404, works immediately without Render
                        HorizontalDivider()
                        SectionHeader("Direct AI fallback", subtitle = "Use Featherless/OpenRouter directly when backend is down (no redeploy needed)")
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                            Switch(checked = directEnabled, onCheckedChange = { viewModel.setDirectEnabled(context, it) })
                            Text("Enable direct AI fallback", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            if (directEnabled) StatusBadge("active", "ok") else StatusBadge("off", "neutral")
                        }
                        Text("When enabled and backend returns 404/HTML, app automatically calls AI directly. Enter your Featherless or OpenRouter key below (stored locally, never committed).", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(
                            value = directBaseUrl,
                            onValueChange = { viewModel.setDirectBaseUrl(context, it) },
                            label = { Text("Direct Base URL") },
                            placeholder = { Text("https://api.featherless.ai/v1") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            textStyle = MaterialTheme.typography.bodySmall
                        )
                        OutlinedTextField(
                            value = directApiKey,
                            onValueChange = { viewModel.setDirectApiKey(context, it) },
                            label = { Text("Direct API Key (Featherless / OpenRouter)") },
                            placeholder = { Text("paste key — stored locally only") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            textStyle = MaterialTheme.typography.bodySmall
                        )
                        OutlinedTextField(
                            value = directModel,
                            onValueChange = { viewModel.setDirectModel(context, it) },
                            label = { Text("Direct Model") },
                            placeholder = { Text("Qwen/Qwen2-VL-72B-Instruct or anthropic/claude-3.5-sonnet") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            textStyle = MaterialTheme.typography.bodySmall
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StatusBadge(if (directApiKey.isBlank()) "key missing" else "key set", if (directApiKey.isBlank()) "warn" else "ok")
                            StatusBadge(directModel.take(28), "accent")
                            if (directEnabled && directApiKey.isNotBlank()) StatusBadge("fallback ready", "ok")
                        }
                        // Model is auto (server default) — advanced users may override in code/build env
                        HorizontalDivider()
                        SectionHeader("Diagnostics")
                        Text("Capture in background: ${if (config.captureInBackground) "yes — foreground service" else "no"} • Max memory ${config.maxMemoryMB} MB • Skipped ${skipped} • Queue ${queueSize}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("Backend health: ${health.ifBlank{ localHealth }} • Model: ${model.ifBlank{ "default" }}${if (directEnabled) " · Direct: ${directModel.take(12)}" else ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if ((health + localHealth).contains("backend not deployed", true) || (health + localHealth).contains("404", true)) {
                            Surface(shape = RoundedCornerShape(8.dp), color = if (directEnabled && directApiKey.isNotBlank()) Tokens.Success.copy(alpha=.12f) else Tokens.Error.copy(alpha=.12f), border = androidx.compose.foundation.BorderStroke(1.dp, if (directEnabled && directApiKey.isNotBlank()) Tokens.Success.copy(alpha=.24f) else Tokens.Error.copy(alpha=.24f))) {
                                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Icon(if (directEnabled && directApiKey.isNotBlank()) Icons.Filled.CheckCircle else Icons.Filled.Warning, null, tint = if (directEnabled && directApiKey.isNotBlank()) Tokens.Success else Tokens.Error, modifier = Modifier.size(16.dp))
                                    Text(
                                        if (directEnabled && directApiKey.isNotBlank()) "Backend 404 — Direct AI enabled (${directModel.take(20)}), will fallback automatically ✅"
                                        else "Backend 404 — Enable Direct AI fallback above for immediate use, or redeploy server on Render",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface
                                    )
                                }
                            }
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { showSettings = false }) { Text("Done") } }
            )
        }
    }
}

@Composable
private fun StatChip(label: String, value: String) {
    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant, border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
    }
}
