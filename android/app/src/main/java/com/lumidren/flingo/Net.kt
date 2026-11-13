package com.lumidren.flingo

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.net.URLEncoder

/**
 * A Flingo PC. [fp] is the SHA-256 fingerprint of its certificate (base64url), empty until known.
 * [hosts] lists every address it may be reached at; [host] is the one to try first.
 */
data class Pc(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val fp: String = "",
    val hosts: List<String> = listOf(host),
)

/** What a pairing QR code carries: the PC and its one-time code. */
data class PairLink(val pc: Pc, val code: String)

/** The result of pairing: the token to keep, and the PC as it really answered. */
data class Paired(val token: String, val pc: Pc)

class NotPairedException : Exception("Not paired")
class WrongCodeException : Exception("Wrong code")
class PairingLockedException : Exception("Pairing is locked")

/** The PC answered, but said no. [message] is its own explanation, already written for people. */
class PcRefusedException(val status: Int, message: String) : Exception(message)

/** Something answered at the PC's address with a different certificate than the one pinned. */
class WrongPcException : IOException("A different computer answered")

/** Talks to the Flingo desktop app over the local network. All calls block; run them off the main thread. */
object Net {
    const val HTTP_PORT = 47801
    private const val DISCOVERY_PORT = 47800
    private const val MISMATCH = "fingerprint mismatch"

    private fun open(host: String, port: Int, path: String, pin: String, connectMs: Int = 2000): Conn {
        val trust = Pinning(decodeFp(pin))
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val conn = URL("https", host, port, path).openConnection() as HttpsURLConnection
        conn.sslSocketFactory = tls.socketFactory
        // The address is an IP on the local network, so there is no name to check. The pin is the check.
        conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
        conn.connectTimeout = connectMs
        conn.readTimeout = 20000
        conn.useCaches = false
        // One connection per request: a kept-alive socket goes stale when the PC sleeps or restarts.
        conn.setRequestProperty("Connection", "close")
        return Conn(conn, trust)
    }

    private fun HttpsURLConnection.body(): String =
        (if (responseCode in 200..299) inputStream else errorStream)?.bufferedReader()?.use { it.readText() } ?: ""

    private fun HttpsURLConnection.error(fallback: String): String =
        runCatching { JSONObject(body()).optString("error", fallback) }.getOrDefault(fallback).ifEmpty { fallback }

    private fun isMismatch(e: Throwable): Boolean {
        var c: Throwable? = e
        while (c != null) {
            if (c is CertificateException && c.message == MISMATCH) return true
            c = c.cause
        }
        return false
    }
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

    fun discover(timeoutMs: Int = 2400): List<Pc> {
        val found = LinkedHashMap<String, Pc>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val msg = MAGIC.toByteArray()
            val targets = broadcastAddresses()
            val end = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            var lastProbe = 0L
            while (System.currentTimeMillis() < end) {
                // UDP broadcasts get dropped on busy Wi-Fi, so ask again every 600 ms.
                if (System.currentTimeMillis() - lastProbe >= 600) {
                    lastProbe = System.currentTimeMillis()
                    for (target in targets) {
                        runCatching { socket.send(DatagramPacket(msg, msg.size, target, DISCOVERY_PORT)) }
                    }
                }
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val json = JSONObject(String(packet.data, 0, packet.length))
                    if (json.optString("app") != "flingo") continue
                    val host = packet.address.hostAddress ?: continue
                    // The fingerprint in a discovery reply is only a claim; pairing pins what TLS really shows.
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

    /** Asks whatever is at [host] who it is. The returned [Pc.fp] is the certificate it presented. */
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

    private fun sendTo(ctx: Context, host: String, prefs: Prefs, uri: Uri, x: Float, onProgress: (Long, Long) -> Unit): String {
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
            val input = try { ctx.contentResolver.openInputStream(uri) } catch (e: Exception) { null } ?: throw UnreadableFileException()
            try {
                input.use { src ->
                    conn.outputStream.use { dst ->
                        val buf = ByteArray(64 * 1024)
                        var sent = 0L
                        while (true) {
                            val n = try { src.read(buf) } catch (e: IOException) { throw UnreadableFileException() }
                            if (n < 0) break
                            dst.write(buf, 0, n)
                            sent += n
                            onProgress(sent, size)
                        }
                    }
                }
            } catch (e: IOException) {
                if (e is UnreadableFileException) throw e
                if (isMismatch(e)) throw WrongPcException()
                // The PC may have refused part-way (too large, no space) and hung up. Its answer says why.
                val status = runCatching { conn.responseCode }.getOrDefault(-1)
                if (status == 401) throw NotPairedException()
                if (status >= 400) throw PcRefusedException(status, conn.error("The PC could not take the file."))
                throw e
            }
            val status = conn.responseCode
            if (status == 401) throw NotPairedException()
            if (status != 200) throw PcRefusedException(status, conn.error("The PC could not take the file."))
            return name
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Sends one file to the paired PC. If the PC's address changed (new DHCP lease),
     * finds it again by its id and retries once.
     */
    fun send(ctx: Context, prefs: Prefs, uri: Uri, x: Float, search: Boolean = true, onProgress: (Long, Long) -> Unit = { _, _ -> }): String {
        var last: IOException? = null
        if (!search) throw last ?: IOException("PC not reachable")
        val moved = runCatching { discover(1800) }.getOrDefault(emptyList()).firstOrNull { it.id == prefs.pcId && it.host !in tried }
            ?: throw last ?: IOException("PC not reachable")
        val name = sendTo(ctx, moved.host, prefs, uri, x, onProgress)
        prefs.host = moved.host
        return name
        val tried = mutableSetOf<String>()
        for (host in candidates(prefs)) {
            tried.add(host)
            try {
                val name = sendTo(ctx, host, prefs, uri, x, onProgress)
                if (host != prefs.host) prefs.host = host
                return name
            } catch (e: UnreadableFileException) {
                throw e
            } catch (e: IOException) {
                last = e
            }
        }
    }
}
