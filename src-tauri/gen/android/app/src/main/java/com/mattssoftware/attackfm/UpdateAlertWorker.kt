package com.mattssoftware.attackfm

import android.app.ActivityManager
import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * One look at the manifest, and at most one notification. See UpdateAlerts.
 *
 * PUBLIC, with the (Context, WorkerParameters) constructor, and that is load-
 * bearing rather than default: WorkManager stores the class NAME and builds the
 * worker by reflection, and the release build is minified. work-runtime's own
 * consumer rules keep the name of every ListenableWorker subclass and the
 * public constructors of every PUBLIC one - an `internal` or `private` worker
 * would compile, pass every debug test, and die in release with nothing in
 * this file to say why.
 *
 * A plain Worker on WorkManager's own background thread, so the blocking
 * HttpURLConnection below is fine where it is. No new HTTP dependency: this is
 * one small GET a few times a day.
 *
 * Every failure is `success()`. A periodic job that answered `retry()` to a
 * registry that is down would back off and knock again on its own clock, and
 * the next period is only hours away anyway - an update announced a few hours
 * late is not worth a phone waking up to ask.
 */
class UpdateAlertWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  private companion object {
    const val TAG = "AFMUpdates"
    const val CONNECT_TIMEOUT_MS = 15_000
    const val READ_TIMEOUT_MS = 20_000
    /** A manifest is two file entries and some notes; anything past this is
     *  not one. */
    const val MAX_BYTES = 256 * 1024
  }

  private data class Manifest(val version: String, val native: Int, val notes: String?)

  private data class Staged(val active: String?, val quarantined: List<String>)

  override fun doWork(): Result {
    val app = applicationContext
    val store = UpdateAlerts.prefs(app)
    // Switched off after this run was already on its way.
    if (!store.getBoolean(UpdateAlerts.KEY_ENABLED, false)) return Result.success()

    val url = store.getString(UpdateAlerts.KEY_MANIFEST, null) ?: UpdateAlerts.DEFAULT_MANIFEST
    val manifest = fetch(url) ?: return Result.success()
    val staged = readBundleState(app)
    val running = store.getString(UpdateAlerts.KEY_RUNNING, null)
    val announced = store.getString(UpdateAlerts.KEY_LAST_NOTIFIED, null)

    val worth = UpdateAlertRules.shouldNotify(
      published = manifest.version,
      publishedNative = manifest.native,
      floors = listOf(running, staged.active, announced),
      quarantined = staged.quarantined,
      nativeGeneration = store.getInt(UpdateAlerts.KEY_GENERATION, 0),
    )
    android.util.Log.i(
      TAG,
      "manifest ${manifest.version} (native ${manifest.native}); running $running, " +
        "staged ${staged.active}, announced $announced -> ${if (worth) "announce" else "quiet"}",
    )
    if (!worth) return Result.success()

    /*
     * Not while somebody is looking at the app.
     *
     * The page asks for updates itself every couple of minutes while it is on
     * screen and puts its own banner up once one is staged, so a tray entry
     * saying the same thing is noise about the screen in front of you - the
     * same rule osNotify.ts applies to the app's other news. NOT recorded as
     * announced: by the next run the page will normally have staged the
     * update, bundles/state.json says so, and the run stays quiet for the
     * right reason; if it has not, the listener hears about it then.
     *
     * IMPORTANCE_FOREGROUND is a visible activity. The playback service alone
     * is FOREGROUND_SERVICE, a step below - music playing behind the home
     * screen is exactly when a notification is wanted.
     */
    val me = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(me)
    if (me.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
      android.util.Log.i(TAG, "app is on screen; leaving ${manifest.version} to the page")
      return Result.success()
    }

    // Asked before recording anything, so a refusal later reversed still hears
    // about the newest version instead of having silently used it up.
    if (!UpdateAlerts.canPost(app)) {
      android.util.Log.i(TAG, "notifications are refused; ${manifest.version} not announced")
      return Result.success()
    }
    if (UpdateAlerts.post(app, manifest.version, manifest.notes)) {
      // commit, not apply: a worker's process can be let go the moment this
      // returns, and an apply still in flight then is an announcement that
      // happens again next time.
      store.edit().putString(UpdateAlerts.KEY_LAST_NOTIFIED, manifest.version).commit()
      android.util.Log.i(TAG, "announced ${manifest.version}")
    }
    return Result.success()
  }

  /** The registry's manifest, or null for nothing published (404), a refusal,
   *  no network, or something that is not a manifest. */
  private fun fetch(address: String): Manifest? {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(address).openConnection() as HttpURLConnection).apply {
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        useCaches = false
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Cache-Control", "no-cache")
      }
      val status = conn.responseCode
      if (status != HttpURLConnection.HTTP_OK) {
        // 404 is the registry's "nothing is published right now", an ordinary
        // state rather than a failure.
        android.util.Log.i(TAG, "manifest answered $status")
        return null
      }
      val raw = conn.inputStream.use { input ->
        val bytes = input.readNBytesCompat(MAX_BYTES)
        String(bytes, Charsets.UTF_8)
      }
      val o = org.json.JSONObject(raw)
      val version = if (o.isNull("version")) "" else o.optString("version").trim()
      if (version.isEmpty()) return null
      Manifest(
        version = version,
        native = o.optInt("native", 0),
        notes = if (o.isNull("notes")) null else o.optString("notes"),
      )
    } catch (e: Exception) {
      android.util.Log.i(TAG, "manifest unreachable: $e")
      null
    } finally {
      conn?.disconnect()
    }
  }

  /**
   * What the OTA installer has staged and refused, from its own file.
   *
   * `<app data dir>/bundles/state.json`, written by src-tauri/src/bundle.rs.
   * Tauri's app_data_dir on Android is the Context's dataDir (PathPlugin's
   * getDataDir), not filesDir - the file is one level above where most Android
   * code would look.
   *
   * Read, never written: that file has one owner and a lock in Rust, and this
   * process has no business in its read-modify-write. An `active` whose files
   * have gone reads as nothing staged - the same rule `bundle_state` applies,
   * because a pointer at a deleted bundle is not an update this device has.
   */
  private fun readBundleState(context: Context): Staged {
    return try {
      val root = File(context.dataDir, "bundles")
      val file = File(root, "state.json")
      if (!file.exists()) return Staged(null, emptyList())
      val o = org.json.JSONObject(file.readText())
      val active = if (o.isNull("active")) null else o.optString("active").trim().ifEmpty { null }
      val present = active?.takeIf {
        File(root, "$it/app.js").exists() && File(root, "$it/app.css").exists()
      }
      val list = o.optJSONArray("quarantined")
      val quarantined = (0 until (list?.length() ?: 0)).mapNotNull { list?.optString(it) }
      Staged(present, quarantined)
    } catch (e: Exception) {
      // Unreadable is treated as nothing staged. The running version is still
      // a floor, so the worst this costs is one early announcement of an
      // update the app had in fact already fetched.
      android.util.Log.w(TAG, "could not read bundle state: $e")
      Staged(null, emptyList())
    }
  }

  /** InputStream.readNBytes is API 33; minSdk is 24. */
  private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < limit) {
      val n = read(buf, 0, minOf(buf.size, limit - out.size()))
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }
}
