package com.mattssoftware.attackfm

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.images.WebImage
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Chromecast half of the native layer: discovery, one session, one
 * loaded stream. The page stays the brain - it owns the queue, decides what
 * plays next and where the scrubber is - and this object is its hands on the
 * TV. Everything the page needs to KNOW travels the other way as one whole
 * JSON snapshot into `window.__AFM_CAST__`: no deltas, no ordering, the page
 * just replaces what it holds. (The same shape is kept in [lastJson] so the
 * page can ask for it synchronously at boot, before any push has happened.)
 *
 * Everything here runs on the main thread. The JS bridge calls arrive on a
 * binder thread and MediaRouter/CastContext both refuse to be touched off
 * main, so every entry point posts; state reads come from the last snapshot,
 * never the framework, which is what makes the synchronous boot read safe.
 *
 * Devices without Play services never get past [ensure]: `available` stays
 * false, the page draws no cast rows, and nothing else here runs.
 */
object CastBridge {
  private val main = Handler(Looper.getMainLooper())
  private var cast: CastContext? = null
  private var router: MediaRouter? = null
  private var selector: MediaRouteSelector? = null
  /** Set once init has been attempted, success or not - a phone without Play
   *  services must not pay the failed attempt again on every call. */
  private var tried = false
  private var activeScan = false

  /** Where snapshots go: MainActivity's line into the page. */
  @Volatile var sink: ((String) -> Unit)? = null
  /** The last snapshot, for the page's synchronous boot read. */
  @Volatile var lastJson: String =
    """{"available":false,"devices":[],"session":null,"media":null,"volume":1}"""

  private val routeCallback = object : MediaRouter.Callback() {
    override fun onRouteAdded(r: MediaRouter, route: MediaRouter.RouteInfo) = publish()
    override fun onRouteRemoved(r: MediaRouter, route: MediaRouter.RouteInfo) = publish()
    override fun onRouteChanged(r: MediaRouter, route: MediaRouter.RouteInfo) = publish()
  }

  private val mediaCallback = object : RemoteMediaClient.Callback() {
    override fun onStatusUpdated() = publish()
  }
  private val progressListener =
    RemoteMediaClient.ProgressListener { _, _ -> publish() }

  private val sessionListener = object : SessionManagerListener<CastSession> {
    private fun hook(session: CastSession) {
      session.remoteMediaClient?.let {
        it.registerCallback(mediaCallback)
        it.addProgressListener(progressListener, 1000)
      }
      publish()
    }
    private fun unhook(session: CastSession) {
      session.remoteMediaClient?.let {
        it.unregisterCallback(mediaCallback)
        it.removeProgressListener(progressListener)
      }
      publish()
    }
    override fun onSessionStarted(session: CastSession, sessionId: String) = hook(session)
    override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = hook(session)
    override fun onSessionEnded(session: CastSession, error: Int) = unhook(session)
    override fun onSessionSuspended(session: CastSession, reason: Int) = publish()
    override fun onSessionStarting(session: CastSession) = publish()
    override fun onSessionStartFailed(session: CastSession, error: Int) = publish()
    override fun onSessionEnding(session: CastSession) {}
    override fun onSessionResuming(session: CastSession, sessionId: String) {}
    override fun onSessionResumeFailed(session: CastSession, error: Int) = publish()
  }

