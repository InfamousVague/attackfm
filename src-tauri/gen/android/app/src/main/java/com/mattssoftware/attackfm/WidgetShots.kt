package com.mattssoftware.attackfm

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.io.File

/**
 * The photographs the page takes of the widget's face.
 *
 * A RemoteViews tree is inflated by the LAUNCHER, which has no WebView, no CSS
 * and no React, so the app's actual interface cannot be drawn there. What CAN
 * cross the process boundary is a picture - so the page renders the face with
 * the real components and hands the bytes over, and the launcher is shown that.
 * See src/app/widget/shot.ts for the other end.
 *
 * KEPT ON DISK, not just in memory. The page is the only thing that can take a
 * picture and the page dies with the app, so a widget whose only copy lived in
 * this process would go blank the moment the app was swiped away - which is
 * most of the time a home screen is being looked at. The last picture of each
 * face survives on disk and is what a cold launcher gets.
 */
object WidgetShots {

  /** One file per face, overwritten in place - only the newest is ever wanted. */
  private fun file(context: Context, face: String): File =
    File(context.filesDir, "widget-$face.png")

  /** Decoded pictures, so a push does not re-read and re-decode a file that has
   *  not changed. Small: three faces, and only one is ever on screen. */
  private val warm = HashMap<String, Bitmap>()

  /**
   * A fresh photograph from the page.
   *
   * Written to disk first and only then hung in front of the launcher, so a
   * process killed mid-write leaves the previous picture rather than half of
   * this one.
   */
  fun receive(context: Context, face: String, base64: String) {
    val bytes = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      android.util.Log.w("AFMedia", "widget shot for $face was not base64")
      return
    }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    if (bitmap == null) {
      android.util.Log.w("AFMedia", "widget shot for $face did not decode")
      return
    }
    try {
      val tmp = File(context.filesDir, "widget-$face.png.part")
      tmp.writeBytes(bytes)
      tmp.renameTo(file(context, face))
    } catch (e: Exception) {
      // A picture that cannot be kept still works for this session.
      android.util.Log.w("AFMedia", "could not keep the $face shot: $e")
    }
    synchronized(warm) { warm[face] = bitmap }
    NowPlayingWidget.refresh(context)
  }

  /** The newest picture of one face, or null if none has ever been taken. */
  fun latest(context: Context, face: String): Bitmap? {
    synchronized(warm) { warm[face]?.let { return it } }
    val f = file(context, face)
    if (!f.exists()) return null
    val bitmap = try {
      BitmapFactory.decodeFile(f.absolutePath)
    } catch (e: Exception) {
      null
    } ?: return null
    synchronized(warm) { warm[face] = bitmap }
    return bitmap
  }

  /**
   * Ask the page for a picture of one face at one size.
   *
   * Sent down the transport channel the car and the lock screen already use,
   * which is what makes it survive the app not running: that path holds a
   * command until a page exists to answer it, rather than dropping it.
   *
   * Rate-limited per face. A launcher will happily ask several times for the
   * same box - a placement, then a size report, then a restore - and each of
   * those would otherwise be a full render and a megabyte of PNG across the
   * bridge for a picture that has not changed.
   */
  private val askedAt = HashMap<String, Long>()

  fun request(context: Context, face: String, widthDp: Int, heightDp: Int, force: Boolean) {
    val key = "$face:${widthDp}x$heightDp"
    val now = android.os.SystemClock.elapsedRealtime()
    synchronized(askedAt) {
      val last = askedAt[key] ?: 0L
      if (!force && now - last < MIN_GAP_MS) return
      askedAt[key] = now
    }
    val density = context.resources.displayMetrics.density
    MainActivity.deliverTransport(
      null,
      "widget:$face:${widthDp}x$heightDp@${"%.2f".format(density)}",
    )
  }

  /**
   * The floor between two pictures of the same face at the same size.
   *
   * The scrubber is the only thing that moves on its own, and it moves about a
   * pixel a second on a four-cell widget - so a picture every ten seconds is
   * already finer than the thing it is drawing. Anything faster is a render, a
   * PNG encode and a bridge crossing for a difference nobody can see.
   */
  private const val MIN_GAP_MS = 9_500L

  /** Forget everything. Used when the music stops, so the idle face is not
   *  answered with a photograph of a song that is no longer playing. */
  fun clear(context: Context) {
    synchronized(warm) { warm.clear() }
    for (face in arrayOf("compact", "medium", "large")) file(context, face).delete()
  }
}
