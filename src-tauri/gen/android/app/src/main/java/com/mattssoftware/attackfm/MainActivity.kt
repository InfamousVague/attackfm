package com.mattssoftware.attackfm

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    /** How long after our own request a focus loss is read as the WebView's
     *  second ask rather than somebody else's interruption. */
    private const val SELF_REQUEST_GRACE_MS = 2_000L
  }

  private var webView: WebView? = null

  /** What the web layer last told us. Drives all three of the things below:
   *  whether the service runs, whether we hold audio focus, and whether the
   *  WebView is allowed to be paused when the app goes behind something. */
  @Volatile private var playing = false
  private var focusRequest: AudioFocusRequest? = null

  /**
   * When we last asked for focus, so our OWN WebView can be told apart from a
   * real interruption.
   *
   * Chromium requests audio focus itself the moment a media element starts. So
   * pressing play fires two requests from one app - ours here, then the
   * WebView's a beat later - and a new GAIN revokes the previous holder, which
   * is us. The system then reports that to this listener as an ordinary LOSS,
   * indistinguishable from another player taking over, and we paused the very
   * deck we had just been asked to protect: play, then silence, almost at once.
   *
   * A real interruption - a call, a spoken direction - arrives long after the
   * press. Anything inside this window is the app's own second request.
   */
  private var focusAskedAt = 0L

  private val audio: AudioManager
    get() = getSystemService(Context.AUDIO_SERVICE) as AudioManager

  /**
   * Audio focus, which is what navigation actually takes from us.
   *
   * Maps asks for transient focus for every spoken direction. Holding focus is
   * how we are told: a DUCK we ignore (the system lowers us and puts us back),
   * a full transient LOSS pauses, and the matching GAIN resumes. Before this
   * the app never asked for focus at all, so it was never told anything - the
   * WebView simply went quiet and stayed quiet.
   */
  private val onFocusChange = AudioManager.OnAudioFocusChangeListener { change ->
    val selfInflicted =
      change != AudioManager.AUDIOFOCUS_GAIN &&
        SystemClock.elapsedRealtime() - focusAskedAt < SELF_REQUEST_GRACE_MS
    when {
      // Our own WebView taking the focus we just asked for. Ignoring it is the
      // difference between background playback working and the music stopping
      // the instant it starts.
      selfInflicted -> Unit
      change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> toWeb("pause")
      change == AudioManager.AUDIOFOCUS_GAIN -> toWeb("resume")
      // A permanent loss is somebody else taking over for good (another player
      // starting). Stop, and do not creep back in over them.
      change == AudioManager.AUDIOFOCUS_LOSS -> {
        toWeb("pause")
        // NOT abandoning here: a request we have let go of is one the system
        // will never hand back, so abandoning on a loss is what turned "paused
        // for a moment" into "paused for the rest of the drive". Keep the
        // request; the GAIN above is the way back.
      }
      // DUCK: the system lowers the volume itself and restores it. Nothing to
      // do, and pausing here is what makes a nav prompt kill the music.
      else -> Unit
    }
  }

  /** Hands a focus event to the page, which owns the deck. */
  private fun toWeb(event: String) {
    runOnUiThread {
      webView?.evaluateJavascript(
        "window.__AFM_AUDIO_FOCUS__ && window.__AFM_AUDIO_FOCUS__('" + event + "')",
        null,
      )
    }
  }

  private fun requestFocus() {
    focusAskedAt = SystemClock.elapsedRealtime()
    if (focusRequest != null) return
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs)
        // The system ducks us for a nav prompt instead of stopping us.
        .setWillPauseWhenDucked(false)
        .setOnAudioFocusChangeListener(onFocusChange)
        .build()
      focusRequest = req
      audio.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      audio.requestAudioFocus(onFocusChange, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }
  }

  private fun abandonFocus() {
    val req = focusRequest
    focusRequest = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (req != null) audio.abandonAudioFocusRequest(req)
    } else {
      @Suppress("DEPRECATION")
      audio.abandonAudioFocus(onFocusChange)
    }
  }

  /** What the page calls when the deck starts or stops. */
  inner class NativeBridge {
    @JavascriptInterface
    fun setPlaying(next: Boolean) {
      if (playing == next) return
      playing = next
      runOnUiThread {
        if (next) {
          requestFocus()
          PlaybackService.start(this@MainActivity)
        } else {
          PlaybackService.stop(this@MainActivity)
          abandonFocus()
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
    // The page's line to the service and to audio focus.
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
