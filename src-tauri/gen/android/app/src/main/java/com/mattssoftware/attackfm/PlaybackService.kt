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
import androidx.core.app.NotificationCompat

/**
 * The reason Android lets the music keep playing.
 *
 * Without a foreground service this app is, to the system, an ordinary app that
 * happens to make noise: backgrounded behind navigation it is a prime candidate
 * the moment memory gets tight, and it gets frozen or killed with no warning.
 * The symptom is music that "randomly" stops on a drive - random only in that
 * you cannot see what the memory manager is doing.
 *
 * A foreground service with an ongoing notification is the contract that says
 * "killing me stops something the listener is deliberately doing." It carries
 * no player of its own: the audio lives in the WebView, and this exists purely
 * so the process holding it is treated as media rather than as spare memory.
 *
 * Started and stopped from MainActivity, which hears about playback from the
 * web layer (window.AFMNative.setPlaying). It must be started while the app is
 * visible - Android forbids a background app from starting a foreground service
 * - which it is: the listener has just pressed play.
 */
class PlaybackService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this,
      0,
      // setFlags, not apply { flags = ... }: inside an apply block `flags`
      // resolves to onStartCommand's own parameter, which is a val.
      Intent(this, MainActivity::class.java)
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val note: Notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Playing")
      .setContentIntent(open)
      // Silent and unswipeable: it is a status, not a message. The listener
      // already knows what is playing - they started it.
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIF_ID, note)
    }
    // Restarted if the system does kill us mid-song, rather than left dead.
    return START_STICKY
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
  }
}