  /** Main thread only. True when the framework is up (now or from earlier). */
  private fun ensure(context: Context): Boolean {
    if (cast != null) return true
    if (tried) return false
    tried = true
    return try {
      // Throws on a device without Play services, or when the manifest's
      // options-provider entry is missing - both mean "no casting", quietly.
      val c = CastContext.getSharedInstance(context.applicationContext)
      cast = c
      c.sessionManager.addSessionManagerListener(sessionListener, CastSession::class.java)
      val sel = MediaRouteSelector.Builder()
        .addControlCategory(
          CastMediaControlIntent.categoryForCast(
            CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID,
          ),
        )
        .build()
      selector = sel
      val r = MediaRouter.getInstance(context.applicationContext)
      router = r
      // Passive discovery from the start: mDNS listening, cheap, and what
      // lets the picker's trigger appear at all - a trigger gated on devices
      // that are only discovered after the trigger is pressed is a circle.
      r.addCallback(sel, routeCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
      // A session can predate this init: the app relaunched under a live
      // cast. Hook its media client the same way a fresh start would.
      c.sessionManager.currentCastSession?.let { s ->
        s.remoteMediaClient?.let {
          it.registerCallback(mediaCallback)
          it.addProgressListener(progressListener, 1000)
        }
      }
      publish()
      true
    } catch (e: Exception) {
      android.util.Log.i("AFMCast", "cast unavailable: $e")
      publish()
      false
    }
  }

  /** Build the whole truth and hand it to the page. Main thread only. */
  private fun publish() {
    val c = cast
    val r = router
    val sel = selector
    val out = JSONObject()
    out.put("available", c != null)
    val devices = JSONArray()
    if (r != null && sel != null) {
      for (route in r.routes) {
        if (!route.matchesSelector(sel) || route.isDefault) continue
        devices.put(JSONObject().put("id", route.id).put("name", route.name))
      }
    }
    out.put("devices", devices)
    val session = c?.sessionManager?.currentCastSession
    if (session != null && session.isConnected) {
      out.put("session", JSONObject().put("device", session.castDevice?.friendlyName ?: "Chromecast"))
      out.put("volume", session.volume)
      val status = session.remoteMediaClient?.mediaStatus
      if (status != null && status.playerState != MediaStatus.PLAYER_STATE_IDLE) {
        val rmc = session.remoteMediaClient!!
        out.put(
          "media",
          JSONObject()
            .put(
              "playing",
              status.playerState == MediaStatus.PLAYER_STATE_PLAYING ||
                status.playerState == MediaStatus.PLAYER_STATE_BUFFERING,
            )
            .put("positionMs", rmc.approximateStreamPosition)
            .put("durationMs", rmc.streamDuration),
        )
      } else {
        out.put("media", JSONObject.NULL)
      }
    } else {
      out.put("session", JSONObject.NULL)
      out.put("media", JSONObject.NULL)
      out.put("volume", 1)
    }
    val json = out.toString()
    lastJson = json
    sink?.invoke(json)
  }

  // --- the page's verbs, all posted to main --------------------------------

  /** The page's boot read, and the nudge that first stands the framework up. */
  fun state(context: Context): String {
    main.post { ensure(context) }
    return lastJson
  }

  /**
   * Active scan while the picker is open, passive the rest of the time.
   * Active discovery wakes every cast device's network stack repeatedly -
   * it is the mode Google says to run only while a chooser is on screen.
   */
  fun setDiscovery(context: Context, active: Boolean) {
    main.post {
      if (!ensure(context)) return@post
      val r = router ?: return@post
      val sel = selector ?: return@post
      if (active == activeScan) return@post
      activeScan = active
      r.removeCallback(routeCallback)
      r.addCallback(
        sel,
        routeCallback,
        if (active) MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or
          MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN
        else MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY,
      )
      publish()
    }
  }

  fun connect(context: Context, routeId: String) {
    main.post {
      if (!ensure(context)) return@post
      val r = router ?: return@post
      val route = r.routes.firstOrNull { it.id == routeId } ?: return@post
      // Selecting a cast-category route is what starts the CastSession; the
      // framework watches route selection and does the rest.
      r.selectRoute(route)
    }
  }

  fun disconnect(context: Context) {
    main.post {
      cast?.sessionManager?.endCurrentSession(true)
    }
  }

  /**
   * Point the TV at a stream. The JSON is the page's whole sentence: what to
   * fetch, what to print while it plays, where to start, whether to run.
   */
  fun load(context: Context, json: String) {
    main.post {
      val rmc = cast?.sessionManager?.currentCastSession?.remoteMediaClient ?: return@post
      val o = try { JSONObject(json) } catch (_: Exception) { return@post }
      val url = o.optString("url")
      if (url.isEmpty()) return@post
      val meta = MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK).apply {
        putString(MediaMetadata.KEY_TITLE, o.optString("title"))
        putString(MediaMetadata.KEY_ARTIST, o.optString("artist"))
        putString(MediaMetadata.KEY_ALBUM_TITLE, o.optString("album"))
        val art = o.optString("art")
        if (art.startsWith("http")) addImage(WebImage(Uri.parse(art)))
      }
      val info = MediaInfo.Builder(url)
        .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
        .setContentType(o.optString("contentType", "audio/mpeg"))
        .setMetadata(meta)
        .apply {
          val duration = o.optLong("durationMs", 0)
          if (duration > 0) setStreamDuration(duration)
        }
        .build()
      rmc.load(
        MediaLoadRequestData.Builder()
          .setMediaInfo(info)
          .setAutoplay(o.optBoolean("autoplay", true))
          .setCurrentTime(o.optLong("positionMs", 0))
          .build(),
      )
    }
  }

  fun play(context: Context) {
    main.post { cast?.sessionManager?.currentCastSession?.remoteMediaClient?.play() }
  }

  fun pause(context: Context) {
    main.post { cast?.sessionManager?.currentCastSession?.remoteMediaClient?.pause() }
  }

  fun seek(context: Context, positionMs: Long) {
    main.post {
      cast?.sessionManager?.currentCastSession?.remoteMediaClient
        ?.seek(MediaSeekOptions.Builder().setPosition(positionMs).build())
    }
  }

  fun setVolume(context: Context, volume: Double) {
    main.post {
      try {
        cast?.sessionManager?.currentCastSession?.volume = volume.coerceIn(0.0, 1.0)
      } catch (_: Exception) {
        // A session mid-teardown throws; the next snapshot tells the truth.
      }
    }
  }
}
