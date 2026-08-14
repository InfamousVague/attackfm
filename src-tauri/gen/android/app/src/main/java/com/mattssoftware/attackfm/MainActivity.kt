package com.mattssoftware.attackfm

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

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
