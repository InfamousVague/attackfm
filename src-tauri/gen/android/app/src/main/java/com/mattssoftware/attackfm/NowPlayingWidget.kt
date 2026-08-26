package com.mattssoftware.attackfm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews

/**
 * Now playing, on the home screen - the player's own face, at three sizes.
 *
 * NO STATE OF ITS OWN. Everything it prints is read from PlaybackService's
 * companion at the moment of drawing, and every publish the page makes -
 * words, artwork, play state, the accent - already ends in a call to
 * [refresh]. A widget that kept its own copy would be one more surface that
 * can disagree with the music.
 *
 * THREE FACES, ONE BINDER. The launcher tells us how big the box is and we
 * inflate the layout that fits: a row, the player folded to two cells, or the
 * cover forward. All three carry the same view ids, so [paint] fills whichever
 * one arrived and the only thing that branches on size is the choice itself.
 *
 * ONE face per push, chosen from the reported size, rather than Android 12's
 * size map carrying all three. The map re-faces a drag without a round trip,
 * which is the nicer resize - and it triples the payload, because every face
 * here carries painted bitmaps. A widget update is a Binder transaction with
 * about a megabyte to live in, and three covers plus three scrubbers plus
 * three discs is how a widget starts throwing TransactionTooLarge on
 * somebody's tablet. A resize happens once; the round trip is free.
 *
 * WHY SO MUCH IS A BITMAP. RemoteViews inflate in the launcher's process: no
 * theme, no custom views, no drawing. The accent the listener chose, the
 * scrubber's squiggle, the cover's corner radius and the plate's wash of the
 * artwork all have to be painted here and pushed across - see [WidgetPaint].
 *
 * The buttons are the SERVICE's own actions, the exact PendingIntent shapes
 * the notification row uses, so a press here and a press there are literally
 * the same code path. When nothing is live there are no buttons at all: the
 * whole plate opens the app, because "play" into a dead WebView is a promise
 * nothing can keep.
 */
