package com.mattssoftware.attackfm

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * What the widget cannot say in XML.
 *
 * RemoteViews are inflated in the LAUNCHER's process: no theme, no custom
 * views, no drawing code. Everything the player's own surfaces do with CSS -
 * the accent the listener chose, the scrubber's squiggle, a cover with the
 * app's corner radius, a plate tinted by the artwork - has to arrive as a
 * BITMAP, drawn here and pushed across.
 *
 * That is a cost worth paying rather than a workaround. A widget built from
 * stock ProgressBars and system media icons is a widget that looks like every
 * other one on the home screen, and this app's whole face is its accent, its
 * corner radius and that squiggle.
 *
 * Everything here is pure: given the same arguments it draws the same pixels,
 * so the provider can cache by argument and redraw only what moved.
 */
object WidgetPaint {

  /** The brand's own pink, when the page has not said otherwise (BRAND_ACCENTS
   *  in the app: 'attack' is #FC427B). */
  const val DEFAULT_ACCENT = 0xFFFC427B.toInt()

  /** The run still to play, in the player's muted rail colour. */
  private const val RAIL = 0x40FFFFFF

  /**
   * The scrubber, as Now Playing paints it: a squiggle behind the playhead in
   * the accent, a flat rail ahead of it, and a slim pill on the join.
   *
   * The player's bar swells with the beat; a home screen has no beat to swell
   * to, so the wave here is the still life of it - a fixed swell that reads as
   * the same object without pretending to be live.
   *
   * @param progress 0..1. Below about one part in a thousand the squiggle is
   *   still drawn at its first crest, so a track at 0:00 shows a bar rather
   *   than an empty box.
   */
  fun wave(widthPx: Int, heightPx: Int, progress: Float, accent: Int): Bitmap {
    val w = max(8, widthPx)
    val h = max(4, heightPx)
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val mid = h / 2f
    val stroke = min(h * 0.34f, 7f).coerceAtLeast(2f)
    val at = (w * progress.coerceIn(0f, 1f))

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
      strokeWidth = stroke
    }

    // The rail first, whole, so the squiggle lands on top of an unbroken line
    // rather than beside a gap the anti-aliasing would show as a seam.
    paint.color = RAIL
    canvas.drawLine(stroke / 2f, mid, w - stroke / 2f, mid, paint)

    if (at <= stroke) {
      drawThumb(canvas, max(stroke, at), mid, h, accent)
      return bmp
    }

