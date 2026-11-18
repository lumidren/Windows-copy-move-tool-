package com.lumidren.flingo

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore

/** A file the PC sent to this phone, as the Received list shows it. [uri] is kept as text so this can be tested off the phone. */
data class ReceivedFile(val uri: String, val name: String, val size: Long, val mime: String, val addedMs: Long)

/**
 * What the PC has sent to this phone: the files in Pictures/Flingo and Download/Flingo,
 * newest first. Nothing is kept in a list of Flingo's own; the phone's shared storage is asked,
 * so a file that was deleted or moved elsewhere is simply no longer shown.
 */
object Received {
    const val LIMIT = 60

    /** The newest files Flingo has saved here. Blocking: call it off the main thread. */
    fun list(ctx: Context): List<ReceivedFile> {
        val resolver = ctx.contentResolver
        val volume = MediaStore.VOLUME_EXTERNAL_PRIMARY
        return newest(
            query(resolver, MediaStore.Images.Media.getContentUri(volume), "Pictures/Flingo/", "image/*") +
                query(resolver, MediaStore.Video.Media.getContentUri(volume), "Pictures/Flingo/", "video/*") +
                query(resolver, MediaStore.Downloads.getContentUri(volume), "Download/Flingo/", "application/octet-stream"),
        )
    }

    private fun query(resolver: ContentResolver, collection: Uri, folder: String, kind: String): List<ReceivedFile> {
        val columns = arrayOf(
            MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DATE_ADDED,
        )
        val found = ArrayList<ReceivedFile>()
        // A phone that refuses the question (no such collection, storage away) just has nothing to show.
        runCatching {
            resolver.query(
                collection, columns, "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?", arrayOf("$folder%"),
                "${MediaStore.MediaColumns.DATE_ADDED} DESC",
            )?.use { c ->
                while (c.moveToNext() && found.size < LIMIT) {
                    found += ReceivedFile(
                        uri = ContentUris.withAppendedId(collection, c.getLong(0)).toString(),
                        name = c.getString(1)?.takeIf { it.isNotBlank() } ?: "file",
                        size = c.getLong(2),
                        mime = c.getString(3)?.takeIf { it.isNotBlank() } ?: kind,
                        addedMs = c.getLong(4) * 1000,
                    )
                }
            }
        }
        return found
    }

    /** Newest first, each file once, no more than [limit]. */
    fun newest(files: List<ReceivedFile>, limit: Int = LIMIT): List<ReceivedFile> =
        files.distinctBy { it.uri }.sortedByDescending { it.addedMs }.take(limit)

    /** How long ago a file arrived, in a few words. */
    fun ago(addedMs: Long, nowMs: Long): String {
        val minutes = (nowMs - addedMs) / 60_000
        return when {
            minutes < 1 -> "Just now"
            minutes < 60 -> "$minutes min ago"
            minutes < 24 * 60 -> "${minutes / 60} h ago"
            minutes < 48 * 60 -> "Yesterday"
            minutes < 31 * 24 * 60 -> "${minutes / (24 * 60)} days ago"
            else -> "Over a month ago"
        }
    }

    /** The few letters shown in place of a picture for a file that has none: its extension. */
    fun badge(name: String): String =
        name.substringAfterLast('.', "").filter { it.isLetterOrDigit() }.take(4).uppercase().ifEmpty { "FILE" }

    /** True for an app package: a file Flingo never opens itself, because opening it starts an install. */
    fun installs(name: String, mime: String): Boolean =
        mime.equals("application/vnd.android.package-archive", ignoreCase = true) ||
            name.substringAfterLast('.', "").lowercase() in setOf("apk", "apks", "xapk", "apkm")

    /** What a row of the list says under the name, and what a screen reader says after it. */
    fun detail(file: ReceivedFile, nowMs: Long): String = "${Words.size(file.size)} · ${ago(file.addedMs, nowMs)}"
}
