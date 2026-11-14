package com.lumidren.flingo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** Trying several addresses at once: the quick one wins and the dead ones are not waited for. */
class RaceTest {
    private fun timed(block: () -> Any?): Pair<Any?, Long> {
        val start = System.nanoTime()
        val result = block()
        return result to (System.nanoTime() - start) / 1_000_000
    }

    @Test fun theOneThatAnswersWinsWithoutWaitingForTheDeadOnes() {
        // Two addresses that take two seconds to fail, in front of one that answers at once.
        val (winner, ms) = timed {
            Race.first(listOf("dead-1", "dead-2", "live"), 5_000) { host ->
                if (host == "live") true else { Thread.sleep(2_000); false }
            }
        }
        assertEquals("live", winner)
        assertTrue("took $ms ms; one after another it would be over 4000", ms < 500)
    }

    @Test fun theFirstToSucceedWinsNotTheFirstInTheList() {
        val winner = Race.first(listOf("slow", "quick"), 5_000) { host ->
            Thread.sleep(if (host == "slow") 400 else 20)
            true
        }
        assertEquals("quick", winner)
    }

    @Test fun whenAllFailItSaysSoAsSoonAsTheLastOneHas() {
        val (winner, ms) = timed { Race.first(listOf("a", "b", "c"), 5_000) { Thread.sleep(50); false } }
        assertNull(winner)
        assertTrue("took $ms ms instead of giving up after the last failure", ms < 1_000)
    }

    @Test fun anAttemptThatThrowsIsAFailureAndDoesNotStopTheOthers() {
        val winner = Race.first(listOf("throws", "works"), 5_000) { host ->
            if (host == "throws") throw IllegalStateException("no route")
            Thread.sleep(30)
            true
        }
        assertEquals("works", winner)
    }

    @Test fun itGivesUpAtTheTimeLimit() {
        val (winner, ms) = timed { Race.first(listOf("never"), 200) { Thread.sleep(3_000); true } }
        assertNull(winner)
        assertTrue("waited $ms ms for a limit of 200", ms in 150..1_000)
    }

    @Test fun nothingToTryIsNothingFound() {
        assertNull(Race.first(emptyList<String>(), 1_000) { true })
    }

    @Test fun everyAddressIsTriedOnceAndAtTheSameTime() {
        val running = AtomicInteger(0)
        val most = AtomicInteger(0)
        val tried = AtomicInteger(0)
        Race.first(listOf(1, 2, 3, 4), 5_000) {
            tried.incrementAndGet()
            most.accumulateAndGet(running.incrementAndGet()) { a, b -> maxOf(a, b) }
            Thread.sleep(150)
            running.decrementAndGet()
            false
        }
        assertEquals(4, tried.get())
        assertEquals("they did not overlap", 4, most.get())
    }
}