    // A swell: amplitude eased in from the left and out at the playhead, so
    // the wave grows out of the line instead of starting mid-crest.
    //
    // 0.62 of the room, not all of it. At full height the squiggle stops
    // reading as a bar with a wave IN it and starts reading as a spring - the
    // player's own bar leaves air above and below the crests, and that air is
    // most of why it looks calm.
    val amp = ((h / 2f - stroke / 2f) * 0.62f).coerceAtLeast(1f)
    // One crest per 40px of the BITMAP, which lands near the player's own
    // wavelength once the ImageView stretches 560px across a four-cell widget.
    // Held in pixels rather than as a count of crests, so a wider widget gets
    // more waves rather than longer ones.
    val period = 40f
    val path = Path()
    var x = stroke / 2f
    var first = true
    while (x <= at) {
      val edge = min(1f, min(x, at - x) / 26f)
      val y = mid + sin(x / period * 2f * Math.PI.toFloat()) * amp * edge
      if (first) {
        path.moveTo(x, y)
        first = false
      } else {
        path.lineTo(x, y)
      }
      x += 1.5f
    }
    paint.color = accent
    canvas.drawPath(path, paint)
    drawThumb(canvas, at, mid, h, accent)
    return bmp
  }

  /** The playhead: the player's slim vertical pill, narrow enough that it
   *  never hides the wave underneath it. */
  private fun drawThumb(canvas: Canvas, x: Float, mid: Float, h: Int, accent: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }
    val halfW = max(1.4f, h * 0.075f)
    val halfH = max(2.5f, h * 0.42f)
    val cx = x.coerceIn(halfW, canvas.width - halfW)
    canvas.drawRoundRect(
      RectF(cx - halfW, mid - halfH, cx + halfW, mid + halfH),
      halfW,
      halfW,
      paint,
    )
  }

  /**
   * The play button: the player's own filled accent disc with a white glyph.
   *
   * Drawn rather than tinted because setColorStateList on a background is
   * Android 12 and up, and this app runs back to 24 - and because the disc
   * carries the accent's own soft halo, which no tint of a shape drawable
   * would give it.
   */
  fun playButton(sizePx: Int, playing: Boolean, accent: Int): Bitmap {
    val s = max(16, sizePx)
    val bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val c = s / 2f
    val r = s / 2f - s * 0.06f

    // The halo, so the disc sits ON the plate rather than being pasted to it.
    canvas.drawCircle(
      c,
      c,
      r + s * 0.05f,
      Paint(Paint.ANTI_ALIAS_FLAG).apply { color = (accent and 0x00FFFFFF) or 0x38000000 },
    )
    canvas.drawCircle(
      c,
      c,
      r,
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = LinearGradient(
          0f, 0f, 0f, s.toFloat(),
          lighten(accent, 0.14f), darken(accent, 0.10f),
          Shader.TileMode.CLAMP,
        )
      },
    )

    val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      style = Paint.Style.FILL
    }
    if (playing) {
      val barW = s * 0.09f
      val barH = s * 0.30f
      val gap = s * 0.07f
      canvas.drawRoundRect(
        RectF(c - gap - barW, c - barH, c - gap, c + barH), barW / 2.4f, barW / 2.4f, glyph,
      )
      canvas.drawRoundRect(
        RectF(c + gap, c - barH, c + gap + barW, c + barH), barW / 2.4f, barW / 2.4f, glyph,
      )
    } else {
      // Nudged right of centre: a triangle centred on its bounding box reads
      // as sitting left, which is the oldest bug in play buttons.
      val h = s * 0.30f
      val path = Path().apply {
        moveTo(c - h * 0.52f + s * 0.035f, c - h)
        lineTo(c + h * 0.95f + s * 0.035f, c)
        lineTo(c - h * 0.52f + s * 0.035f, c + h)
        close()
      }
      glyph.strokeJoin = Paint.Join.ROUND
      glyph.strokeWidth = s * 0.06f
      glyph.style = Paint.Style.FILL_AND_STROKE
      canvas.drawPath(path, glyph)
    }
    return bmp
  }

  /** The cover, square-cropped and rounded the way every cover in the app is. */
  fun cover(source: Bitmap, sizePx: Int, radiusPx: Float): Bitmap {
    val s = max(8, sizePx)
    val out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val scale = s.toFloat() / min(source.width, source.height)
    val matrix = Matrix().apply {
      setScale(scale, scale)
      postTranslate(
        (s - source.width * scale) / 2f,
        (s - source.height * scale) / 2f,
      )
    }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        .apply { setLocalMatrix(matrix) }
    }
    canvas.drawRoundRect(RectF(0f, 0f, s.toFloat(), s.toFloat()), radiusPx, radiusPx, paint)
    return out
  }

  /**
   * The plate, tinted by the cover.
   *
   * Now Playing sits the words on a wash of the artwork; the home screen gets
   * the same idea at a fraction of the strength. The colour is the cover's
   * average pulled hard toward the app's near-black - enough that a red album
   * and a blue one feel different, not enough that anything stops being
   * near-black.
   */
  fun plateTint(art: Bitmap?): Int {
    if (art == null) return 0xF2101014.toInt()
    // A 12x12 read is plenty for an average and costs nothing; scaling the
    // whole cover down IS the averaging.
    val small = Bitmap.createScaledBitmap(art, 12, 12, true)
    var r = 0L
    var g = 0L
    var b = 0L
    for (y in 0 until 12) {
      for (x in 0 until 12) {
        val p = small.getPixel(x, y)
        r += Color.red(p)
        g += Color.green(p)
        b += Color.blue(p)
      }
    }
    if (small !== art) small.recycle()
    val n = 144
    // 0.16 of the cover over the plate: a wash, not a colour.
    val mix = 0.16f
    val base = 0x10
    return Color.argb(
      0xF2,
      (base + (r / n - base) * mix).toInt().coerceIn(0, 255),
      (base + (g / n - base) * mix).toInt().coerceIn(0, 255),
      (base + 4 + (b / n - base - 4) * mix).toInt().coerceIn(0, 255),
    )
  }

  private fun lighten(color: Int, amount: Float): Int = Color.argb(
    Color.alpha(color),
    (Color.red(color) + (255 - Color.red(color)) * amount).toInt().coerceIn(0, 255),
    (Color.green(color) + (255 - Color.green(color)) * amount).toInt().coerceIn(0, 255),
    (Color.blue(color) + (255 - Color.blue(color)) * amount).toInt().coerceIn(0, 255),
  )

  private fun darken(color: Int, amount: Float): Int = Color.argb(
    Color.alpha(color),
    (Color.red(color) * (1f - amount)).toInt().coerceIn(0, 255),
    (Color.green(color) * (1f - amount)).toInt().coerceIn(0, 255),
    (Color.blue(color) * (1f - amount)).toInt().coerceIn(0, 255),
  )

  /** m:ss, or h:mm:ss once a book runs past the hour. */
  fun clock(ms: Long): String {
    val total = max(0L, ms) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) String.format("%d:%02d:%02d", h, m, s) else String.format("%d:%02d", m, s)
  }
}
