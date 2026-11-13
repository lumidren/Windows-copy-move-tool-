package com.lumidren.flingo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Hears from Android how an update is going. First Android asks for its own confirmation
 * screen to be shown; later it reports a failure. After a successful update the app has been
 * replaced and closed, so the new copy says so in a notification that opens it again.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            ACTION_STATUS -> when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                    val shown = confirm != null && runCatching { ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
                    if (!shown) report(PackageInstaller.STATUS_FAILURE)
                }
                PackageInstaller.STATUS_SUCCESS -> Unit
                else -> report(status)
            }
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Updater.clean(ctx)
                Prefs(ctx).update = null
                announce(ctx)
            }
        }
    }

    private fun report(status: Int) {
        Handler(Looper.getMainLooper()).post { Updater.failed(status) }
    }

    private fun announce(ctx: Context) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // Without permission to notify this does nothing, and Flingo is simply opened by hand.
        runCatching {
            manager.notify(
                NOTIFICATION,
                Notification.Builder(ctx, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("Flingo was updated to ${BuildConfig.VERSION_NAME}")
                    .setContentText("Tap to open it.")
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }

    companion object {
        const val ACTION_STATUS = "com.lumidren.flingo.UPDATE_STATUS"
        private const val CHANNEL = "updates"
        private const val NOTIFICATION = 3
    }
}
