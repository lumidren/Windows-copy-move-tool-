package com.lumidren.flingo

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.SecureRandom

/** Something the person asked to send: one file or many, sent in the order given. */
class SendJob(
    val uris: List<Uri>,
    /** Where across the PC's screen an animated arrival should enter, 0 (left) to 1 (right). */
    val x: Float,
    /** Whether the first file flies in on the PC. The rest of a batch always arrives quietly. */
    val animateFirst: Boolean,
    /** Off when the PC is already known to be out of reach, so a single flick is answered fast. */
    val search: Boolean = true,
)

/** Where the job being sent has got to. Byte counts cover the whole job, not one file. */
data class SendState(
    val index: Int,
    val count: Int,
    val sent: Long,
    /** -1 when the phone cannot tell the size of every file. */
    val total: Long,
    /** Bytes per second, smoothed. 0 until there is enough to measure. */
    val speed: Long,
    /** The connection is lost and the phone is trying to carry on. */
    val waiting: Boolean,
    /** Worth a notification and a cancel button: many files, or a large one. */
    val long: Boolean,
    /** More jobs are queued behind this one. */
    val queued: Int,
)

sealed class SendResult {
    /** [skipped] files could not be opened on the phone and were left out. */
    data class Done(val sent: Int, val skipped: Int) : SendResult()
    data class Cancelled(val sent: Int, val of: Int) : SendResult()
    data class Failed(val sent: Int, val of: Int, val why: Why, val message: String = "") : SendResult()
    enum class Why { NOT_PAIRED, REFUSED, UNREADABLE, UNREACHABLE }
}

/**
 * The queue of files on their way to the PC. It belongs to the app, not to a screen, so a
 * transfer carries on when the person switches to another app or the screen turns off.
 * Everything here is called and reported on the main thread.
 */
object Transfers {
    interface Listener {
        fun onProgress(state: SendState)
        fun onFinished(result: SendResult)
    }

    /** More files than this, or more bytes, and a transfer counts as long. */
    private const val LONG_COUNT = 3
    private const val LONG_BYTES = 20L * 1024 * 1024
    /** How long a long transfer keeps trying after the connection drops. */
    private const val PATIENCE_MS = 45_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private val queue = ArrayDeque<SendJob>()
    private val random = SecureRandom()
    @Volatile private var cancelled = false
    @Volatile private var currentId = "" // the PC's name for the file being sent
    private var running = false

    /** The screen that is showing progress, if one is in front. */
    var listener: Listener? = null

    /** Null when nothing is being sent. */
    var state: SendState? = null
        private set

    /** The outcome of the last job if no screen was there to see it. Read it once with [takeResult]. */
    private var unseen: SendResult? = null

    val busy: Boolean get() = running

    fun takeResult(): SendResult? = unseen.also { unseen = null }

    fun enqueue(ctx: Context, job: SendJob) {
        if (job.uris.isEmpty()) return
        queue.addLast(job)
        if (!running) {
            running = true
            scope.launch { drain(ctx.applicationContext) }
        }
    }

    /** Stops the job being sent and forgets the ones waiting behind it. */
    fun cancel(ctx: Context) {
        if (!running) return
        cancelled = true
        queue.clear()
        val prefs = Prefs(ctx.applicationContext)
        val id = currentId
        // Network work, so not on the main thread: drop the connection, then tell the PC it was on purpose.
        Thread {
            Net.abort()
            runCatching { Net.cancelOnPc(prefs, id) }
        }.start()
    }

    private fun id(): String = ByteArray(6).also(random::nextBytes).joinToString("") { "%02x".format(it) }

    private suspend fun drain(ctx: Context) {
        while (true) {
            val job = queue.removeFirstOrNull() ?: break
            cancelled = false
            val result = run(ctx, job)
            TransferService.finish(ctx, result, visible = listener != null)
            state = null
            val seen = listener
            if (seen != null) seen.onFinished(result) else unseen = result
        }
        running = false
    }

