package com.sirascreenshare.support

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// Required by Android for MediaProjection on API 29+. The notification is
// non-dismissable while the session is live, which doubles as a customer-
// facing signal that the session is active.

class SiraProjectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(CHANNEL_ID, "Screen share session", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Shown while a Sira support agent is viewing your screen."
      nm.createNotificationChannel(channel)
    }

    val notif: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Screen share active")
      .setContentText("A support agent is viewing this app.")
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setOngoing(true)
      .build()

    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL_ID = "sira-projection"
    private const val NOTIF_ID = 8132
  }
}
