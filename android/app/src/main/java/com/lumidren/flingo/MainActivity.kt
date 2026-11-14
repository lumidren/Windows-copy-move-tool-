package com.lumidren.flingo

import android.Manifest
import android.animation.ValueAnimator
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewOutlineProvider
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.zxing.integration.android.IntentIntegrator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

class MainActivity : Activity() {
    private companion object { const val PICK_FILES = 7 }

    private val scope = MainScope()
    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var grid: RecyclerView
    private lateinit var adapter: GalleryAdapter
    private lateinit var chip: TextView
    private lateinit var zone: FrameLayout
    private lateinit var zoneLabel: TextView
    private lateinit var sendButton: TextView
    private lateinit var status: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var statusBar: ProgressBar
    private lateinit var statusCancel: TextView
    private lateinit var empty: TextView
    private lateinit var selectBar: LinearLayout
    private lateinit var selectCount: TextView
    private lateinit var updateBar: LinearLayout
    private lateinit var updateText: TextView
    private lateinit var updateGo: TextView
    private lateinit var updateClose: TextView

    // drag state
    private var dragging = false
    private var floating: ImageView? = null
    private var dragItem: MediaItem? = null
    private var dragUris: List<Uri> = emptyList()
    private var originX = 0f
    private var originY = 0f
    private var grabDx = 0f
    private var grabDy = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var wasInZone = false
    private var tracker: VelocityTracker? = null
    private var statusJob: Job? = null
    private var healthJob: Job? = null
    private var updateJob: Job? = null
    private var cancelAction: () -> Unit = {}
    private var dropping = false
    private var pendingShare: List<Uri> = emptyList()
    /** Whether a finger is on the glass. A long-press without one comes from a screen reader, a switch or a keyboard. */
    private var fingerDown = false
    private var bottomInset = 0
    /** Decides when the progress of a transfer is said aloud. */
    private val voice = ProgressVoice()
    private var announcedUpdate = ""

