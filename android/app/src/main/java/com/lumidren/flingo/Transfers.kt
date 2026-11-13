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
