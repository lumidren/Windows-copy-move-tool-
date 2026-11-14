package com.lumidren.flingo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechTest {
    @Test fun marksMeantForTheEyeAreNotReadOut() {
        assertEquals("Sent to Home-PC", Speech.plain("Sent to Home-PC ✓"))
        assertEquals("3 selected", Speech.plain("3 selected  ▾"))
        assertEquals("45% of 1.20 GB, 12.0 MB/s, about 2 min left", Speech.plain("45% of 1.20 GB · 12.0 MB/s · about 2 min left"))
        assertEquals("Sending 3 of 24 45% of 60 MB", Speech.plain("Sending 3 of 24\n45% of 60 MB"))
        assertEquals("Connection lost. Trying to carry on", Speech.plain("Connection lost. Trying to carry on…"))
        assertEquals("Flick up to send", Speech.plain("↑  Flick up to send"))
        assertEquals("About Flingo", Speech.plain("About Flingo  ›"))
    }

    @Test fun aTileSaysWhichPhotoItIs() {
        assertEquals("Photo 1 of 3000, 14 Nov, 15:02", Speech.tile(false, 0, 3000, "14 Nov, 15:02"))
        assertEquals("Video 12 of 40, yesterday", Speech.tile(true, 11, 40, "yesterday"))
    }
}

class ProgressVoiceTest {
    @Test fun theStartIsSpokenOnceAndTheStepsAfterItAreNot() {
        val v = ProgressVoice()
        assertEquals("Sending 1 of 24", v.step("Sending 1 of 24", 0, false, false, 1_000))
        assertNull(v.step("Sending 1 of 24", 10, false, false, 1_100))
        assertNull(v.step("Sending 2 of 24", 40, false, false, 1_200))
    }

    @Test fun tenUpdatesASecondForAMinuteSayOnlyAHandfulOfThings() {
        val v = ProgressVoice()
        var spoken = 0
        for (i in 0..600) if (v.step("Sending ${1 + i / 25} of 24", i * 1000 / 600, false, false, 1_000L + i * 100) != null) spoken++
        // the start and three quarters; nothing else is needed within 20 s of each
        assertTrue("spoke $spoken times", spoken in 4..6)
    }

    @Test fun eachQuarterIsSaidOnceWithAPauseBeforeIt() {
        val v = ProgressVoice(pauseMs = 5_000)
        v.step("Sending", 0, false, false, 0)
        assertNull("too soon after the start", v.step("Sending", 260, false, false, 2_000))
        assertEquals("Sending, 25 percent", v.step("Sending", 270, false, false, 6_000))
        assertNull(v.step("Sending", 400, false, false, 12_000))
        assertEquals("Sending, 50 percent", v.step("Sending", 510, false, false, 12_100))
        assertNull("the end is announced by the result, not here", v.step("Sending", 1000, false, false, 29_999))
    }

    @Test fun aQuickTransferThatJumpsPastSeveralQuartersSaysOnlyWhereItIs() {
        val v = ProgressVoice(pauseMs = 5_000)
        v.step("Sending", 0, false, false, 0)
        assertEquals("Sending, 75 percent", v.step("Sending", 800, false, false, 6_000))
        assertNull(v.step("Sending", 900, false, false, 12_000))
    }

    @Test fun losingTheConnectionAndGettingItBackAreSaidAtOnce() {
        val v = ProgressVoice()
        v.step("Sending 3 of 24", 100, false, false, 0)
        assertEquals("Connection lost. Trying to carry on", v.step("Connection lost. Trying to carry on…", 100, true, false, 300))
        assertNull("nothing is repeated while it waits", v.step("Connection lost. Trying to carry on…", 100, true, false, 40_000))
        assertEquals("Carrying on. Sending 3 of 24", v.step("Sending 3 of 24", 110, false, false, 40_100))
    }

    @Test fun theFinalCheckIsSaidWhenItBegins() {
        val v = ProgressVoice()
        v.step("Receiving", 0, false, false, 0)
        assertEquals("Checking the file", v.step("Checking the file…", 1000, false, true, 1_000))
        assertNull(v.step("Checking the file…", 1000, false, true, 1_100))
    }

    @Test fun aLongSilenceIsBrokenWithOrWithoutAKnownSize() {
        val known = ProgressVoice(longestSilenceMs = 20_000)
        known.step("Sending", 0, false, false, 0)
        assertNull(known.step("Sending", 120, false, false, 19_000))
        assertEquals("Sending, 13 percent", known.step("Sending", 130, false, false, 20_000))

        val unknown = ProgressVoice(longestSilenceMs = 20_000)
        unknown.step("Sending", null, false, false, 0)
        assertNull("the byte count changes ten times a second and is never read out", unknown.step("Sending", null, false, false, 100))
        assertEquals("Sending", unknown.step("Sending", null, false, false, 20_000))
    }

    @Test fun afterAResetTheNextTransferIsAnnouncedFromItsStart() {
        val v = ProgressVoice()
        v.step("Sending", 900, false, false, 0)
        v.reset()
        assertEquals("Receiving 1 of 3", v.step("Receiving 1 of 3", 0, false, false, 100))
    }
}
