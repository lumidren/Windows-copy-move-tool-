package com.lumidren.flingo

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
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
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
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
    private val scope = MainScope()
    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var grid: RecyclerView
    private lateinit var adapter: GalleryAdapter
    private lateinit var chip: TextView
    private lateinit var zone: TextView
    private lateinit var status: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var statusBar: ProgressBar
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
    private var wasInZone = false
    private var tracker: VelocityTracker? = null
    private var statusJob: Job? = null
    private var healthJob: Job? = null
    private var pendingShare: List<Uri> = emptyList()

    /** Whether the paired PC answered the last time it was asked. Null until the first answer. */
    private var online: Boolean? = null
    private var sending = false

    private val accent = Color.parseColor("#6C8CFF")
    private val good = Color.parseColor("#4DE1A1")
    private val warn = Color.parseColor("#FFB84D")
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
        handleIntent(intent)
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
    }

    override fun onPause() {
        healthJob?.cancel()
        super.onPause()
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
            compoundDrawablePadding = dpi(8f)
            setOnClickListener { if (prefs.paired) showPcDialog() else showPairDialog() }
        }
        header.addView(chip)
        header.addView(TextView(this).apply {
            text = "⚙"
            textSize = 22f
            setTextColor(Color.parseColor("#C5CAD8"))
            gravity = Gravity.CENTER
            contentDescription = "Settings"
            setOnClickListener { showSettings() }
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
            // Keep the label at the top edge so the dragged photo and the finger don't cover it.
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
            alpha = 0f
            visibility = View.GONE
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
            progressBackgroundTintList = ColorStateList.valueOf(Color.parseColor("#3A4053"))
            visibility = View.GONE
        }
        status = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = pill(Color.parseColor("#F01F2330"), 22f)
            setPadding(dpi(18f), dpi(11f), dpi(18f), dpi(11f))
            elevation = dp(8f)
            visibility = View.GONE
            addView(statusText, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(statusBar, LinearLayout.LayoutParams(dpi(220f), dpi(4f)).apply { topMargin = dpi(8f); gravity = Gravity.CENTER_HORIZONTAL })
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
            insets
        }
        setContentView(root)
    }

    private fun dot(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
        setSize(dpi(9f), dpi(9f))
    }

    private fun updateChip() {
        if (!prefs.paired) {
            chip.text = "Pair with PC"
            chip.background = pill(accent, 20f)
            chip.setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, null, null)
            chip.contentDescription = "Pair with PC"
            return
        }
        chip.text = prefs.pcName
        chip.background = pill(Color.parseColor("#1F2330"), 20f)
        val color = when (online) { true -> good; false -> warn; null -> Color.parseColor("#6B7285") }
        chip.setCompoundDrawablesRelativeWithIntrinsicBounds(dot(color), null, null, null)
        chip.contentDescription = when (online) {
            true -> "${prefs.pcName}, connected"
            false -> "${prefs.pcName}, not reachable"
            null -> "${prefs.pcName}, checking"
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

    /** [progress] is 0..1000, or null for no bar. */
    private fun showStatus(text: String, sticky: Boolean = false, progress: Int? = null, holdMs: Long = 2600) {
        statusJob?.cancel()
        if (statusText.text != text) {
            statusText.text = text
            if (progress == null) status.announceForAccessibility(text)
        }
        statusBar.visibility = if (progress == null) View.GONE else View.VISIBLE
        if (progress != null) statusBar.progress = progress
        status.visibility = View.VISIBLE
        if (!sticky) statusJob = scope.launch {
            delay(holdMs)
            status.visibility = View.GONE
        }
    }

    private fun hideStatus() {
        statusJob?.cancel()
        status.visibility = View.GONE
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
                if (!sending) checkConnection(relocate = misses >= 2)
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
        wasInZone = false

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
                val inZone = fingerInZone()
                if (inZone != wasInZone) {
                    wasInZone = inZone
                    setZoneActive(inZone)
                    if (inZone) buzz(HapticFeedbackConstants.CLOCK_TICK) // a tick as the photo crosses into the send zone
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
    private fun size(bytes: Long): String = when {
        bytes < 1024 * 1024 -> "${maxOf(1, bytes / 1024)} KB"
        bytes < 1024L * 1024 * 1024 -> "%.1f MB".format(bytes / 1048576.0)
        else -> "%.2f GB".format(bytes / 1073741824.0)
    }

    private fun send(uris: List<Uri>, x: Float) {
        if (sending) {
            showStatus("Still sending the last one. Try again in a moment.")
            return
        }
        sending = true
        scope.launch {
            var sent = 0
            try {
                for (uri in uris) {
                    val prefix = if (uris.size > 1) "Sending ${sent + 1} of ${uris.size}" else "Sending"
                    showStatus("$prefix…", sticky = true, progress = 0)
                    var lastShown = 0L
                    val search = online != false // already known to be out of reach: answer fast
                    withContext(Dispatchers.IO) {
                        Net.send(this@MainActivity, prefs, uri, x, search) progress@{ done, total ->
                            val now = SystemClock.uptimeMillis()
                            if (now - lastShown < 60 && done != total) return@progress
                            lastShown = now
                            runOnUiThread {
                                if (total > 0) {
                                    val pct = (done * 100 / total).toInt()
                                    // Small files finish before a number is worth reading.
                                    val label = if (total > 3 * 1024 * 1024) "$prefix · $pct% of ${size(total)}" else "$prefix…"
                                    showStatus(label, sticky = true, progress = (done * 1000 / total).toInt())
                                } else {
                                    showStatus("$prefix · ${size(done)}", sticky = true)
                                }
                            }
                        }
                    }
                    sent++
                }
                online = true
                updateChip()
                buzz(hapticYes)
                showStatus(if (sent > 1) "Sent $sent files to ${prefs.pcName} ✓" else "Sent to ${prefs.pcName} ✓")
            } catch (_: NotPairedException) {
                buzz(hapticNo)
                forgetPc("${prefs.pcName} no longer recognises this phone. Tap Pair with PC to pair again.")
            } catch (e: PcRefusedException) {
                buzz(hapticNo)
                showStatus(e.message ?: "The PC could not take the file.", holdMs = 6000)
            } catch (_: UnreadableFileException) {
                buzz(hapticNo)
                showStatus("That file can't be opened on this phone. Try another one.", holdMs = 5000)
            } catch (_: Exception) {
                buzz(hapticNo)
                online = false
                updateChip()
                val already = if (sent > 0) "$sent sent, the rest did not go. " else ""
                showStatus("${already}Can't reach ${prefs.pcName}. Tap its name at the top to reconnect.", holdMs = 7000)
            } finally {
                sending = false
            }
        }
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
            send(uris, 0.5f)
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
    private fun showPairDialog() {
        val choices = arrayOf(
            "Scan the QR code\nFastest. Works on any network.",
            "Find my PC on this Wi-Fi",
            "Type the PC's address and code",
        )
        AlertDialog.Builder(this)
            .setTitle("Pair with your PC")
            .setItems(choices) { _, i ->
                when (i) {
                    0 -> scanQr()
                    1 -> searchForPc()
                    else -> showManualDialog()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun scanQr() {
        IntentIntegrator(this)
            .setCaptureActivity(ScanActivity::class.java)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt("Point at the QR code in Flingo on your PC")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
            .initiateScan()
    }

    @Deprecated("The scanner library still delivers its result this way.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
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
        if (pendingShare.isNotEmpty()) {
            val uris = pendingShare
            pendingShare = emptyList()
            send(uris, 0.5f)
        }
    }

    /** Pairs from a QR code: tries each address in it, pinned to the certificate in it. */
    private fun pairWith(link: PairLink) {
        showStatus("Pairing with ${link.pc.name}…", sticky = true)
        scope.launch {
            var problem = "Can't reach ${link.pc.name}. Put the phone and the PC on the same Wi-Fi or hotspot, then scan again."
            val paired = withContext(Dispatchers.IO) {
                for (host in link.pc.hosts) {
                    try {
                        return@withContext Net.pair(link.pc.copy(host = host), link.code, deviceName(), prefs.deviceId)
                    } catch (_: WrongCodeException) {
                        problem = "That QR code has already been used. The PC is showing a new one: scan it again."
                        break
                    } catch (_: PairingLockedException) {
                        problem = "Pairing is locked on ${link.pc.name}. On the PC, press Pair a phone, then scan again."
                        break
                    } catch (e: PcRefusedException) {
                        problem = e.message ?: problem
                        break
                    } catch (_: WrongPcException) {
                        problem = "A different computer answered at that address. Scan the code on your own PC again."
                    } catch (_: IOException) {
                        // not reachable at this address; try the next one
                    }
                }
                null
            }
            if (paired != null) onPaired(paired)
            else { buzz(hapticNo); showStatus(problem, holdMs = 7000) }
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

    private fun box(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dpi(22f), dpi(8f), dpi(22f), 0)
        views.forEach { addView(it, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
    }

    /** Address and code on one screen, for when the camera or discovery cannot be used. */
    private fun showManualDialog(presetHost: String = "") {
        val address = field("PC address, e.g. 192.168.1.20", numeric = false).apply { setText(presetHost) }
        val code = field("000000", numeric = true)
        AlertDialog.Builder(this)
            .setTitle("Type the PC's details")
            .setMessage("Both are shown under Pair a phone in Flingo on the PC.")
            .setView(box(address, code))
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair") { _, _ ->
                val host = address.text.toString().trim().removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore(':')
                val digits = code.text.toString().trim()
                if (host.isEmpty() || digits.length != 6) {
                    showStatus("Enter the PC's address and the 6-digit code.", holdMs = 4000)
                    showManualDialog(host)
                    return@setPositiveButton
                }
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
            .show()
        (if (presetHost.isEmpty()) address else code).requestFocus()
    }

    private fun showCodeDialog(pc: Pc) {
        val code = field("000000", numeric = true)
        AlertDialog.Builder(this)
            .setTitle("Pair with ${pc.name}")
            .setMessage("Type the 6-digit code shown in Flingo on the PC.")
            .setView(box(code))
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair") { _, _ -> pairWithCode(pc, code.text.toString().trim()) }
            .show()
        code.requestFocus()
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
            min = 10
            max = 50
            progress = prefs.zonePercent
            setPadding(dpi(8f), dpi(16f), dpi(8f), dpi(16f))
        }
        fun refresh() { label.text = "Send zone: top ${bar.progress}% of the screen" }
        bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) { prefs.zonePercent = p; refresh() }
            override fun onStartTrackingTouch(s: SeekBar) {}
            override fun onStopTrackingTouch(s: SeekBar) {}
        })
        refresh()
        val awake = CheckBox(this).apply {
            text = "Keep the screen on while Flingo is open"
            textSize = 15f
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
        box.addView(awake)

        AlertDialog.Builder(this).setTitle("Settings").setView(box).setPositiveButton("Done", null).show()
    }
}
