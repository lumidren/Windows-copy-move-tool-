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
