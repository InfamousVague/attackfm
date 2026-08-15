package com.mattssoftware.attackfm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat

/**
 * The reason Android lets the music keep playing - and the reason anything
 * outside the app knows what is playing at all.
 *
 * TWO JOBS, AND THEY ARE NOT THE SAME ONE.
 *
 * First, the foreground service. Without it this app is, to the system, an
 * ordinary app that happens to make noise: backgrounded behind navigation it is
 * a prime candidate the moment memory gets tight, and it gets frozen or killed
 * with no warning. The symptom is music that "randomly" stops on a drive -
 * random only in that you cannot see what the memory manager is doing. The
 * ongoing notification is the contract that says "killing me stops something
 * the listener is deliberately doing."
 *
 * Second, the MediaSession. On iOS a WKWebView hands `navigator.mediaSession`
 * straight to the system, which is why the lock screen, Control Center and
 * CarPlay all work with no native code at all (see src/app/mediaSession.ts).
 * **An Android WebView does not.** Chromium publishes a system session for a
 * browser TAB, not for a WebView embedded in somebody else's app - so
 * everything that module sets went nowhere here. Android Auto had no session to
 * read, which is why the dashboard showed nothing playing, and no session to
 * send a skip to, which is why the car's next/previous did nothing at all.
 *
 * So the session lives here, fed from the web layer through MainActivity, and
 * its callbacks are routed back into the page. It carries no player of its own:
 * the audio is still the WebView's, and this is only the face it wears to the
 * rest of the system.
 */
