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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicIntegerArray
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicLongArray
import java.util.concurrent.atomic.AtomicReference
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
    @Volatile private var full = false // the phone ran out of room, so the files beside that one stop too
    @Volatile private var receiving = false
    // A file arrived, but the PC could not be told (the connection went at that moment). Until
    // it hears, the PC shows the file as still on its way, so the phone asks to be offered it again.
    @Volatile private var unheard = false
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
        var everything = true
        while (coroutineContext.isActive && prefs.paired) {
            val offered = try {
                // The first question asks for everything, including what an earlier run of the app had begun.
                withContext(Dispatchers.IO) { Net.outbox(prefs, if (everything) 0 else 25, all = everything) }
            } catch (_: NotPairedException) {
                return
            } catch (_: IOException) {
                delay(4000) // the PC is not there right now; the health check says so on screen
                continue
            } ?: return // an older Flingo on the PC, which cannot send to phones
            everything = false
            unheard = false
            // Files this phone already has are only confirmed again, without a second arrival.
            val fresh = withContext(Dispatchers.IO) { offered.filterNot { retell(prefs, it) } }
            // After a round that lost the connection, files are left half-fetched. The PC only
            // lists those, and the ones it never heard about, when asked for everything.
            val lost = fresh.isNotEmpty() && receive(ctx, prefs, fresh) is ReceiveResult.Lost
            if (lost || unheard) {
                everything = true
                delay(2000)
            }
            if (leaveWhenIdle && !unheard) return
        }
    }

    /** True if [item] arrived earlier and only its confirmation is owed to the PC, which is sent again here. */
    private fun retell(prefs: Prefs, item: Incoming): Boolean {
        prefs.inboxDone(item.id) ?: return false
        try { Net.outboxReport(prefs, item.id, true) } catch (_: Exception) { unheard = true }
        return true
    }

    // What one file of a round is doing, for the line of progress the screen shows.
    private const val FETCHING = 1
    private const val WAITING = 2
    private const val CHECKING = 3

    private suspend fun receive(ctx: Context, prefs: Prefs, offered: List<Incoming>): ReceiveResult {
        receiving = true
        cancelled = false
        full = false
        val count = offered.size
        val total = offered.sumOf { it.size }
        val long = count > LONG_COUNT || total > LONG_BYTES
        val meter = Transfers.Meter()

        // Several files are fetched at once, each on its own thread, so what they have done is
        // kept in counters any thread may touch. The screen is only told from the main thread.
        val got = AtomicLongArray(count) // bytes of each file that have arrived
        val doing = AtomicIntegerArray(count)
        val dealt = AtomicInteger(0) // files finished with, whether they arrived or not
        val arrived = AtomicInteger(0)
        val failed = AtomicInteger(0)
        val last = AtomicReference<Arrived?>(null)
        val lost = AtomicBoolean(false) // the connection went for too long: take no more files this round
        val settled = ConcurrentHashMap.newKeySet<String>() // files the PC has already had an answer about
        val shownAt = AtomicLong(0)

        fun report() {
            var bytes = 0L
            var waiting = false
            var fetching = false
            var checking = false
            for (i in 0 until count) {
                bytes += got.get(i)
                when (doing.get(i)) {
                    WAITING -> waiting = true
                    FETCHING -> fetching = true
                    CHECKING -> checking = true
                }
            }
            val s = SendState(
                minOf(count, dealt.get() + 1), count, bytes, total, meter.speed(bytes, waiting), waiting, long, 0,
                incoming = true, checking = checking && !fetching && !waiting,
            )
            state = s
            listener?.onProgress(s)
            TransferService.update(ctx, s)
        }

        /** From any thread. Without [now], at most one report every [Transfers.PROGRESS_MS]. */
        fun show(now: Boolean) {
            val at = SystemClock.elapsedRealtime()
            if (!now && at - shownAt.get() < Transfers.PROGRESS_MS) return
            shownAt.set(at)
            main.post { if (receiving && !cancelled) report() }
        }

        /** Fetches file [i] on the calling thread. Throws when the round has to stop. */
        fun fetchOne(i: Int) {
            val item = offered[i]
            doing.set(i, FETCHING)
            show(now = true)
            val saved = try {
                receiveOne(ctx, prefs, item, onCheck = {
                    // Reading a large file back takes a moment; say so instead of sitting at 100%.
                    if (item.size > LONG_BYTES) { doing.set(i, CHECKING); show(now = true) }
                }) { bytes, waiting ->
                    got.set(i, bytes)
                    val was = doing.getAndSet(i, if (waiting) WAITING else FETCHING)
                    show(now = bytes == item.size || (was == WAITING) != waiting)
                }
            } finally {
                doing.set(i, 0)
            }
            got.set(i, item.size)
            settled.add(item.id)
            dealt.incrementAndGet()
            if (saved == null) {
                failed.incrementAndGet()
            } else {
                arrived.incrementAndGet()
                last.set(saved)
                main.post { listener?.onArrived(saved) }
            }
            show(now = true)
        }

        if (long) TransferService.start(ctx)
        report()
        // Each of the files going at once ends in its own way; the round ends in the worst of them.
        val stopped = AtomicBoolean(false)
        val noSpace = AtomicBoolean(false)
        withContext(Dispatchers.IO) {
            val next = AtomicInteger(0)
            coroutineScope {
                repeat(minOf(Transfers.STREAMS, count)) {
                    launch {
                        while (!cancelled && !full && !lost.get()) {
                            val i = next.getAndIncrement()
                            if (i >= count) break
                            try {
                                fetchOne(i)
                            } catch (_: SendCancelledException) {
                                stopped.set(true)
                            } catch (_: StorageException) {
                                noSpace.set(true)
                                full = true
                                Net.abortFetch() // the files beside it have nowhere to go either
                            } catch (_: Exception) {
                                // Not paired any more, or the connection stayed away too long. The
                                // other files finish or give up by themselves.
                                lost.set(true)
                            }
                        }
                    }
                }
            }
        }
        val result = when {
            cancelled || stopped.get() -> {
                // Whatever was offered with the cancelled file is given back too.
                withContext(Dispatchers.IO) {
                    offered.filterNot { it.id in settled }.forEach { runCatching { Net.outboxDecline(prefs, it.id) } }
                }
                ReceiveResult.Cancelled(arrived.get())
            }
            noSpace.get() -> ReceiveResult.NoSpace
            lost.get() -> ReceiveResult.Lost(arrived.get())
            else -> ReceiveResult.Done(arrived.get(), failed.get(), last.get())
        }
        receiving = false
        state = null
        TransferService.finishReceive(ctx, result, visible = listener != null)
        val seen = listener
        if (seen != null) seen.onFinished(result) else pendingResult = result
        return result
    }

    // ---------- one file ----------

    /**
     * Fetches one file into shared storage. Returns it once it is complete, checked and
     * visible; null when it will not be coming (taken back on the PC, changed there, or it
     * failed the check). Throws when the whole round has to stop.
     */
    private fun receiveOne(ctx: Context, prefs: Prefs, item: Incoming, onCheck: () -> Unit, onProgress: (Long, Boolean) -> Unit): Arrived? {
        val resolver = ctx.contentResolver
        val mime = typeOf(item)
        var uri = prefs.inboxPart(item.id)?.let(Uri::parse)?.takeIf { sizeOf(resolver, it) >= 0 }
            ?: create(resolver, item, mime).also { prefs.setInboxPart(item.id, it.toString()) }
        var lastProgress = SystemClock.elapsedRealtime()
        try {
            while (true) {
                if (cancelled || full) throw SendCancelledException()
                var have = sizeOf(resolver, uri).coerceAtLeast(0)
                if (have > item.size) { // not ours any more; start it again
                    resolver.delete(uri, null, null)
                    uri = create(resolver, item, mime).also { prefs.setInboxPart(item.id, it.toString()) }
                    have = 0
                }
                if (have == item.size) break
                try {
                    append(resolver, uri, have) { out ->
                        Net.fetch(prefs, item, have, out, { cancelled || full }) { got ->
                            lastProgress = SystemClock.elapsedRealtime()
                            onProgress(got, false)
                        }
                    }
                    break
                } catch (e: SendCancelledException) {
                    throw e
                } catch (e: StorageException) {
                    throw e
                } catch (e: GoneException) {
                    throw e
                } catch (e: PcRefusedException) {
                    throw e
                } catch (e: NotPairedException) {
                    throw e
                } catch (e: IOException) {
                    // A dropped connection. Keep what arrived and carry on from there, for a while.
                    if (SystemClock.elapsedRealtime() - lastProgress >= PATIENCE_MS) throw e
                    onProgress(sizeOf(resolver, uri).coerceAtLeast(0), true)
                    val until = SystemClock.elapsedRealtime() + 1500
                    while (SystemClock.elapsedRealtime() < until) {
                        if (cancelled || full) throw SendCancelledException()
                        Thread.sleep(100)
                    }
                }
            }
            // Check what is actually on the phone, not what went past on the way in.
            onCheck()
            if (sha256(resolver, uri) != item.sha256) {
                discard(resolver, prefs, item, uri)
                runCatching { Net.outboxReport(prefs, item.id, false, "The file did not arrive intact.") }
                return null
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            prefs.setInboxDone(item.id, uri.toString())
            prefs.setInboxPart(item.id, null)
            // If this is lost, it is said again when the PC next lists what it is still waiting to hear about.
            runCatching { Net.outboxReport(prefs, item.id, true) }.onFailure { unheard = true }
            return Arrived(uri, item.name, mime)
        } catch (e: SendCancelledException) {
            discard(resolver, prefs, item, uri)
            if (full && !cancelled) {
                // Stopped because a file beside this one found the phone full. Tell the PC the same.
                runCatching { Net.outboxReport(prefs, item.id, false, "The phone ran out of space.") }
                throw StorageException()
            }
            throw e
        } catch (e: StorageException) {
            discard(resolver, prefs, item, uri)
            runCatching { Net.outboxReport(prefs, item.id, false, "The phone ran out of space.") }
            throw e
        } catch (_: GoneException) {
            discard(resolver, prefs, item, uri) // taken back on the PC
            return null
        } catch (_: PcRefusedException) {
            discard(resolver, prefs, item, uri) // changed on the PC since it was queued
            return null
        }
        // Any other IOException leaves the partial file in place: the next run carries on from it.
    }

    private fun discard(resolver: ContentResolver, prefs: Prefs, item: Incoming, uri: Uri) {
        runCatching { resolver.delete(uri, null, null) }
        prefs.setInboxPart(item.id, null)
    }

    /** The phone's own idea of the file's type, from its name; it decides which folder the file goes to. */
    private fun typeOf(item: Incoming): String {
        val ext = item.name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: item.mime.takeIf { it.matches(Regex("[a-z0-9.+-]{1,60}/[a-z0-9.+-]{1,60}")) }
            ?: "application/octet-stream"
    }

    /**
     * Makes the file in shared storage, hidden until it is complete: Pictures/Flingo for photos
     * and videos, Download/Flingo for everything else. Only the name is used, never a path, and
     * Android picks a free name if that one is taken.
     */
    private fun create(resolver: ContentResolver, item: Incoming, mime: String): Uri {
        val name = item.name.replace(Regex("""[\\/:*?"<>|\u0000-\u001f\u007f]"""), "_").trim().trimStart('.').take(180).ifEmpty { "file" }
        fun insert(collection: Uri, folder: String, type: String): Uri? = runCatching {
            resolver.insert(collection, ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, type)
                put(MediaStore.MediaColumns.RELATIVE_PATH, folder)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            })
        }.getOrNull()
        val volume = MediaStore.VOLUME_EXTERNAL_PRIMARY
        val made = when {
            mime.startsWith("image/") -> insert(MediaStore.Images.Media.getContentUri(volume), "Pictures/Flingo", mime)
            mime.startsWith("video/") -> insert(MediaStore.Video.Media.getContentUri(volume), "Pictures/Flingo", mime)
            else -> null
        }
        return made
            ?: insert(MediaStore.Downloads.getContentUri(volume), "Download/Flingo", mime)
            ?: insert(MediaStore.Downloads.getContentUri(volume), "Download/Flingo", "application/octet-stream")
            ?: throw StorageException()
    }

    /** Bytes written so far, or -1 if the file is gone. */
    private fun sizeOf(resolver: ContentResolver, uri: Uri): Long =
        runCatching { resolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1

    /** Opens the file to write on from byte [from], dropping anything after it. */
    private fun append(resolver: ContentResolver, uri: Uri, from: Long, write: (java.io.OutputStream) -> Unit) {
        val pfd = resolver.openFileDescriptor(uri, "rw") ?: throw IOException("The file cannot be opened")
        pfd.use {
            FileOutputStream(it.fileDescriptor).use { out ->
                out.channel.truncate(from)
                out.channel.position(from)
                write(out)
                runCatching { out.fd.sync() }
            }
        }
    }

    private fun sha256(resolver: ContentResolver, uri: Uri): String {
        val md = MessageDigest.getInstance("SHA-256")
        (resolver.openInputStream(uri) ?: throw IOException("The file cannot be read back")).use { input ->
            val buf = ByteArray(BUFFER)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
