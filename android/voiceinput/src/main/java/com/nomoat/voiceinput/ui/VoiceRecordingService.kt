package com.nomoat.voiceinput.ui

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class VoiceRecordingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: englishVoiceStrings.voiceInput
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: englishVoiceStrings.listening
        val manager = NotificationManagerCompat.from(this)
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW).setName(title).build(),
        )
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(launch)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        } catch (_: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "voice-input"
        private const val NOTIFICATION_ID = 0x766f69
        private const val EXTRA_TITLE = "com.nomoat.voiceinput.title"
        private const val EXTRA_TEXT = "com.nomoat.voiceinput.text"

        fun start(context: Context, title: String, text: String): Boolean = try {
            val intent = Intent(context, VoiceRecordingService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text)
            ContextCompat.startForegroundService(context, intent)
            true
        } catch (_: Exception) {
            false
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, VoiceRecordingService::class.java)) }
        }

        fun keepAlive(context: Context): VoiceKeepAlive {
            val app = context.applicationContext
            return object : VoiceKeepAlive {
                override fun start(strings: VoiceStrings): Boolean = VoiceRecordingService.start(app, strings.voiceInput, strings.listening)

                override fun stop() {
                    VoiceRecordingService.stop(app)
                }
            }
        }
    }
}
