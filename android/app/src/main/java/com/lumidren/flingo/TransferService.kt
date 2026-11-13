package com.lumidren.flingo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock

/**
 * Keeps a long transfer alive while Flingo is not on screen. Android may stop an app's
 * work when it is in the background; a foreground service with a notification tells it
 * the person is waiting for this one. It holds no transfer logic: [Transfers] does the work.
 */
class TransferService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // Keep the processor and the Wi-Fi radio awake with the screen off, for as long as a transfer could take.
        runCatching {
            wake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flingo:transfer").apply { acquire(6 * 60 * 60 * 1000L) }
        }
        runCatching {
            @Suppress("DEPRECATION")
            wifi = applicationContext.getSystemService(WifiManager::class.java)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "flingo:transfer").apply { acquire() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            Transfers.cancel(this)
            return START_NOT_STICKY
        }
        val state = Transfers.state
        if (state == null && !Transfers.busy) {
            // Started with nothing to do (the transfer ended first): show the required notification and leave.
            foreground(sending(this, null))
            stopSelf()
            return START_NOT_STICKY
        }
        foreground(sending(this, state))
        return START_NOT_STICKY
    }

    private fun foreground(n: Notification) {
        runCatching { startForeground(ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) }
            .onFailure { stopSelf() }
    }

    /** Android 15 limits how long this kind of service may run in a day. Stop cleanly instead of being killed. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onDestroy() {
        runCatching { wake?.takeIf { it.isHeld }?.release() }
        runCatching { wifi?.takeIf { it.isHeld }?.release() }
        live = false
        super.onDestroy()
    }

    companion object {
        private const val ACTION_CANCEL = "com.lumidren.flingo.CANCEL"
        private const val CHANNEL_PROGRESS = "progress"
        private const val CHANNEL_RESULT = "result"
        private const val ONGOING = 1
        private const val RESULT = 2
        @Volatile private var live = false
        private var updatedAt = 0L

        private fun manager(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)

        private fun channels(ctx: Context) {
            val m = manager(ctx)
            m.createNotificationChannel(NotificationChannel(CHANNEL_PROGRESS, "Transfers in progress", NotificationManager.IMPORTANCE_LOW))
            m.createNotificationChannel(NotificationChannel(CHANNEL_RESULT, "Finished transfers", NotificationManager.IMPORTANCE_DEFAULT))
        }

        private fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        private fun sending(ctx: Context, s: SendState?): Notification {
            channels(ctx)
            val cancel = PendingIntent.getService(
                ctx, 1,
                Intent(ctx, TransferService::class.java).setAction(ACTION_CANCEL),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val b = Notification.Builder(ctx, CHANNEL_PROGRESS)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Sending to ${Prefs(ctx).pcName.ifEmpty { "your PC" }}")
                .setContentText(if (s == null) "Getting ready…" else Words.progress(s))
                .setContentIntent(openApp(ctx))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .addAction(Notification.Action.Builder(null, "Cancel", cancel).build())
            val fraction = s?.let(Words::fraction)
            if (s != null && !s.waiting) b.setProgress(1000, fraction ?: 0, fraction == null)
            return b.build()
        }

        /** Called when a long transfer begins, while the app is on screen. */
        fun start(ctx: Context) {
            live = true
            runCatching { ctx.startForegroundService(Intent(ctx, TransferService::class.java)) }
                .onFailure { live = false } // not allowed right now: the transfer still runs while the app is open
        }

        /** Refreshes the notification, at most once a second. */
        fun update(ctx: Context, s: SendState) {
            if (!live) return
            val now = SystemClock.elapsedRealtime()
            if (now - updatedAt < 1000) return
            updatedAt = now
            runCatching { manager(ctx).notify(ONGOING, sending(ctx, s)) }
        }

        /** Ends the service. If no screen is showing the outcome, leaves a notification that says it. */
        fun finish(ctx: Context, result: SendResult, visible: Boolean) {
            val wasLive = live
            live = false
            runCatching { ctx.stopService(Intent(ctx, TransferService::class.java)) }
            if (visible || !wasLive || result is SendResult.Cancelled) return
            val pc = Prefs(ctx).pcName.ifEmpty { "your PC" }
            val (title, text) = when (result) {
                is SendResult.Done ->
                    "Sent ${Words.files(result.sent)} to $pc" to
                        (if (result.skipped > 0) "${Words.files(result.skipped)} could not be opened and were left out." else "All done.")
                is SendResult.Failed ->
                    "Sending to $pc stopped" to "${result.sent} of ${result.of} sent. Open Flingo to send the rest."
                is SendResult.Cancelled -> return
            }
            channels(ctx)
            runCatching {
                manager(ctx).notify(
                    RESULT,
                    Notification.Builder(ctx, CHANNEL_RESULT)
                        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                        .setContentTitle(title)
                        .setContentText(text)
                        .setContentIntent(openApp(ctx))
                        .setAutoCancel(true)
                        .build(),
                )
            }
        }
    }
}
