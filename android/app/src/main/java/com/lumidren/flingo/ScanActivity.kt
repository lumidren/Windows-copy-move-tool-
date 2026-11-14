package com.lumidren.flingo

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.journeyapps.barcodescanner.Size
import com.journeyapps.barcodescanner.camera.CameraSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The QR scanner, and everything that happens between seeing the code and being paired.
 *
 * It used to be the scanner library's own screen: a red line, no word of what to point at,
 * and it closed the instant it read something, leaving the person to wonder whether it had
 * worked. This one says what to do, says "Scanned" the moment it reads the code, pairs while
 * it is still on screen, and says "Paired". If the code cannot be used it says why and keeps
 * looking, so scanning the PC's new code needs no extra tap.
 *
 * It is also quicker to read a code: the camera focuses continuously instead of every two
 * seconds, and only QR codes are looked for, in the square where the code is expected.
 */
class ScanActivity : Activity() {
    companion object {
        /** In the result when the person chose to type the code instead. */
        const val TYPE_IT = "typeIt"
        /** For automated tests only (see BuildConfig.TEST_HOOKS): text to treat as a code just read. */
        const val SIMULATE = "simulate"
        private const val ASK_CAMERA = 3
    }

    private enum class Look { SEARCHING, SCANNED, PAIRED, PROBLEM }

    private val scope = MainScope()
    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var camera: BarcodeView
    private lateinit var frame: Frame
    private lateinit var headline: TextView
    private lateinit var detail: TextView
    private lateinit var torchButton: TextView
    private lateinit var allowButton: TextView
    private var busy = false // a code has been read and is being used
    private var torch = false
    private var cameraOn = false
    private var rejected = ""
    private var rejectedAt = 0L

    private fun dpi(v: Float) = (v * resources.displayMetrics.density).toInt()
    private fun pill(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radius * resources.displayMetrics.density }
    private fun say(text: String) { root.announceForAccessibility(Speech.plain(text)) }

    /** The square the code goes in. Everything outside it is dimmed; its outline changes colour with what is happening. */
    private class Frame(ctx: Context) : View(ctx) {
        var color = Color.WHITE
            set(value) { field = value; invalidate() }
        private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
        private val hole = Path()
        private val box = RectF()

        /** The side of the square in pixels, for a view of this size. */
        fun side(w: Int = width, h: Int = height): Float = minOf(w, h) * 0.68f

        override fun onDraw(canvas: Canvas) {
            val d = resources.displayMetrics.density
            val s = side()
            box.set((width - s) / 2, (height - s) / 2, (width + s) / 2, (height + s) / 2)
            hole.reset()
            hole.addRoundRect(box, 26 * d, 26 * d, Path.Direction.CW)
            canvas.save()
            canvas.clipOutPath(hole)
            canvas.drawColor(0xA6000000.toInt())
            canvas.restore()
            line.color = color
            line.strokeWidth = 4 * d
            canvas.drawRoundRect(box, 26 * d, 26 * d, line)
        }
    }

