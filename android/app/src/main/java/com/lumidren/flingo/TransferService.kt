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
            Transfers.cancel()
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
