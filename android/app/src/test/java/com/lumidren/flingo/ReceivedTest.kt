package com.lumidren.flingo

import org.junit.Assert.assertEquals
import org.junit.Test

class ReceivedTest {
    private val minute = 60_000L
    private val hour = 60 * minute
    private val day = 24 * hour
    private val now = 1_800_000_000_000L

    private fun file(uri: String, addedMs: Long, name: String = "a.jpg", size: Long = 2_500_000) =
        ReceivedFile(uri, name, size, "image/jpeg", addedMs)

    @Test fun `the newest file is first`() {
        val files = listOf(file("u1", now - 3 * hour), file("u2", now - minute), file("u3", now - 2 * day))
        assertEquals(listOf("u2", "u1", "u3"), Received.newest(files).map { it.uri })
    }

    @Test fun `a file found twice is listed once`() {
        // A video in Pictures is answered by more than one collection on some phones.
        val files = listOf(file("u1", now - hour), file("u1", now - hour), file("u2", now))
        assertEquals(listOf("u2", "u1"), Received.newest(files).map { it.uri })
    }

    @Test fun `the list stops at its limit and keeps the newest`() {
        val files = (1..100).map { file("u$it", now - it * minute) }
        val shown = Received.newest(files, limit = 10)
        assertEquals(10, shown.size)
        assertEquals("u1", shown.first().uri)
        assertEquals("u10", shown.last().uri)
    }

    @Test fun `how long ago is said in a few words`() {
        assertEquals("Just now", Received.ago(now - 20_000, now))
        assertEquals("Just now", Received.ago(now + 5_000, now)) // a clock a little ahead is not "minus one minute"
        assertEquals("1 min ago", Received.ago(now - minute, now))
        assertEquals("59 min ago", Received.ago(now - 59 * minute, now))
        assertEquals("1 h ago", Received.ago(now - hour, now))
        assertEquals("23 h ago", Received.ago(now - 23 * hour - 59 * minute, now))
        assertEquals("Yesterday", Received.ago(now - 30 * hour, now))
        assertEquals("2 days ago", Received.ago(now - 2 * day, now))
        assertEquals("30 days ago", Received.ago(now - 30 * day, now))
        assertEquals("Over a month ago", Received.ago(now - 40 * day, now))
    }

    @Test fun `a file with no picture shows its extension`() {
        assertEquals("PDF", Received.badge("Boarding pass.pdf"))
        assertEquals("DOCX", Received.badge("report.final.docx"))
        assertEquals("FILE", Received.badge("README"))
        assertEquals("FILE", Received.badge("odd."))
        assertEquals("TARG", Received.badge("backup.targz2"))
        assertEquals("7Z", Received.badge("archive.7z"))
    }

    @Test fun `a row says the size and when`() {
        assertEquals("2.4 MB · 5 min ago", Received.detail(file("u", now - 5 * minute), now))
        assertEquals("12 KB · Yesterday", Received.detail(file("u", now - 30 * hour, size = 12_800), now))
    }
}