    // ---------- lifecycle ----------
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        buildUi()
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), ASK_CAMERA)

        if (BuildConfig.TEST_HOOKS) intent.getStringExtra(SIMULATE)?.let { text -> root.postDelayed({ read(text) }, 1500) }
    }

    override fun onResume() {
        super.onResume()
        if (cameraOn) camera.resume()
    }

    override fun onPause() {
        if (cameraOn) camera.pause()
        super.onPause()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != ASK_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startCamera()
            camera.resume()
        } else {
            noCamera()
        }
    }

    // ---------- the screen ----------
    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        camera = BarcodeView(this).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        root.addView(camera, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        frame = Frame(this).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        root.addView(frame, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        // Top: what this screen is for, and the way out.
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpi(8f), dpi(8f), dpi(18f), dpi(14f))
            // Dark behind the words, fading out, so they read over whatever the camera sees.
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xE6000000.toInt(), Color.TRANSPARENT))
        }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bar.addView(TextView(this).apply {
            text = "✕"
            glyph(20f)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            contentDescription = "Close the scanner"
            setOnClickListener { finish() }
        }.asButton(24f), LinearLayout.LayoutParams(dpi(48f), dpi(48f)))
        bar.addView(TextView(this).apply {
            text = "Scan the code on your PC"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            isAccessibilityHeading = true
            setPadding(dpi(6f), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        top.addView(bar)
        top.addView(TextView(this).apply {
            text = "Open Flingo on the PC. It shows a square code: hold the phone so the code is inside the frame."
            textSize = 14f
            setTextColor(Palette.SOFT)
            setPadding(dpi(12f), dpi(2f), 0, dpi(18f))
        })
        root.addView(top, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))

        // Bottom: what is happening right now, in large words, and the two other things one might want.
        headline = TextView(this).apply {
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        detail = TextView(this).apply {
            textSize = 14f
            setTextColor(Palette.SOFT)
            gravity = Gravity.CENTER
            setPadding(0, dpi(4f), 0, 0)
        }
        fun quiet(label: String) = TextView(this).apply {
            text = label
            textSize = 14f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            minHeight = dpi(48f)
            setPadding(dpi(18f), 0, dpi(18f), 0)
            background = pill(Palette.PANEL_2, 24f).apply { setStroke(dpi(1f), Palette.EDGE) }
        }.asButton(24f)
        torchButton = quiet("Light on").apply {
            // Only where the phone has a light to switch on.
            visibility = if (packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) View.VISIBLE else View.GONE
            setOnClickListener { setTorch(!torch) }
        }
        allowButton = quiet("Allow the camera").apply {
            visibility = View.GONE
            setOnClickListener { askForCameraAgain() }
        }
        val typeIt = quiet("Type it in instead").apply {
            setOnClickListener {
                setResult(RESULT_CANCELED, Intent().putExtra(TYPE_IT, true))
                finish()
            }
        }
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            val gap = { LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = dpi(5f); rightMargin = dpi(5f) } }
            addView(allowButton, gap())
            addView(torchButton, gap())
            addView(typeIt, gap())
        }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dpi(20f), dpi(26f), dpi(20f), dpi(20f))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xF2000000.toInt(), Color.TRANSPARENT))
            addView(headline)
            addView(detail)
            addView(buttons, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dpi(16f) })
        }
        root.addView(bottom, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        root.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            top.setPadding(dpi(8f), insets.systemWindowInsetTop + dpi(8f), dpi(18f), dpi(14f))
            @Suppress("DEPRECATION")
            bottom.setPadding(dpi(20f), dpi(26f), dpi(20f), insets.systemWindowInsetBottom + dpi(20f))
            insets
        }
        setContentView(root)
        show(Look.SEARCHING)
    }

    /** One place decides what the screen says, so the words, the colour, the buzz and the spoken line never disagree. */
    private fun show(look: Look, words: String = "", more: String = "") {
        when (look) {
            Look.SEARCHING -> {
                frame.color = Color.WHITE
                headline.text = "Looking for the code…"
                detail.text = more
            }
            Look.SCANNED -> {
                frame.color = Palette.GOOD
                headline.text = "✓  Scanned"
                detail.text = "Connecting to your PC…"
                root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                say("Scanned. Connecting to your PC.")
            }
            Look.PAIRED -> {
                frame.color = Palette.GOOD
                headline.text = "✓  Paired with $words"
                detail.text = "You can flick photos to it now."
                root.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
                say("Paired with $words.")
            }
            Look.PROBLEM -> {
                frame.color = Palette.WARN
                headline.text = "Not paired"
                detail.text = words
                root.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
                say("Not paired. $words")
            }
        }
    }

    // ---------- the camera ----------
    private fun startCamera() {
        if (cameraOn) return
        cameraOn = true
        allowButton.visibility = View.GONE
        // Only QR codes are looked for, which is quicker than trying every kind of barcode on each frame.
        camera.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        camera.cameraSettings = CameraSettings().apply {
            // Keep the picture sharp all the time, instead of refocusing every two seconds.
            isAutoFocusEnabled = true
            isContinuousFocusEnabled = true
            focusMode = CameraSettings.FocusMode.CONTINUOUS
            isMeteringEnabled = true
        }
        // Look only where the code is expected, a little beyond the frame that is drawn.
        camera.addOnLayoutChangeListener { _, l, t, r, b, _, _, _, _ ->
            val side = (frame.side(r - l, b - t) * 1.18f).toInt().coerceAtMost(minOf(r - l, b - t))
            if (side > 0 && camera.framingRectSize?.width != side) camera.framingRectSize = Size(side, side)
        }
        camera.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) { result.text?.let(::read) }
        })
    }

    private fun setTorch(on: Boolean) {
        if (!cameraOn) return
        torch = on
        runCatching { camera.setTorch(on) }
        torchButton.text = if (on) "Light off" else "Light on"
        say(if (on) "Light on" else "Light off")
    }

    /** The camera was refused. Say what that means and offer both ways forward. */
    private fun noCamera() {
        frame.color = Palette.WARN
        headline.text = "The camera is switched off for Flingo"
        detail.text = "Flingo uses it only to read the code on your PC. You can allow it, or type the code in."
        allowButton.visibility = View.VISIBLE
        torchButton.visibility = View.GONE
        say("${headline.text}. ${detail.text}")
    }

    private fun askForCameraAgain() {
        // After "Don't ask again" Android no longer shows its question, so the setting has to be changed by hand.
        if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), ASK_CAMERA)
        } else {
            runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            finish()
        }
    }

    // ---------- a code was read ----------
    private fun deviceName(): String = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"

    private fun read(text: String) {
        if (busy) return
        val link = Pairing.parse(text)
        if (link == null) {
            // Some other QR code. Say so once, and keep looking; the camera sees it many times a second.
            val now = SystemClock.elapsedRealtime()
            if (text == rejected && now - rejectedAt < 4000) return
            rejected = text
            rejectedAt = now
            show(Look.SEARCHING, more = "That is a different code. Flingo's is on the PC's screen, in the Flingo window.")
            say("That is a different code. Point at the one in Flingo on your PC.")
            return
        }
        busy = true
        if (cameraOn) camera.stopDecoding()
        show(Look.SCANNED)
        scope.launch {
            val started = SystemClock.elapsedRealtime()
            val outcome = withContext(Dispatchers.IO) { Pairing.byLink(link, deviceName(), prefs.deviceId) }
            // "Scanned" stays long enough to be read, even when pairing takes a tenth of a second.
            delay((350 - (SystemClock.elapsedRealtime() - started)).coerceAtLeast(0))
            when (outcome) {
                is PairOutcome.Done -> {
                    prefs.savePairing(outcome.paired)
                    show(Look.PAIRED, outcome.paired.pc.name)
                    delay(700)
                    setResult(RESULT_OK)
                    finish()
                }
                is PairOutcome.Problem -> {
                    show(Look.PROBLEM, outcome.text)
                    // Long enough to read, then look again by itself: for a used code the PC is already showing a new one.
                    delay(3200)
                    busy = false
                    show(Look.SEARCHING)
                    if (cameraOn) camera.decodeContinuous(object : BarcodeCallback {
                        override fun barcodeResult(result: BarcodeResult) { result.text?.let(::read) }
                    })
                }
            }
        }
    }
}
