package com.mattssoftware.attackfm

import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  /** What the web layer last told us. Drives both of the things below:
   *  whether the foreground service runs, and whether the WebView is allowed
   *  to be paused when the app goes behind something. */
  @Volatile private var playing = false
  @Volatile private var syncing = false
  /*
   * DELIBERATELY no audio-focus request anywhere in this activity.
   *
   * The WebView requests audio focus by itself the moment one of its media
   * elements starts playing - Chromium's media stack owns that request, ducks
   * for a navigation prompt, pauses the element for a phone call. The
   * interruption story is already handled, below any JS.
   *
   * When this activity ALSO requested focus, the two requests fought: focus is
   * granted per-request, not per-app, so whichever landed second revoked the
   * first. Ours landed second (the JS bridge fires after play() has begun),
   * Chromium's grant was revoked, and Chromium answered by pausing the element
   * directly - no focus event reached this activity (our own request had just
   * WON) and none reached the page, whose pause handler read it as a person
   * pressing pause and dropped the intent to play. Every press of play
   * silenced itself within the second. 0.3.62's grace window guarded the
   * wrong loser: it filtered losses on OUR listener, but in the dominant
   * order we never lose - Chromium does, and Chromium tells nobody.
   */

  /** What the page calls when the deck starts or stops, and what is on. */
  inner class NativeBridge {
    /**
     * The song, for everything outside the app to print.
     *
     * Sent from the same place the web mediaSession metadata is set, because
     * on Android that call reaches nothing: a WebView does not publish its
     * page's session to the system. This is the Android half of the same
     * sentence.
     */
    @JavascriptInterface
    fun setNowPlaying(title: String, artist: String, album: String, durationMs: Long) {
      PlaybackService.publishMetadata(title, artist, album, durationMs)
    }

    /** Playing or not, and where - the state a car draws its scrubber from. */
    @JavascriptInterface
    fun setPlaybackState(playing: Boolean, positionMs: Long) {
      PlaybackService.publishState(playing, positionMs)
    }

    /**
     * What only the home-screen widget wants: the listener's accent, the line
     * under the title, and whether this one is kept.
     *
     * Separate from setNowPlaying because none of it is metadata a car or a
     * lock screen has any use for, and because it changes on its own clock -
     * a heart is pressed without the song changing.
     *
     * `favourite` is an Int rather than a Boolean so the page can say "I do not
     * know": -1 leaves the heart off the widget entirely, which is the honest
     * face before the library has answered. A bridge cannot carry a nullable.
     */
    /**
     * A photograph of the widget's face, from the page that drew it.
     *
     * The launcher cannot run the kit, so it is shown a picture instead - see
     * WidgetShots and src/app/widget/shot.ts. Base64 because the bridge is a
     * string pipe, the same reason the cover travels that way.
     */
    @JavascriptInterface
    fun setWidgetShot(face: String, base64: String) {
      WidgetShots.receive(this@MainActivity, face, base64)
    }

    @JavascriptInterface
    fun setNowPlayingExtras(accentHex: String, line: String, favourite: Int) {
      PlaybackService.publishExtras(
        this@MainActivity,
        accentHex.ifBlank { null },
        line.ifBlank { null },
        if (favourite < 0) null else favourite > 0,
      )
    }

    /**
     * The cover, as bytes. The web layer already holds the image (cached,
     * authenticated, resized); base64 keeps the bridge a string pipe and
     * spares this side a network stack. Decode failures drop silently -
     * a missing cover is a state the system surfaces render fine.
     */
    @JavascriptInterface
    fun setArtwork(base64: String) {
      val bytes = try {
        android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
      } catch (_: Exception) { return }
      val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
      PlaybackService.publishArtwork(bmp)
    }

    /** Asked for by the page as it starts, so a cold launch from a share does
     *  not lose the link it was launched with. */
    @JavascriptInterface
    fun takeSharedLink(): String {
      val link = shared ?: return ""
      shared = null
      return link
    }

    /**
     * The page's playlists, for Android Auto's browse list.
     *
     * JSON in, because org.json ships with the platform and three fields do
     * not earn a schema. Tabs are stripped from what gets stored - the cache
     * under this is tab-separated, and a name is not allowed to break the
     * format it rides in.
     */
    @JavascriptInterface
    fun setCollections(json: String) {
      val rows = try {
        val arr = org.json.JSONArray(json)
        (0 until arr.length()).mapNotNull { i ->
          val o = arr.optJSONObject(i) ?: return@mapNotNull null
          val id = o.optString("id")
          val name = o.optString("name").replace("\t", " ")
          if (id.isEmpty() || name.isEmpty()) null
          else Triple(id, name, o.optString("subtitle").replace("\t", " "))
        }
      } catch (_: Exception) { return }
      PlaybackService.publishCollections(this@MainActivity, rows)
    }

    /**
     * The whole browse tree for the car, in one call.
     *
     * `{ "<parentId>": [ { id, name, subtitle, browsable } ] }`. One call
     * rather than one per branch because the page rebuilds the tree whole
     * whenever the library changes, and a car that read a half-written tree
     * would show branches that open into the previous library.
     *
     * Tabs are stripped from every field: the cache under this is
     * tab-separated, and a song called "a\tb" is not allowed to break the
     * format carrying it.
     */
    @JavascriptInterface
    fun setBrowseTree(json: String) {
      val tree = try {
        val root = org.json.JSONObject(json)
        val out = LinkedHashMap<String, List<BrowseNode>>()
        for (parent in root.keys()) {
          val arr = root.optJSONArray(parent) ?: continue
          val nodes = (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("id")
            val name = o.optString("name").replace("\t", " ")
            if (id.isEmpty() || name.isEmpty()) {
              null
            } else {
              BrowseNode(id, name, o.optString("subtitle").replace("\t", " "), o.optBoolean("browsable"))
            }
          }
          out[parent] = nodes
        }
        out
      } catch (_: Exception) { return }
      PlaybackService.publishBrowseTree(this@MainActivity, tree)
    }

    /**
     * The page can answer transport commands now.
     *
     * Called when the web layer installs `window.__AFM_TRANSPORT__`. This is
     * the handshake that makes a cold car tap work: the command was kept while
     * there was no page, the app was started, and this is the app saying it is
     * ready to be told what the driver pressed.
     */
    /**
     * What killed the webview last time, if anything did - read once and
     * cleared, so the diagnostics report can finally say "the renderer was
     * killed by the system" instead of showing an empty ring after a death
     * that never reached JavaScript.
     */
    @JavascriptInterface
    fun lastWebviewDeath(): String? =
        try {
            // Three ways a run can end without a word - the renderer dying,
            // an uncaught Kotlin exception, a Rust panic - and each leaves its
            // note under a different name. All of them are the answer to the
            // same question.
            // The Rust side writes where Tauri says the app's data lives,
            // which on Android may be filesDir or its parent - look in both.
            val places = listOfNotNull(filesDir, filesDir.parentFile)
            val notes = listOf("last-webview-death.txt", "last-uncaught-death.txt", "last-native-death.txt")
                .flatMap { name -> places.map { java.io.File(it, name) } }
                .mapNotNull { f ->
                    if (f.exists()) {
                        val text = f.readText()
                        f.delete()
                        text
                    } else null
                }
            /*
             * And the OS's own record. Android 11+ keeps the reason it last
             * ended this app - native crash, ANR, the low-memory killer, a
             * signal - which covers every death our own hooks cannot see,
             * because the killer was outside the process. Only a reason from
             * AFTER the previous read is reported, so an old death is not
             * re-announced forever.
             */
            val system = try {
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    val am = getSystemService(android.app.ActivityManager::class.java)
                    val marker = java.io.File(filesDir, "last-exit-read.txt")
                    val since = marker.takeIf { it.exists() }?.readText()?.toLongOrNull() ?: 0L
                    val reasons = am.getHistoricalProcessExitReasons(packageName, 0, 3)
                    val fresh = reasons.firstOrNull { it.timestamp > since && it.processName == packageName }
                    marker.writeText(System.currentTimeMillis().toString())
                    fresh?.let {
                        val why = when (it.reason) {
                            android.app.ApplicationExitInfo.REASON_CRASH -> "java crash"
                            android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
                            android.app.ApplicationExitInfo.REASON_ANR -> "not responding (ANR)"
                            android.app.ApplicationExitInfo.REASON_LOW_MEMORY -> "killed for memory"
                            android.app.ApplicationExitInfo.REASON_SIGNALED -> "signal ${it.status}"
                            android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource use"
                            android.app.ApplicationExitInfo.REASON_USER_REQUESTED -> "closed by the user"
                            android.app.ApplicationExitInfo.REASON_USER_STOPPED -> "stopped by the user"
                            else -> "reason ${it.reason}"
                        }
                        "the system recorded: $why${it.description?.let { d -> " — $d" } ?: ""}"
                    }
                } else null
            } catch (_: Exception) { null }
            val all = notes + listOfNotNull(system)
            if (all.isEmpty()) null else all.joinToString(" | ")
        } catch (_: Exception) {
            null
        }

    /** The audiobook drop folder's absolute path, or null where there is none. */
    @JavascriptInterface
    fun audiobooksDir(): String? = booksDir

    /**
     * The BROWSABLE vault: /storage/emulated/0/AttackFM/Music, the folder any
     * file manager can walk into - by request, so cached music can be browsed
     * and pruned by hand. Android/data (the audiobooks folder's compromise
     * above) has been walled off from file managers since Android 11; the
     * shared root is the only place that is genuinely browsable, and writing
     * there needs the all-files grant below. Null until that grant exists -
     * the web layer falls back to the private vault and nothing changes.
     */
    @JavascriptInterface
    fun vaultDir(): String? =
      try {
        if (!android.os.Environment.isExternalStorageManager()) null
        else {
          val dir = java.io.File(
            android.os.Environment.getExternalStorageDirectory(),
            "AttackFM/Music",
          )
          if (!dir.exists() && !dir.mkdirs()) null else dir.absolutePath
        }
      } catch (_: Exception) {
        null
      }

    /** Whether the all-files grant is already in hand. */
    @JavascriptInterface
    fun canBrowseVault(): Boolean =
      try {
        android.os.Environment.isExternalStorageManager()
      } catch (_: Exception) {
        false
      }

    /**
     * Open the system's all-files-access page for this app. A SETTINGS SCREEN,
     * not a dialog - Android gives this permission no runtime prompt - so the
     * web layer says where the person is being taken before calling this.
     */
    @JavascriptInterface
    fun requestVaultAccess() {
      try {
        val intent = Intent(
          android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
          android.net.Uri.parse("package:$packageName"),
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
      } catch (_: Exception) {
        // A build without the screen (some forks): the toggle lives under
        // Settings > Apps > Special access > All files access instead.
      }
    }

    @JavascriptInterface
    fun transportReady() {
      runOnUiThread { flushTransport() }
    }

    @JavascriptInterface
    fun setPlaying(next: Boolean) {
      if (playing == next) return
      playing = next
      applyHold()
    }

    // --- Chromecast, all thin delegates to CastBridge -----------------------
    // The page is the brain: it decides what the TV should fetch and when.
    // These are its hands. Every one is safe on a phone that cannot cast at
    // all - CastBridge answers "unavailable" and ignores the verbs.

    /** The snapshot as of the last push, and the nudge that stands the
     *  framework up the first time anyone asks. */
    @JavascriptInterface
    fun castState(): String = CastBridge.state(this@MainActivity)

    /** Active scan while the device picker is open, passive otherwise. */
    @JavascriptInterface
    fun castDiscovery(active: Boolean) = CastBridge.setDiscovery(this@MainActivity, active)

    @JavascriptInterface
    fun castConnect(routeId: String) = CastBridge.connect(this@MainActivity, routeId)

    @JavascriptInterface
    fun castDisconnect() = CastBridge.disconnect(this@MainActivity)

    /** Point the TV at a stream - url/title/artist/album/art/contentType/
     *  durationMs/positionMs/autoplay, as one JSON sentence. */
    @JavascriptInterface
    fun castLoad(json: String) = CastBridge.load(this@MainActivity, json)

    @JavascriptInterface
    fun castPlay() = CastBridge.play(this@MainActivity)

    @JavascriptInterface
    fun castPause() = CastBridge.pause(this@MainActivity)

    @JavascriptInterface
    fun castSeek(positionMs: Double) = CastBridge.seek(this@MainActivity, positionMs.toLong())

    @JavascriptInterface
    fun castVolume(volume: Double) = CastBridge.setVolume(this@MainActivity, volume)

    /**
     * The cache sweep's hold on the process.
     *
     * Without it, tabbing away mid-sweep froze the app and every queued
     * download died at the socket - "fetch failed: error sending request",
     * 144 times. The same service that keeps playback alive keeps the sync
     * alive, wearing the dataSync type and its own notification words while
     * no song is on.
     */
    @JavascriptInterface
    fun setSyncing(next: Boolean) {
      if (syncing == next) return
      syncing = next
      PlaybackService.syncing = next
      applyHold()
    }
  }

  /** One rule for the service: it runs while EITHER leg needs the process,
   *  so a song ending mid-sweep does not drop the downloads with it.
   *
   *  Pause SOFTENS rather than stops. Stopping released the MediaSession and
   *  dismissed the notification, which blanked every control surface outside
   *  the app - lock screen, a paired computer's media panel, Android Auto -
   *  and made play-from-outside impossible: there was nothing left to press.
   *  The controls only truly leave when the paused notification is swiped
   *  away, or the activity itself dies. */
  private fun applyHold() {
    runOnUiThread {
      if (playing || syncing) PlaybackService.start(this)
      else PlaybackService.soften()
    }
  }

  companion object {
    /** The activity currently on screen, so the service can reach its page. */
    private var live: MainActivity? = null

    /** A shared link waiting for the web layer to exist. */
    private var shared: String? = null

    /** Where books you already own are dropped, once the activity has made it. */
    private var booksDir: String? = null

    /**
     * Hand a transport command to the page.
     *
     * The session's callbacks and the notification's buttons both arrive in the
     * service, which has no WebView of its own - the deck lives in the page.
     * This is the one wire between them, and it is the same shape the audio
     * focus route used to be: a global the page installs, called by name.
     */
    /**
     * Commands that arrived before there was anywhere to put them.
     *
     * A car does NOT wait for the app. Android Auto binds the browse service
     * itself, and the service answers the tree from its own cache - so the
     * dashboard can be showing your playlists while this activity does not
     * exist at all. Every tap on that list then arrived here, found no page,
     * and was thrown away: the rows drew perfectly and playing one did
     * nothing, which is the exact shape of "my music isn't showing up in the
     * car". Same for a tap that lands in the seconds after launch, before the
     * page has installed its handler.
     *
     * So a command with nowhere to go is now KEPT, the app is started to make
     * somewhere for it to go, and the page flushes the queue the moment it can
     * answer (`transportReady`). Bounded, because a queue of stale intents is
     * its own bug - a drive's worth of button presses must not all fire at
     * once when the page finally opens.
     */
    private val pending = ArrayDeque<String>()
    private const val MAX_PENDING = 4

    private fun remember(what: String) {
      // One press of a kind is enough; the newest wins for repeats.
      pending.remove(what)
      pending.addLast(what)
      while (pending.size > MAX_PENDING) pending.removeFirst()
    }

    /** The page has a handler now: hand it everything that was waiting. */
    fun flushTransport() {
      if (pending.isEmpty()) return
      val waiting = pending.toList()
      pending.clear()
      android.util.Log.i("AFMedia", "flushing ${waiting.size} queued transport command(s)")
      for (what in waiting) deliverTransport(null, what)
    }

    /**
     * @param context When given, the app is STARTED if it is not running -
     *   which is the whole point for a car. Null when re-delivering something
     *   already queued, so a failed flush cannot loop back into a launch.
     */
    fun deliverTransport(context: Context?, what: String) {
      val activity = live
      if (activity == null) {
        android.util.Log.w("AFMedia", "transport '$what' held: no live activity")
        remember(what)
        // Bring the page up so there is something to hand it to. The app holds
        // a media foreground service at this point, which is what makes the
        // start permissible from the background; if the system refuses anyway
        // the command simply stays queued for the next time the app is opened,
        // which is still better than the silence this replaced.
        context?.let {
          try {
            it.startActivity(
              Intent(it, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
          } catch (e: Exception) {
            android.util.Log.w("AFMedia", "could not start the app for '$what': $e")
          }
        }
        return
      }
      activity.runOnUiThread {
        val wv = activity.webView
        if (wv == null) {
          android.util.Log.w("AFMedia", "transport '$what' held: no webview")
          remember(what)
          return@runOnUiThread
        }
        // A paused, backgrounded webview is FROZEN: evaluateJavascript queues
        // but nothing runs until the app is foregrounded by hand - which read
        // as "play from the lock screen does nothing". Waking it first costs
        // nothing when it is already awake, and the page's own setPlaying
        // keeps it awake from there.
        wv.onResume()
        android.util.Log.i("AFMedia", "transport -> page: $what")
        val escaped = what.replace("\\", "\\\\").replace("'", "\\'")
        wv.evaluateJavascript(
          "window.__AFM_TRANSPORT__ ? (window.__AFM_TRANSPORT__('" + escaped + "'), 'handled') : 'no-handler'",
        ) { result ->
          if (result != "\"handled\"") {
            // The page is up but not yet listening - a tap in the first
            // seconds of a cold start. Held rather than lost; transportReady
            // is moments away.
            android.util.Log.w("AFMedia", "transport '$what' held: page answered $result")
            remember(what)
          }
        }
      }
    }
  }

  /**
   * The WebView is NOT paused while music is playing.
   *
   * TauriActivity's onPause calls mWebView.onPause(), which suspends the
   * processing attached to the view and its DOM. That is right for a page
   * nobody is looking at and wrong for one that is the music player: whatever
   * exactly it suspends, it is the only thing standing between "backgrounded"
   * and "the deck keeps running". Letting super pause it and immediately
   * un-pausing is the contained way to say so from here - the alternative is
   * editing generated code that regenerates.
   *
   * Only while playing: a backgrounded app that is silent goes properly quiet,
   * and costs nothing.
   */
  override fun onPause() {
    super.onPause()
    // The deck keeps running for music, and for a sweep: a paused webview
    // cannot finish the downloads its own sweep started.
    if (playing || syncing) webView?.onResume()
  }

  /**
   * Portrait on a phone, whatever the device likes on anything bigger.
   *
   * The decision is a resource, not a measurement taken here: res/values
   * says no and res/values-sw600dp says yes, so Android's own definition of
   * "big enough" picks the answer and a television - far past 600dp - keeps
   * the landscape it can only ever be in.
   *
   * UNSPECIFIED rather than a landscape or sensor value on the large side:
   * that is what this activity had before any lock existed, so tablets keep
   * exactly the behaviour they have today, the device's own rotation setting
   * included.
   */
  private fun applyOrientationLock() {
    requestedOrientation =
      if (resources.getBoolean(R.bool.afm_rotate)) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
  }

  /**
   * The drop folder for books you already own.
   *
   * An audiobook bought from a shop arrives as a file, not as a catalogue
   * entry - so there has to be somewhere to PUT it. This is the app's own
   * external files directory, which is the one place on modern Android a media
   * app may create and read without asking for a storage permission it has no
   * other use for.
   *
   * The honest caveat, and the reason this is a starting point rather than the
   * finished answer: since Android 11 the Files app will not browse into
   * `Android/data`, so this folder is comfortable to reach over USB or adb and
   * awkward to reach from the phone itself. A folder the user picks (SAF) and
   * the share sheet are the two ways to fix that, and neither changes what
   * happens to a file once it is here.
   */
  private fun ensureAudiobooksFolder(): String? =
    try {
      val dir = java.io.File(getExternalFilesDir(null), "Audiobooks")
      if (!dir.exists() && !dir.mkdirs()) {
        android.util.Log.w("AFMBooks", "could not create ${dir.absolutePath}")
        null
      } else {
        android.util.Log.i("AFMBooks", "audiobooks folder: ${dir.absolutePath}")
        dir.absolutePath
      }
    } catch (e: Exception) {
      android.util.Log.w("AFMBooks", "audiobooks folder failed: $e")
      null
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    // An uncaught exception on ANY thread - a @JavascriptInterface method, a
    // handler, the main thread - kills the app with nothing in the ring the
    // diagnostics can reach. Note it first, then let the death proceed:
    // surviving an unknown exception is how state corrupts; naming it is how
    // it gets fixed.
    val prior = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, e ->
      try {
        val stack = android.util.Log.getStackTraceString(e).take(2000)
        java.io.File(filesDir, "last-uncaught-death.txt")
          .writeText("uncaught on ${thread.name}: $stack")
      } catch (_: Exception) {}
      prior?.uncaughtException(thread, e)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    live = this
    booksDir = ensureAudiobooksFolder()
    applyOrientationLock()
    // The share that launched us, if that is how we were started.
    shared = linkFrom(intent)
    // Or the spoken request that did. A cold "play X on AttackFM" arrives
    // here rather than in onNewIntent - the process did not exist to be
    // re-entered - and this is the case the whole intent filter is for.
    playFromSearch(intent)
  }

  /**
   * A link shared INTO the app - "Share -> AttackFM" from Spotify or anywhere
   * else - rather than tapped as a link.
   *
   * This is the door that actually works. An https link to open.spotify.com is
   * a verified App Link belonging to Spotify, so Android hands it straight to
   * Spotify and never offers us; the spotify: scheme does reach a chooser but
   * is not the form anyone shares. The share sheet is neither: it asks every
   * time, it needs nothing turned off, and Spotify's own Share menu puts us in
   * it.
   *
   * Held rather than delivered when there is no page yet - a cold launch from
   * a share runs this long before any JavaScript exists, and the web layer
   * collects it when it starts.
   */
  private fun linkFrom(intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_SEND) return null
    if (intent.type != "text/plain") return null
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return null
    // Shared text is usually a sentence WITH a link in it ("Listen to X by Y
    // on Spotify: https://..."), so take the URL rather than the message.
    val url = Regex("(https?://\\S+|spotify:\\S+)").find(text)?.value ?: return null
    return url.trimEnd('.', ',', ')')
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (playFromSearch(intent)) return
    val link = linkFrom(intent) ?: return
    shared = link
    deliverShared()
  }

  /**
   * Assistant asking for something by name.
   *
   * Routed through `deliverTransport` rather than straight at the WebView,
   * because the whole point of this path is that it arrives when the app is
   * NOT running: that function already holds a command until a page exists and
   * brings the app up to make one, which is exactly the behaviour a spoken
   * request needs. The words themselves are resolved on the page, by the same
   * search the search screen uses.
   *
   * An empty query is a real request - "play music on AttackFM" - and means
   * shuffle, the same reading the session callback gives it.
   */
  private fun playFromSearch(intent: Intent?): Boolean {
    if (intent?.action != "android.media.action.MEDIA_PLAY_FROM_SEARCH") return false
    val query = intent.getStringExtra(android.app.SearchManager.QUERY)?.trim().orEmpty()
    deliverTransport(this, if (query.isEmpty()) "collection:shuffle" else "search:" + query)
    return true
  }

  /** Hands the held share to the page, if there is a page to hand it to. */
  private fun deliverShared() {
    val link = shared ?: return
    val wv = webView ?: return
    runOnUiThread {
      wv.onResume()
      val escaped = link.replace("\\", "\\\\").replace("'", "\\'")
      wv.evaluateJavascript(
        "window.__AFM_SHARED_LINK__ ? (window.__AFM_SHARED_LINK__('" + escaped + "'), 'ok') : 'no'",
      ) { result ->
        // Cleared only once it actually landed; otherwise it waits for the
        // page to come up and ask for it.
        if (result == "\"ok\"") shared = null
        else android.util.Log.i("AFMedia", "shared link held: page not ready ($result)")
      }
    }
  }

  /**
   * Re-decided whenever the screen itself changes shape.
   *
   * The manifest lists screenLayout and smallestScreenSize among the changes
   * this activity handles, which means Android hands them over instead of
   * recreating the activity - so a lock set once at startup would outlive the
   * screen it was chosen for. A foldable opened out is exactly that case: it
   * crosses 600dp mid-session and would otherwise stay pinned to the phone's
   * portrait on a tablet-sized display.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyOrientationLock()
  }

  /** Whether this activity ever actually came up. See onDestroy. */
  private var everResumed = false

  override fun onResume() {
    super.onResume()
    everResumed = true
    // A service start the system refused while we were backgrounded gets its
    // foreground moment here. applyHold() is idempotent - starting an
    // already-running service is a no-op - so re-applying is always safe.
    if (PlaybackService.startDenied) {
      PlaybackService.startDenied = false
      applyHold()
    }
  }


  /**
   * wry's own client, with one addition: the renderer dying does not take the
   * application with it. The note goes to a file the diagnostics read back on
   * the next launch, and the activity recreates - a restart instead of a
   * vanishing act. Everything else is forwarded untouched, because the
   * wrapped client is what serves tauri.localhost itself.
   */
  private class SurvivingWebViewClient(
    private val activity: android.app.Activity,
    private val inner: android.webkit.WebViewClient,
  ) : android.webkit.WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?) =
      inner.shouldOverrideUrlLoading(view, request)
    override fun shouldInterceptRequest(view: WebView?, request: android.webkit.WebResourceRequest?) =
      inner.shouldInterceptRequest(view, request)
    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) =
      inner.onPageStarted(view, url, favicon)
    override fun onPageFinished(view: WebView?, url: String?) = inner.onPageFinished(view, url)
    override fun onLoadResource(view: WebView?, url: String?) = inner.onLoadResource(view, url)
    override fun onPageCommitVisible(view: WebView?, url: String?) = inner.onPageCommitVisible(view, url)
    override fun onReceivedError(
      view: WebView?,
      request: android.webkit.WebResourceRequest?,
      error: android.webkit.WebResourceError?,
    ) = inner.onReceivedError(view, request, error)
    override fun onReceivedHttpError(
      view: WebView?,
      request: android.webkit.WebResourceRequest?,
      errorResponse: android.webkit.WebResourceResponse?,
    ) = inner.onReceivedHttpError(view, request, errorResponse)
    override fun onReceivedSslError(
      view: WebView?,
      handler: android.webkit.SslErrorHandler?,
      error: android.net.http.SslError?,
    ) = inner.onReceivedSslError(view, handler, error)
    override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) =
      inner.doUpdateVisitedHistory(view, url, isReload)
    override fun onFormResubmission(view: WebView?, dontResend: android.os.Message?, resend: android.os.Message?) =
      inner.onFormResubmission(view, dontResend, resend)
    override fun onReceivedHttpAuthRequest(
      view: WebView?,
      handler: android.webkit.HttpAuthHandler?,
      host: String?,
      realm: String?,
    ) = inner.onReceivedHttpAuthRequest(view, handler, host, realm)
    override fun onReceivedClientCertRequest(view: WebView?, request: android.webkit.ClientCertRequest?) =
      inner.onReceivedClientCertRequest(view, request)
    override fun onScaleChanged(view: WebView?, oldScale: Float, newScale: Float) =
      inner.onScaleChanged(view, oldScale, newScale)
    override fun shouldOverrideKeyEvent(view: WebView?, event: android.view.KeyEvent?) =
      inner.shouldOverrideKeyEvent(view, event)
    override fun onUnhandledKeyEvent(view: WebView?, event: android.view.KeyEvent?) =
      inner.onUnhandledKeyEvent(view, event)

    override fun onRenderProcessGone(
      view: WebView?,
      detail: android.webkit.RenderProcessGoneDetail?,
    ): Boolean {
      val why =
        if (detail?.didCrash() == true) "renderer crashed"
        else "renderer was killed by the system (low memory)"
      android.util.Log.e("AFMedia", "webview gone: $why")
      try {
        val file = java.io.File(activity.filesDir, "last-webview-death.txt")
        file.writeText("${java.util.Date()} — $why (priority ${detail?.rendererPriorityAtExit() ?: -1})")
      } catch (_: Exception) {}
      try {
        activity.recreate()
      } catch (_: Exception) {}
      return true
    }
  }

  override fun onDestroy() {
    if (live === this) live = null
    /*
     * The webview dies with the activity, and the audio with the webview - a
     * session left standing after this would be controls over a corpse.
     *
     * UNLESS this activity never came up at all. When the service asks for the
     * app on a car's behalf, Android may refuse the background start: the
     * activity is created and destroyed without ever being shown, and it would
     * take the media session down with it on its way out - the app vanishing
     * from the dashboard as a direct result of the driver pressing something.
     * A stillborn activity owns no webview and no audio, so it has nothing to
     * clean up and must not clean up somebody else's.
     */
    if (everResumed) PlaybackService.stop(this)
    super.onDestroy()
  }

  // The system back gesture, routed into the app instead of out of it.
  //
  // TauriActivity opts out of wry's own back handling (handleBackNavigation =
  // false), so without this the dispatcher holds no callbacks at all and a back
  // swipe falls through to the framework default: finish() - the whole app
  // closes from anywhere. The app is a SPA with its OWN page history (the nav
  // stack in App.tsx) plus sheets and modals the gesture should dismiss first,
  // and only the web side knows any of that. So: hand the gesture to the page
  // (window.__AFM_BACK__, installed by src/app/systemBack.ts), which closes an
  // overlay or steps its history and answers true - or answers false at the
  // root, where backing out means backgrounding the task, the way every other
  // Android app leaves the stage. Never finish(): a music player that keeps
  // playing wants its process alive behind the home screen.
  //
  // Registered in onWebViewCreate - the hook WryActivity calls once the
  // webview exists - so there is a page to evaluate against by the time the
  // callback can possibly fire.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    /*
     * Outlive the renderer.
     *
     * When Android kills the webview's renderer - reclaiming memory, almost
     * always - the DEFAULT is to kill the whole application, which from the
     * couch is "the app just closed", with an empty diagnostics ring because
     * nothing survived to write. The handler has to live on the WebViewClient,
     * and wry OWNS the client - its RustWebViewClient is regenerated from
     * templates on every build, so an override written into it lasts exactly
     * one build (measured). So the client wry installed is wrapped instead,
     * from the hand-written layer that survives regeneration: every behaviour
     * forwarded, one question answered differently. Posted, because wry
     * assigns its client after this hook returns.
     */
    webView.post {
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        val current = webView.webViewClient
        if (current !is SurvivingWebViewClient) {
          webView.webViewClient = SurvivingWebViewClient(this, current)
        }
      }
    }
    // The page's line to the foreground service.
    webView.addJavascriptInterface(NativeBridge(), "AFMNative")
    // Cast snapshots flow the other way, into window.__AFM_CAST__. The same
    // wake-first rule as the transport push: a frozen webview queues
    // evaluateJavascript forever, and a snapshot delivered after the app is
    // foregrounded by hand is a snapshot nobody was waiting for. The page
    // installs the handler before it ever asks castState(), so a push that
    // finds no handler just means a boot still in progress - dropped, and the
    // boot read covers it.
    CastBridge.sink = { json ->
      val wv = this.webView
      runOnUiThread {
        if (wv != null) {
          wv.onResume()
          val escaped = json.replace("\\", "\\\\").replace("'", "\\'")
          wv.evaluateJavascript(
            "window.__AFM_CAST__ && window.__AFM_CAST__('" + escaped + "')",
            null,
          )
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = this@MainActivity.webView
        if (wv == null) {
          moveTaskToBack(true)
          return
        }
        wv.evaluateJavascript("window.__AFM_BACK__ ? window.__AFM_BACK__() : false") { result ->
          // evaluateJavascript hands back the JSON of the expression: "true"
          // when the page consumed the gesture. Anything else - false, null
          // from a page still loading - means the app is at its root.
          if (result != "true") {
            moveTaskToBack(true)
          }
        }
      }
    })
  }
}
