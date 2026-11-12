package com.lumidren.flingo

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewOutlineProvider
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : Activity() {
    private val scope = MainScope()
    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var grid: RecyclerView
    private lateinit var adapter: GalleryAdapter
    private lateinit var chip: TextView
    private lateinit var zone: TextView
    private lateinit var status: TextView
    private lateinit var empty: TextView

    // drag state
    private var dragging = false
    private var floating: ImageView? = null
    private var dragItem: MediaItem? = null
    private var originX = 0f
    private var originY = 0f
    private var grabDx = 0f
    private var grabDy = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var tracker: VelocityTracker? = null
    private var statusJob: Job? = null
    private var pendingShare: List<Uri> = emptyList()

    private val accent = Color.parseColor("#6C8CFF")
    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun dpi(v: Float) = dp(v).toInt()

    private fun pill(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius)
    }

    // ---------- lifecycle ----------
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        buildUi()
        updateChip()
        if (hasMediaPermission()) loadGallery() else requestMediaPermission()
    }

    override fun onDestroy() {
        scope.cancel()
        adapter.shutdown()
        tracker?.recycle()
        super.onDestroy()
    }

    // ---------- UI ----------
    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0E1016")) }

        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dpi(18f), dpi(14f), dpi(10f), dpi(12f))
        }
        header.addView(TextView(this).apply {
            text = "Flingo"
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        chip = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.WHITE)
            maxLines = 1
            setPadding(dpi(14f), dpi(8f), dpi(14f), dpi(8f))
            minHeight = dpi(40f)
            gravity = Gravity.CENTER
        }
        header.addView(chip)
        header.addView(TextView(this).apply {
            text = "⚙"
            textSize = 22f
            setTextColor(Color.parseColor("#C5CAD8"))
            gravity = Gravity.CENTER
            contentDescription = "Settings"
        }, LinearLayout.LayoutParams(dpi(48f), dpi(48f)))
        column.addView(header)

        column.addView(TextView(this).apply {
            text = "Hold a photo, then flick it up toward your PC."
            textSize = 13f
            setTextColor(Color.parseColor("#9097AA"))
            setPadding(dpi(18f), 0, dpi(18f), dpi(10f))
        })

        adapter = GalleryAdapter(
            this,
            onTap = { showStatus("Hold a photo, then flick it up.") },
            onPickUp = ::startDrag,
        )
        grid = RecyclerView(this).apply {
            layoutManager = GridLayoutManager(this@MainActivity, 3)
            adapter = this@MainActivity.adapter
            setHasFixedSize(true)
        }
        column.addView(grid, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        root.addView(column, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        empty = TextView(this).apply {
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#C5CAD8"))
            setPadding(dpi(32f), dpi(32f), dpi(32f), dpi(32f))
            visibility = View.GONE
            setOnClickListener { requestMediaPermission() }
        }
        root.addView(empty, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.CENTER))

        zone = TextView(this).apply {
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            alpha = 0f
            visibility = View.GONE
        }
        root.addView(zone, FrameLayout.LayoutParams(MATCH_PARENT, dpi(160f), Gravity.TOP))

        status = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.WHITE)
            background = pill(Color.parseColor("#F01F2330"), 22f)
            setPadding(dpi(18f), dpi(11f), dpi(18f), dpi(11f))
            elevation = dp(8f)
            visibility = View.GONE
        }
        root.addView(status, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = dpi(40f)
        })

        root.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            column.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)
    }

    private fun updateChip() {
        if (prefs.paired) {
            chip.text = "●  ${prefs.pcName}"
            chip.background = pill(Color.parseColor("#1F2330"), 20f)
        } else {
            chip.text = "Pair with PC"
            chip.background = pill(accent, 20f)
        }
    }

    private fun setZoneActive(active: Boolean) {
        val target = if (prefs.paired) prefs.pcName else "your PC"
        zone.text = if (active) "Release to send to $target" else "↑  Flick up to send"
        zone.background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(if (active) Color.parseColor("#F06C8CFF") else Color.parseColor("#996C8CFF"), Color.TRANSPARENT),
        )
    }

    private fun showStatus(text: String, sticky: Boolean = false) {
        statusJob?.cancel()
        status.text = text
        status.visibility = View.VISIBLE
        status.announceForAccessibility(text)
        if (!sticky) statusJob = scope.launch {
            delay(2600)
            status.visibility = View.GONE
        }
    }

    // ---------- gallery + permission ----------
    private fun mediaPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    private fun hasMediaPermission(): Boolean {
        if (mediaPermissions().any { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) return true
        // Android 14+: the user may have granted access to selected photos only.
        return Build.VERSION.SDK_INT >= 34 &&
            checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestMediaPermission() {
        val perms = mediaPermissions().toMutableList()
        if (Build.VERSION.SDK_INT >= 34) perms.add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        requestPermissions(perms.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (hasMediaPermission()) {
            loadGallery()
        } else {
            empty.text = "Flingo needs access to your photos to show them here.\n\nTap to allow."
            empty.visibility = View.VISIBLE
        }
    }

    private fun loadGallery() {
        scope.launch {
            val items = withContext(Dispatchers.IO) { Gallery.load(this@MainActivity) }
            adapter.submit(items)
            empty.text = "No photos or videos on this phone yet."
            empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        }
    }

    // ---------- drag + flick ----------
    private fun rootOnScreen(): IntArray = IntArray(2).also { root.getLocationOnScreen(it) }

    private fun startDrag(item: MediaItem, source: ImageView) {
        if (dragging) return
        val loc = IntArray(2).also { source.getLocationOnScreen(it) }
        val base = rootOnScreen()
        val view = ImageView(this).apply {
            setImageDrawable(source.drawable)
            scaleType = ImageView.ScaleType.CENTER_CROP
            elevation = dp(16f)
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(v: View, outline: Outline) = outline.setRoundRect(0, 0, v.width, v.height, dp(14f))
            }
        }
        root.addView(view, FrameLayout.LayoutParams(source.width, source.height))
        originX = (loc[0] - base[0]).toFloat()
        originY = (loc[1] - base[1]).toFloat()
        view.x = originX
        view.y = originY
        grabDx = lastX - base[0] - originX
        grabDy = lastY - base[1] - originY
        view.animate().scaleX(1.18f).scaleY(1.18f).setDuration(120).start()
        source.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)

        floating = view
        dragItem = item
        dragging = true

        zone.layoutParams = zone.layoutParams.apply { height = root.height * prefs.zonePercent / 100 }
        setZoneActive(false)
        zone.visibility = View.VISIBLE
        zone.animate().alpha(1f).setDuration(150).start()

        // Take the gesture away from the list so it stops scrolling.
        val now = SystemClock.uptimeMillis()
        val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, lastX, lastY, 0)
        super.dispatchTouchEvent(cancel)
        cancel.recycle()
    }

    private fun fingerInZone(): Boolean = (lastY - rootOnScreen()[1]) < root.height * prefs.zonePercent / 100f

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        lastX = ev.rawX
        lastY = ev.rawY
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            tracker?.recycle()
            tracker = VelocityTracker.obtain()
        }
        tracker?.addMovement(ev)
        if (!dragging) return super.dispatchTouchEvent(ev)

        when (ev.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val base = rootOnScreen()
                floating?.let {
                    it.x = lastX - base[0] - grabDx
                    it.y = lastY - base[1] - grabDy
                }
                setZoneActive(fingerInZone())
            }
            MotionEvent.ACTION_UP -> finishDrag(cancelled = false)
            MotionEvent.ACTION_CANCEL -> finishDrag(cancelled = true)
        }
        return true
    }

    private fun finishDrag(cancelled: Boolean) {
        val view = floating
        val item = dragItem
        dragging = false
        floating = null
        dragItem = null
        zone.animate().alpha(0f).setDuration(180).withEndAction { zone.visibility = View.GONE }.start()
        if (view == null || item == null) return

        tracker?.computeCurrentVelocity(1000)
        val vy = tracker?.yVelocity ?: 0f
        val flung = vy < -dp(1100f)
        val shouldSend = !cancelled && (fingerInZone() || flung)

        if (shouldSend && prefs.paired) {
            val x = ((lastX - rootOnScreen()[0]) / root.width).coerceIn(0f, 1f)
            view.animate().y(-view.height * 1.6f).scaleX(0.5f).scaleY(0.5f).alpha(0.4f)
                .setDuration(220).withEndAction { root.removeView(view) }.start()
            send(listOf(item.uri), x)
        } else {
            view.animate().x(originX).y(originY).scaleX(1f).scaleY(1f)
                .setDuration(200).withEndAction { root.removeView(view) }.start()
            if (shouldSend) showPairDialog()
        }
    }

    // ---------- sending ----------
    private fun send(uris: List<Uri>, x: Float) {
        scope.launch {
            var sent = 0
            try {
                for (uri in uris) {
                    showStatus(if (uris.size > 1) "Sending ${sent + 1} of ${uris.size}…" else "Sending…", sticky = true)
                    withContext(Dispatchers.IO) { Net.send(this@MainActivity, prefs, uri, x) }
                    sent++
                }
                showStatus(if (sent > 1) "Sent $sent files to ${prefs.pcName} ✓" else "Sent to ${prefs.pcName} ✓")
            } catch (_: NotPairedException) {
                prefs.clearPairing()
                updateChip()
                showStatus("That PC no longer knows this phone. Pair again.")
            } catch (_: Exception) {
                showStatus("Couldn't reach ${prefs.pcName}. Is Flingo open on the PC, on the same Wi-Fi?")
            }
        }
    }

}
