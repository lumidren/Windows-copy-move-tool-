package com.lumidren.flingo

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.LruCache
import android.util.Size
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.util.concurrent.Executors

data class MediaItem(val id: Long, val uri: Uri, val isVideo: Boolean, val date: Long)

object Gallery {
    /** Newest photos and videos first. Blocking; call off the main thread. */
    fun load(ctx: Context, limit: Int = 3000): List<MediaItem> {
        val items = ArrayList<MediaItem>()
        fun query(base: Uri, isVideo: Boolean) {
            val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED)
            runCatching {
                ctx.contentResolver.query(base, cols, null, null, "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use { c ->
                    var n = 0
                    while (c.moveToNext() && n++ < limit) {
                        val id = c.getLong(0)
                        items.add(MediaItem(id, ContentUris.withAppendedId(base, id), isVideo, c.getLong(1)))
                    }
                }
            }
        }
        query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, false)
        items.sortByDescending { it.date }
        return if (items.size > limit) items.subList(0, limit) else items
    }
}

