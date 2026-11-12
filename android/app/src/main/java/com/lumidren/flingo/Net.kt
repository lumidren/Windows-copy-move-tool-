package com.lumidren.flingo

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder

data class Pc(val id: String, val name: String, val host: String, val port: Int)

class NotPairedException : Exception("Not paired")
class WrongCodeException(message: String) : Exception(message)

/** Talks to the Flingo desktop app over the local network. All calls block; run them off the main thread. */
object Net {
    const val HTTP_PORT = 47801
    private const val DISCOVERY_PORT = 47800
    private const val MAGIC = "FLINGO_DISCOVER"

    private fun broadcastAddresses(): List<InetAddress> {
        val out = mutableListOf<InetAddress>()
        runCatching {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.interfaceAddresses) addr.broadcast?.let(out::add)
            }
        }
        runCatching { out.add(InetAddress.getByName("255.255.255.255")) }
        return out
    }

    fun discover(timeoutMs: Int = 1500): List<Pc> {
        val found = LinkedHashMap<String, Pc>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val msg = MAGIC.toByteArray()
            for (target in broadcastAddresses()) {
                runCatching { socket.send(DatagramPacket(msg, msg.size, target, DISCOVERY_PORT)) }
            }
            val end = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < end) {
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val json = JSONObject(String(packet.data, 0, packet.length))
                    if (json.optString("app") != "flingo") continue
                    val host = packet.address.hostAddress ?: continue
                    val pc = Pc(json.getString("id"), json.getString("name"), host, json.optInt("port", HTTP_PORT))
                    found.putIfAbsent(pc.id, pc)
                } catch (_: SocketTimeoutException) {
                    // keep listening until the deadline
                } catch (_: Exception) {
                    // ignore malformed replies
                }
            }
        }
        return found.values.toList()
    }

    private fun open(host: String, port: Int, path: String): HttpURLConnection {
        val conn = URL("http", host, port, path).openConnection() as HttpURLConnection
        conn.connectTimeout = 2500
        conn.readTimeout = 15000
        return conn
    }

    private fun HttpURLConnection.body(): String =
        (if (responseCode in 200..299) inputStream else errorStream)?.bufferedReader()?.use { it.readText() } ?: ""

    fun info(host: String, port: Int = HTTP_PORT): Pc? = runCatching {
        val conn = open(host, port, "/info")
        try {
            val json = JSONObject(conn.body())
            if (json.optString("app") != "flingo") null
            else Pc(json.getString("id"), json.getString("name"), host, port)
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    /** Returns the token to store. */
    fun pair(pc: Pc, code: String, deviceName: String): String {
        val conn = open(pc.host, pc.port, "/pair")
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val payload = JSONObject().put("code", code).put("deviceName", deviceName).toString().toByteArray()
            conn.outputStream.use { it.write(payload) }
            val json = runCatching { JSONObject(conn.body()) }.getOrDefault(JSONObject())
            if (conn.responseCode != 200) throw WrongCodeException(json.optString("error", "Pairing failed"))
            return json.getString("token")
        } finally {
            conn.disconnect()
        }
    }

    private fun describe(ctx: Context, uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment ?: "file"
        var size = -1L
        runCatching {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    if (!c.isNull(0)) name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return name to size
    }

    private fun sendTo(ctx: Context, host: String, prefs: Prefs, uri: Uri, x: Float): String {
        val (name, size) = describe(ctx, uri)
        val conn = open(host, prefs.port, "/send?x=$x")
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.readTimeout = 60000
            conn.setRequestProperty("Authorization", "Bearer ${prefs.token}")
            conn.setRequestProperty("X-Filename", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
            conn.setRequestProperty("Content-Type", ctx.contentResolver.getType(uri) ?: "application/octet-stream")
            if (size >= 0) conn.setFixedLengthStreamingMode(size) else conn.setChunkedStreamingMode(64 * 1024)
            val input = ctx.contentResolver.openInputStream(uri) ?: throw IOException("Cannot read file")
            input.use { src -> conn.outputStream.use { dst -> src.copyTo(dst, 64 * 1024) } }
            val code = conn.responseCode
            if (code == 401) throw NotPairedException()
            if (code != 200) throw IOException("PC answered $code")
            return name
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Sends one file to the paired PC. If the PC's address changed (new DHCP lease),
     * finds it again by its id and retries once.
     */
    fun send(ctx: Context, prefs: Prefs, uri: Uri, x: Float): String {
        try {
            return sendTo(ctx, prefs.host, prefs, uri, x)
        } catch (e: IOException) {
            val moved = discover().firstOrNull { it.id == prefs.pcId && it.host != prefs.host } ?: throw e
            prefs.host = moved.host
            return sendTo(ctx, moved.host, prefs, uri, x)
        }
    }
}
