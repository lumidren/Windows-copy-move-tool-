package com.lumidren.flingo

/** Words for a screen reader. Nothing here touches Android, so it is tested on a plain JVM. */
object Speech {
    /**
     * Text as it should be spoken. The screen uses marks that mean something to the eye
     * and are read out as "check mark" or "middle dot" by a screen reader.
     */
    fun plain(text: String): String = text
        .replace("✓", "").replace("▾", "").replace("›", "").replace("↑", "")
        .replace(" · ", ", ").replace("…", "")
        .replace('\n', ' ').replace(Regex(" {2,}"), " ")
        .replace(" ,", ",").replace(" .", ".")
        .trim()

    /** One tile of the photo grid. Every tile used to say only "Photo", which told nobody which one. */
    fun tile(isVideo: Boolean, position: Int, count: Int, taken: String): String =
        "${if (isVideo) "Video" else "Photo"} ${position + 1} of $count, $taken"
}

/**
 * Decides when the progress of a transfer is worth saying aloud.
 *
 * The number on screen changes up to ten times a second. Read out every time, it would never
 * stop; never read out, a blind person presses Send and hears nothing until the end. So it
 * is spoken at the start, whenever the connection is lost or comes back, when the final check
 * begins, and at each quarter of the way, with a pause between any two.
 */
class ProgressVoice(private val pauseMs: Long = 5_000, private val longestSilenceMs: Long = 20_000) {
    private var started = false
    private var waiting = false
    private var checking = false
    private var quarter = 0
    private var spokenAt = 0L

    /** Call when a transfer ends, so the next one is announced from its start. */
    fun reset() {
        started = false
        waiting = false
        checking = false
        quarter = 0
        spokenAt = 0L
    }

    /**
     * One step of progress. Returns the words to say now, or null to stay silent.
     * [title] is what the screen shows ("Sending 3 of 24"); [fraction] is 0 to 1000, or null
     * when the size is not known.
     */
    fun step(title: String, fraction: Int?, waiting: Boolean, checking: Boolean, nowMs: Long): String? {
        val words = Speech.plain(title)
        val percent = fraction?.let { it / 10 }
        fun say(text: String): String {
            spokenAt = nowMs
            if (fraction != null) quarter = maxOf(quarter, fraction / 250)
            return text
        }
        if (!started) {
            started = true
            this.waiting = waiting
            this.checking = checking
            return say(words)
        }
        if (waiting != this.waiting) {
            this.waiting = waiting
            // Losing the connection and getting it back are said at once, whatever was said a moment ago.
            return say(if (waiting) words else "Carrying on. $words")
        }
        if (checking != this.checking) {
            this.checking = checking
            if (checking) return say(words)
        }
        if (waiting) return null
        val quiet = nowMs - spokenAt
        if (fraction != null && fraction / 250 > quarter && fraction < 1000 && quiet >= pauseMs) {
            return say("$words, ${fraction / 250 * 25} percent")
        }
        if (quiet >= longestSilenceMs) return say(if (percent != null) "$words, $percent percent" else words)
        return null
    }
}
