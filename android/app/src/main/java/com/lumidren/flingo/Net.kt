package com.lumidren.flingo

import android.annotation.SuppressLint
import android.content.Context
import android.net.Network
import android.net.Uri
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

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

/** The person stopped the transfer. Not an IOException, so nothing mistakes it for a network fault. */
class SendCancelledException : RuntimeException("Cancelled")

/** How one file is sent, and what the PC is told about it. */
data class SendOptions(
    /** Save without the arrival animation. */
    val quiet: Boolean = false,
    /** Shared by every file sent in one go, so the PC shows them as one. Empty for a file on its own. */
    val batch: String = "",
    val index: Int = 1,
    val count: Int = 1,
    /** Size of the whole batch, or -1 if not known. */
    val batchBytes: Long = -1,
    /** Names this transfer, so it can be carried on from where it stopped after a dropped connection. */
    val id: String = "",
    /** How long to keep trying after the last byte got through. 0 gives up at the first failure. */
    val patienceMs: Long = 0,
)

/** Talks to the Flingo desktop app over the local network. All calls block; run them off the main thread. */
object Net {
    const val HTTP_PORT = 47801
    private const val DISCOVERY_PORT = 47800
    private const val MAGIC = "FLINGO_DISCOVER"
    private const val MISMATCH = "fingerprint mismatch"

    /**
     * The Wi-Fi network the phone is on, if any. A hotspot or a travel router usually has no
     * internet, and Android then sends an app's traffic over mobile data instead, where the PC
     * cannot be reached. Every connection is therefore tied to Wi-Fi explicitly. It is null when
     * the phone is itself the hotspot; the system then routes to its own clients correctly.
     */
    @Volatile var wifi: Network? = null

    // ---------- certificate pinning ----------
    // The PC's certificate is self-signed, so there is no authority to ask. Instead the phone
    // remembers the certificate's fingerprint when it pairs and accepts only that one afterwards.
    @SuppressLint("CustomX509TrustManager")
    private class Pinning(private val pin: ByteArray?) : X509TrustManager {
        @Volatile var seen: ByteArray? = null

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            throw CertificateException("not a server")

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            val leaf = chain.firstOrNull() ?: throw CertificateException("no certificate")
            val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
            if (pin != null && !MessageDigest.isEqual(pin, fp)) throw CertificateException(MISMATCH)
            seen = fp
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private class Conn(val http: HttpsURLConnection, val trust: Pinning) {
        /** The fingerprint the PC actually presented, as stored in [Pc.fp]. */
        val fp: String get() = trust.seen?.let(::encodeFp) ?: ""
    }

