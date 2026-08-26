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
        // The id IS the command. Anything with a scheme is one the page knows
        // how to obey; a bare id would be a row this service invented, and
        // there are none.
        if (mediaId.contains(':')) command(mediaId)
      }
      /*
       * "Play Fleetwood Mac on AttackFM".
       *
       * The query is handed to the PAGE rather than matched here. The library,
       * its aliases and its typo rescue all live there - `searchLibrary` is
       * several hundred lines of ranking that already answers this exact
       * question for the search screen - and a second matcher in Kotlin would
       * be a worse one that disagrees with the first. This side's job is to
       * carry the words across.
       *
       * An EMPTY query is not a failure: "play music on AttackFM" is a real
       * thing to say and Assistant sends it with nothing attached. Shuffling
       * the library is the honest reading, and it is what the car's own
       * "Shuffle all" row does.
       */
      override fun onPlayFromSearch(query: String?, extras: android.os.Bundle?) {
        val q = query?.trim().orEmpty()
        if (q.isEmpty()) command("collection:shuffle") else command("search:" + q)
      }
      /** Assistant prepares before it plays; both mean the same thing here. */
      override fun onPrepareFromSearch(query: String?, extras: android.os.Bundle?) =
        onPlayFromSearch(query, extras)
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
   * The browse tree.
   *
   * Every node the car can reach comes from the page, cached in preferences,
   * because Android Auto binds this service and asks for the root long before
   * a WebView has stood up - and an answer of "three rows now, four hundred in
   * a second" draws as the tree twitching. The cache is what lets a car
   * plugged in cold show the real library immediately.
   *
   * A parent with no cached children answers empty rather than guessing, with
   * ONE exception: a root that has never been published falls back to the
   * three built-in collections. That is what an older bundle running on this
   * APK produces, and three honest rows beat a blank screen with the app's
   * name over it.
   */
  override fun onGetRoot(
    clientPackageName: String,
    clientUid: Int,
    rootHints: android.os.Bundle?,
  ): BrowserRoot {
    // Advertising search is what makes the car offer its own search field and
    // what tells Assistant this app can be asked for something by name. It is
    // a root extra rather than a manifest flag, so it travels with the tree.
    val extras = android.os.Bundle()
    extras.putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
    return BrowserRoot(BROWSE_ROOT, extras)
  }

  private fun mediaItem(node: BrowseNode) =
    android.support.v4.media.MediaBrowserCompat.MediaItem(
      android.support.v4.media.MediaDescriptionCompat.Builder()
        .setMediaId(node.id)
        .setTitle(node.title)
        .setSubtitle(node.subtitle)
        .build(),
      if (node.browsable) {
        android.support.v4.media.MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
      } else {
        android.support.v4.media.MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
      },
    )

  override fun onLoadChildren(
    parentId: String,
    result: Result<MutableList<android.support.v4.media.MediaBrowserCompat.MediaItem>>,
  ) {
    val published = browseChildren(this, parentId)
    if (published.isNotEmpty()) {
      result.sendResult(published.map(::mediaItem).toMutableList())
      return
    }
    if (parentId != BROWSE_ROOT) {
      // A branch with nothing in it. Empty is the honest answer - the page
      // publishes what exists, and inventing a row here would be a dead end
      // of exactly the kind this feature was written to remove.
      result.sendResult(mutableListOf())
      return
    }
    // The floor: no tree has ever been published on this device.
    val rows = mutableListOf(
      mediaItem(BrowseNode("collection:liked", "Liked", "Your favourites", false)),
      mediaItem(BrowseNode("collection:all", "All songs", "The whole library", false)),
      mediaItem(BrowseNode("collection:shuffle", "Shuffle all", "Everything, surprised", false)),
    )
    for (p in collections(this)) rows.add(mediaItem(BrowseNode(p.first, p.second, p.third, false)))
    result.sendResult(rows)
  }

  /**
   * The car's own search box.
   *
   * Distinct from `onPlayFromSearch`, which plays at once. This one lists what
   * matched so a passenger can choose, and it answers from the cached tree
   * rather than the page - a car searching does not want to wait for a WebView
   * that may not be running. Plain contains-matching, deliberately: this is a
   * filter over a few hundred names the driver can already see, not the
   * ranked, typo-rescuing search the page does when it is asked to PLAY.
   */
  override fun onSearch(
    query: String,
    extras: android.os.Bundle?,
    result: Result<MutableList<android.support.v4.media.MediaBrowserCompat.MediaItem>>,
  ) {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) {
      result.sendResult(mutableListOf())
      return
    }
    val seen = HashSet<String>()
    val hits = mutableListOf<android.support.v4.media.MediaBrowserCompat.MediaItem>()
    for (parent in browseParents(this)) {
      for (node in browseChildren(this, parent)) {
        if (hits.size >= SEARCH_LIMIT) break
        if (!node.title.lowercase().contains(needle)) continue
        if (!seen.add(node.id)) continue
        hits.add(mediaItem(node))
      }
    }
    result.sendResult(hits)
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
      // The heart on the widget. Routed like every other button - the page
      // owns what "kept" means and answers by publishing the new state back.
      ACTION_FAVOURITE -> command("favourite")
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
    retick()
    // The kept pictures are of a song that is no longer playing; the idle face
    // is drawn from primitives and needs none of them.
    WidgetShots.clear(this)
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
    const val ACTION_FAVOURITE = "attackfm.favourite"

    /** The live service's session, so MainActivity can feed it without binding. */
    private var active: MediaSessionCompat? = null
    private var instance: PlaybackService? = null
    private var lastTitle: String? = null
    private var lastArtist: String? = null
    private var lastAlbum: String? = null
    private var lastDuration = 0L
    private var lastPosition = 0L
    /** When [lastPosition] was true, on the monotonic clock. */
    private var lastPositionAt = 0L
    private var lastLine: String? = null
    private var lastAccent: Int? = null
    private var lastFavourite: Boolean? = null
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
      lastPositionAt = android.os.SystemClock.elapsedRealtime()
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
      retick()
    }

    /*
     * THE SCRUBBER'S OWN HEARTBEAT.
     *
     * A RemoteViews face is a still image: nothing on the home screen redraws
     * because time passed. The position it prints is extrapolated and so always
     * right, but it is only ever REPAINTED when something pushes - and the page
     * pushes on state changes and on seeks, which during an album is almost
     * never. Without this the bar would freeze at whichever second the track
     * started and only jump when the song changed.
     *
     * Stopped the moment the music does, and free when no widget is placed:
     * refresh returns on an empty id list before it draws anything.
     */
    private val ticker = android.os.Handler(android.os.Looper.getMainLooper())
    private val tick = object : Runnable {
      override fun run() {
        val here = instance ?: return
        if (lastState != PlaybackStateCompat.STATE_PLAYING) return
        NowPlayingWidget.refresh(here)
        ticker.postDelayed(this, NowPlayingWidget.TICK_MS)
      }
    }

    private fun retick() {
      ticker.removeCallbacks(tick)
      if (lastState == PlaybackStateCompat.STATE_PLAYING) {
        ticker.postDelayed(tick, NowPlayingWidget.TICK_MS)
      }
    }

    fun start(context: Context) {
      val intent = Intent(context, PlaybackService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: IllegalStateException) {
        // Android 12+ refuses a foreground start from the background - the
        // sync leg waking while the phone is pocketed, a remote play racing
        // past the media-button exemption window. The refusal used to travel
        // up as ForegroundServiceStartNotAllowedException and kill the whole
        // process. Swallow it and remember the want instead: the activity's
        // onResume re-applies the hold, and the service starts the moment
        // the system allows it again.
        startDenied = true
      }
    }

    /** A start the system refused, waiting for the next foreground moment. */
    @Volatile var startDenied = false

    fun stop(context: Context) {
      context.stopService(Intent(context, PlaybackService::class.java))
    }

    /** Pause-shape: session and notification stay, foreground pin lets go.
     *  A no-op when the service never started - nothing to soften. */
    fun soften() {
      instance?.soften()
    }

    private const val BROWSE_PREFS = "attackfm.browse"

    /** How many rows one car search may return. A driver is not scrolling. */
    private const val SEARCH_LIMIT = 30

    /**
     * Store the whole tree at once.
     *
     * Written as one preferences file with a key per parent, and a roll of the
     * parents that exist - so a rebuild can DROP a branch (an artist whose
     * last song left the library) rather than leaving it behind as a node the
     * car can still open into nothing. Clearing and rewriting is right because
     * the page always publishes the whole tree; there is no partial update to
     * merge.
     *
     * Same tab-separated rows as the collections cache under it, for the same
     * reason: the only reader is a few lines below, and a JSON parser here
     * would be a dependency for four fields. The page strips tabs.
     */
    fun publishBrowseTree(context: Context, tree: Map<String, List<BrowseNode>>) {
      val prefs = context.getSharedPreferences(BROWSE_PREFS, Context.MODE_PRIVATE)
      val was = prefs.getStringSet("parents", emptySet()) ?: emptySet()
      val edit = prefs.edit().clear()
      edit.putStringSet("parents", tree.keys.toSet())
      for ((parent, nodes) in tree) {
        edit.putStringSet(
          "p:" + parent,
          nodes.mapIndexed { i, n ->
            "$i\t${n.id}\t${n.title}\t${n.subtitle}\t${if (n.browsable) "B" else "P"}"
          }.toSet(),
        )
      }
      edit.apply()
      /*
       * Tell every browser what moved.
       *
       * A client mid-look redraws; one that has not asked yet finds the fresh
       * answer when it does. Parents that have GONE are notified too - a car
       * sitting on an artist page that no longer exists needs to be told, or
       * it holds the old list until something else makes it ask.
       */
      val touched = HashSet<String>(was)
      touched.addAll(tree.keys)
      for (parent in touched) instance?.notifyChildrenChanged(parent)
    }

    /** Every parent the last publish wrote. */
    fun browseParents(context: Context): Set<String> =
      context.getSharedPreferences(BROWSE_PREFS, Context.MODE_PRIVATE)
        .getStringSet("parents", emptySet()) ?: emptySet()

    fun browseChildren(context: Context, parentId: String): List<BrowseNode> =
      (context.getSharedPreferences(BROWSE_PREFS, Context.MODE_PRIVATE)
        .getStringSet("p:" + parentId, emptySet()) ?: emptySet())
        .mapNotNull { row ->
          val parts = row.split('\t')
          if (parts.size < 5) {
            null
          } else {
            Pair(
              parts[0].toIntOrNull() ?: 0,
              BrowseNode(parts[1], parts[2], parts[3], parts[4] == "B"),
            )
          }
        }
        // A string SET forgets order; the index prefix is how the page's own
        // ordering - liked order, album then track number - survives the trip.
        .sortedBy { it.first }
        .map { it.second }

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

    /**
     * What the widget draws, read in one piece.
     *
     * The POSITION is extrapolated rather than reported. The page publishes on
     * state changes and on seeks, not on every tick (useSystemNowPlaying sends
     * a coarse position only when it jumps more than a couple of seconds), so
     * `lastPosition` is a stamp with an age. Carrying it forward by the clock
     * while playing is exactly what PlaybackStateCompat's rate of 1 tells the
     * system to do with the same number - this only does it for a surface that
     * cannot extrapolate on its own.
     */
    fun widgetSnapshot(): WidgetState {
      val playing = lastState == PlaybackStateCompat.STATE_PLAYING
      val ran = if (playing) android.os.SystemClock.elapsedRealtime() - lastPositionAt else 0L
      val at = (lastPosition + ran).coerceAtMost(
        if (lastDuration > 0) lastDuration else Long.MAX_VALUE,
      )
      return WidgetState(
        title = lastTitle,
        artist = lastArtist,
        line = lastLine,
        art = lastArt,
        playing = playing,
        live = lastState != PlaybackStateCompat.STATE_NONE,
        positionMs = at.coerceAtLeast(0L),
        durationMs = lastDuration,
        accent = lastAccent,
        favourite = lastFavourite,
      )
    }

    /**
     * What the page knows and the notification never needed: the listener's
     * accent, the line under the title, and whether this one is kept.
     *
     * One call rather than three because they change together - a new track
     * carries a new line and a new heart - and every one of them ends in the
     * same widget push.
     */
    fun publishExtras(context: Context, accentHex: String?, line: String?, favourite: Boolean?) {
      lastAccent = accentHex?.let { hex ->
        try {
          android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#" + hex)
        } catch (e: IllegalArgumentException) {
          // A colour the page computed in a space this cannot parse (oklch
          // straight out of a custom property) is not worth failing over; the
          // brand's own pink is the honest fallback.
          null
        }
      } ?: lastAccent
      lastLine = line
      lastFavourite = favourite
      NowPlayingWidget.refresh(context)
    }
  }
}

/**
 * One row in the car's browse tree.
 *
 * `browsable` is the whole point of this feature: every node the tree
 * published before was a leaf, so an artist could be shown and never opened.
 */
data class BrowseNode(
  val id: String,
  val title: String,
  val subtitle: String,
  val browsable: Boolean,
)

/** One read of everything the home-screen widget prints. */
data class WidgetState(
  val title: String?,
  val artist: String?,
  /** The third line, when there is something truer than the album to say -
   *  a book's chapter. Null for a song. */
  val line: String?,
  val art: android.graphics.Bitmap?,
  val playing: Boolean,
  val live: Boolean,
  /** Extrapolated to NOW, not the last number the page sent - see
   *  [PlaybackService.widgetSnapshot]. */
  val positionMs: Long,
  val durationMs: Long,
  /** The accent the listener chose, as the page computed it. Null until the
   *  page has said, which is when the widget falls back to the brand's own. */
  val accent: Int?,
  /** Whether the song is already kept. Null means the page has not said, and
   *  the heart stays off the face rather than guessing. */
  val favourite: Boolean?,
)