class NowPlayingWidget : AppWidgetProvider() {

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    // Placement, resize, reboot: draw from whatever the companion holds. After
    // a process death that is the idle face, which is the truth - the music is
    // not playing.
    refresh(context)
  }

  /** A drag on the handles. Only the pre-12 path needs it: the size map covers
   *  every shape at once on newer launchers. */
  override fun onAppWidgetOptionsChanged(
    context: Context,
    manager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    refresh(context)
  }

  companion object {
    /**
     * How often the scrubber is redrawn while something is playing.
     *
     * The page publishes its position on state changes and on SEEKS, not on
     * every tick - see useSystemNowPlaying - so between pushes the position is
     * extrapolated from the clock, exactly as the media session does with a
     * rate of 1. That covers the number being right; this covers it being
     * REDRAWN, because a RemoteViews face is a still image until something
     * pushes a new one.
     *
     * Ten seconds is about twelve pixels of a four-minute song on a four-cell
     * widget - fine enough that the bar is never visibly wrong, coarse enough
     * that a long album costs a few hundred pushes rather than a few hundred
     * thousand.
     */
    const val TICK_MS = 10_000L

    /*
     * HOW BIG THE PAINTED PARTS ARE.
     *
     * Everything a widget draws travels as pixels in a Binder transaction with
     * about a megabyte to live in, so these are sized for the LARGEST face and
     * scaled down by the smaller ones rather than being generous. A 200px
     * cover in a 140dp slot is already past retina on a three-times screen.
     */
    private const val COVER_PX = 200
    private const val COVER_RADIUS_PX = 22f
    private const val DISC_PX = 168

    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, NowPlayingWidget::class.java))
      if (ids.isEmpty()) return
      val state = PlaybackService.widgetSnapshot()
      /*
       * Painted ONCE for the whole sweep, not once per widget.
       *
       * Two widgets on two screens are the same song, and RemoteViews' bitmap
       * cache stores a Bitmap by identity - so handing every face the same
       * instance is also what keeps the payload one cover rather than several.
       */
      val cover = state.art?.let { WidgetPaint.cover(it, COVER_PX, COVER_RADIUS_PX) }
      val disc = if (state.live && state.title != null) {
        WidgetPaint.playButton(DISC_PX, state.playing, state.accent ?: WidgetPaint.DEFAULT_ACCENT)
      } else {
        null
      }

      for (id in ids) {
        val options = manager.getAppWidgetOptions(id)
        val chosen = faceFor(context, options)
        /*
         * Ask for a fresh picture, then draw whatever we have.
         *
         * Never the other way round and never blocking on it: the page answers
         * on its own schedule (and cannot answer at all when the app is not
         * running), so a widget that waited would be a blank widget. The
         * request lands, the answer arrives later, and WidgetShots.receive
         * calls back in here to draw it.
         */
        if (state.live && state.title != null) {
          WidgetShots.request(context, chosen.id, boxWidthDp(context, options), boxHeightDp(context, options), false)
        }
        val shot = if (state.live && state.title != null) WidgetShots.latest(context, chosen.id) else null
        manager.updateAppWidget(
          id,
          if (shot != null) picture(context, chosen, shot, state)
          else face(context, chosen.layout, state, chosen, cover, disc),
        )
      }
    }

    private fun boxWidthDp(context: Context, options: Bundle): Int {
      val landscape =
        context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val key =
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
        else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH
      // The reported box is bigger than the drawn one - see faceFor - so the
      // picture is asked for at the size the plate actually gets.
      return options.getInt(key, 320).coerceIn(120, 720)
    }

    private fun boxHeightDp(context: Context, options: Bundle): Int {
      val landscape =
        context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val key =
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
        else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
      return options.getInt(key, 100).coerceIn(60, 720)
    }

    /*
     * The picture is asked for at the size the launcher REPORTS, and the
     * ImageView stretches it into whatever the plate actually gets.
     *
     * An earlier cut subtracted a measured 34dp of launcher padding, which is
     * right for a four-by-two and wrong for a row: the same launcher keeps
     * about 34dp there and about 4 here. A constant that is only true at one
     * size is worse than no constant - the aspect error from stretching is a
     * few percent, and the error from insetting by the wrong number is not.
     */

    /**
     * Which face fits the box the launcher gave this one.
     *
     * The options carry FOUR numbers, not two, and which pair is the box you
     * are actually in depends on the orientation: portrait is the minimum
     * width by the maximum height, landscape is the other diagonal. Reading
     * the two minimums instead - the cautious-looking choice - takes the
     * landscape height in portrait, which is barely a third of the box and
     * means the cover-forward face can never be chosen at all. That was a real
     * bug: a widget dragged to fill four cells by four stayed on the two-cell
     * face with a hole under it.
     */
    private fun faceFor(context: Context, options: Bundle): Face {
      val landscape =
        context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
      val width = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
        else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
        0,
      )
      val height = options.getInt(
        if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
        else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT,
        0,
      )
      /*
       * The thresholds are in the launcher's dp, NOT in the widget's.
       *
       * A launcher reports the box it reserves, which is bigger than the box
       * it draws - the reference launcher hands back about 34dp more height
       * than the plate actually gets, and the full screen width for a widget
       * that stops short of both edges. Measured, because no amount of
       * reasoning gets you a number another process made up: a four-by-two on
       * a Pixel reports 360x224 for a plate that is nearer 260x190.
       *
       * Ties go to the SMALLER face on purpose. A row in a box with space to
       * spare looks deliberate; a cover-forward face in a box too short for a
       * cover has a hole where the artwork should be, which is exactly what
       * shipped before this was measured.
       */
      val face = when {
        height >= 270 && width >= 220 -> Face.LARGE
        height >= 150 -> Face.MEDIUM
        else -> Face.COMPACT
      }
      // Kept: which numbers a launcher reports for a given box is the one
      // thing here that cannot be reasoned out from the outside, and a face
      // that will not change on resize looks exactly like a broken widget.
      android.util.Log.i("AFMedia", "widget box ${width}x${height}dp -> $face")
      return face
    }

    private enum class Face(val layout: Int, val shotLayout: Int, val id: String) {
      COMPACT(R.layout.widget_now_playing, R.layout.widget_shot_compact, "compact"),
      MEDIUM(R.layout.widget_now_playing_medium, R.layout.widget_shot_medium, "medium"),
      LARGE(R.layout.widget_now_playing_large, R.layout.widget_shot_large, "large"),
    }

    /**
     * The face as a PHOTOGRAPH, when the page has taken one.
     *
     * This is what the widget wears whenever it can. The layout beside it -
     * the one built out of RemoteViews primitives - is the floor: what a
     * launcher gets before the app has ever been up to draw anything, and
     * after a reboot with nothing playing. It is not a second design being
     * kept in step; it is the face for "there is no picture yet".
     *
     * The buttons are invisible Views laid over the image, and where they sit
     * is a contract with WidgetFace.tsx - see widget_shot_compact.xml.
     */
    private fun picture(
      context: Context,
      which: Face,
      shot: android.graphics.Bitmap,
      state: WidgetState,
    ): RemoteViews {
      val views = RemoteViews(context.packageName, which.shotLayout)
      views.setImageViewBitmap(R.id.widget_shot, shot)
      views.setOnClickPendingIntent(R.id.widget_prev, action(context, PlaybackService.ACTION_PREVIOUS))
      views.setOnClickPendingIntent(
        R.id.widget_play,
        action(context, if (state.playing) PlaybackService.ACTION_PAUSE else PlaybackService.ACTION_PLAY),
      )
      views.setOnClickPendingIntent(R.id.widget_next, action(context, PlaybackService.ACTION_NEXT))
      if (state.favourite != null) {
        views.setOnClickPendingIntent(R.id.widget_heart, action(context, PlaybackService.ACTION_FAVOURITE))
      }
      openTheApp(context, views, R.id.widget_open, R.id.widget_open_bottom)
      return views
    }

    private fun face(
      context: Context,
      layout: Int,
      state: WidgetState,
      which: Face,
      cover: android.graphics.Bitmap?,
      disc: android.graphics.Bitmap?,
    ): RemoteViews {
      val views = RemoteViews(context.packageName, layout)
      paint(context, views, state, which, cover, disc)
      return views
    }

    private fun paint(
      context: Context,
      views: RemoteViews,
      state: WidgetState,
      which: Face,
      cover: android.graphics.Bitmap?,
      disc: android.graphics.Bitmap?,
    ) {
      val accent = state.accent ?: WidgetPaint.DEFAULT_ACCENT
      val live = state.live && state.title != null

      /*
       * The plate takes its wash from the cover, the way the player's backdrop
       * does - as a TINT of the shape drawable, never as a background colour.
       * setBackgroundColor would replace the drawable outright and square off
       * the corners, which is the whole reason the plate is a shape.
       *
       * setColorStateList is Android 12 and up. Below it the plate stays the
       * app's flat near-black, which is what it has always been.
       */
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        views.setColorStateList(
          R.id.widget_root,
          "setBackgroundTintList",
          ColorStateList.valueOf(
            if (live) WidgetPaint.plateTint(state.art) else WidgetPaint.plateTint(null),
          ),
        )
      }

      if (!live) {
        views.setTextViewText(R.id.widget_title, "AttackFM")
        views.setTextViewText(R.id.widget_artist, "Nothing playing — tap to open")
        views.setViewVisibility(R.id.widget_line, View.GONE)
        views.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder)
        views.setViewVisibility(R.id.widget_prev, View.GONE)
        views.setViewVisibility(R.id.widget_play, View.GONE)
        views.setViewVisibility(R.id.widget_next, View.GONE)
        views.setViewVisibility(R.id.widget_heart, View.GONE)
        views.setViewVisibility(R.id.widget_wave, View.GONE)
        views.setViewVisibility(R.id.widget_clocks, View.GONE)
        openTheApp(context, views)
        return
      }

      views.setTextViewText(R.id.widget_title, state.title)
      views.setTextViewText(R.id.widget_artist, state.artist ?: "")
      // The third line is what the player puts under the title when there is
      // something truer than the album to say - a book's chapter. Absent for a
      // song, rather than the album repeated under the artist.
      if (!state.line.isNullOrBlank()) {
        views.setTextViewText(R.id.widget_line, state.line)
        views.setViewVisibility(R.id.widget_line, View.VISIBLE)
      } else {
        views.setViewVisibility(R.id.widget_line, View.GONE)
      }

      if (cover != null) {
        views.setImageViewBitmap(R.id.widget_art, cover)
      } else {
        views.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder)
      }

      // The scrubber. A track with no duration yet - a stream, a file still
      // opening - gets no bar rather than a bar pinned at zero pretending to
      // know something.
      if (state.durationMs > 0) {
        val waveH = when (which) {
          Face.COMPACT -> 18
          Face.MEDIUM -> 54
          Face.LARGE -> 64
        }
        views.setImageViewBitmap(
          R.id.widget_wave,
          WidgetPaint.wave(
            WAVE_PX,
            waveH,
            state.positionMs.toFloat() / state.durationMs.toFloat(),
            accent,
          ),
        )
        views.setViewVisibility(R.id.widget_wave, View.VISIBLE)
        views.setTextViewText(R.id.widget_elapsed, WidgetPaint.clock(state.positionMs))
        views.setTextViewText(
          R.id.widget_remaining,
          "-" + WidgetPaint.clock(state.durationMs - state.positionMs),
        )
        if (which != Face.COMPACT) views.setViewVisibility(R.id.widget_clocks, View.VISIBLE)
      } else {
        views.setViewVisibility(R.id.widget_wave, View.GONE)
        views.setViewVisibility(R.id.widget_clocks, View.GONE)
      }

      // One disc for every face: the ImageViews are fitCenter, so the smaller
      // ones scale the same bitmap down rather than each carrying their own.
      if (disc != null) views.setImageViewBitmap(R.id.widget_play, disc)
      views.setViewVisibility(R.id.widget_prev, View.VISIBLE)
      views.setViewVisibility(R.id.widget_play, View.VISIBLE)
      views.setViewVisibility(R.id.widget_next, View.VISIBLE)
      views.setOnClickPendingIntent(R.id.widget_prev, action(context, PlaybackService.ACTION_PREVIOUS))
      views.setOnClickPendingIntent(
        R.id.widget_play,
        action(context, if (state.playing) PlaybackService.ACTION_PAUSE else PlaybackService.ACTION_PLAY),
      )
      views.setOnClickPendingIntent(R.id.widget_next, action(context, PlaybackService.ACTION_NEXT))

      // The heart only where there is room for it, and only once the page has
      // said which way it points - an outline that might already be filled is
      // worse than no heart at all.
      if (which == Face.COMPACT || state.favourite == null) {
        views.setViewVisibility(R.id.widget_heart, View.GONE)
      } else {
        views.setViewVisibility(R.id.widget_heart, View.VISIBLE)
        views.setImageViewResource(
          R.id.widget_heart,
          if (state.favourite) R.drawable.ic_widget_heart_on else R.drawable.ic_widget_heart,
        )
        views.setOnClickPendingIntent(
          R.id.widget_heart,
          action(context, PlaybackService.ACTION_FAVOURITE),
        )
      }

      openTheApp(context, views, R.id.widget_art)
    }

    /**
     * How wide the squiggle is drawn before the ImageView scales it.
     *
     * Fixed rather than measured: a widget cannot ask how many pixels it got,
     * and fitXY makes the difference a stretch of the wavelength rather than a
     * wrong position - the played fraction is proportional either way. Sized
     * for the transaction rather than for the screen, with the wave's period
     * chosen so it lands at the player's own wavelength after the stretch.
     */
    private const val WAVE_PX = 560

    /**
     * The plate itself always opens the app - words and art are a doorway,
     * whichever face is showing.
     *
     * `also` names the ids that exist in THIS layout and nowhere else. A
     * RemoteViews action against a view the inflated layout does not contain
     * is not ignored: it throws inside the launcher, and every face using it
     * renders as "Can't load widget" with nothing in the app's own log. The
     * picture layouts have no widget_art, and that one line took the whole
     * widget down.
     */
    private fun openTheApp(context: Context, views: RemoteViews, vararg also: Int) {
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      views.setOnClickPendingIntent(R.id.widget_root, open)
      for (id in also) views.setOnClickPendingIntent(id, open)
    }

    /**
     * A button's press, delivered to the service.
     *
     * getForegroundService on O+, because the paused face is exactly when the
     * service is NOT foreground - soften() detaches the pin - and Play from
     * the widget has to be able to bring it back. onStartCommand goes
     * foreground first thing, which is the promotion this form contracts for.
     */
    private fun action(context: Context, what: String): PendingIntent {
      val intent = Intent(context, PlaybackService::class.java).setAction(what)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        PendingIntent.getForegroundService(context, what.hashCode(), intent, flags)
      } else {
        PendingIntent.getService(context, what.hashCode(), intent, flags)
      }
    }
  }
}