class PlaybackService : Service() {
  private var session: MediaSessionCompat? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val made = MediaSessionCompat(this, "AttackFM")
    made.setCallback(object : MediaSessionCompat.Callback() {
      // Every one of these is a button somewhere the app is not: the lock
      // screen, the notification, a steering wheel, an Android Auto dashboard.
      // They all land in the page's own transport, so intent is recorded in the
      // one place that owns it rather than in a second copy out here.
      override fun onPlay() = command("play")
      override fun onPause() = command("pause")
      override fun onSkipToNext() = command("next")
      override fun onSkipToPrevious() = command("previous")
      override fun onStop() = command("pause")
      override fun onSeekTo(pos: Long) = command("seek:" + (pos / 1000))
    })
    made.isActive = true
    session = made
    active = made
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    // The notification's own buttons come back here as an action rather than
    // through the session, because a PendingIntent is what a notification can
    // carry. They land in the same place the session's callbacks do.
    when (intent?.action) {
      ACTION_PLAY -> command("play")
      ACTION_PAUSE -> command("pause")
      ACTION_NEXT -> command("next")
      ACTION_PREVIOUS -> command("previous")
      else -> Unit
    }
    goForeground(NOTIF_ID, buildNotification())
    // Restarted if the system does kill us mid-song, rather than left dead.
    return START_STICKY
  }

  /** Re-post with whatever the page last told us, so the row's play/pause and
   *  the words above it follow the music instead of freezing at track one. */
  fun refreshNotification() {
    ensureChannel()
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIF_ID, buildNotification())
  }

  /** Named apart from Service.startForeground on purpose: an overload with the
   *  same name cannot narrow the supertype's visibility, and shadowing it is
   *  how the two-argument call below silently recursed. */
  private fun goForeground(id: Int, note: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(id, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      @Suppress("DEPRECATION")
      startForeground(id, note)
    }
  }

  /**
   * The notification, wearing the session.
   *
   * MediaStyle with the session token is what turns a line of text into a
   * transport: the system draws the buttons, and Android Auto and the lock
   * screen read the same session for their own. The three actions are declared
   * here as well as in the playback state because the notification's row is
   * built from these, while the car's row is built from the state's actions
   * mask - two audiences, the same three buttons.
   */
  private fun buildNotification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      // setFlags, not apply { flags = ... }: inside an apply block `flags`
      // resolves to onStartCommand's own parameter, which is a val.
      Intent(this, MainActivity::class.java)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val playing = lastState == PlaybackStateCompat.STATE_PLAYING
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(lastTitle ?: getString(R.string.app_name))
      .setContentText(lastArtist ?: "")
      .setContentIntent(open)
      .setOngoing(playing)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(
        android.R.drawable.ic_media_previous,
        "Previous",
        actionIntent(ACTION_PREVIOUS),
      )
      .addAction(
        if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        if (playing) "Pause" else "Play",
        actionIntent(if (playing) ACTION_PAUSE else ACTION_PLAY),
      )
      .addAction(android.R.drawable.ic_media_next, "Next", actionIntent(ACTION_NEXT))

    session?.let { s ->
      builder.setStyle(
        androidx.media.app.NotificationCompat.MediaStyle()
          .setMediaSession(s.sessionToken)
          .setShowActionsInCompactView(0, 1, 2),
      )
    }
    return builder.build()
  }

  private fun actionIntent(what: String): PendingIntent =
    PendingIntent.getService(
      this,
      what.hashCode(),
      Intent(this, PlaybackService::class.java).setAction(what),
      PendingIntent.FLAG_IMMUTABLE,
    )

  /** Hands a transport command to the page, which owns the deck. */
  private fun command(what: String) {
    MainActivity.deliverTransport(what)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    session?.isActive = false
    session?.release()
    if (active === session) active = null
    session = null
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps music playing when AttackFM is in the background."
        setShowBadge(false)
      },
    )
  }

  companion object {
    private const val CHANNEL = "attackfm.playback"
    private const val NOTIF_ID = 1

    const val ACTION_PLAY = "attackfm.play"
    const val ACTION_PAUSE = "attackfm.pause"
    const val ACTION_NEXT = "attackfm.next"
    const val ACTION_PREVIOUS = "attackfm.previous"

    /** The live service's session, so MainActivity can feed it without binding. */
    private var active: MediaSessionCompat? = null
    private var instance: PlaybackService? = null
    private var lastTitle: String? = null
    private var lastArtist: String? = null
    private var lastState = PlaybackStateCompat.STATE_NONE

    /**
     * What is playing, as the system should print it.
     *
     * Duration matters as much as the words: without it a car draws a scrubber
     * with no length and refuses to seek.
     */
    fun publishMetadata(title: String, artist: String, album: String, durationMs: Long) {
      lastTitle = title
      lastArtist = artist
      active?.setMetadata(
        MediaMetadataCompat.Builder()
          .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
          .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
          .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
          .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
          .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, artist)
          .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
          .build(),
      )
      instance?.refreshNotification()
    }

    /**
     * Whether it is playing, where it is, and what may be pressed.
     *
     * The actions mask is the load-bearing part for a car: a dashboard draws
     * exactly the buttons this declares, and sends nothing it was not told
     * about. Skip forward and back are declared unconditionally - the queue's
     * ends are the app's business, and a button that greys out at the last
     * track is worse in a car than one that quietly does nothing.
     */
    fun publishState(playing: Boolean, positionMs: Long) {
      lastState =
        if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
      active?.setPlaybackState(
        PlaybackStateCompat.Builder()
          .setActions(
            PlaybackStateCompat.ACTION_PLAY or
              PlaybackStateCompat.ACTION_PAUSE or
              PlaybackStateCompat.ACTION_PLAY_PAUSE or
              PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
              PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
              PlaybackStateCompat.ACTION_SEEK_TO or
              PlaybackStateCompat.ACTION_STOP,
          )
          // Rate 1 while playing so the system extrapolates the clock between
          // pushes; 0 while paused so it holds still.
          .setState(lastState, positionMs, if (playing) 1f else 0f)
          .build(),
      )
      instance?.refreshNotification()
    }

    fun start(context: Context) {
      val intent = Intent(context, PlaybackService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PlaybackService::class.java))
    }
  }
}
