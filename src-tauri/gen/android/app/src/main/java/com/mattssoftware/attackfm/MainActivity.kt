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

  /** What the page calls when the deck starts or stops. */
  inner class NativeBridge {
    @JavascriptInterface
    fun setPlaying(next: Boolean) {
      if (playing == next) return
      playing = next
      runOnUiThread {
        if (next) {
          PlaybackService.start(this@MainActivity)
        } else {
          PlaybackService.stop(this@MainActivity)
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
    if (playing) webView?.onResume()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
