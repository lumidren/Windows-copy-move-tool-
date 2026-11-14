package com.lumidren.flingo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The contrast of every pair of colours that carries text or marks a control. WCAG 2.2 level AA. */
class PaletteTest {
    private val white = 0xFFFFFFFF.toInt()
    private val black = 0xFF000000.toInt()

    private fun atLeast(min: Double, ink: Int, paper: Int, what: String) {
        val ratio = Palette.contrast(ink, paper)
        assertTrue("$what is %.2f:1, needs $min:1".format(ratio), ratio >= min)
    }

    @Test fun theSumsAreRight() {
        assertEquals(21.0, Palette.contrast(black, white), 0.01)
        assertEquals(4.48, Palette.contrast(0xFF777777.toInt(), white), 0.01) // the well-known near miss
        // Black at 128/255 over white: just under half way, so 7F and not 80.
        assertEquals(0xFF7F7F7F.toInt(), Palette.over(0x80000000.toInt(), white))
    }

    @Test fun textReachesFourAndAHalfToOneOnEverySurface() {
        val surfaces = listOf("background" to Palette.BG, "panel" to Palette.PANEL, "second panel" to Palette.PANEL_2, "recommended row" to Palette.PANEL_BEST)
        for ((name, paper) in surfaces) {
            atLeast(4.5, Palette.TEXT, paper, "white text on the $name")
            atLeast(4.5, Palette.SOFT, paper, "soft text on the $name")
            atLeast(4.5, Palette.MUTED, paper, "muted text on the $name")
            atLeast(4.5, Palette.DETAIL, paper, "detail text on the $name")
        }
        atLeast(4.5, Palette.ACCENT, Palette.PANEL, "accent-coloured words on a sheet")
        atLeast(4.5, Palette.ON_ACCENT, Palette.ACCENT, "words on a filled button")
        atLeast(4.5, Palette.ON_ACCENT, Palette.GOOD, "the BEST marker")
    }

    /** The reason filled buttons use dark text. */
    @Test fun whiteOnTheAccentColourWouldFail() {
        assertTrue(Palette.contrast(Palette.TEXT, Palette.ACCENT) < 4.5)
    }

    @Test fun wordsOnTheStatusPillReadOverTheDarkestAndTheBrightestPhoto() {
        for (behind in listOf(Palette.BG, white)) {
            val pill = Palette.over(Palette.STATUS, behind)
            atLeast(4.5, Palette.TEXT, pill, "status text")
            // "Cancel" is 14sp bold, which WCAG counts as large text.
            atLeast(3.0, Palette.ACCENT, pill, "the Cancel word on the status pill")
        }
    }

    @Test fun wordsDrawnOverAPhotoSitOnAPatchThatKeepsThemReadable() {
        for (behind in listOf(black, white, Palette.ACCENT)) {
            atLeast(4.5, Palette.TEXT, Palette.over(Palette.SCRIM, behind), "white on the dark patch")
        }
    }

    @Test fun outlinesMarksAndBarsReachThreeToOne() {
        atLeast(3.0, Palette.EDGE, Palette.PANEL, "the outline of a quiet button on a sheet")
        atLeast(3.0, Palette.EDGE, Palette.PANEL_2, "the outline of a quiet button on a panel")
        atLeast(3.0, Palette.ACCENT, Palette.PANEL_2, "the outline of Browse files")
        atLeast(3.0, Palette.ACCENT, Palette.TRACK, "a progress bar on its track")
        atLeast(3.0, Palette.TEXT, Palette.ACCENT, "the tick on a selected photo")
        atLeast(3.0, Palette.TEXT, Palette.BG, "the focus ring")
        for (dot in listOf(Palette.GOOD, Palette.WARN, Palette.EDGE)) atLeast(3.0, dot, Palette.PANEL_2, "a connection dot")
    }

    /** Green and amber are almost equally bright, so the dot is also hollow when the PC is out of reach. */
    @Test fun connectedAndNotReachableCannotBeToldApartByColourAlone() {
        assertTrue(Palette.contrast(Palette.GOOD, Palette.WARN) < 1.5)
    }
}
