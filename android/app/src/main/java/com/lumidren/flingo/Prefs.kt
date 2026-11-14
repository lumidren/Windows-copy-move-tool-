package com.lumidren.flingo

import android.content.Context
import java.util.UUID

/** Pairing details and user settings. */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("flingo", Context.MODE_PRIVATE)

    var host: String
        get() = sp.getString("host", "") ?: ""
        set(v) = sp.edit().putString("host", v).apply()
    var port: Int
        get() = sp.getInt("port", Net.HTTP_PORT)
        set(v) = sp.edit().putInt("port", v).apply()
    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) = sp.edit().putString("token", v).apply()
    var pcName: String
        get() = sp.getString("pcName", "") ?: ""
        set(v) = sp.edit().putString("pcName", v).apply()
    var pcId: String
        get() = sp.getString("pcId", "") ?: ""
        set(v) = sp.edit().putString("pcId", v).apply()

    /** Fingerprint of the paired PC's certificate. Every later connection must present this one. */
    val fp: String get() = sp.getString("fp", "") ?: ""

    /** Every address the paired PC was reachable at when it was paired. */
    val hosts: List<String> get() = (sp.getString("hosts", "") ?: "").split(',').filter { it.isNotEmpty() }

    /** Identifies this phone to a PC, so pairing again replaces the old entry instead of adding one. */
    val deviceId: String
        get() = sp.getString("deviceId", null) ?: UUID.randomUUID().toString().also { sp.edit().putString("deviceId", it).apply() }

    /** Height of the send zone as a percentage of the screen (10–50). */
    var zonePercent: Int
        get() = sp.getInt("zone", 25).coerceIn(10, 50)
        set(v) = sp.edit().putInt("zone", v.coerceIn(10, 50)).apply()

    /** Keep the phone's screen on while Flingo is open, so it is ready the moment it is needed. */
    var keepAwake: Boolean
        get() = sp.getBoolean("keepAwake", true)
        set(v) = sp.edit().putBoolean("keepAwake", v).apply()

    /** Whether the notification permission has been asked for once. It is never asked twice. */
    var askedNotifications: Boolean
        get() = sp.getBoolean("askedNotifications", false)
        set(v) = sp.edit().putBoolean("askedNotifications", v).apply()

    /** Ask GitHub now and then whether a newer Flingo exists. Nothing installs without a tap. */
    var checkUpdates: Boolean
        get() = sp.getBoolean("checkUpdates", true)
        set(v) = sp.edit().putBoolean("checkUpdates", v).apply()

    /** When the release list was last read (wall clock, milliseconds). */
    var updateCheckedAt: Long
        get() = sp.getLong("updateCheckedAt", 0)
        set(v) = sp.edit().putLong("updateCheckedAt", v).apply()

    /** The newer release found by the last check, or null. Kept so the offer survives closing the app. */
    var update: Update?
        get() = sp.getString("update", null)?.let(Update::fromJson)
        set(v) = sp.edit().putString("update", v?.toJson()).apply()

    /** The version the offer was closed on. It is not offered again until asked for. */
    var updateDismissed: String
        get() = sp.getString("updateDismissed", "") ?: ""
        set(v) = sp.edit().putString("updateDismissed", v).apply()

    // ---------- files on their way in from the PC ----------
    // Kept so a download carries on, and is not fetched twice, across a restart of the app.
    private fun ids(key: String): org.json.JSONObject =
        runCatching { org.json.JSONObject(sp.getString(key, "{}") ?: "{}") }.getOrDefault(org.json.JSONObject())

    private fun remember(key: String, id: String, uri: String?, keep: Int) {
        val all = ids(key)
        if (uri == null) all.remove(id) else all.put(id, uri)
        // Old entries make way for new ones; the PC forgets a file long before this list does.
        val names = all.keys().asSequence().toList()
        names.dropLast(keep).forEach { all.remove(it) }
        sp.edit().putString(key, all.toString()).apply()
    }

    /** Where the part of file [id] that has arrived so far is kept, if any. */
    fun inboxPart(id: String): String? = ids("inboxParts").optString(id).ifEmpty { null }
    fun setInboxPart(id: String, uri: String?) = remember("inboxParts", id, uri, 50)

    /** Where file [id] was saved, if it arrived whole. */
    fun inboxDone(id: String): String? = ids("inboxDone").optString(id).ifEmpty { null }
    fun setInboxDone(id: String, uri: String) = remember("inboxDone", id, uri, 200)

    // A pairing made before transfers were encrypted has no fingerprint, so it has to be made again.
    val paired: Boolean get() = token.isNotEmpty() && host.isNotEmpty() && fp.isNotEmpty()

    fun savePairing(p: Paired) {
        sp.edit()
            .putString("host", p.pc.host).putInt("port", p.pc.port)
            .putString("hosts", p.pc.hosts.joinToString(","))
            .putString("pcName", p.pc.name).putString("pcId", p.pc.id)
            .putString("fp", p.pc.fp)
            .putString("token", p.token).apply()
    }

    fun clearPairing() {
        sp.edit().remove("host").remove("hosts").remove("port").remove("pcName").remove("pcId").remove("fp").remove("token").apply()
    }
}
