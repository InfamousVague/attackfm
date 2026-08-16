package com.mattssoftware.attackfm

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

    @JavascriptInterface
    fun setPlaying(next: Boolean) {
      if (playing == next) return
      playing = next
      applyHold()
    }

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

    /**
     * Hand a transport command to the page.
     *
     * The session's callbacks and the notification's buttons both arrive in the
     * service, which has no WebView of its own - the deck lives in the page.
     * This is the one wire between them, and it is the same shape the audio
     * focus route used to be: a global the page installs, called by name.
     */
    fun deliverTransport(what: String) {
      val activity = live
      if (activity == null) {
        android.util.Log.w("AFMedia", "transport '$what' dropped: no live activity")
        return
      }
      activity.runOnUiThread {
        val wv = activity.webView
        if (wv == null) {
          android.util.Log.w("AFMedia", "transport '$what' dropped: no webview")
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
            android.util.Log.w("AFMedia", "transport '$what' reached page but found $result")
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    live = this
  }

  override fun onDestroy() {
    if (live === this) live = null
    // The webview dies with the activity, and the audio with the webview - a
    // session left standing after this would be controls over a corpse.
    PlaybackService.stop(this)
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
    // The page's line to the foreground service.
    webView.addJavascriptInterface(NativeBridge(), "AFMNative")
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
