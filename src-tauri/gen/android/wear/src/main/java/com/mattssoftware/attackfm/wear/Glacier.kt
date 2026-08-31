package com.mattssoftware.attackfm.wear

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/**
 * GlacierUI, translated - not run.
 *
 * The kit itself is React and CSS, and Wear OS has no WebView to render either,
 * so the watch cannot RUN Glacier. What it can carry is the design language:
 * these are the kit's dark-theme token values (vendor/@glacier/tokens) with the
 * app's own Attack accent, hand-converted once, so the watch reads as the same
 * product as the phone even though not one line of the kit executes here.
 *
 * Dark only, deliberately: Wear OS is a dark platform (OLED, always-on), and
 * the kit's dark ramp is the one the app actually wears.
 */
object Glacier {
    /** --glacier-gray-1 (dark): the app's ground. */
    val bg = Color(0xFF101014)

    /** --glacier-gray-3 (dark): raised surfaces, chips, buttons at rest. */
    val surface = Color(0xFF232329)

    /** --glacier-gray-12 (dark): primary ink. */
    val text = Color(0xFFEDEDF2)

    /** --glacier-gray-11 (dark): secondary ink. */
    val textMuted = Color(0xFFB9B7C2)

    /** The Attack accent - the pink the whole app wears. */
    val accent = Color(0xFFE0245E)

    /** Ink on an accent-filled control. */
    val onAccent = Color(0xFFFFFFFF)
}

@Composable
fun GlacierTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colors = Colors(
            primary = Glacier.accent,
            primaryVariant = Glacier.accent,
            secondary = Glacier.accent,
            secondaryVariant = Glacier.accent,
            background = Glacier.bg,
            surface = Glacier.surface,
            error = Color(0xFFFF5470),
            onPrimary = Glacier.onAccent,
            onSecondary = Glacier.onAccent,
            onBackground = Glacier.text,
            onSurface = Glacier.text,
            onSurfaceVariant = Glacier.textMuted,
            onError = Glacier.onAccent,
        ),
        content = content,
    )
}
