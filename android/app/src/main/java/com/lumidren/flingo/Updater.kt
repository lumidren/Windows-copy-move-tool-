package com.lumidren.flingo

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** A newer release of Flingo, as GitHub describes it. */
data class Update(val version: String, val url: String, val size: Long, val sha256: String, val page: String) {
    fun toJson(): String = JSONObject()
        .put("version", version).put("url", url).put("size", size).put("sha256", sha256).put("page", page).toString()

    companion object {
        fun fromJson(text: String): Update? = runCatching {
            val o = JSONObject(text)
            Update(o.getString("version"), o.getString("url"), o.getLong("size"), o.getString("sha256"), o.getString("page"))
        }.getOrNull()
    }
}

/** What a downloaded update turned out to be, before Android is asked to install it. */
enum class Verdict { OK, NOT_FLINGO, NOT_NEWER, OTHER_KEY }

/** The download did not arrive whole, or is not the file the release described. */
class BadDownloadException(message: String) : IOException(message)

/**
 * Finds out whether a newer Flingo has been released, fetches it and hands it to Android to
 * install. The only thing it talks to is the public list of releases on GitHub; it sends
 * nothing about this phone or its files. All network and file calls block: run them off the
 * main thread. Nothing is installed without the person confirming it on Android's own screen.
 */
object Updater {
    private const val ASSET = "flingo.apk"
    private const val RELEASES = "https://github.com/lumidren/Windows-copy-move-tool-/releases/"
    const val LATEST_PAGE = RELEASES + "latest"
    private const val MAX_BYTES = 200L * 1024 * 1024 // far above any real APK; stops a runaway download
    const val CHECK_EVERY_MS = 12 * 60 * 60 * 1000L

    private val VERSION = Regex("""^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$""")
    private val DIGEST = Regex("""^sha256:([0-9a-f]{64})$""")

    /** "v1.2.3" or "1.2.3" -> [1, 2, 3]. Anything else (a beta, a typo) -> null. */
    fun parseVersion(text: String): List<Int>? =
        VERSION.find(text.trim())?.groupValues?.drop(1)?.map { it.toInt() }

    /** True when version [a] is newer than version [b]. Unreadable versions are never newer. */
    fun isNewer(a: String, b: String): Boolean {
        val x = parseVersion(a) ?: return false
        val y = parseVersion(b) ?: return false
        for (i in 0..2) if (x[i] != y[i]) return x[i] > y[i]
        return false
    }

