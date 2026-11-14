package com.lumidren.flingo

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.util.TypedValue
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView

// Small things every screen of Flingo uses, so that a button behaves the same wherever it is.

/** Density-independent pixels to pixels, from any view. */
internal fun View.px(dp: Float): Int = (dp * resources.displayMetrics.density).toInt()

/** A white outline that shows only while a keyboard or a switch has its focus here. */
internal fun View.focusRing(radius: Float) = StateListDrawable().apply {
    addState(intArrayOf(android.R.attr.state_focused), GradientDrawable().apply {
        setColor(Color.TRANSPARENT)
        setStroke(px(3f), Color.WHITE)
        cornerRadius = radius * resources.displayMetrics.density
    })
    addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
}

/**
 * Every button in Flingo is a piece of text with a tap on it. This tells TalkBack, Switch
 * Access and Voice Access that it is a button, lets a keyboard reach it, and shows where the
 * focus is. [action] names what a tap does when the label alone does not ("select more at once").
 */
internal fun <T : View> T.asButton(radius: Float = 14f, action: String? = null): T {
    isFocusable = true
    foreground = focusRing(radius)
    accessibilityDelegate = object : View.AccessibilityDelegate() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(host, info)
            info.className = android.widget.Button::class.java.name
            if (action != null) info.addAction(AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, action))
        }
    }
    return this
}

/** A mark such as ✕ or ⚙ is a picture, not words: it keeps its size when the phone's text is made larger, like the box it sits in. */
internal fun TextView.glyph(dip: Float) = setTextSize(TypedValue.COMPLEX_UNIT_DIP, dip)
