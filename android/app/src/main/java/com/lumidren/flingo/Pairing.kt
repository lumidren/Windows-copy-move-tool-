package com.lumidren.flingo

import java.io.IOException
import java.net.URLDecoder

/** How an attempt to pair ended. */
sealed class PairOutcome {
    data class Done(val paired: Paired) : PairOutcome()
    /** It did not work. [text] says why, and what to do, in words for the person holding the phone. */
    data class Problem(val text: String) : PairOutcome()
}

/** Reading a pairing code, and pairing from one. */
object Pairing {
    /** Characters that are not seen and can reorder or hide what is: they have no place in a name. */
    const val INVISIBLE = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff"
    private val CODE = Regex("\\d{6}")
    private val FINGERPRINT = Regex("[A-Za-z0-9_-]{43}")
    private val IPV4 = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")

    /** True for what a certificate's fingerprint looks like in a pairing code: 32 bytes as base64url. */
    fun isFingerprint(text: String): Boolean = text.matches(FINGERPRINT)

    /**
     * True for an address a PC on the same Wi-Fi or hotspot can have: a private or link-local
     * IPv4 address, written as numbers. Not a name, not an address on the internet, and not
     * this phone itself: a pairing link from another app must not be able to point Flingo at
     * a server of that app's choosing.
     */
    fun isLocalAddress(host: String): Boolean {
        val m = IPV4.matchEntire(host) ?: return false
        val (a, b, c, d) = m.destructured.toList().map { it.toIntOrNull() ?: return false }
        if (listOf(a, b, c, d).any { it > 255 }) return false
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b in 64..127)
    }

    /**
     * Reads what a pairing QR code holds: flingo://pair?h=addresses&c=code&fp=fingerprint
     * (port, name and id are optional). Null for anything else, including another app's QR code,
     * a code without the PC's fingerprint, and one that points anywhere but the local network.
     * Plain string work, so it is tested without a phone.
     */
    fun parse(text: String): PairLink? {
        val prefix = "flingo://pair?"
        if (!text.startsWith(prefix, ignoreCase = true)) return null
        val q = HashMap<String, String>()
        for (part in text.substring(prefix.length).substringBefore('#').split('&')) {
            val key = part.substringBefore('=')
            if (key.isEmpty() || key in q) continue
            q[key] = runCatching { URLDecoder.decode(part.substringAfter('=', ""), "UTF-8") }.getOrDefault("")
        }
        val hosts = (q["h"] ?: "").split(',').map { it.trim() }.filter(::isLocalAddress).distinct()
        val code = q["c"] ?: ""
        val port = q["p"]?.toIntOrNull() ?: Net.HTTP_PORT
        val fp = q["fp"] ?: ""
        if (hosts.isEmpty() || !code.matches(CODE) || port !in 1..65535 || !isFingerprint(fp)) return null
        val pc = Pc(
            id = q["id"] ?: "",
            name = (q["n"]?.filter { !it.isISOControl() && it !in INVISIBLE }?.trim()?.takeIf { it.isNotEmpty() } ?: "your PC").take(40),
            host = hosts.first(), port = port,
            fp = fp,
            hosts = hosts,
        )
        return PairLink(pc, code)
    }

    /**
     * Pairs from a QR code. Every address in the code is tried at the same moment and the
     * first that answers is paired with, pinned to the certificate in the code. Blocking:
     * call it off the main thread.
     */
    fun byLink(link: PairLink, deviceName: String, deviceId: String): PairOutcome {
        val pc = link.pc
        val unreachable = "Can't reach ${pc.name}. Put the phone and the PC on the same Wi-Fi or hotspot, then scan again."
        // The address that answers first, then the others in case that one turns out to be another machine.
        val live = Net.firstReachable(pc.hosts, pc.port) ?: return PairOutcome.Problem(unreachable)
        var problem = unreachable
        for (host in listOf(live) + pc.hosts.filter { it != live }) {
            try {
                return PairOutcome.Done(Net.pair(pc.copy(host = host), link.code, deviceName, deviceId))
            } catch (_: WrongCodeException) {
                return PairOutcome.Problem("That code has already been used. The PC is showing a new one: scan it again.")
            } catch (_: PairingLockedException) {
                return PairOutcome.Problem("Pairing is locked on ${pc.name}. On the PC, press Pair a phone, then scan again.")
            } catch (e: PcRefusedException) {
                return PairOutcome.Problem(e.message ?: unreachable)
            } catch (_: WrongPcException) {
                problem = "A different computer answered at that address. Scan the code on your own PC again."
            } catch (_: IOException) {
                // not reachable at this address after all; try the next one
            }
        }
        return PairOutcome.Problem(problem)
    }
}