    /**
     * Reads GitHub's description of a release. Null unless it is a finished release, newer than
     * [current], with an APK that comes from this project's downloads and has a known checksum.
     */
    fun readRelease(json: String, current: String, downloads: String = BuildConfig.UPDATE_DOWNLOADS): Update? {
        val release = runCatching { JSONObject(json) }.getOrNull() ?: return null
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null
        val version = parseVersion(release.optString("tag_name"))?.joinToString(".") ?: return null
        if (!isNewer(version, current)) return null
        val assets = release.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            if (a.optString("name") != ASSET) continue
            val sha = DIGEST.find(a.optString("digest"))?.groupValues?.get(1) ?: return null
            val url = a.optString("browser_download_url")
            val size = a.optLong("size", -1)
            if (!url.startsWith(downloads) || size <= 0 || size > MAX_BYTES) return null
            val page = release.optString("html_url").takeIf { it.startsWith(RELEASES) } ?: LATEST_PAGE
            return Update(version, url, size, sha, page)
        }
        return null
    }

    private fun open(url: String): HttpURLConnection =
        // Whatever network has internet: unlike transfers to the PC, this is not tied to Wi-Fi.
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 20_000
            setRequestProperty("User-Agent", "Flingo")
            setRequestProperty("Accept", "application/vnd.github+json")
        }

    /** Asks for the newest release. Null when this is it; throws when it cannot find out. */
    fun check(current: String = BuildConfig.VERSION_NAME): Update? {
        val conn = open(BuildConfig.UPDATE_FEED)
        try {
            val status = conn.responseCode
            if (status != 200) throw IOException("The release list answered $status")
            return readRelease(conn.inputStream.bufferedReader().use { it.readText() }, current)
        } finally {
            conn.disconnect()
        }
    }

    private fun dir(ctx: Context) = File(ctx.cacheDir, "updates")

    /** Deletes downloaded updates. They are only needed until Android has installed them. */
    fun clean(ctx: Context, keep: String = "") {
        dir(ctx).listFiles()?.forEach { if (it.name != keep) it.delete() }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Downloads [update] into the app's cache and checks it against the size and checksum the
     * release declared. A file that does not match is deleted and [BadDownloadException] thrown.
     */
    fun download(ctx: Context, update: Update, cancelled: () -> Boolean, onProgress: (Long, Long) -> Unit): File {
        val name = "flingo-${update.version}.apk"
        val file = File(dir(ctx).apply { mkdirs() }, name)
        clean(ctx, keep = name)
        // Already here from an earlier try: use it if it is intact.
        if (file.length() == update.size && sha256(file) == update.sha256) return file
        file.delete()

        val part = File(file.path + ".part")
        val conn = open(update.url)
        try {
            val status = conn.responseCode
            if (status != 200) throw IOException("The download answered $status")
            val md = MessageDigest.getInstance("SHA-256")
            var received = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelled()) throw SendCancelledException()
                        val n = input.read(buf)
                        if (n < 0) break
                        received += n
                        if (received > update.size) throw BadDownloadException("The download is larger than the release says")
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                        onProgress(received, update.size)
                    }
                }
            }
            if (received != update.size) throw IOException("The download stopped early")
            val sum = md.digest().joinToString("") { "%02x".format(it) }
            if (sum != update.sha256) throw BadDownloadException("The download does not match the release checksum")
            if (!part.renameTo(file)) throw IOException("Could not keep the download")
            return file
        } finally {
            conn.disconnect()
            part.delete()
        }
    }

    private fun signers(info: PackageInfo?): Set<String>? {
        val signing = info?.signingInfo ?: return null
        val certs = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        return certs?.map { c -> MessageDigest.getInstance("SHA-256").digest(c.toByteArray()).joinToString("") { "%02x".format(it) } }?.toSet()
    }

    /**
     * Looks at a downloaded APK the way Android will: is it Flingo, is it newer, and was it
     * signed with the same key as the copy on this phone? Android refuses an update signed
     * with another key, so saying so first saves a confusing error.
     */
    fun inspect(ctx: Context, file: File): Verdict {
        val pm = ctx.packageManager
        @Suppress("DEPRECATION")
        val theirs = pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return Verdict.NOT_FLINGO
        if (theirs.packageName != ctx.packageName) return Verdict.NOT_FLINGO
        @Suppress("DEPRECATION")
        val mine = pm.getPackageInfo(ctx.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        if (theirs.longVersionCode <= mine.longVersionCode) return Verdict.NOT_NEWER
        val a = signers(mine)
        val b = signers(theirs)
        // If Android will not say who signed one of them, leave the decision to its installer.
        if (a != null && b != null && a.intersect(b).isEmpty()) return Verdict.OTHER_KEY
        return Verdict.OK
    }

    /**
     * Hands the APK to Android's installer. Android then shows its own screen asking whether
     * to update; [UpdateReceiver] opens it and hears how it went.
     */
    fun install(ctx: Context, file: File) {
        val installer = ctx.packageManager.packageInstaller
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            setSize(file.length())
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite(ASSET, 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out, 256 * 1024) }
                session.fsync(out)
            }
            val status = PendingIntent.getBroadcast(
                ctx, id,
                Intent(ctx, UpdateReceiver::class.java).setAction(UpdateReceiver.ACTION_STATUS),
                // Android fills in the result, so it has to be allowed to change the intent.
                PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
            )
            session.commit(status.intentSender)
        }
    }

    // ---------- how the install went ----------
    /** Set by the screen while it is in front. */
    @Volatile var onFailure: ((String) -> Unit)? = null
    @Volatile private var missed: String? = null

    /** A failure that arrived while no screen was listening. */
    fun takeFailure(): String? = missed.also { missed = null }

    fun failed(status: Int) {
        val text = when (status) {
            PackageInstaller.STATUS_FAILURE_ABORTED -> "Update cancelled."
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                "Android refused the update: it does not match the Flingo on this phone."
            PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough free space to update."
            PackageInstaller.STATUS_FAILURE_BLOCKED -> "This phone does not allow Flingo to install updates."
            else -> "The update could not be installed."
        }
        val listener = onFailure
        if (listener != null) listener(text) else missed = text
    }
}
