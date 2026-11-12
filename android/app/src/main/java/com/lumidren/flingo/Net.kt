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

}
