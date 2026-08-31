package com.mattssoftware.attackfm.wear

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Lucide, ported by hand - the watch draws the same icons the phone does.
 *
 * There is no Lucide artifact for Compose, and the first cut leaned on emoji
 * glyphs instead, which render as whatever the system font feels like and
 * matched nothing. Each icon here is the actual Lucide path data (24x24,
 * stroke 2, round caps and joins) rebuilt as an ImageVector, so the wrist and
 * the phone speak one icon language.
 *
 * Stroke colour is white and every use goes through Icon's tint, which
 * recolours the whole vector - the white here is only a stand-in.
 */
object Lucide {
    private fun icon(name: String, block: ImageVector.Builder.() -> Unit): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply(block).build()

    private fun ImageVector.Builder.stroke(block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) {
        path(
            fill = null,
            stroke = SolidColor(Color.White),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            pathFillType = PathFillType.NonZero,
            pathBuilder = block,
        )
    }

    /** lucide `play`, filled - the one glyph that reads better solid at 56dp. */
    val Play: ImageVector by lazy {
        icon("play") {
            path(
                fill = SolidColor(Color.White),
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(6f, 3f); lineTo(20f, 12f); lineTo(6f, 21f); close()
            }
        }
    }

    /** lucide `pause`, filled to match Play. */
    val Pause: ImageVector by lazy {
        icon("pause") {
            path(fill = SolidColor(Color.White)) {
                moveTo(5f, 4f); lineTo(9f, 4f); lineTo(9f, 20f); lineTo(5f, 20f); close()
            }
            path(fill = SolidColor(Color.White)) {
                moveTo(15f, 4f); lineTo(19f, 4f); lineTo(19f, 20f); lineTo(15f, 20f); close()
            }
        }
    }

    /** lucide `skip-back`. */
    val SkipBack: ImageVector by lazy {
        icon("skip-back") {
            path(fill = SolidColor(Color.White), stroke = SolidColor(Color.White), strokeLineWidth = 2f, strokeLineJoin = StrokeJoin.Round) {
                moveTo(19f, 20f); lineTo(9f, 12f); lineTo(19f, 4f); close()
            }
            stroke { moveTo(5f, 19f); lineTo(5f, 5f) }
        }
    }

    /** lucide `skip-forward`. */
    val SkipForward: ImageVector by lazy {
        icon("skip-forward") {
            path(fill = SolidColor(Color.White), stroke = SolidColor(Color.White), strokeLineWidth = 2f, strokeLineJoin = StrokeJoin.Round) {
                moveTo(5f, 4f); lineTo(15f, 12f); lineTo(5f, 20f); close()
            }
            stroke { moveTo(19f, 5f); lineTo(19f, 19f) }
        }
    }

    /** lucide `delete` - the backspace key. */
    val Delete: ImageVector by lazy {
        icon("delete") {
            stroke {
                moveTo(20f, 5f); lineTo(9f, 5f); lineTo(2f, 12f); lineTo(9f, 19f); lineTo(20f, 19f)
                arcTo(2f, 2f, 0f, false, false, 22f, 17f); lineTo(22f, 7f)
                arcTo(2f, 2f, 0f, false, false, 20f, 5f); close()
            }
            stroke { moveTo(18f, 9f); lineTo(12f, 15f) }
            stroke { moveTo(12f, 9f); lineTo(18f, 15f) }
        }
    }

    /** lucide `check` - the Go key. */
    val Check: ImageVector by lazy {
        icon("check") { stroke { moveTo(4f, 12f); lineTo(9f, 17f); lineTo(20f, 6f) } }
    }

    /** lucide `minus` / `plus` - the volume ends. */
    val Minus: ImageVector by lazy {
        icon("minus") { stroke { moveTo(5f, 12f); lineTo(19f, 12f) } }
    }
    val Plus: ImageVector by lazy {
        icon("plus") {
            stroke { moveTo(5f, 12f); lineTo(19f, 12f) }
            stroke { moveTo(12f, 5f); lineTo(12f, 19f) }
        }
    }

    /** lucide `music` - the track placeholder where art has not landed. */
    val Music: ImageVector by lazy {
        icon("music") {
            stroke { moveTo(9f, 18f); lineTo(9f, 5f); lineTo(21f, 3f); lineTo(21f, 16f) }
            stroke {
                moveTo(9f, 18f)
                arcTo(3f, 3f, 0f, true, true, 3f, 18f)
                arcTo(3f, 3f, 0f, true, true, 9f, 18f)
            }
            stroke {
                moveTo(21f, 16f)
                arcTo(3f, 3f, 0f, true, true, 15f, 16f)
                arcTo(3f, 3f, 0f, true, true, 21f, 16f)
            }
        }
    }

    /** lucide `log-out`. */
    val LogOut: ImageVector by lazy {
        icon("log-out") {
            stroke {
                moveTo(9f, 21f); lineTo(5f, 21f)
                arcTo(2f, 2f, 0f, false, true, 3f, 19f); lineTo(3f, 5f)
                arcTo(2f, 2f, 0f, false, true, 5f, 3f); lineTo(9f, 3f)
            }
            stroke { moveTo(16f, 17f); lineTo(21f, 12f); lineTo(16f, 7f) }
            stroke { moveTo(21f, 12f); lineTo(9f, 12f) }
        }
    }

    /** lucide `heart` - the Liked shelf's mark. */
    val Heart: ImageVector by lazy {
        icon("heart") {
            stroke {
                moveTo(19f, 14f)
                curveTo(20.49f, 12.54f, 22f, 10.79f, 22f, 8.5f)
                arcTo(5.5f, 5.5f, 0f, false, false, 16.5f, 3f)
                curveTo(14.76f, 3f, 13.09f, 3.81f, 12f, 5.09f)
                curveTo(10.91f, 3.81f, 9.24f, 3f, 7.5f, 3f)
                arcTo(5.5f, 5.5f, 0f, false, false, 2f, 8.5f)
                curveTo(2f, 10.79f, 3.51f, 12.54f, 5f, 14f)
                lineTo(12f, 21f); lineTo(19f, 14f); close()
            }
        }
    }

    /** lucide `watch` - the sign-in face's own mark. */
    val Watch: ImageVector by lazy {
        icon("watch") {
            stroke {
                moveTo(18f, 12f)
                arcTo(6f, 6f, 0f, true, true, 6f, 12f)
                arcTo(6f, 6f, 0f, true, true, 18f, 12f)
            }
            stroke { moveTo(12f, 10f); lineTo(12f, 12f); lineTo(13.5f, 13.5f) }
            stroke { moveTo(16.13f, 7.66f); lineTo(15.6f, 2.9f); arcTo(1f, 1f, 0f, false, false, 14.6f, 2f); lineTo(9.4f, 2f); arcTo(1f, 1f, 0f, false, false, 8.4f, 2.9f); lineTo(7.87f, 7.66f) }
            stroke { moveTo(7.88f, 16.36f); lineTo(8.4f, 21.1f); arcTo(1f, 1f, 0f, false, false, 9.4f, 22f); lineTo(14.6f, 22f); arcTo(1f, 1f, 0f, false, false, 15.6f, 21.1f); lineTo(16.12f, 16.36f) }
        }
    }
}