    // Keeps Net.wifi pointing at the current Wi-Fi network, including one with no internet.
    private val wifiWatcher = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { Net.wifi = network }
        override fun onLost(network: Network) { if (Net.wifi == network) Net.wifi = null }
    }

    /** Whether the paired PC answered the last time it was asked. Null until the first answer. */
    private var online: Boolean? = null

    // Progress and results of whatever is being sent, while this screen is in front.
    // Files coming in from the PC, while this screen is in front.
    private val receiveWatcher = object : Inbox.Listener {
        override fun onProgress(state: SendState) = showReceive(state)
        override fun onArrived(file: Arrived) = dropIn(file)
        override fun onFinished(result: ReceiveResult) = showReceived(result)
    }

    private val sendWatcher = object : Transfers.Listener {
        override fun onProgress(state: SendState) = showSend(state)
        override fun onFinished(result: SendResult) = showResult(result)
    }

    private val accent = Palette.ACCENT
    private val good = Palette.GOOD
    private val warn = Palette.WARN
    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun dpi(v: Float) = dp(v).toInt()

    private fun pill(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius)
    }

    // ---------- for people who do not use the screen the usual way ----------
    /** Text set this large in the phone's settings needs rows to stack instead of sitting side by side. */
    private val bigText: Boolean get() = resources.configuration.fontScale >= 1.3f

    /** False when the phone has animations switched off, or Flingo's own "Reduce motion" is on. */
    private val motionOk: Boolean get() = ValueAnimator.areAnimatorsEnabled() && !prefs.reduceMotion

    /** Says something to a screen reader. Marks that are drawn for the eye are left out. */
    private fun say(text: String) { root.announceForAccessibility(Speech.plain(text)) }

    // Buttons get their role and focus ring from asButton(), in Ui.kt, which the scanner screen uses too.

    /** As many columns of photos as fit: three on a phone held upright, more when it is turned. */
    private fun columns(): Int = maxOf(3, resources.configuration.screenWidthDp / 130)

    /** The screen was turned. The same views are laid out again; nothing is rebuilt or lost. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        (grid.layoutManager as GridLayoutManager).spanCount = columns()
    }

    // ---------- lifecycle ----------
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        runCatching {
            val wifiOnly = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            getSystemService(ConnectivityManager::class.java).registerNetworkCallback(wifiOnly, wifiWatcher)
        }
        buildUi()
        updateChip()
        if (hasMediaPermission()) loadGallery() else requestMediaPermission()
        // When Android brings the app back after closing it, it hands over the same intent as
        // the first time. A pairing link or a share in it was dealt with then, and must not be again.
        if (savedInstanceState == null) handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (prefs.keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        startHealthChecks()
        // Catch up with a transfer that kept going while this screen was away.
        Transfers.listener = sendWatcher
        Transfers.takeResult()?.let(::showResult)
        Transfers.state?.let(::showSend)
        // And with whatever the PC has been sending this way.
        Inbox.listener = receiveWatcher
        Inbox.takeResult()?.let(::showReceived)
        Inbox.state?.let(::showReceive)
        Inbox.start(this)
        Updater.onFailure = ::updateFailed
        Updater.takeFailure()?.let(::updateFailed)
        checkForUpdate()
    }

    override fun onPause() {
        healthJob?.cancel()
        Transfers.listener = null
        Inbox.listener = null
        Inbox.pause()
        Updater.onFailure = null
        super.onPause()
    }

    @Deprecated("Still the simplest way to give Back a meaning inside one screen.")
    override fun onBackPressed() {
        if (adapter.selectedCount > 0) adapter.clearSelection()
        else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onDestroy() {
        scope.cancel()
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(wifiWatcher) }
        adapter.shutdown()
        tracker?.recycle()
        super.onDestroy()
    }

    // ---------- UI ----------
    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Palette.BG) }

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
            // One line, and smaller if it has to be: with the largest text and a long PC name
            // beside it, it would otherwise wrap a letter to a line or lose its last letter.
            maxLines = 1
            setAutoSizeTextTypeUniformWithConfiguration(13, 22, 1, TypedValue.COMPLEX_UNIT_SP)
            isAccessibilityHeading = true
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        chip = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.WHITE)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = dpi(210f)
            setPadding(dpi(14f), dpi(8f), dpi(14f), dpi(8f))
            minHeight = dpi(48f)
            gravity = Gravity.CENTER
            compoundDrawablePadding = dpi(8f)
            setOnClickListener { if (prefs.paired) showPcDialog() else showPairDialog() }
        }.asButton(24f)
        header.addView(chip)
        header.addView(TextView(this).apply {
            text = "⚙"
            glyph(22f)
            setTextColor(Palette.SOFT)
            gravity = Gravity.CENTER
            contentDescription = "Settings"
            setOnClickListener { showSettings() }
        }.asButton(24f), LinearLayout.LayoutParams(dpi(48f), dpi(48f)))
        column.addView(header)

        // Side by side normally. With large text the hint would be squeezed into a column a few
        // words wide, so then the button goes underneath it.
        val hintRow = LinearLayout(this).apply {
            orientation = if (bigText) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = if (bigText) Gravity.START else Gravity.CENTER_VERTICAL
            setPadding(dpi(18f), 0, dpi(12f), dpi(10f))
        }
        hintRow.addView(TextView(this).apply {
            text = "Hold a photo and flick it up. Tap to select several."
            textSize = 13f
            setTextColor(Palette.MUTED)
        }, if (bigText) LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT) else LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        hintRow.addView(TextView(this).apply {
            // Opens the phone's own file browser: the way to send a large video, a document or
            // anything else that is not a photo in the grid. Outlined so it reads as a button.
            text = "Browse files"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            maxLines = 1
            background = pill(Palette.PANEL_2, 24f).apply { setStroke(dpi(1.5f), accent) }
            setPadding(dpi(16f), 0, dpi(16f), 0)
            minHeight = dpi(48f)
            // Begins with the words on the button, so "tap Browse files" works by voice.
            contentDescription = "Browse files. Send any file, such as a large video or a document"
            setOnClickListener { pickFiles() }
        }.asButton(24f), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { if (bigText) topMargin = dpi(8f) else leftMargin = dpi(10f) })
        column.addView(hintRow)

        // Shown when a newer Flingo has been released: what it is, a button to get it, and a way to close the offer.
        updateText = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.WHITE)
        }
        updateGo = TextView(this).apply {
            text = "Update"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Palette.ON_ACCENT)
            gravity = Gravity.CENTER
            background = pill(accent, 24f)
            setPadding(dpi(18f), 0, dpi(18f), 0)
            minHeight = dpi(48f)
        }.asButton(24f)
        updateClose = TextView(this).apply {
            text = "✕"
            glyph(16f)
            setTextColor(Palette.SOFT)
            gravity = Gravity.CENTER
            contentDescription = "Dismiss the update offer"
        }.asButton(24f)
        updateBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pill(Palette.PANEL_2, 14f)
            setPadding(dpi(14f), dpi(6f), dpi(4f), dpi(6f))
            visibility = View.GONE
            addView(updateText, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(updateGo)
            addView(updateClose, LinearLayout.LayoutParams(dpi(48f), dpi(48f)).apply { leftMargin = dpi(4f) })
        }
        column.addView(updateBar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
            leftMargin = dpi(12f)
            rightMargin = dpi(12f)
            bottomMargin = dpi(10f)
        })

        adapter = GalleryAdapter(
            this,
            onPickUp = ::startDrag,
            onSelection = ::updateSelectBar,
        )
        grid = RecyclerView(this).apply {
            id = View.generateViewId()
            layoutManager = GridLayoutManager(this@MainActivity, columns())
            adapter = this@MainActivity.adapter
            setHasFixedSize(true)
        }
        column.addView(grid, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        // Shown while photos are selected: how many, a way to select more at once, and Send.
        // This is the way to send without the flick. On screen it is at the foot, under the
        // thumb; a screen reader reaches it before the grid, not after three thousand photos.
        val clear = TextView(this).apply {
            id = View.generateViewId()
            text = "✕"
            glyph(18f)
            setTextColor(Palette.SOFT)
            gravity = Gravity.CENTER
            contentDescription = "Clear selection"
            accessibilityTraversalBefore = grid.id
            setOnClickListener { adapter.clearSelection() }
        }.asButton(24f)
        selectCount = TextView(this).apply {
            id = View.generateViewId()
            textSize = 15f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER_VERTICAL
            minHeight = dpi(48f)
            setPadding(dpi(6f), 0, dpi(6f), 0)
            // Selecting, clearing and "select the last 7 days" are said as they happen.
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            accessibilityTraversalAfter = clear.id
            setOnClickListener { showSelectMenu() }
        }.asButton(12f, action = "select more at once")
        sendButton = TextView(this).apply {
            text = "Send"
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Palette.ON_ACCENT)
            gravity = Gravity.CENTER
            background = pill(accent, 24f)
            setPadding(dpi(26f), 0, dpi(26f), 0)
            minHeight = dpi(48f)
            accessibilityTraversalAfter = selectCount.id
            setOnClickListener { sendSelection() }
        }.asButton(24f)
        selectBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Palette.PANEL)
            setPadding(dpi(8f), dpi(8f), dpi(12f), dpi(8f))
            visibility = View.GONE
            addView(clear, LinearLayout.LayoutParams(dpi(48f), dpi(48f)))
            addView(selectCount, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(sendButton)
        }
        column.addView(selectBar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(column, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        // Tappable only while it is asking for permission (see onRequestPermissionsResult).
        empty = TextView(this).apply {
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Palette.SOFT)
            setPadding(dpi(32f), dpi(32f), dpi(32f), dpi(32f))
            visibility = View.GONE
        }
        root.addView(empty, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.CENTER))

        // The send zone is see-through, with the header showing behind it. Its words sit on
        // their own dark patch so they read whatever is underneath.
        zoneLabel = TextView(this).apply {
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = pill(Palette.SCRIM, 20f)
            setPadding(dpi(16f), dpi(8f), dpi(16f), dpi(8f))
        }
        zone = FrameLayout(this).apply {
            alpha = 0f
            visibility = View.GONE
            // What it says is spoken as the photo crosses into and out of it.
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            // Keep the label at the top edge so the dragged photo and the finger don't cover it.
            addView(zoneLabel, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
        }
        root.addView(zone, FrameLayout.LayoutParams(MATCH_PARENT, dpi(160f), Gravity.TOP))

        // Status pill: one line of text, plus a progress bar while a file is on its way.
        statusText = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        statusBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progressTintList = ColorStateList.valueOf(accent)
            progressBackgroundTintList = ColorStateList.valueOf(Palette.TRACK)
            // The words beside it say how far it has got; read out as well, it would repeat them.
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            visibility = View.GONE
        }
        statusCancel = TextView(this).apply {
            text = "Cancel"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(accent)
            gravity = Gravity.CENTER
            minHeight = dpi(48f)
            minWidth = dpi(48f)
            setPadding(dpi(14f), 0, dpi(2f), 0)
            contentDescription = "Cancel the transfer"
            visibility = View.GONE
            setOnClickListener { cancelAction() }
        }.asButton(12f)
        val statusLine = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(statusText, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, 1f))
            addView(statusCancel)
        }
        status = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = pill(Palette.STATUS, 22f)
            setPadding(dpi(18f), dpi(11f), dpi(18f), dpi(11f))
            elevation = dp(8f)
            visibility = View.GONE
            addView(statusLine, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.CENTER_HORIZONTAL })
            // As wide as the words above it, so it fits a narrow screen and a large display size.
            addView(statusBar, LinearLayout.LayoutParams(MATCH_PARENT, dpi(4f)).apply { topMargin = dpi(8f) })
        }
        root.addView(status, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = dpi(40f)
            leftMargin = dpi(20f)
            rightMargin = dpi(20f)
        })

        root.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            column.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            zone.setPadding(0, insets.systemWindowInsetTop + dpi(10f), 0, 0)
            @Suppress("DEPRECATION")
            bottomInset = insets.systemWindowInsetBottom
            placeStatus()
            insets
        }
        setContentView(root)
    }

    /** Keeps the status pill clear of the selection bar and of the phone's own navigation bar, however tall they are. */
    private fun placeStatus() {
        val bar = if (selectBar.visibility == View.VISIBLE) maxOf(selectBar.height, dpi(64f)) else 0
        (status.layoutParams as FrameLayout.LayoutParams).bottomMargin = bottomInset + bar + dpi(if (bar > 0) 16f else 40f)
        status.requestLayout()
    }

    /** [hollow] draws a ring instead of a full dot, so a state is a shape as well as a colour. */
    private fun dot(color: Int, hollow: Boolean = false) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        if (hollow) { setColor(Color.TRANSPARENT); setStroke(dpi(2f), color) } else setColor(color)
        setSize(dpi(10f), dpi(10f))
    }

    private fun updateChip() {
        if (!prefs.paired) {
            chip.text = "Pair with PC"
            chip.setTextColor(Palette.ON_ACCENT)
            chip.background = pill(accent, 24f)
            chip.setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, null, null)
            chip.contentDescription = "Pair with PC"
            return
        }
        chip.text = prefs.pcName
        chip.setTextColor(Color.WHITE)
        chip.background = pill(Palette.PANEL_2, 24f)
        // Green and amber are almost equally bright, so they are also different shapes:
        // a full dot when connected, a ring when the PC cannot be reached.
        val mark = when (online) { true -> dot(good); false -> dot(warn, hollow = true); null -> dot(Palette.EDGE) }
        chip.setCompoundDrawablesRelativeWithIntrinsicBounds(mark, null, null, null)
        chip.contentDescription = when (online) {
            true -> "${prefs.pcName}, connected"
            false -> "${prefs.pcName}, not reachable"
            null -> "${prefs.pcName}, checking"
        }
    }

    private fun setZoneActive(active: Boolean) {
        val target = if (prefs.paired) prefs.pcName else "your PC"
        val many = dragUris.size
        zoneLabel.text = when {
            active && many > 1 -> "Release to send $many to $target"
            active -> "Release to send to $target"
            many > 1 -> "↑  Flick up to send $many"
            else -> "↑  Flick up to send"
        }
        zone.background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(if (active) Color.parseColor("#F06C8CFF") else Color.parseColor("#996C8CFF"), Color.TRANSPARENT),
        )
    }

    /** [progress] is 0..1000, -1 for a transfer whose size is not known, or null for no bar. [cancelable] adds a Cancel button for the transfer in progress. */
    private fun showStatus(text: String, sticky: Boolean = false, progress: Int? = null, holdMs: Long = 2600, cancelable: Boolean = false) {
        statusJob?.cancel()
        if (statusText.text.toString() != text) statusText.text = text
        // Progress is spoken by rules of its own (see ProgressVoice). Everything else is said as
        // it appears, also when it is the same words as the last time.
        if (progress == null) say(text)
        statusCancel.visibility = if (cancelable) View.VISIBLE else View.GONE
        statusBar.visibility = if (progress == null) View.GONE else View.VISIBLE
        if (progress != null) {
            // Size unknown: a bar that keeps moving says "working". With reduced motion it stays still and empty, and the words say it.
            statusBar.isIndeterminate = progress < 0 && motionOk
            if (progress >= 0) statusBar.progress = progress
        }
        status.visibility = View.VISIBLE
        if (!sticky) statusJob = scope.launch {
            // Anyone who has asked Android for more time to read a message gets it here too.
            val kind = AccessibilityManager.FLAG_CONTENT_TEXT or (if (cancelable) AccessibilityManager.FLAG_CONTENT_CONTROLS else 0)
            delay(getSystemService(AccessibilityManager::class.java).getRecommendedTimeoutMillis(holdMs.toInt(), kind).toLong())
            status.visibility = View.GONE
        }
    }

    private fun hideStatus() {
        statusJob?.cancel()
        status.visibility = View.GONE
    }

    // ---------- updates ----------
    /**
     * Shows what is already known, and asks GitHub again if the last answer is old.
     * [manual] is "Check now" in Settings: it always asks, and it says what it found.
     */
    private fun checkForUpdate(manual: Boolean = false) {
        if (updateJob?.isActive == true) return
        showUpdate(prefs.update)
        val now = System.currentTimeMillis()
        val fresh = now >= prefs.updateCheckedAt && now - prefs.updateCheckedAt < Updater.CHECK_EVERY_MS
        if (!manual && (!prefs.checkUpdates || fresh)) return
        updateJob = scope.launch {
            val found = withContext(Dispatchers.IO) { runCatching { Updater.check() } }
            if (found.isFailure) {
                // Being offline is normal for Flingo, so only a check somebody asked for says it failed.
                if (manual) showStatus("Could not check for updates. Is the phone online?")
                return@launch
            }
            val update = found.getOrNull()
            prefs.updateCheckedAt = System.currentTimeMillis()
            prefs.update = update
            if (manual) prefs.updateDismissed = ""
            if (update == null) Updater.clean(this@MainActivity)
            showUpdate(update)
            if (manual && update == null) showStatus("You have the newest version.")
        }
    }

    private fun showUpdate(update: Update?) {
        val offer = update != null && Updater.isNewer(update.version, BuildConfig.VERSION_NAME) && prefs.updateDismissed != update.version
        updateBar.visibility = if (offer) View.VISIBLE else View.GONE
        if (!offer || update == null) return
        updateText.text = "Flingo ${update.version} is available"
        // Said once for each version, not every time the screen comes back.
        if (announcedUpdate != update.version) {
            announcedUpdate = update.version
            say("Flingo ${update.version} is available. The Update button is near the top of the screen.")
        }
        updateGo.visibility = View.VISIBLE
        updateClose.visibility = View.VISIBLE
        updateGo.setOnClickListener { startUpdate(update) }
        updateClose.setOnClickListener {
            prefs.updateDismissed = update.version
            updateBar.visibility = View.GONE
        }
    }

    /** Downloads the update, checks it, and hands it to Android, which asks before it installs. */
    private fun startUpdate(update: Update) {
        if (updateJob?.isActive == true) return
        if (Transfers.busy) { showStatus("Wait for the transfer to finish, then update."); return }
        updateGo.visibility = View.GONE
        updateClose.visibility = View.GONE
        updateText.text = "Downloading Flingo ${update.version}…"
        say("Downloading Flingo ${update.version}") // the percentage that follows changes four times a second and is not read out
        updateJob = scope.launch {
            var shown = 0L
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val file = Updater.download(this@MainActivity, update, { !isActive }) { got, of ->
                        val now = SystemClock.elapsedRealtime()
                        if (now - shown > 250 || got == of) {
                            shown = now
                            root.post { if (isActive) updateText.text = "Downloading Flingo ${update.version}… ${got * 100 / of}%" }
                        }
                    }
                    val verdict = Updater.inspect(this@MainActivity, file)
                    if (verdict == Verdict.OK) Updater.install(this@MainActivity, file)
                    verdict
                }
            }
            showUpdate(update)
            val failure = result.exceptionOrNull()
            when {
                failure is BadDownloadException -> showStatus("The download did not match the release, so it was thrown away. Try again.", holdMs = 5000)
                failure != null -> showStatus("The update could not be downloaded. Try again.", holdMs = 4000)
                result.getOrNull() == Verdict.OK -> { updateText.text = "Confirm the update on the next screen"; say("Confirm the update on the next screen") }
                result.getOrNull() == Verdict.OTHER_KEY -> explainOtherKey(update)
                else -> showStatus("That download is not a newer Flingo, so it was not installed.", holdMs = 5000)
            }
        }
    }

    /** Android only replaces an app with one signed by the same key. Say what to do instead of failing oddly. */
    private fun explainOtherKey(update: Update) {
        AlertDialog.Builder(this)
            .setTitle("This update has to be installed by hand")
            .setMessage(
                "Flingo ${update.version} is signed with a different key from the Flingo on this phone, " +
                    "so Android will not install it over this one.\n\n" +
                    "Uninstall Flingo, install the new version from the download page, and pair with your PC again.",
            )
            .setPositiveButton("Open download page") { _, _ ->
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update.page))) }
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun updateFailed(message: String) {
        showUpdate(prefs.update)
        showStatus(message, holdMs = 5000)
    }

    private fun buzz(kind: Int) { root.performHapticFeedback(kind) }
    private val hapticYes get() = if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
    private val hapticNo get() = if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS

    // ---------- staying connected ----------
    // While the app is open it asks the PC "are you there?" every few seconds, so the chip in the
    // corner is always true and a changed address is found before the next flick, not during it.
    private fun startHealthChecks() {
        healthJob?.cancel()
        if (!prefs.paired) { online = null; updateChip(); return }
        healthJob = scope.launch {
            var misses = 0
            while (isActive) {
                // After a single miss the PC is looked for by name as well, so a changed address is found in a second or two, not ten.
                if (!Transfers.busy) checkConnection(relocate = misses >= 1)
                misses = if (online == false) misses + 1 else 0
                delay(if (online == true) 4000 else 2500)
            }
        }
    }

    private suspend fun checkConnection(relocate: Boolean = false): Boolean {
        if (!prefs.paired) return false
        val result = withContext(Dispatchers.IO) {
            try {
                Net.ping(prefs) || (relocate && Net.relocate(prefs) && Net.ping(prefs))
            } catch (_: NotPairedException) {
                null
            } catch (_: Exception) {
                false
            }
        }
        if (result == null) {
            forgetPc("${prefs.pcName} no longer recognises this phone. Tap Pair with PC to pair again.")
            return false
        }
        if (online != result) {
            // Said when it really changes, and only then. Leaving it to the chip to announce
            // itself made it speak again after every transfer.
            if (online != null || !result) say("${prefs.pcName}, ${if (result) "connected" else "not reachable"}")
            online = result
            updateChip()
        }
        return result
    }

    private fun forgetPc(message: String) {
        prefs.clearPairing()
        online = null
        healthJob?.cancel()
        updateChip()
        showStatus(message, holdMs = 6000)
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
        if (requestCode != 1) return
        if (hasMediaPermission()) {
            loadGallery()
        } else {
            empty.text = "Flingo needs access to your photos to show them here.\n\nTap to allow."
            empty.visibility = View.VISIBLE
            empty.setOnClickListener { requestMediaPermission() }
            empty.asButton(18f)
        }
    }

    private fun loadGallery() {
        scope.launch {
            val items = withContext(Dispatchers.IO) { Gallery.load(this@MainActivity) }
            adapter.submit(items)
            // Plain words now, not a button: there is nothing to tap.
            empty.setOnClickListener(null)
            empty.isClickable = false
            empty.isFocusable = false
            empty.accessibilityDelegate = null
            empty.text = "No photos or videos on this phone yet."
            empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        }
    }

    // ---------- drag + flick ----------
    private fun rootOnScreen(): IntArray = IntArray(2).also { root.getLocationOnScreen(it) }

    /**
     * Sends a photo, and anything selected with it, the way a flick does: the first one
     * flies in on the PC. This is the flick for anyone who cannot make the gesture.
     */
    private fun sendNow(item: MediaItem) {
        val uris = listOf(item.uri) + adapter.selection().filter { it != item.uri }
        if (!prefs.paired) { pendingShare = uris; showPairDialog(); return }
        send(uris, 0.5f, animateFirst = true)
        adapter.clearSelection()
    }

    private fun startDrag(item: MediaItem, source: ImageView) {
        if (dragging) return
        // A hold with no finger on the glass comes from a screen reader, a switch or a keyboard.
        // There is nothing to drag with, and a drag begun this way could never be let go of.
        // So it means "send this one".
        if (!fingerDown) { sendNow(item); return }
        if (source.drawable == null) return // its picture has not loaded yet, so there is nothing to pick up
        val loc = IntArray(2).also { source.getLocationOnScreen(it) }
        val base = rootOnScreen()
        val view = ImageView(this).apply {
            setImageDrawable(source.drawable)
            scaleType = ImageView.ScaleType.CENTER_CROP
            elevation = dp(16f)
            clipToOutline = true
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
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
        if (motionOk) view.animate().scaleX(1.18f).scaleY(1.18f).setDuration(120).start()
        source.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)

        floating = view
        dragItem = item
        // With photos selected, a flick takes them all: the one under the finger first, so it is the one that flies.
        dragUris = listOf(item.uri) + adapter.selection().filter { it != item.uri }
        dragging = true
        wasInZone = false

        zone.layoutParams = zone.layoutParams.apply { height = root.height * prefs.zonePercent / 100 }
        setZoneActive(false)
        zone.visibility = View.VISIBLE
        if (motionOk) zone.animate().alpha(1f).setDuration(150).start() else zone.alpha = 1f

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
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> fingerDown = true
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> fingerDown = false
        }
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
                val inZone = fingerInZone()
                if (inZone != wasInZone) {
                    wasInZone = inZone
                    setZoneActive(inZone)
                    if (inZone) buzz(HapticFeedbackConstants.CLOCK_TICK) // a tick as the photo crosses into the send zone
                    say(if (inZone) "In the send zone. Let go to send." else "Out of the send zone. Let go to put it back.")
                }
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
        if (motionOk) zone.animate().alpha(0f).setDuration(180).withEndAction { zone.visibility = View.GONE }.start()
        else { zone.alpha = 0f; zone.visibility = View.GONE }
        if (view == null || item == null) return

        tracker?.computeCurrentVelocity(1000)
        val vy = tracker?.yVelocity ?: 0f
        val flung = vy < -dp(1100f)
        val shouldSend = !cancelled && (fingerInZone() || flung)

        if (shouldSend && prefs.paired) {
            val x = ((lastX - rootOnScreen()[0]) / root.width).coerceIn(0f, 1f)
            if (motionOk) {
                view.animate().y(-view.height * 1.6f).scaleX(0.5f).scaleY(0.5f).alpha(0.4f)
                    .setDuration(220).withEndAction { root.removeView(view) }.start()
            } else {
                // Reduced motion: it fades where it was let go. Nothing flies off.
                view.animate().alpha(0f).setDuration(160).withEndAction { root.removeView(view) }.start()
            }
            send(dragUris, x, animateFirst = true)
            adapter.clearSelection()
        } else {
            if (motionOk) {
                view.animate().x(originX).y(originY).scaleX(1f).scaleY(1f)
                    .setDuration(200).withEndAction { root.removeView(view) }.start()
            } else {
                root.removeView(view)
            }
            if (shouldSend) showPairDialog()
        }
    }

    // ---------- sending ----------
    /**
     * Hands files to the queue, which sends them even if this screen goes away. A flick sets
     * [animateFirst], so its photo flies in on the PC; everything else arrives quietly.
     */
    private fun send(uris: List<Uri>, x: Float, animateFirst: Boolean) {
        if (uris.isEmpty()) return
        if (uris.size > 3) askForNotifications()
        if (Transfers.busy) showStatus("Added to the queue.", holdMs = 1500)
        else showStatus(if (uris.size > 1) "Getting ${uris.size} files ready…" else "Sending…", sticky = true, progress = 0)
        // A PC already known to be out of reach is not searched for, so the answer comes back fast.
        Transfers.enqueue(this, SendJob(uris, x, animateFirst, search = online != false))
    }

    // ---------- receiving from the PC ----------
    private fun showReceive(s: SendState) {
        cancelAction = { Inbox.cancel() }
        showStatus(Words.progress(s, lines = if (s.long) 2 else 1), sticky = true, progress = Words.fraction(s) ?: -1, cancelable = s.long)
        speakProgress(s)
        if (s.long) askForNotifications()
    }

    /** The start, each quarter, a lost connection and the final check are said aloud; the steps in between are not. */
    private fun speakProgress(s: SendState) {
        voice.step(Words.title(s), Words.fraction(s), s.waiting, s.checking, SystemClock.elapsedRealtime())?.let(::say)
    }

    /** The mirror of the flick: the photo that just arrived drops in from the top of the screen. */
    private fun dropIn(file: Arrived) {
        if (!file.mime.startsWith("image/") && !file.mime.startsWith("video/")) return
        // One at a time: fifty photos arriving in a few seconds should not be fifty pictures in the air.
        if (dropping) return
        dropping = true
        scope.launch {
            val size = dpi(190f)
            val picture = withContext(Dispatchers.IO) {
                runCatching { contentResolver.loadThumbnail(file.uri, android.util.Size(size, size), null) }.getOrNull()
            }
            if (picture == null) { dropping = false; return@launch }
            val calm = !motionOk
            val rest = root.height * 0.3f
            val view = ImageView(this@MainActivity).apply {
                setImageBitmap(picture)
                scaleType = ImageView.ScaleType.CENTER_CROP
                elevation = dp(14f)
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(v: View, o: Outline) = o.setRoundRect(0, 0, v.width, v.height, dp(18f))
                }
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                if (calm) { translationY = rest; alpha = 0f } else { translationY = -size * 1.2f; rotation = -9f }
            }
            root.addView(view, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
            if (calm) {
                // Reduced motion: the picture fades in where it would have come to rest, stays, and
                // fades out. Nothing falls, turns or bounces. The wait is kept by the clock, because
                // with animations switched off in Android an animated wait is no wait at all.
                view.animate().alpha(1f).setDuration(220).start()
                view.postDelayed({
                    view.animate().alpha(0f).setDuration(220).withEndAction { root.removeView(view); dropping = false }.start()
                }, 1400)
                return@launch
            }
            view.animate().translationY(rest).rotation(0f).setDuration(520)
                .setInterpolator(android.view.animation.OvershootInterpolator(1.1f))
                .withEndAction {
                    view.animate().setStartDelay(700).alpha(0f).scaleX(0.3f).scaleY(0.3f).translationY(rest + dp(90f)).setDuration(260)
                        .withEndAction { root.removeView(view); dropping = false }.start()
                }.start()
        }
    }

    private fun showReceived(result: ReceiveResult) {
        voice.reset()
        val pc = prefs.pcName.ifEmpty { "your PC" }
        when (result) {
            is ReceiveResult.Done -> {
                if (result.arrived > 0) { buzz(hapticYes); loadGallery() }
                val where = if (result.last?.mime?.let { it.startsWith("image/") || it.startsWith("video/") } == true) "Pictures/Flingo" else "Download/Flingo"
                val text = when {
                    result.arrived == 0 -> "Nothing arrived: it was taken back or changed on $pc."
                    result.arrived == 1 -> "Received ${result.last?.name ?: "1 file"} ✓\nSaved in $where"
                    else -> "Received ${Words.files(result.arrived)} from $pc ✓"
                } + if (result.failed > 0 && result.arrived > 0) "\n${Words.files(result.failed)} did not arrive." else ""
                showStatus(text, holdMs = 4500)
            }
            is ReceiveResult.Cancelled -> showStatus("Cancelled.")
            is ReceiveResult.Lost -> showStatus("Lost the connection to $pc.\nWhat arrived is kept; it carries on when the PC is back.", holdMs = 6000)
            is ReceiveResult.NoSpace -> { buzz(hapticNo); showStatus("Not enough space on this phone for that file.", holdMs = 6000) }
        }
    }

    private fun showSend(s: SendState) {
        cancelAction = { Transfers.cancel(this) }
        showStatus(Words.progress(s, lines = if (s.long) 2 else 1), sticky = true, progress = Words.fraction(s) ?: -1, cancelable = s.long)
        speakProgress(s)
    }

    private fun showResult(r: SendResult) {
        voice.reset()
        val pc = prefs.pcName
        when (r) {
            is SendResult.Done -> {
                online = true
                updateChip()
                buzz(hapticYes)
                when {
                    r.skipped > 0 -> showStatus("Sent ${r.sent} to $pc. ${Words.files(r.skipped)} could not be opened on this phone.", holdMs = 6000)
                    r.sent > 1 -> showStatus("Sent ${r.sent} files to $pc ✓")
                    else -> showStatus("Sent to $pc ✓")
                }
            }
            is SendResult.Cancelled ->
                showStatus(if (r.sent > 0) "Stopped. ${r.sent} of ${r.of} were sent." else "Cancelled.", holdMs = 3500)
            is SendResult.Failed -> {
                buzz(hapticNo)
                val already = if (r.sent > 0) "${r.sent} of ${r.of} sent, the rest did not go. " else ""
                when (r.why) {
                    SendResult.Why.NOT_PAIRED ->
                        forgetPc("$pc no longer recognises this phone. Tap Pair with PC to pair again.")
                    SendResult.Why.REFUSED ->
                        showStatus(already + r.message.ifEmpty { "The PC could not take the file." }, holdMs = 6000)
                    SendResult.Why.UNREADABLE ->
                        showStatus("That file can't be opened on this phone. Try another one.", holdMs = 5000)
                    SendResult.Why.UNREACHABLE -> {
                        online = false
                        updateChip()
                        showStatus("${already}Can't reach $pc. Tap its name at the top to reconnect.", holdMs = 7000)
                    }
                }
            }
        }
    }

    /** A long transfer shows its progress in a notification, which Android 13 and later only allow after asking. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33 || prefs.askedNotifications) return
        prefs.askedNotifications = true
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
        }
    }

    // ---------- selecting several ----------
    private fun updateSelectBar(count: Int) {
        selectBar.visibility = if (count > 0) View.VISIBLE else View.GONE
        selectCount.text = if (bigText) "$count selected" else "$count selected  ▾" // the arrow alone on a second line helps nobody
        selectCount.contentDescription = "$count selected"
        sendButton.contentDescription = when {
            !prefs.paired -> "Send $count. You will be asked to pair with your PC first."
            count == 1 -> "Send to ${prefs.pcName}"
            else -> "Send $count to ${prefs.pcName}"
        }
        // Keep the status pill clear of the bar, now and once the bar has been measured.
        placeStatus()
        selectBar.post { placeStatus() }
    }

    /**
     * The Send button: the way to send without the flick. One photo is sent as a flick would
     * send it, so it flies in on the PC. Several arrive quietly, as a batch.
     */
    private fun sendSelection() {
        val uris = adapter.selection()
        if (uris.isEmpty()) return
        if (!prefs.paired) { pendingShare = uris; showPairDialog(); return }
        send(uris, 0.5f, animateFirst = uris.size == 1)
        adapter.clearSelection()
    }

    /** Selecting two hundred photos one tap at a time is nobody's idea of smooth. */
    private fun showSelectMenu() {
        val day = 24 * 60 * 60L
        val now = System.currentTimeMillis() / 1000
        val spans = listOf("Today" to day, "The last 7 days" to 7 * day, "The last 30 days" to 30 * day, "Everything" to Long.MAX_VALUE)
        val counts = spans.map { (_, span) -> adapter.count { span == Long.MAX_VALUE || now - it.date < span } }
        AlertDialog.Builder(this)
            .setTitle("Select")
            .setItems(spans.mapIndexed { i, (label, _) -> "$label  (${counts[i]})" }.toTypedArray()) { _, i ->
                val span = spans[i].second
                adapter.select { span == Long.MAX_VALUE || now - it.date < span }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------- any file ----------
    private fun pickFiles() {
        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        @Suppress("DEPRECATION")
        runCatching { startActivityForResult(pick, PICK_FILES) }
            .onFailure { showStatus("This phone has no file picker. Share the file to Flingo from another app instead.", holdMs = 5000) }
    }

    private fun pickedFiles(data: Intent?): List<Uri> {
        val clip = data?.clipData
        if (clip != null) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        return listOfNotNull(data?.data)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        if (intent.action == Intent.ACTION_VIEW) {
            val data = intent.data
            intent.action = Intent.ACTION_MAIN // don't act on it again after rotation
            if (data != null) handleLink(data, scannedHere = false)
            return
        }
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent)
            else -> return
        }
        intent.action = Intent.ACTION_MAIN // don't resend on rotation
        if (uris.isEmpty()) return
        if (prefs.paired) {
            send(uris, 0.5f, animateFirst = uris.size == 1)
        } else {
            pendingShare = uris
            showPairDialog()
        }
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

    // ---------- pairing ----------
    // ---------- sheets ----------
    // The pairing choice and the About screen are drawn in Flingo's own look, not the system's.

    /** A rounded dark panel in the middle of the screen. [fill] adds its contents. [title] is what a screen reader says as it opens. */
    private fun sheet(title: String, fill: LinearLayout.(Dialog) -> Unit): Dialog {
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setTitle(title) // not drawn, but it names the window for a screen reader
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = pill(Palette.PANEL, 26f).apply { setStroke(dpi(1f), Palette.LINE) }
            setPadding(dpi(20f), dpi(22f), dpi(20f), dpi(10f))
        }
        panel.fill(dialog)
        // Scrolls on a small screen or with large text, instead of cutting the last choice off.
        dialog.setContentView(ScrollView(this).apply { addView(panel) })
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(minOf(resources.displayMetrics.widthPixels - dpi(32f), dpi(440f)), WRAP_CONTENT)
        }
        dialog.show()
        return dialog
    }

    private fun sheetTitle(words: String) = TextView(this).apply {
        text = words
        textSize = 21f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.WHITE)
        isAccessibilityHeading = true
    }

    private fun sheetNote(words: String) = TextView(this).apply {
        text = words
        textSize = 14f
        setTextColor(Palette.MUTED)
        setPadding(0, dpi(4f), 0, dpi(16f))
    }

    private fun sheetClose(dialog: Dialog, label: String) = TextView(this).apply {
        text = label
        textSize = 15f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(accent)
        gravity = Gravity.CENTER
        minHeight = dpi(48f)
        minWidth = dpi(48f)
        setPadding(dpi(18f), 0, dpi(10f), 0)
        setOnClickListener { dialog.dismiss() }
    }.asButton(12f)

    /**
     * A rounded surface that shows a ripple when pressed. It always has an outline: the surface
     * is barely lighter than the sheet behind it, and without one only the words showed it was a button.
     */
    private fun pressable(color: Int, radius: Float, outline: Boolean) = RippleDrawable(
        ColorStateList.valueOf(Color.parseColor("#33FFFFFF")),
        pill(color, radius).apply { if (outline) setStroke(dpi(1.5f), accent) else setStroke(dpi(1f), Palette.EDGE) },
        pill(Color.WHITE, radius),
    )

    /** One way to do something: a round badge, a title, and a line that says when to pick it. */
    private fun choice(badge: String, title: String, detail: String, recommended: Boolean, onPick: () -> Unit): View {
        val words = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // With large text the marker goes under the title instead of being pushed off the row.
            val heading = LinearLayout(this@MainActivity).apply {
                orientation = if (bigText) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
                gravity = if (bigText) Gravity.START else Gravity.CENTER_VERTICAL
                addView(TextView(this@MainActivity).apply {
                    text = title
                    textSize = 16f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                })
                if (recommended) addView(TextView(this@MainActivity).apply {
                    text = "BEST"
                    textSize = 10f
                    letterSpacing = 0.08f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Palette.ON_ACCENT)
                    background = pill(good, 8f)
                    setPadding(dpi(7f), dpi(2f), dpi(7f), dpi(2f))
                }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { if (bigText) topMargin = dpi(4f) else leftMargin = dpi(8f) })
            }
            addView(heading)
            addView(TextView(this@MainActivity).apply {
                text = detail
                textSize = 13f
                setTextColor(Palette.DETAIL)
                setPadding(0, dpi(3f), 0, 0)
            })
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pressable(Color.parseColor(if (recommended) "#222A48" else "#1F2330"), 18f, outline = recommended)
            setPadding(dpi(14f), dpi(14f), dpi(12f), dpi(14f))
            isClickable = true
            isFocusable = true
            // One item for a screen reader, and "Recommended" is not left to a coloured marker.
            contentDescription = (if (recommended) "Recommended. " else "") + "$title. $detail"
            addView(TextView(this@MainActivity).apply {
                text = badge
                glyph(12f)
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(if (recommended) Palette.ON_ACCENT else Palette.SOFT)
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(if (recommended) accent else Palette.LINE)
                }
            }, LinearLayout.LayoutParams(dpi(46f), dpi(46f)))
            addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = dpi(14f) })
            addView(TextView(this@MainActivity).apply {
                text = "›"
                textSize = 24f
                setTextColor(Palette.EDGE)
                setPadding(dpi(8f), 0, 0, dpi(4f))
            })
            setOnClickListener { onPick() }
        }.asButton(18f)
    }

    private fun showPairDialog() {
        sheet("Pair with your PC") { dialog ->
            fun then(action: () -> Unit): () -> Unit = { dialog.dismiss(); action() }
            val gap = { LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dpi(10f) } }
            addView(sheetTitle("Pair with your PC"))
            addView(sheetNote("Open Flingo on the PC first. You only do this once."))
            addView(choice("QR", "Scan the QR code", "Fastest. Works on any Wi-Fi, even one that hides devices from each other.", recommended = true, onPick = then(::scanQr)))
            addView(choice("Wi-Fi", "Find my PC", "Looks for Flingo on the Wi-Fi this phone is on.", recommended = false, onPick = then(::searchForPc)), gap())
            addView(choice("123", "Type it in", "Enter the PC's address and its 6-digit code by hand.", recommended = false, onPick = then { showManualDialog() }), gap())
            addView(sheetClose(dialog, "Cancel"), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.END; topMargin = dpi(6f) })
        }
    }

    // ---------- about ----------
    private fun openLink(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .onFailure { showStatus("This phone has no browser to open that link.", holdMs = 4000) }
    }

    private fun linkButton(label: String, url: String) = TextView(this).apply {
        text = label
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(Color.WHITE)
        gravity = Gravity.CENTER
        minHeight = dpi(48f)
        background = pressable(Palette.PANEL_2, 16f, outline = false)
        contentDescription = "$label. Opens in the browser."
        setOnClickListener { openLink(url) }
    }.asButton(16f)

    private fun linkRow(first: View, second: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(first, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        addView(second, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = dpi(10f) })
    }

    /** What Flingo is, who made it, and where to find both. */
    private fun showAbout() {
        sheet("About Flingo") { dialog ->
            fun centred(words: String, size: Float, color: Int, bold: Boolean = false) = TextView(this@MainActivity).apply {
                text = words
                textSize = size
                setTextColor(color)
                gravity = Gravity.CENTER
                if (bold) setTypeface(typeface, Typeface.BOLD)
            }
            fun below(dp: Float) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dpi(dp) }
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.mipmap.ic_launcher)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO // the name is right below it
            }, LinearLayout.LayoutParams(dpi(76f), dpi(76f)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(centred("Flingo", 24f, Color.WHITE, bold = true).apply { isAccessibilityHeading = true }, below(10f))
            addView(centred("Version ${BuildConfig.VERSION_NAME}", 13f, Palette.MUTED), below(2f))
            addView(centred(About.PITCH, 15f, Palette.SOFT), below(12f))

            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                background = pill(Palette.PANEL_BEST, 18f).apply { setStroke(dpi(1.5f), accent) }
                setPadding(dpi(18f), dpi(16f), dpi(18f), dpi(16f))
                addView(TextView(this@MainActivity).apply {
                    text = "MADE BY"
                    textSize = 11f
                    letterSpacing = 0.12f
                    setTextColor(Palette.MUTED)
                })
                addView(TextView(this@MainActivity).apply {
                    text = About.MAKER
                    textSize = 22f
                    setTypeface(typeface, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    setPadding(0, dpi(2f), 0, dpi(6f))
                })
                addView(TextView(this@MainActivity).apply {
                    text = About.TAGLINE
                    textSize = 14f
                    setTextColor(Palette.SOFT)
                })
            }, below(18f))

            addView(linkRow(linkButton("Website", About.WEBSITE), linkButton("GitHub", About.GITHUB)), below(12f))
            addView(linkRow(linkButton("LinkedIn", About.LINKEDIN), linkButton("Source code", About.SOURCE)), below(10f))
            addView(centred(About.PROMISE, 12f, Palette.MUTED), below(16f))
            addView(sheetClose(dialog, "Close"), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.END; topMargin = dpi(4f) })
        }
    }

    private fun scanQr() {
        IntentIntegrator(this)
            .setCaptureActivity(ScanActivity::class.java)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("Point at the QR code in Flingo on your PC")
            .setBeepEnabled(false)
            .setOrientationLocked(false) // the scanner turns with the phone, like the rest of Flingo
            .initiateScan()
    }

    @Deprecated("The scanner library still delivers its result this way.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK_FILES) {
            val uris = if (resultCode == RESULT_OK) pickedFiles(data) else emptyList()
            if (uris.isEmpty()) return
            if (prefs.paired) send(uris, 0.5f, animateFirst = false)
            else { pendingShare = uris; showPairDialog() }
            return
        }
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan == null) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val text = scan.contents ?: return // closed without scanning
        handleLink(Uri.parse(text), scannedHere = true)
    }

    /** A pairing link, from the in-app scanner or from another app such as the phone's camera. */
    private fun handleLink(uri: Uri, scannedHere: Boolean) {
        val link = Net.parseLink(uri)
        if (link == null) {
            showStatus("That isn't a Flingo pairing code. Scan the QR code shown in Flingo on your PC.", holdMs = 5000)
            return
        }
        if (scannedHere) {
            pairWith(link)
            return
        }
        // A link opened from outside the app could have been made by anyone, so ask first.
        AlertDialog.Builder(this)
            .setTitle("Pair with ${link.pc.name}?")
            .setMessage("Photos you flick will go to the computer at ${link.pc.host}. Only continue if you just scanned the code on your own PC.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair") { _, _ -> pairWith(link) }
            .show()
    }

    private fun deviceName(): String = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"

    private fun onPaired(p: Paired) {
        prefs.savePairing(p)
        online = true
        updateChip()
        startHealthChecks()
        buzz(hapticYes)
        showStatus("Paired with ${p.pc.name} ✓")
        Inbox.start(this)
        if (pendingShare.isNotEmpty()) {
            val uris = pendingShare
            pendingShare = emptyList()
            send(uris, 0.5f, animateFirst = uris.size == 1)
            adapter.clearSelection()
        }
    }

    /** Pairs from a link that was opened from outside the app. (A code read by Flingo's own scanner is paired there.) */
    private fun pairWith(link: PairLink) {
        showStatus("Pairing with ${link.pc.name}…", sticky = true)
        scope.launch {
            when (val outcome = withContext(Dispatchers.IO) { Pairing.byLink(link, deviceName(), prefs.deviceId) }) {
                is PairOutcome.Done -> onPaired(outcome.paired)
                is PairOutcome.Problem -> { buzz(hapticNo); showStatus(outcome.text, holdMs = 7000) }
            }
        }
    }

    private fun searchForPc() {
        val searching = AlertDialog.Builder(this)
            .setTitle("Looking for your PC…")
            .setMessage("Open Flingo on your PC. Both devices need to be on the same Wi-Fi.")
            .setNegativeButton("Cancel", null)
            .show()
        scope.launch {
            val pcs = withContext(Dispatchers.IO) { runCatching { Net.discover() }.getOrDefault(emptyList()) }
            if (!searching.isShowing) return@launch
            searching.dismiss()
            val builder = AlertDialog.Builder(this@MainActivity).setNegativeButton("Cancel", null)
            if (pcs.isEmpty()) {
                builder.setTitle("No PC found")
                    .setMessage("Some Wi-Fi networks stop devices from finding each other. Scanning the QR code shown in Flingo on the PC works on any network.")
                    .setPositiveButton("Scan QR code") { _, _ -> scanQr() }
                    .setNeutralButton("Search again") { _, _ -> searchForPc() }
            } else {
                builder.setTitle("Choose your PC")
                    .setItems(pcs.map { it.name }.toTypedArray()) { _, i -> showCodeDialog(pcs[i]) }
            }
            builder.show()
        }
    }

    private fun field(hintText: String, numeric: Boolean) = EditText(this).apply {
        hint = hintText
        maxLines = 1
        minHeight = dpi(48f)
        minimumHeight = dpi(48f)
        if (numeric) {
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(InputFilter.LengthFilter(6))
            textSize = 24f
            letterSpacing = 0.3f
            gravity = Gravity.CENTER
        } else {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
    }

    /** The contents of a dialog, able to scroll: with large text they can be taller than the screen. */
    private fun box(vararg views: View): View = ScrollView(this).apply {
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpi(22f), dpi(8f), dpi(22f), 0)
            views.forEach { addView(it, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
        })
    }

    /** A field with its name above it. A hint alone is gone as soon as typing starts, and is no name to a screen reader. */
    private fun labelled(name: String, input: EditText): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        input.id = View.generateViewId()
        addView(TextView(this@MainActivity).apply {
            text = name
            textSize = 13f
            setTextColor(Palette.SOFT)
            labelFor = input.id
            setPadding(dpi(4f), dpi(10f), 0, 0)
        })
        addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }

    /** Address and code on one screen, for when the camera or discovery cannot be used. */
    private fun showManualDialog(presetHost: String = "") {
        val address = field("e.g. 192.168.1.20", numeric = false).apply { setText(presetHost) }
        val code = field("6 digits", numeric = true)
        val dialog = AlertDialog.Builder(this)
            .setTitle("Type the PC's details")
            .setMessage("Both are shown under Pair a phone in Flingo on the PC.")
            .setView(box(labelled("PC address", address), labelled("Pairing code", code)))
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair", null) // set below, so that a mistake does not close the dialog
            .show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val host = address.text.toString().trim().removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore(':')
            val digits = code.text.toString().trim()
            // What is wrong is said on the field it is wrong in, and what was typed is kept.
            if (host.isEmpty()) { address.error = "Enter the PC's address"; address.requestFocus(); return@setOnClickListener }
            if (digits.length != 6) { code.error = "Enter all 6 digits of the code"; code.requestFocus(); return@setOnClickListener }
            dialog.dismiss()
            showStatus("Connecting to $host…", sticky = true)
            scope.launch {
                val pc = withContext(Dispatchers.IO) { Net.info(host) }
                if (pc == null) {
                    buzz(hapticNo)
                    showStatus("No Flingo PC answered at $host. Check the address, and that both are on the same network.", holdMs = 7000)
                } else {
                    pairWithCode(pc, digits)
                }
            }
        }
        (if (presetHost.isEmpty()) address else code).requestFocus()
    }

    /** [problem] is shown on the field when the last code tried was wrong. */
    private fun showCodeDialog(pc: Pc, problem: String? = null) {
        val code = field("6 digits", numeric = true)
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pair with ${pc.name}")
            .setMessage("Type the 6-digit code shown in Flingo on the PC.")
            .setView(box(labelled("Pairing code", code)))
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair", null)
            .show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val digits = code.text.toString().trim()
            if (digits.length != 6) { code.error = "Enter all 6 digits of the code"; code.requestFocus(); return@setOnClickListener }
            dialog.dismiss()
            pairWithCode(pc, digits)
        }
        code.requestFocus()
        if (problem != null) code.error = problem
    }

    /** Pairs with a typed code. The PC's certificate is remembered from this first connection. */
    private fun pairWithCode(pc: Pc, code: String) {
        showStatus("Pairing with ${pc.name}…", sticky = true)
        scope.launch {
            try {
                val paired = withContext(Dispatchers.IO) { Net.pair(pc, code, deviceName(), prefs.deviceId) }
                onPaired(paired)
                showStatus("Paired with ${paired.pc.name} ✓  Security code ${Net.securityCode(paired.pc.fp)}", holdMs = 6000)
            } catch (_: WrongCodeException) {
                buzz(hapticNo)
                // Said on the field itself: a message under the dialog that reopens would not be seen.
                hideStatus()
                showCodeDialog(pc, "That code didn't match. Check the code on the PC and try again.")
            } catch (_: PairingLockedException) {
                buzz(hapticNo)
                showStatus("Pairing is locked on ${pc.name}. On the PC, press Pair a phone, then try again.", holdMs = 7000)
            } catch (e: PcRefusedException) {
                buzz(hapticNo)
                showStatus(e.message ?: "The PC did not accept the pairing.", holdMs = 6000)
            } catch (_: Exception) {
                buzz(hapticNo)
                showStatus("Couldn't reach ${pc.name}. Check that both are on the same network.", holdMs = 6000)
            }
        }
    }

    /** What the chip opens once paired: the connection's state, and the way back when it is lost. */
    private fun showPcDialog() {
        val name = prefs.pcName
        val builder = AlertDialog.Builder(this).setTitle(name)
        if (online == true) {
            builder.setMessage("Connected and encrypted.\n\nSecurity code ${Net.securityCode(prefs.fp)}\nAddress ${prefs.host}")
                .setPositiveButton("OK", null)
        } else {
            builder.setMessage("Can't reach $name right now.\n\n• Is Flingo open on the PC?\n• Are the phone and the PC on the same Wi-Fi or hotspot?\n\nIf the PC moved to another network, scan its QR code again.")
                .setPositiveButton("Try again") { _, _ ->
                    showStatus("Looking for $name…", sticky = true)
                    scope.launch {
                        if (checkConnection(relocate = true)) { buzz(hapticYes); showStatus("Connected to $name ✓") }
                        else { buzz(hapticNo); showStatus("Still can't reach $name.", holdMs = 4000) }
                    }
                }
        }
        builder.setNeutralButton("Scan QR code") { _, _ -> scanQr() }
            .setNegativeButton("Unpair") { _, _ ->
                prefs.clearPairing()
                online = null
                healthJob?.cancel()
                updateChip()
                showStatus("Unpaired.")
            }
            .show()
    }

    // ---------- settings ----------
    private fun showSettings() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpi(24f), dpi(12f), dpi(24f), 0)
        }
        val label = TextView(this).apply { textSize = 15f }
        val note = TextView(this).apply {
            text = "Let go of a photo inside this area at the top of the screen to send it. A quick upward flick sends from anywhere."
            textSize = 13f
            alpha = 0.7f
        }
        val bar = SeekBar(this).apply {
            id = View.generateViewId()
            min = 10
            max = 50
            progress = prefs.zonePercent
            setPadding(dpi(8f), dpi(16f), dpi(8f), dpi(16f))
            contentDescription = "Height of the send zone"
        }
        label.labelFor = bar.id
        fun refresh() {
            label.text = "Send zone: top ${bar.progress}% of the screen"
            // Otherwise a screen reader says how far along the slider is, which is a different number.
            if (Build.VERSION.SDK_INT >= 30) bar.stateDescription = "top ${bar.progress} percent of the screen"
        }
        bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) { prefs.zonePercent = p; refresh() }
            override fun onStartTrackingTouch(s: SeekBar) {}
            override fun onStopTrackingTouch(s: SeekBar) {}
        })
        refresh()
        val awake = CheckBox(this).apply {
            text = "Keep the screen on while Flingo is open"
            textSize = 15f
            minHeight = dpi(48f)
            isChecked = prefs.keepAwake
            setPadding(dpi(6f), dpi(14f), 0, dpi(6f))
            setOnCheckedChangeListener { _, on ->
                prefs.keepAwake = on
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        box.addView(label)
        box.addView(bar)
        box.addView(note)
        val updates = CheckBox(this).apply {
            text = "Check for updates"
            textSize = 15f
            minHeight = dpi(48f)
            isChecked = prefs.checkUpdates
            setPadding(dpi(6f), dpi(14f), 0, dpi(6f))
            setOnCheckedChangeListener { _, on -> prefs.checkUpdates = on }
        }
        val calm = CheckBox(this).apply {
            text = "Reduce motion"
            textSize = 15f
            minHeight = dpi(48f)
            isChecked = prefs.reduceMotion
            setPadding(dpi(6f), dpi(14f), 0, dpi(6f))
            setOnCheckedChangeListener { _, on -> prefs.reduceMotion = on }
        }
        val calmNote = TextView(this).apply {
            text = if (ValueAnimator.areAnimatorsEnabled()) "A photo that arrives fades in instead of dropping in, and a photo you send fades instead of flying off."
            else "Movement is already reduced, because animations are switched off in this phone's settings."
            textSize = 13f
            alpha = 0.7f
        }
        val checkNow = TextView(this).apply {
            text = "Check now"
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(accent)
            gravity = Gravity.CENTER
            minHeight = dpi(48f)
            minWidth = dpi(48f)
            setPadding(dpi(12f), 0, dpi(4f), 0)
        }.asButton(12f)
        // The button sits under the words, not beside them: beside, large text left the words a column a few letters wide.
        val versionRow = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = "Version ${BuildConfig.VERSION_NAME}. Flingo asks GitHub which version is the newest; nothing installs without a tap."
                textSize = 13f
                alpha = 0.7f
            })
            addView(checkNow, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.END })
        }
        box.addView(awake)
        box.addView(calm)
        box.addView(calmNote)
        box.addView(updates)
        val about = TextView(this).apply {
            text = "About Flingo  ›"
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(accent)
            gravity = Gravity.CENTER_VERTICAL
            minHeight = dpi(48f)
            setPadding(dpi(6f), dpi(6f), 0, 0)
            contentDescription = "About Flingo"
        }.asButton(12f)
        box.addView(versionRow)
        box.addView(about)

        // Able to scroll: with large text the list is taller than the screen, and a dialog does not scroll by itself.
        val dialog = AlertDialog.Builder(this).setTitle("Settings").setView(ScrollView(this).apply { addView(box) }).setPositiveButton("Done", null).show()
        about.setOnClickListener {
            dialog.dismiss()
            showAbout()
        }
        checkNow.setOnClickListener {
            dialog.dismiss()
            showStatus("Checking for updates…")
            checkForUpdate(manual = true)
        }
    }
}
