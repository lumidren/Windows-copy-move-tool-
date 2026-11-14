package com.lumidren.flingo

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/** A file the PC has put aside for this phone. */
data class Incoming(val id: String, val name: String, val size: Long, val mime: String, val sha256: String)

/** A file that has arrived and been checked. */
data class Arrived(val uri: Uri, val name: String, val mime: String)

/** How a round of receiving ended. */
sealed class ReceiveResult {
    /** [arrived] files are saved; [failed] did not make it. [last] is the newest one saved. */
    data class Done(val arrived: Int, val failed: Int, val last: Arrived?) : ReceiveResult()
    data class Cancelled(val arrived: Int) : ReceiveResult()
    /** The connection was lost for too long. What had arrived of the current file is kept, to carry on later. */
    data class Lost(val arrived: Int) : ReceiveResult()
    object NoSpace : ReceiveResult()
}

/** The phone has no room left for the file. */
class StorageException : IOException("No space left on the phone")

/**
 * Collects what the paired PC sends to this phone.
 *
 * The PC cannot reach a phone reliably, so the phone asks: while Flingo is on screen it keeps
 * one quiet request open to the PC, which answers the moment something is put in its outbox.
 * Each file is then fetched by id, written straight into the phone's shared Pictures or
 * Download folder through MediaStore (no storage permission needed), checked against the
 * SHA-256 the PC promised, and only then made visible and confirmed to the PC. A dropped
 * connection is picked up from the byte it stopped at.
 *
 * Like [Transfers], this lives for as long as the app's process, so a long download carries
 * on when the screen that started it has gone.
 */
object Inbox {
    interface Listener {
        fun onProgress(state: SendState)
        fun onArrived(file: Arrived)
        fun onFinished(result: ReceiveResult)
    }

    private const val PATIENCE_MS = 45_000L
    private const val LONG_COUNT = 3
    private const val LONG_BYTES = 20L * 1024 * 1024
    private const val BUFFER = 256 * 1024

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private var loop: Job? = null
    private var leaveWhenIdle = false
    @Volatile private var cancelled = false
    @Volatile private var receiving = false
    private var pendingResult: ReceiveResult? = null

    /** Set by the screen while it is in front. */
    var listener: Listener? = null

    var state: SendState? = null
        private set

    val busy: Boolean get() = receiving

    /** A result that arrived while no screen was listening. */
    fun takeResult(): ReceiveResult? = pendingResult.also { pendingResult = null }

    /** Starts asking the PC, if this phone is paired and is not asking already. */
    fun start(ctx: Context) {
        leaveWhenIdle = false
        if (loop?.isActive == true) return
        val app = ctx.applicationContext
        if (!Prefs(app).paired) return
        loop = scope.launch { ask(app) }
    }

    /** The screen went away. A download in progress carries on to its end; an idle wait stops. */
    fun pause() {
        if (receiving) { leaveWhenIdle = true; return }
        loop?.cancel()
        loop = null
        Net.stopAsking()
    }

    /** Stops the download in progress and gives up the rest of what was offered with it. */
    fun cancel() {
        if (!receiving) return
        cancelled = true
        Net.abortFetch()
    }

    private suspend fun ask(ctx: Context) {
        val prefs = Prefs(ctx)
        var first = true
        while (coroutineContext.isActive && prefs.paired) {
            val offered = try {
                // The first question asks for everything, including what an earlier run of the app had begun.
                withContext(Dispatchers.IO) { Net.outbox(prefs, if (first) 0 else 25, all = first) }
            } catch (_: NotPairedException) {
                return
            } catch (_: IOException) {
                delay(4000) // the PC is not there right now; the health check says so on screen
                continue
            } ?: return // an older Flingo on the PC, which cannot send to phones
            first = false
            if (offered.isNotEmpty()) receive(ctx, prefs, offered)
            if (leaveWhenIdle) return
        }
    }

    private suspend fun receive(ctx: Context, prefs: Prefs, offered: List<Incoming>) {
        receiving = true
        cancelled = false
        val count = offered.size
        val total = offered.sumOf { it.size }
        val long = count > LONG_COUNT || total > LONG_BYTES
        val meter = Transfers.Meter()
        var before = 0L // bytes of the files already dealt with
        var arrived = 0
        var failed = 0
        var last: Arrived? = null

        fun report(index: Int, got: Long, waiting: Boolean, checking: Boolean = false) {
            val bytes = before + got
            val s = SendState(index, count, bytes, total, meter.speed(bytes, waiting), waiting, long, 0, incoming = true, checking = checking)
            state = s
            listener?.onProgress(s)
            TransferService.update(ctx, s)
        }

        if (long) TransferService.start(ctx)
        var result: ReceiveResult
        try {
            for ((i, item) in offered.withIndex()) {
                if (cancelled) throw SendCancelledException()
                report(i + 1, 0, false)
                var shownAt = 0L
                val saved = withContext(Dispatchers.IO) {
                    receiveOne(ctx, prefs, item, onCheck = {
                        // Reading a large file back takes a moment; say so instead of sitting at 100%.
                        if (item.size > LONG_BYTES) main.post { if (receiving && !cancelled) report(i + 1, item.size, false, checking = true) }
                    }) { got, waiting ->
                        val now = SystemClock.elapsedRealtime()
                        if (now - shownAt < 100 && got != item.size && !waiting) return@receiveOne
                        shownAt = now
                        main.post { if (receiving && !cancelled) report(i + 1, got, waiting) }
                    }
                }
                before += item.size
                if (saved == null) { failed++; continue }
                arrived++
                last = saved
                listener?.onArrived(saved)
            }
            result = ReceiveResult.Done(arrived, failed, last)
        } catch (_: SendCancelledException) {
            // Whatever was offered with the cancelled file is given back too.
            withContext(Dispatchers.IO) { offered.forEach { runCatching { Net.outboxDecline(prefs, it.id) } } }
            result = ReceiveResult.Cancelled(arrived)
        } catch (_: StorageException) {
            result = ReceiveResult.NoSpace
        } catch (_: NotPairedException) {
            result = ReceiveResult.Lost(arrived)
        } catch (_: IOException) {
            result = ReceiveResult.Lost(arrived)
        }
        receiving = false
        state = null
        TransferService.finishReceive(ctx, result, visible = listener != null)
        val seen = listener
        if (seen != null) seen.onFinished(result) else pendingResult = result
    }
