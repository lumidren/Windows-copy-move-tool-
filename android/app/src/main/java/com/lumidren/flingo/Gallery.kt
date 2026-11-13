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
        query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
        items.sortByDescending { it.date }
        return if (items.size > limit) items.subList(0, limit) else items
    }
}

private class SquareFrame(ctx: Context) : FrameLayout(ctx) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = super.onMeasure(widthSpec, widthSpec)
}

class GalleryAdapter(
    private val ctx: Context,
    private val onTap: () -> Unit,
    private val onPickUp: (MediaItem, ImageView) -> Unit,
) : RecyclerView.Adapter<GalleryAdapter.Holder>() {

    private var items: List<MediaItem> = emptyList()
    private val pool = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    private val selected = HashSet<Uri>()
    class Holder(view: View, val image: ImageView, val badge: TextView) : RecyclerView.ViewHolder(view) {
        var key: String? = null
    }

    fun submit(list: List<MediaItem>) {
        items = list
        notifyDataSetChanged()
    }

    override fun getItemCount() = items.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val d = ctx.resources.displayMetrics.density
        val frame = SquareFrame(ctx).apply {
            layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding((1.5f * d).toInt(), (1.5f * d).toInt(), (1.5f * d).toInt(), (1.5f * d).toInt())
        }
        val image = ImageView(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#171A23"))
        }
        frame.addView(image, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val badge = TextView(ctx).apply {
            text = "▶"
            setTextColor(Color.WHITE)
            textSize = 12f
            setShadowLayer(4f, 0f, 1f, Color.BLACK)
        }
        frame.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            marginEnd = (8 * d).toInt(); bottomMargin = (6 * d).toInt()
        })
        return Holder(frame, image, badge)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = items[position]
        val key = item.uri.toString()
        holder.key = key
        holder.badge.visibility = if (item.isVideo) View.VISIBLE else View.GONE
        holder.image.contentDescription = if (item.isVideo) "Video" else "Photo"
        holder.itemView.setOnClickListener { onTap() }
        holder.itemView.setOnLongClickListener {
            if (holder.image.drawable != null) onPickUp(item, holder.image)
            true
        }
        val cached = cache.get(key)
        if (cached != null) {
            holder.image.setImageBitmap(cached)
            return
        }
        holder.image.setImageDrawable(null)
        pool.execute {
            val bmp = runCatching { ctx.contentResolver.loadThumbnail(item.uri, Size(320, 320), null) }.getOrNull() ?: return@execute
            cache.put(key, bmp)
            main.post { if (holder.key == key) holder.image.setImageBitmap(bmp) }
        }
    }

    fun shutdown() = pool.shutdownNow()
}
