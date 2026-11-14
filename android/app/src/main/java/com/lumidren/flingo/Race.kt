package com.lumidren.flingo

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Trying several things at the same moment and taking the first that works.
 *
 * A PC can be at any of a few addresses, and finding out that one is dead takes a second or
 * two. Tried one after another, a dead address in front of the live one costs that wait every
 * time. Tried together, the live one answers in a few milliseconds and the dead ones are
 * simply not waited for.
 *
 * Nothing here touches Android, so it is tested on a plain JVM.
 */
object Race {
    /**
     * Runs [attempt] for every item at once, each on its own thread, and returns the first item
     * whose attempt returned true. Null if none did within [timeoutMs], or all failed sooner.
     * An attempt that throws counts as a failure. Slow attempts are left to finish by themselves.
     */
    fun <T> first(items: List<T>, timeoutMs: Long, attempt: (T) -> Boolean): T? {
        if (items.isEmpty()) return null
        val results = LinkedBlockingQueue<Pair<T, Boolean>>()
        for (item in items) {
            Thread {
                val ok = try { attempt(item) } catch (_: Throwable) { false }
                results.offer(item to ok)
            }.apply { isDaemon = true }.start()
        }
        val deadline = System.nanoTime() + timeoutMs * 1_000_000
        var left = items.size
        while (left > 0) {
            val wait = deadline - System.nanoTime()
            if (wait <= 0) return null
            val (item, ok) = results.poll(wait, TimeUnit.NANOSECONDS) ?: return null
            if (ok) return item
            left--
        }
        return null
    }
}