    private fun encodeFp(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun decodeFp(fp: String): ByteArray? =
        if (fp.isEmpty()) null else runCatching { Base64.decode(fp, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }.getOrNull()

    /** A short form of the fingerprint that people can compare by eye, e.g. "4F2A 91C3". */
    fun securityCode(fp: String): String {
        val bytes = decodeFp(fp) ?: return ""
        val hex = bytes.take(4).joinToString("") { "%02X".format(it) }
        return hex.substring(0, 4) + " " + hex.substring(4)
    }

    private fun open(host: String, port: Int, path: String, pin: String, connectMs: Int = 2000): Conn {
        val trust = Pinning(decodeFp(pin))
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val url = URL("https", host, port, path)
        val conn = (wifi?.openConnection(url) ?: url.openConnection()) as HttpsURLConnection
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

    // ---------- finding the PC ----------
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
            runCatching { wifi?.bindSocket(socket) }
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
        val c = open(host, port, "/info", pin = "")
        try {
            val json = JSONObject(c.http.body())
            if (json.optString("app") != "flingo") null
            else Pc(json.getString("id"), json.getString("name"), host, port, c.fp)
        } finally {
            c.http.disconnect()
        }
    }.getOrNull()

    /** Reads a pairing QR code: flingo://pair?h=addresses&c=code&fp=fingerprint (port, name and id are optional). */
    fun parseLink(uri: Uri): PairLink? = runCatching {
        if (uri.scheme != "flingo" || uri.host != "pair") return null
        val hosts = (uri.getQueryParameter("h") ?: "").split(',').map { it.trim() }
            .filter { it.matches(Regex("[0-9A-Za-z.:-]{1,64}")) }
        val code = uri.getQueryParameter("c") ?: ""
        val port = uri.getQueryParameter("p")?.toIntOrNull() ?: HTTP_PORT
        if (hosts.isEmpty() || !code.matches(Regex("\\d{6}")) || port !in 1..65535) return null
        val pc = Pc(
            id = uri.getQueryParameter("id") ?: "",
            name = (uri.getQueryParameter("n") ?: "your PC").take(40),
            host = hosts.first(), port = port,
            fp = uri.getQueryParameter("fp") ?: "",
            hosts = hosts,
        )
        PairLink(pc, code)
    }.getOrNull()

    // ---------- pairing ----------
    /**
     * Pairs with [pc] at [Pc.host]. If [Pc.fp] is known (it came from a QR code) the PC must
     * present exactly that certificate; otherwise the certificate it presents is remembered.
     */
    fun pair(pc: Pc, code: String, deviceName: String, deviceId: String): Paired {
        val c = open(pc.host, pc.port, "/pair", pc.fp)
        try {
            c.http.requestMethod = "POST"
            c.http.doOutput = true
            c.http.setRequestProperty("Content-Type", "application/json")
            val payload = JSONObject().put("code", code).put("deviceName", deviceName).put("deviceId", deviceId).toString().toByteArray()
            c.http.outputStream.use { it.write(payload) }
            when (val status = c.http.responseCode) {
                200 -> {
                    val json = JSONObject(c.http.body())
                    val real = pc.copy(id = json.optString("id", pc.id), name = json.optString("name", pc.name), fp = c.fp)
                    return Paired(json.getString("token"), real)
                }
                403 -> throw WrongCodeException()
                423 -> throw PairingLockedException()
                else -> throw PcRefusedException(status, c.http.error("The PC did not accept the pairing."))
            }
        } catch (e: IOException) {
            throw if (isMismatch(e)) WrongPcException() else e
        } finally {
            c.http.disconnect()
        }
    }

    // ---------- staying connected ----------
    private fun candidates(prefs: Prefs): List<String> = (listOf(prefs.host) + prefs.hosts).filter { it.isNotEmpty() }.distinct()

    /**
     * True if the paired PC answers. Tries every address it is known by and remembers the one that works.
     * Throws [NotPairedException] if the PC answers but has forgotten this phone.
     */
    fun ping(prefs: Prefs): Boolean {
        for (host in candidates(prefs)) {
            val c = open(host, prefs.port, "/ping", prefs.fp, connectMs = 1500)
            try {
                c.http.readTimeout = 4000
                c.http.setRequestProperty("Authorization", "Bearer ${prefs.token}")
                val status = c.http.responseCode
                if (status == 401) throw NotPairedException()
                if (status == 200) {
                    if (host != prefs.host) prefs.host = host
                    return true
                }
            } catch (_: IOException) {
                // not at this address; try the next
            } finally {
                c.http.disconnect()
            }
        }
        return false
    }

    /** Looks for the paired PC by name-and-id broadcast, for when its address has changed. */
    fun relocate(prefs: Prefs): Boolean {
        val moved = runCatching { discover(1500) }.getOrDefault(emptyList()).firstOrNull { it.id == prefs.pcId } ?: return false
        prefs.host = moved.host
        return true
    }

    // ---------- sending ----------
    /** A file's name and its size in bytes, or -1 when the phone cannot tell. */
    fun describe(ctx: Context, uri: Uri): Pair<String, Long> {
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

    @Volatile private var inFlight: HttpsURLConnection? = null

    /** Drops the connection of the file being sent, so a write that is stuck returns at once. */
    fun abort() { runCatching { inFlight?.disconnect() } }

    private fun sendPath(x: Float, o: SendOptions, offset: Long): String {
        val q = StringBuilder("/send?x=$x")
        if (o.quiet) q.append("&quiet=1")
        if (o.batch.isNotEmpty()) {
            q.append("&batch=${o.batch}&i=${o.index}&n=${o.count}")
            if (o.batchBytes >= 0) q.append("&bytes=${o.batchBytes}")
        }
        if (o.id.isNotEmpty()) {
            q.append("&id=${o.id}")
            if (offset > 0) q.append("&offset=$offset")
        }
        return q.toString()
    }

    /** One attempt at one address, starting [offset] bytes into the file. */
    private fun sendTo(
        ctx: Context, host: String, prefs: Prefs, uri: Uri, name: String, size: Long, x: Float,
        o: SendOptions, offset: Long, cancelled: () -> Boolean, onProgress: (Long, Long) -> Unit,
    ): String {
        val c = open(host, prefs.port, sendPath(x, o, offset), prefs.fp, connectMs = 1500)
        val conn = c.http
        inFlight = conn
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.readTimeout = 60000
            conn.setRequestProperty("Authorization", "Bearer ${prefs.token}")
            conn.setRequestProperty("X-Filename", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
            conn.setRequestProperty("Content-Type", ctx.contentResolver.getType(uri) ?: "application/octet-stream")
            if (size >= 0) conn.setFixedLengthStreamingMode(size - offset) else conn.setChunkedStreamingMode(BUFFER)
            val input = try { ctx.contentResolver.openInputStream(uri) } catch (e: Exception) { null } ?: throw UnreadableFileException()
            try {
                input.use { src ->
                    var skipped = 0L
                    while (skipped < offset) {
                        val n = try { src.skip(offset - skipped) } catch (e: IOException) { 0L }
                        if (n <= 0) throw UnreadableFileException()
                        skipped += n
                    }
                    conn.outputStream.use { dst ->
                        val buf = ByteArray(BUFFER)
                        var sent = offset
                        onProgress(sent, size)
                        while (true) {
                            if (cancelled()) throw SendCancelledException()
                            val n = try { src.read(buf) } catch (e: IOException) { throw UnreadableFileException() }
                            if (n < 0) break
                            dst.write(buf, 0, n)
                            sent += n
                            onProgress(sent, size)
                        }
                    }
                }
            } catch (e: IOException) {
                if (cancelled()) throw SendCancelledException()
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
            if (inFlight === conn) inFlight = null
            conn.disconnect()
        }
    }

    /**
     * One attempt at every address the PC is known by. If it is at none of them (new DHCP lease,
     * different network) and [search] is on, looks for it by id and tries there.
     */
    private fun sendOnce(
        ctx: Context, prefs: Prefs, uri: Uri, name: String, size: Long, x: Float, search: Boolean,
        o: SendOptions, offset: Long, cancelled: () -> Boolean, onProgress: (Long, Long) -> Unit,
    ): String {
        var last: IOException? = null
        val tried = mutableSetOf<String>()
        for (host in candidates(prefs)) {
            tried.add(host)
            try {
                val sent = sendTo(ctx, host, prefs, uri, name, size, x, o, offset, cancelled, onProgress)
                if (host != prefs.host) prefs.host = host
                return sent
            } catch (e: UnreadableFileException) {
                throw e
            } catch (e: IOException) {
                last = e
            }
        }
        if (!search) throw last ?: IOException("PC not reachable")
        val moved = runCatching { discover(1800) }.getOrDefault(emptyList()).firstOrNull { it.id == prefs.pcId && it.host !in tried }
            ?: throw last ?: IOException("PC not reachable")
        val sent = sendTo(ctx, moved.host, prefs, uri, name, size, x, o, offset, cancelled, onProgress)
        prefs.host = moved.host
        return sent
    }

    /** How many bytes of the transfer named [id] the PC already has. 0 if none, or if it cannot say. */
    private fun resumeAt(prefs: Prefs, id: String): Long {
        for (host in candidates(prefs)) {
            val c = open(host, prefs.port, "/resume?id=$id", prefs.fp, connectMs = 1500)
            try {
                c.http.readTimeout = 5000
                c.http.setRequestProperty("Authorization", "Bearer ${prefs.token}")
                val status = c.http.responseCode
                if (status == 401) throw NotPairedException()
                // A PC running an older Flingo answers 404: it keeps nothing, so start again.
                return if (status == 200) JSONObject(c.http.body()).optLong("received", 0) else 0
            } catch (_: IOException) {
                // not at this address; try the next
            } finally {
                c.http.disconnect()
            }
        }
        throw IOException("PC not reachable")
    }

    private fun pause(ms: Long, cancelled: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + ms
        while (SystemClock.elapsedRealtime() < end) {
            if (cancelled()) throw SendCancelledException()
            Thread.sleep(100)
        }
    }

    /**
     * Sends one file to the paired PC. [onProgress] reports bytes sent, the file's size (-1 if
     * unknown), and whether the connection is currently lost.
     *
     * With [SendOptions.patienceMs] above zero, a dropped connection is not the end: it keeps
     * trying for that long since the last byte got through, and carries on from where the PC
     * says it stopped instead of starting again. With [search] off, a PC that is already known
     * to be out of reach is not looked for, so a single flick is answered quickly.
     */
    fun send(
        ctx: Context, prefs: Prefs, uri: Uri, x: Float, search: Boolean = true,
        o: SendOptions = SendOptions(), cancelled: () -> Boolean = { false },
        onProgress: (sent: Long, size: Long, waiting: Boolean) -> Unit = { _, _, _ -> },
    ): String {
        val (name, size) = describe(ctx, uri)
        var offset = 0L
        var reached = 0L
        var lastProgress = SystemClock.elapsedRealtime()
        var first = true
        while (true) {
            if (cancelled()) throw SendCancelledException()
            try {
                return sendOnce(ctx, prefs, uri, name, size, x, search && first, o, offset, cancelled) { sent, total ->
                    if (sent > reached) {
                        reached = sent
                        lastProgress = SystemClock.elapsedRealtime()
                    }
                    onProgress(sent, total, false)
                }
            } catch (e: UnreadableFileException) {
                throw e
            } catch (e: PcRefusedException) {
                // 409: the PC and the phone disagree about where to carry on. Anything else is final.
                if (e.status != 409 || SystemClock.elapsedRealtime() - lastProgress >= o.patienceMs) throw e
            } catch (e: IOException) {
                if (SystemClock.elapsedRealtime() - lastProgress >= o.patienceMs) throw e
            }
            first = false
            onProgress(reached, size, true)
            pause(1200, cancelled)
            // Ask the PC how much it kept. If it cannot be asked yet, the next attempt will fail too and wait again.
            offset = if (o.id.isNotEmpty() && size > 0 && reached > 0) {
                try { resumeAt(prefs, o.id).coerceIn(0, size) } catch (_: IOException) { 0L }
            } else 0L
        }
    }

    private const val BUFFER = 256 * 1024
}

/** The file on this phone could not be opened or read. */
class UnreadableFileException : IOException("Cannot read file")
