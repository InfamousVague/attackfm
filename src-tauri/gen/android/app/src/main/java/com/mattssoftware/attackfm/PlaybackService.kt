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
import androidx.media.MediaBrowserServiceCompat

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
class PlaybackService : MediaBrowserServiceCompat() {
  private var session: MediaSessionCompat? = null

  /*
   * NO onBind override here, deliberately.
   *
   * MediaBrowserServiceCompat implements onBind itself, and that binding IS
   * how Android Auto reaches the app. The plain `= null` this class used to
   * return is exactly what made the car find nothing: a MediaSession alone is
   * not enough, because Android Auto only looks at apps that answer the
   * MediaBrowserService action in the first place.
   */

  override fun onCreate() {
    super.onCreate()
    val made = MediaSessionCompat(this, "AttackFM")
    made.setCallback(object : MediaSessionCompat.Callback() {
      // Every one of these is a button somewhere the app is not: the lock
      // screen, the notification, a steering wheel, an Android Auto dashboard,
      // a paired computer's media panel. They all land in the page's own
      // transport, so intent is recorded in the one place that owns it rather
      // than in a second copy out here.
      override fun onPlay() = command("play")
      override fun onPause() = command("pause")
      override fun onSkipToNext() = command("next")
      override fun onSkipToPrevious() = command("previous")
      override fun onStop() = command("pause")
      override fun onSeekTo(pos: Long) = command("seek:" + (pos / 1000))
      // A row tapped in the car's browse list. The id IS the command - see
      // onLoadChildren for the three ids this service publishes.
      override fun onPlayFromMediaId(mediaId: String?, extras: android.os.Bundle?) {
        if (mediaId == null) return
        // The id IS the command, for both kinds of row this service publishes.
        if (mediaId.startsWith("collection:") || mediaId.startsWith("playlist:")) command(mediaId)
      }
    })
    /*
     * Where "open the app" goes from outside it.
     *
     * A car's now-playing card, the lock screen and a paired computer all offer
     * a way back to the app itself, and they take it from the SESSION rather
     * than from the notification - so without this the button is simply absent
     * (dumpsys reports `launchIntent=null`). The notification has always
     * carried its own copy; the session never did.
     */
    made.setSessionActivity(
      PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java)
          .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE,
      ),
    )
    made.isActive = true
    session = made
    active = made
    instance = this
    // What a MediaBrowser client (Android Auto, Assistant) follows from the
    // browse tree to the transport.
    sessionToken = made.sessionToken

    // Whatever the page told us BEFORE this service existed.
    //
    // The web layer pushes metadata from an effect that runs earlier than the
    // one starting this service - React runs effects in declaration order - so
    // on the first play of a launch the song was published to a session that
    // did not exist yet and was dropped. The values are cached in the
    // companion regardless, so the new session opens already knowing them
    // rather than waiting for the next track change to catch up.
    if (lastTitle != null) {
      publishMetadata(lastTitle!!, lastArtist ?: "", lastAlbum ?: "", lastDuration)
    }
    if (lastState != PlaybackStateCompat.STATE_NONE) {
      publishState(lastState == PlaybackStateCompat.STATE_PLAYING, lastPosition)
    }
  }

  /**
   * The browse tree: three rows, all playable.
   *
   * An empty root technically satisfies Android Auto, but it draws as a blank
   * screen with the app's name over it - which reads as broken, not minimal.
   * Three collections the library always has give the car something honest to
   * offer, and tapping one plays it: the id travels through the session's
   * onPlayFromMediaId into the page, which builds the queue the same way the
   * CarPlay bridge does on iOS. A full artist/album tree is a later feature;
   * this is the difference between "appears with content" and "appears broken".
   */
  override fun onGetRoot(
    clientPackageName: String,
    clientUid: Int,
    rootHints: android.os.Bundle?,
  ): BrowserRoot = BrowserRoot(BROWSE_ROOT, null)

  override fun onLoadChildren(
    parentId: String,
    result: Result<MutableList<android.support.v4.media.MediaBrowserCompat.MediaItem>>,
  ) {
    if (parentId != BROWSE_ROOT) {
      result.sendResult(mutableListOf())
      return
    }
    fun item(id: String, title: String, subtitle: String) =
      android.support.v4.media.MediaBrowserCompat.MediaItem(
        android.support.v4.media.MediaDescriptionCompat.Builder()
          .setMediaId(id)
          .setTitle(title)
          .setSubtitle(subtitle)
          .build(),
        android.support.v4.media.MediaBrowserCompat.MediaItem.FLAG_PLAYABLE,
      )
    val rows = mutableListOf(
      item("collection:liked", "Liked", "Your favourites"),
      item("collection:all", "All songs", "The whole library"),
      item("collection:shuffle", "Shuffle all", "Everything, surprised"),
    )
    // The playlists, as the page last published them. Cached in preferences so
    // a car plugged in before the app has drawn a single frame still gets the
    // real list - the WebView is slower to stand up than Android Auto is to
    // ask, and an answer of "three rows now, twelve in a second" draws as the
    // tree twitching.
    for (p in collections(this)) rows.add(item(p.first, p.second, p.third))
    result.sendResult(rows)
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
      // The paused notification swiped away: the listener is done. This is the
      // one moment the controls should actually disappear.
      ACTION_STOP -> {
        stopForeground(true)
        stopSelf()
        return START_NOT_STICKY
      }
      else -> Unit
    }
    goForeground(NOTIF_ID, buildNotification())
    // Restarted if the system does kill us mid-song, rather than left dead.
    return START_STICKY
  }

  /**
   * Paused is not gone.
   *
   * This used to stop the whole service on pause, which released the session
   * and dismissed the notification - and with them every control surface
   * OUTSIDE the app: the lock screen went blank, a paired computer's media
   * panel lost the buttons, Android Auto dropped the card. Pressing play from
   * any of them could not work, because there was nothing left to press.
   *
   * Softening keeps the session alive and the notification standing (now
   * swipeable, no longer foreground-pinned), wearing a Play button and
   * STATE_PAUSED - which is exactly the "resumable" shape every external
   * surface expects from a paused player.
   */
  fun soften() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_DETACH)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(false)
    }
    refreshNotification()
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
      // The truthful type for the moment: playback while a song is on, data
      // sync while only the cache is working. Re-running startForeground on a
      // transition updates the type in place.
      val kind =
        if (lastState == PlaybackStateCompat.STATE_PLAYING)
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        else if (syncing) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      startForeground(id, note, kind)
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
      .setLargeIcon(lastArt)
      .setContentTitle(if (!playing && syncing) "Downloading your music" else lastTitle ?: getString(R.string.app_name))
      .setContentText(if (!playing && syncing) "Keeping songs on this phone" else lastArtist ?: "")
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
      // Swiping the (paused, unpinned) notification away is "I'm done": tear
      // the controls down for real instead of leaving a ghost session.
      .setDeleteIntent(actionIntent(ACTION_STOP))

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

  /** Hands a transport command to the page, which owns the deck. Logged at
   *  every hop (grep AFMedia in logcat), because the last silent version of
   *  this chain took days to see through. */
  private fun command(what: String) {
    android.util.Log.i("AFMedia", "session command: $what")
    // The service's own context, so a command arriving with the app closed
    // can start it rather than being dropped - see deliverTransport.
    MainActivity.deliverTransport(this, what)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    session?.isActive = false
    session?.release()
    if (active === session) active = null
    session = null
    super.onDestroy()
    // The last publish before the lights go out. Without it the widget keeps
    // whatever song was playing when the service died and stands there
    // promising controls that reach nothing - lastState going NONE is what
    // flips it to the tap-to-open face.
    lastState = PlaybackStateCompat.STATE_NONE
    NowPlayingWidget.refresh(this)
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
    const val ACTION_STOP = "attackfm.stop"

    /** The live service's session, so MainActivity can feed it without binding. */
    private var active: MediaSessionCompat? = null
    private var instance: PlaybackService? = null
    private var lastTitle: String? = null
    private var lastArtist: String? = null
    private var lastAlbum: String? = null
    private var lastDuration = 0L
    private var lastPosition = 0L
    /** The cover for the CURRENT song, decoded from bytes the web layer sent.
     *  Cleared the moment a different song is published, so a slow art fetch
     *  can never dress the next track in the last one's sleeve. */
    private var lastArt: android.graphics.Bitmap? = null
    private var lastState = PlaybackStateCompat.STATE_NONE
    /** True while the web layer's cache sweep is downloading. */
    @Volatile var syncing = false
    const val BROWSE_ROOT = "attackfm.root"

    /**
     * What is playing, as the system should print it.
     *
     * Duration matters as much as the words: without it a car draws a scrubber
     * with no length and refuses to seek.
     */
    fun publishMetadata(title: String, artist: String, album: String, durationMs: Long) {
      if (title != lastTitle || artist != lastArtist) lastArt = null
      lastTitle = title
      lastArtist = artist
      lastAlbum = album
      lastDuration = durationMs
      pushMetadata()
      instance?.refreshNotification()
      instance?.let { NowPlayingWidget.refresh(it) }
    }

    /**
     * The cover, arriving on its own wire.
     *
     * Art always lands AFTER the words - the web layer fetches and shrinks it
     * once the song is already announced - so it is its own publish rather
     * than a parameter the metadata call would have to wait on. The bitmap
     * rides METADATA_KEY_ALBUM_ART, which is the field the lock screen, the
     * notification's MediaStyle and an Android Auto dashboard all read.
     */
    fun publishArtwork(art: android.graphics.Bitmap) {
      lastArt = art
      pushMetadata()
      instance?.refreshNotification()
      instance?.let { NowPlayingWidget.refresh(it) }
    }

    private fun pushMetadata() {
      val b = MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
        .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, lastAlbum)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, lastTitle)
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, lastArtist)
        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDuration)
      lastArt?.let {
        b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
        b.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
      }
      active?.setMetadata(b.build())
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
      lastPosition = positionMs
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
      instance?.let { NowPlayingWidget.refresh(it) }
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

    /** Pause-shape: session and notification stay, foreground pin lets go.
     *  A no-op when the service never started - nothing to soften. */
    fun soften() {
      instance?.soften()
    }

    private const val COLLECTIONS_PREFS = "attackfm.collections"

    /**
     * The page's playlists, for the car's browse list.
     *
     * Stored as one string per row - id, name, subtitle, tab-separated -
     * because the ONLY reader is onLoadChildren and a JSON parser here would
     * be a dependency for three fields. Tabs cannot appear in a playlist name
     * that came through the page (they are stripped there), and a name that
     * somehow carries one loses its tail rather than shifting the row.
     */
    fun publishCollections(context: Context, rows: List<Triple<String, String, String>>) {
      context.getSharedPreferences(COLLECTIONS_PREFS, Context.MODE_PRIVATE)
        .edit()
        .putStringSet(
          "rows",
          rows.mapIndexed { i, r -> "$i\t${r.first}\t${r.second}\t${r.third}" }.toSet(),
        )
        .apply()
      // A browser mid-look redraws; one that has not asked yet simply finds
      // the fresh answer when it does.
      instance?.notifyChildrenChanged(BROWSE_ROOT)
    }

    fun collections(context: Context): List<Triple<String, String, String>> =
      (context.getSharedPreferences(COLLECTIONS_PREFS, Context.MODE_PRIVATE)
        .getStringSet("rows", emptySet()) ?: emptySet())
        .mapNotNull { row ->
          val parts = row.split('\t')
          if (parts.size < 4) null else Pair(parts[0].toIntOrNull() ?: 0, Triple(parts[1], parts[2], parts[3]))
        }
        // A string SET forgets order; the index prefix is how the page's own
        // ordering survives the round trip.
        .sortedBy { it.first }
        .map { it.second }

    /** What the widget draws, read in one piece. */
    fun widgetSnapshot(): WidgetState =
      WidgetState(
        title = lastTitle,
        artist = lastArtist,
        art = lastArt,
        playing = lastState == PlaybackStateCompat.STATE_PLAYING,
        live = lastState != PlaybackStateCompat.STATE_NONE,
      )
  }
}

/** One read of everything the home-screen widget prints. */
data class WidgetState(
  val title: String?,
  val artist: String?,
  val art: android.graphics.Bitmap?,
  val playing: Boolean,
  val live: Boolean,
)
