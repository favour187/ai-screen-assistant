package com.aiscreenassistant.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ── Design Tokens — mirrored from desktop tokens.css ──
object Tokens {
    // Dark (default)
    val Bg = Color(0xFF090B10)
    val BgSubtle = Color(0xFF0E1117)
    val Surface = Color(0xFF13171F)
    val SurfaceRaised = Color(0xFF191F2E)
    val SurfaceHover = Color(0xFF1E2536)
    val Border = Color(0xFF232B3E)
    val BorderStrong = Color(0xFF2E3951)
    val Text = Color(0xFFEef1F7)
    val TextSecondary = Color(0xFFA0AAC0)
    val TextTertiary = Color(0xFF6D7892)
    val Accent = Color(0xFF5B6CFF)
    val Accent2 = Color(0xFF8B5CF6)
    val Success = Color(0xFF22C55E)
    val Warning = Color(0xFFF59E0B)
    val Error = Color(0xFFEF4444)
    val Info = Color(0xFF38BDF8)
}

// Dark-first palette (premium, minimal, depth)
private val DarkColors = darkColorScheme(
    primary = Tokens.Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF1E2536),
    onPrimaryContainer = Color(0xFFD6DCF0),
    secondary = Tokens.Accent2,
    onSecondary = Color.White,
    background = Tokens.Bg,
    onBackground = Tokens.Text,
    surface = Tokens.Surface,
    onSurface = Tokens.Text,
    surfaceVariant = Tokens.SurfaceRaised,
    onSurfaceVariant = Tokens.TextSecondary,
    outline = Tokens.Border,
    outlineVariant = Tokens.Border,
    error = Tokens.Error,
    onError = Color.White,
    errorContainer = Color(0xFF2A1214),
    onErrorContainer = Color(0xFFFECACA),
    scrim = Color(0x99000000)
)

// Light — activated via system setting or toggle
private val LightColors = lightColorScheme(
    primary = Tokens.Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE6E8FF),
    onPrimaryContainer = Color(0xFF1A1D2E),
    secondary = Tokens.Accent2,
    onSecondary = Color.White,
    background = Color(0xFFF6F7F9),
    onBackground = Color(0xFF0F172A),
    surface = Color.White,
    onSurface = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFF1F4F9),
    onSurfaceVariant = Color(0xFF64748B),
    outline = Color(0xFFE2E7F0),
    outlineVariant = Color(0xFFEEF1F5),
    error = Tokens.Error,
    onError = Color.White,
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
    scrim = Color(0x52000000)
)

private val AppTypography = Typography(
    headlineLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Bold, fontSize = 22.sp, letterSpacing = (-0.02).sp, lineHeight = 26.sp),
    headlineSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, letterSpacing = (-0.01).sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.02.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 19.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 17.sp, color = Tokens.TextSecondary),
    labelSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 10.sp, letterSpacing = 0.06.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.04.sp)
)

private val AppShapes = androidx.compose.material3.Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(24.dp)
)

@Composable
fun AIScreenAssistantTheme(
    darkTheme: Boolean = androidx.compose.foundation.isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colors = if (darkTheme) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, typography = AppTypography, shapes = AppShapes, content = content)
}
