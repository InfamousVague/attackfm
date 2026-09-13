package com.mattssoftware.attackfm

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * "Tell me when there is a new AttackFM", while the app is closed.
 *
 * The app already updates ITSELF: the launch gate installs a newer frontend
 * before the first screen (LaunchUpdate.tsx) and the session asks again every
 * couple of minutes while it is on screen (serverSession.tsx). What neither can
 * do is reach somebody who has not opened the app - a page that is not running
 * asks nobody anything. So this is only the knock on the door: a periodic
 * WorkManager job reads the same public manifest the page reads, and when it
 * names a version this device has not got, it posts one notification. Tapping
 * it opens the app, and the ordinary launch gate does the actual updating.
 * Nothing here downloads or installs a byte of the update.
 *
 * OPT-IN, and owned by the page. The switch lives in Settings > Notifications
 * (`attackfm-update-alerts` in localStorage, off by default), and the page says
 * what it holds through `setUpdateAlerts` on every start as well as on every
 * flip - so the schedule converges on the switch after a reinstall, a restored
 * backup or anything else that lets the two disagree, rather than trusting
 * that they never will.
 *
 * WorkManager rather than an alarm or a service because it is the one
 * scheduler that survives a reboot (it re-registers itself from its own
 * database), respects Doze without special permissions, and waits for a
 * network by itself. The cost is that the OS chooses the exact moment: six
 * hours is a floor, not an appointment.
 */
object UpdateAlerts {
  private const val TAG = "AFMUpdates"

  /** One unique job for the app's whole life; see [schedule]. */
  private const val WORK = "attackfm.update-alerts"

  /** Its own channel, not the notification plugin's "default" and not the
   *  playback one: a listener who silences update news in the system settings
   *  must not be silencing their download notices or their transport controls
   *  along with it. */
  const val CHANNEL = "attackfm.updates"

  /** A fixed id, so a newer version REPLACES the older entry in the tray
   *  instead of stacking a second one beside it. Not PlaybackService's 1. */
  private const val NOTIFICATION_ID = 0x0AF_0907

  private const val PERIOD_HOURS = 6L

  /** Where the page itself asks (appUpdate.ts, `${REGISTRY_URL}/v1/app/bundle`),
   *  used until the page has told us otherwise. */
  const val DEFAULT_MANIFEST = "https://registry.attack.fm/v1/app/bundle"

  private const val PREFS = "attackfm.update-alerts"
  const val KEY_ENABLED = "enabled"
  /** The version the page last said it was running - the baseline. */
  const val KEY_RUNNING = "runningVersion"
  const val KEY_GENERATION = "nativeGeneration"
  const val KEY_LAST_NOTIFIED = "lastNotifiedVersion"
  const val KEY_MANIFEST = "manifestUrl"
  private const val KEY_COPY_CHANNEL = "copyChannel"
  private const val KEY_COPY_CHANNEL_HINT = "copyChannelHint"
  private const val KEY_COPY_TITLE = "copyTitle"
  private const val KEY_COPY_BODY = "copyBody"

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /**
   * The page's whole answer, as one JSON sentence:
   * `{ enabled, version, nativeGeneration, manifestUrl, copy: { channel,
   * channelHint, title, body } }`.
   *
   * One string rather than positional arguments because a JavascriptInterface
   * method is matched by name AND argument count: a later page that sent one
   * more field to an older binary would throw instead of being ignored. JSON
   * lets either side grow.
   *
   * The COPY rides along because the words belong to the page. The worker runs
   * with no page and no i18next, and the catalogue that knows how to say "is
   * out" in Arabic is in the bundle, not in this APK - so the page translates
   * at the moment it calls (every start, and every language change) and this
   * side stores the result. English fallbacks cover a store that was never
   * written.
   */
  fun configure(context: Context, json: String) {
    val app = context.applicationContext
    val o = try {
      org.json.JSONObject(json)
    } catch (e: Exception) {
      android.util.Log.w(TAG, "ignoring a malformed configuration: $e")
      return
    }
    val enabled = o.optBoolean("enabled", false)
    val copy = o.optJSONObject("copy")
    val store = prefs(app)
    store.edit().apply {
      putBoolean(KEY_ENABLED, enabled)
      text(o, "version")?.let { putString(KEY_RUNNING, it) }
      o.optInt("nativeGeneration", 0).takeIf { it > 0 }?.let { putInt(KEY_GENERATION, it) }
      text(o, "manifestUrl")
        ?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        ?.let { putString(KEY_MANIFEST, it) }
      if (copy != null) {
        text(copy, "channel")?.let { putString(KEY_COPY_CHANNEL, it) }
        text(copy, "channelHint")?.let { putString(KEY_COPY_CHANNEL_HINT, it) }
        text(copy, "title")?.let { putString(KEY_COPY_TITLE, it) }
        text(copy, "body")?.let { putString(KEY_COPY_BODY, it) }
      }
    }.apply()

    try {
      val work = WorkManager.getInstance(app)
      if (enabled) schedule(work) else work.cancelUniqueWork(WORK)
    } catch (e: Exception) {
      // WorkManager not initialised (a stripped startup provider, a process
      // that is not the app's main one). The switch is stored; the next start
      // tries again.
      android.util.Log.w(TAG, "could not ${if (enabled) "schedule" else "cancel"} update checks: $e")
    }

    if (enabled) {
      // Renames the channel in the system settings when the language changed.
      // Only when on: a listener who never asked for this should not find an
      // "App updates" category under the app's notification settings.
      ensureChannel(app)
      retireIfAnswered(app)
    } else {
      // Off means stop telling me, including the entry already in the tray.
      NotificationManagerCompat.from(app).cancel(NOTIFICATION_ID)
    }
    android.util.Log.i(
      TAG,
      "update alerts ${if (enabled) "on" else "off"}, running ${store.getString(KEY_RUNNING, null)}",
    )
  }

