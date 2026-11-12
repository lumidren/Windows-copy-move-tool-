package com.lumidren.flingo

import android.content.Context

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

    /** Height of the send zone as a percentage of the screen (10–50). */
    var zonePercent: Int
        get() = sp.getInt("zone", 25).coerceIn(10, 50)
        set(v) = sp.edit().putInt("zone", v.coerceIn(10, 50)).apply()

    val paired: Boolean get() = token.isNotEmpty() && host.isNotEmpty()

    fun savePairing(pc: Pc, newToken: String) {
        sp.edit()
            .putString("host", pc.host).putInt("port", pc.port)
            .putString("pcName", pc.name).putString("pcId", pc.id)
            .putString("token", newToken).apply()
    }

    fun clearPairing() {
        sp.edit().remove("host").remove("port").remove("pcName").remove("pcId").remove("token").apply()
    }
}