    private suspend fun run(ctx: Context, job: SendJob): SendResult {
        val prefs = Prefs(ctx)
        val count = job.uris.size
        val described = withContext(Dispatchers.IO) { job.uris.map { Net.describe(ctx, it) } }
        val sizes = described.map { it.second }
        val total = if (sizes.all { it >= 0 }) sizes.sum() else -1L
        val long = count > LONG_COUNT || total > LONG_BYTES || total < 0
        val batch = if (count > 1) id() else ""
        var before = 0L // bytes of the files already finished
        var sent = 0
        var skipped = 0
        val meter = Meter()

        fun report(index: Int, fileSent: Long, waiting: Boolean) {
            val bytes = before + fileSent
            val s = SendState(index, count, bytes, total, meter.speed(bytes, waiting), waiting, long, queue.size)
            state = s
            listener?.onProgress(s)
            TransferService.update(ctx, s)
        }

        if (long) TransferService.start(ctx)
        report(1, 0, false)
        try {
            for ((i, uri) in job.uris.withIndex()) {
                if (cancelled) return SendResult.Cancelled(sent, count)
                val options = SendOptions(
                    quiet = !(job.animateFirst && i == 0),
                    batch = batch, index = i + 1, count = count, batchBytes = total,
                    id = id(),
                    patienceMs = if (long) PATIENCE_MS else 0,
                )
                var shownAt = 0L
                currentId = options.id
                try {
                    withContext(Dispatchers.IO) {
                        Net.send(ctx, prefs, uri, job.x, job.search, options, { cancelled }, described[i]) { fileSent, fileSize, waiting ->
                            val now = SystemClock.elapsedRealtime()
                            if (now - shownAt < 80 && fileSent != fileSize && !waiting) return@send
                            shownAt = now
                            main.post { if (running && !cancelled) report(i + 1, fileSent, waiting) }
                        }
                    }
                    sent++
                } catch (e: UnreadableFileException) {
                    // One unreadable photo should not stop the other two hundred.
                    if (count == 1) return SendResult.Failed(0, 1, SendResult.Why.UNREADABLE)
                    skipped++
                }
                before += sizes[i].coerceAtLeast(0)
            }
            return SendResult.Done(sent, skipped)
        } catch (_: SendCancelledException) {
            return SendResult.Cancelled(sent, count)
        } catch (_: NotPairedException) {
            return SendResult.Failed(sent, count, SendResult.Why.NOT_PAIRED)
        } catch (e: PcRefusedException) {
            return SendResult.Failed(sent, count, SendResult.Why.REFUSED, e.message ?: "")
        } catch (_: Exception) {
            return if (cancelled) SendResult.Cancelled(sent, count) else SendResult.Failed(sent, count, SendResult.Why.UNREACHABLE)
        }
    }

    /** Turns byte counts into a steady bytes-per-second figure. */
    private class Meter {
        private var markAt = SystemClock.elapsedRealtime()
        private var markBytes = 0L
        private var smooth = 0.0

        fun speed(bytes: Long, waiting: Boolean): Long {
            val now = SystemClock.elapsedRealtime()
            if (waiting) { markAt = now; markBytes = bytes; smooth = 0.0; return 0 }
            val dt = now - markAt
            if (dt >= 700) {
                val latest = (bytes - markBytes).coerceAtLeast(0) * 1000.0 / dt
                smooth = if (smooth == 0.0) latest else smooth * 0.6 + latest * 0.4
                markAt = now
                markBytes = bytes
            }
            return smooth.toLong()
        }
    }
}

/** Words for sizes, speeds and time left, shared by the screen and the notification. */
object Words {
    fun size(bytes: Long): String = when {
        bytes < 1024 * 1024 -> "${maxOf(1, bytes / 1024)} KB"
        bytes < 1024L * 1024 * 1024 -> "%.1f MB".format(bytes / 1048576.0)
        else -> "%.2f GB".format(bytes / 1073741824.0)
    }

    private fun left(seconds: Long): String = when {
        seconds < 60 -> "less than a minute left"
        seconds < 3600 -> "about ${(seconds + 30) / 60} min left"
        else -> "about ${seconds / 3600} h ${(seconds % 3600) / 60} min left"
    }

    /** What is happening, e.g. "Sending 7 of 24". */
    fun title(s: SendState): String = when {
        s.waiting -> "Connection lost. Trying to carry on…"
        s.count > 1 -> "Sending ${s.index} of ${s.count}"
        else -> "Sending"
    }

    /** How far it has got, e.g. "45% of 1.20 GB · 12.0 MB/s · about 2 min left". Empty when not worth saying. */
    fun detail(s: SendState): String {
        if (s.total <= 0) return if (s.sent > 0 && s.long) size(s.sent) else ""
        // Small things finish before a number is worth reading.
        if (!s.long && s.total <= 3 * 1024 * 1024) return ""
        val parts = mutableListOf("${s.sent * 100 / s.total}% of ${size(s.total)}")
        if (s.long && s.speed > 0 && !s.waiting) {
            parts.add("${size(s.speed)}/s")
            val seconds = (s.total - s.sent) / s.speed
            if (seconds >= 10) parts.add(left(seconds))
        }
        return parts.joinToString(" · ")
    }

    /** Both together on [lines] lines, for a status pill (2) or a notification (1). */
    fun progress(s: SendState, lines: Int = 1): String {
        val t = title(s)
        val d = detail(s)
        return when {
            d.isEmpty() -> if (s.waiting) t else "$t…"
            lines > 1 -> "$t\n$d"
            else -> "$t · $d"
        }
    }

    fun fraction(s: SendState): Int? = if (s.total > 0) (s.sent * 1000 / s.total).toInt().coerceIn(0, 1000) else null

    fun files(n: Int): String = if (n == 1) "1 file" else "$n files"
}
