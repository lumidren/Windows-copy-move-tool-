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
    private val HOST = Regex("[0-9A-Za-z.:-]{1,64}")
    private val CODE = Regex("\\d{6}")

    /**
     * Reads what a pairing QR code holds: flingo://pair?h=addresses&c=code&fp=fingerprint
     * (port, name and id are optional). Null for anything else, including another app's QR code.
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
        val hosts = (q["h"] ?: "").split(',').map { it.trim() }.filter { it.matches(HOST) }
        val code = q["c"] ?: ""
        val port = q["p"]?.toIntOrNull() ?: Net.HTTP_PORT
        if (hosts.isEmpty() || !code.matches(CODE) || port !in 1..65535) return null
        val pc = Pc(
            id = q["id"] ?: "",
            name = (q["n"]?.takeIf { it.isNotBlank() } ?: "your PC").take(40),
            host = hosts.first(), port = port,
            fp = q["fp"] ?: "",
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
