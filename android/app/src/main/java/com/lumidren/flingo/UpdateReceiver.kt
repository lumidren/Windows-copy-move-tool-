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
