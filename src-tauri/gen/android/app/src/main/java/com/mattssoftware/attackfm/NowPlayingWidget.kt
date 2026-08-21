package com.mattssoftware.attackfm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.View
import android.widget.RemoteViews

/**
 * Now playing, on the home screen.
 *
 * NO STATE OF ITS OWN. Everything it prints is read from PlaybackService's
 * companion at the moment of drawing, and every publish the page makes -
 * words, artwork, play state - already ends in a call to [refresh]. A widget
 * that kept its own copy would be one more surface that can disagree with the
 * music, and the notification/lock-screen path proves the companion is the
 * right single source.
 *
 * The buttons are the SERVICE's own actions, the exact PendingIntent shapes
 * the notification row uses - so a press here and a press there are literally
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

  companion object {
    fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, NowPlayingWidget::class.java))
      if (ids.isEmpty()) return
      val state = PlaybackService.widgetSnapshot()
      val views = RemoteViews(context.packageName, R.layout.widget_now_playing)

      if (state.live && state.title != null) {
        views.setTextViewText(R.id.widget_title, state.title)
        views.setTextViewText(R.id.widget_artist, state.artist ?: "")
        if (state.art != null) {
          views.setImageViewBitmap(R.id.widget_art, state.art)
        } else {
          views.setImageViewResource(R.id.widget_art, android.R.drawable.ic_media_play)
        }
        views.setImageViewResource(
          R.id.widget_play,
          if (state.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        )
        views.setViewVisibility(R.id.widget_prev, View.VISIBLE)
        views.setViewVisibility(R.id.widget_play, View.VISIBLE)
        views.setViewVisibility(R.id.widget_next, View.VISIBLE)
        views.setOnClickPendingIntent(R.id.widget_prev, action(context, PlaybackService.ACTION_PREVIOUS))
        views.setOnClickPendingIntent(
          R.id.widget_play,
          action(context, if (state.playing) PlaybackService.ACTION_PAUSE else PlaybackService.ACTION_PLAY),
        )
        views.setOnClickPendingIntent(R.id.widget_next, action(context, PlaybackService.ACTION_NEXT))
      } else {
        views.setTextViewText(R.id.widget_title, "AttackFM")
        views.setTextViewText(R.id.widget_artist, "Nothing playing — tap to open")
        views.setImageViewResource(R.id.widget_art, android.R.drawable.ic_media_play)
        views.setViewVisibility(R.id.widget_prev, View.GONE)
        views.setViewVisibility(R.id.widget_play, View.GONE)
        views.setViewVisibility(R.id.widget_next, View.GONE)
      }

      // The plate itself always opens the app - words and art are a doorway,
      // whichever face is showing.
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      views.setOnClickPendingIntent(R.id.widget_root, open)

      manager.updateAppWidget(ids, views)
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