  /**
   * KEEP, not REPLACE: this is called on every app start, and REPLACE cancels
   * and re-enqueues - restarting the six-hour clock each time, so a listener
   * who opens the app more often than that would never reach a check at all.
   * KEEP leaves a scheduled job exactly where it is, which is all a start that
   * changed nothing should do.
   *
   * The trade is that a later build changing the period or the constraints
   * will not reach a job that is already scheduled. When that day comes,
   * ExistingPeriodicWorkPolicy.UPDATE (which rewrites the spec but keeps the
   * enqueue time) or a new unique name is the lever; changing the numbers
   * below alone is not.
   */
  private fun schedule(work: WorkManager) {
    val request = PeriodicWorkRequest.Builder(UpdateAlertWorker::class.java, PERIOD_HOURS, TimeUnit.HOURS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .build()
    work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
  }

  /**
   * The entry already in the tray, once it has been acted on.
   *
   * A notification tapped is gone (auto-cancel). One NOT tapped - the app
   * opened from its icon instead, and the launch gate updated it anyway - would
   * otherwise sit in the tray announcing an update that is already running.
   * So when the page starts on a version at or past the last one announced,
   * the announcement is withdrawn.
   */
  private fun retireIfAnswered(context: Context) {
    val store = prefs(context)
    val announced = store.getString(KEY_LAST_NOTIFIED, null) ?: return
    val running = store.getString(KEY_RUNNING, null) ?: return
    if (!UpdateAlertRules.isNewer(announced, running)) {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
  }

  /**
   * Whether a notification posted now would actually be shown.
   *
   * The runtime grant on Android 13+, the app-level switch everywhere, and the
   * channel itself - a listener who turned off just this category has said so
   * as plainly as one who refused the whole app. The worker asks BEFORE it
   * records a version as announced, so a refusal that is later reversed still
   * gets told about the newest version rather than having missed it for good.
   */
  fun canPost(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) return false
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    val channel = manager.getNotificationChannelCompat(CHANNEL)
    return channel == null || channel.importance != NotificationManagerCompat.IMPORTANCE_NONE
  }

  /**
   * DEFAULT importance: it makes its sound and sits in the tray, and does not
   * pop over whatever somebody is doing. That matches what was asked for -
   * something you notice later, not an interruption - and a listener who wants
   * it quieter can lower just this channel.
   */
  private fun ensureChannel(context: Context) {
    val store = prefs(context)
    NotificationManagerCompat.from(context).createNotificationChannel(
      NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
        .setName(store.getString(KEY_COPY_CHANNEL, null) ?: "App updates")
        .setDescription(store.getString(KEY_COPY_CHANNEL_HINT, null) ?: "When a new version of AttackFM is out.")
        .setShowBadge(false)
        .build(),
    )
  }

  /**
   * Put the announcement in the tray. False when the system refused it.
   *
   * The MissingPermission suppression is not a shortcut: the worker only calls
   * this after [canPost] has checked the grant, and lint cannot follow a check
   * made in another function. The catch below covers the grant being withdrawn
   * in between.
   */
  @android.annotation.SuppressLint("MissingPermission")
  fun post(context: Context, version: String, notes: String?): Boolean {
    ensureChannel(context)
    val store = prefs(context)
    val title = (store.getString(KEY_COPY_TITLE, null) ?: "AttackFM {version} is out")
      .replace("{version}", version)
    val body = UpdateAlertRules.body(notes)
      ?: store.getString(KEY_COPY_BODY, null)
      ?: "Open AttackFM to get it."

    /*
     * A PLAIN launcher intent - exactly what tapping the icon sends.
     *
     * Nothing more specific on purpose. MainActivity reads its intents for
     * shared links and spoken requests, and a notification that carried any
     * payload would be one more thing that path has to decide not to act on.
     * The launch gate needs no instruction: it checks for an update on every
     * cold start. (If the app is already running in the background - music
     * playing - the tap brings it forward instead, and the session's own
     * foreground check stages the update and offers the restart.)
     */
    val launch = Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setClass(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    val tap = PendingIntent.getActivity(
      context,
      NOTIFICATION_ID,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_notify_update)
      .setContentTitle(title)
      .setContentText(body.substringBefore('\n'))
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(tap)
      .setAutoCancel(true)
      // Deliberately NOT setOnlyAlertOnce. The worker never posts the same
      // version twice (KEY_LAST_NOTIFIED), so every post is news - including
      // a newer version replacing an older one nobody has read yet, which
      // only-alert-once would slip into the tray without a sound.
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .build()

    return try {
      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
      true
    } catch (e: SecurityException) {
      // The grant was withdrawn between canPost and here.
      android.util.Log.w(TAG, "notification refused: $e")
      false
    }
  }

  /** A string field, or null for missing, JSON null and blank alike - optString
   *  alone turns a JSON null into the four letters "null". */
  private fun text(o: org.json.JSONObject, name: String): String? =
    if (o.isNull(name)) null else o.optString(name).trim().ifEmpty { null }
}
