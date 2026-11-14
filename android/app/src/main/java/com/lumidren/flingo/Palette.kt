package com.lumidren.flingo

import kotlin.math.pow

/**
 * Flingo's colours, in one place and as plain numbers, so they can be checked without a
 * phone: the unit tests work out the contrast of every pair that carries text or marks a
 * control, and fail if one drops below what WCAG 2.2 level AA asks for.
 */
object Palette {
    const val BG = 0xFF0E1016.toInt()
    const val PANEL = 0xFF171A23.toInt()
    const val PANEL_2 = 0xFF1F2330.toInt()
    /** The recommended choice and the card about the maker. */
    const val PANEL_BEST = 0xFF222A48.toInt()
    const val LINE = 0xFF2A2F3F.toInt()
    /** The unfilled part of a progress bar. */
    const val TRACK = 0xFF3A4053.toInt()
    /** The outline of a quiet button: 3:1 or better against the panels it sits on. */
    const val EDGE = 0xFF6B7285.toInt()
    const val MUTED = 0xFF9097AA.toInt()
    const val DETAIL = 0xFFA6ADC0.toInt()
    const val SOFT = 0xFFC5CAD8.toInt()
    const val TEXT = 0xFFFFFFFF.toInt()
    const val ACCENT = 0xFF6C8CFF.toInt()
    /** Text on the accent colour. Dark, because white on it reaches only 3.1:1. */
    const val ON_ACCENT = 0xFF0E1016.toInt()
    const val GOOD = 0xFF4DE1A1.toInt()
    const val WARN = 0xFFFFB84D.toInt()
    /** A dark patch behind words or marks that are drawn over a photo or over the send zone. */
    const val SCRIM = 0xE60E1016.toInt()
    /** The status pill at the foot of the screen, which photos show through a little. */
    const val STATUS = 0xF01F2330.toInt()

    private fun channel(value: Int): Double {
        val c = value / 255.0
        return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
    }

    /** Relative luminance, as WCAG defines it. The colour's own transparency is ignored. */
    fun luminance(color: Int): Double =
        0.2126 * channel(color shr 16 and 0xFF) + 0.7152 * channel(color shr 8 and 0xFF) + 0.0722 * channel(color and 0xFF)

    /** The WCAG contrast ratio of two opaque colours, from 1 (the same) to 21 (black on white). */
    fun contrast(a: Int, b: Int): Double {
        val x = luminance(a)
        val y = luminance(b)
        return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
    }

    /** What a see-through colour really looks like over an opaque one. */
    fun over(top: Int, under: Int): Int {
        val alpha = (top ushr 24) / 255.0
        fun mix(shift: Int): Int = Math.round((top shr shift and 0xFF) * alpha + (under shr shift and 0xFF) * (1 - alpha)).toInt()
        return (0xFF shl 24) or (mix(16) shl 16) or (mix(8) shl 8) or mix(0)
    }
}
