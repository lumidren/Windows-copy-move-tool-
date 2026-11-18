package com.lumidren.flingo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Reading what a pairing QR code holds. */
class PairingParseTest {
    private val fp = "f-HqfVVjW0s4P_RPoI9Kjw2xnTPGUoZgZRIRGHxrBkk"

    @Test fun theCodeFlingoShowsIsRead() {
        val link = Pairing.parse("flingo://pair?h=192.168.1.11,10.0.0.5&c=123456&fp=$fp")!!
        assertEquals("123456", link.code)
        assertEquals(listOf("192.168.1.11", "10.0.0.5"), link.pc.hosts)
        assertEquals("192.168.1.11", link.pc.host)
        assertEquals(fp, link.pc.fp)
        assertEquals(47801, link.pc.port)
        assertEquals("your PC", link.pc.name) // the link no longer carries the name; the PC says it when it pairs
    }

    @Test fun aPortAndANameAreTakenWhenTheyAreThere() {
        val link = Pairing.parse("flingo://pair?h=10.0.2.2&c=000111&p=47821&n=Home-PC&id=abc123&fp=$fp")!!
        assertEquals(47821, link.pc.port)
        assertEquals("Home-PC", link.pc.name)
        assertEquals("abc123", link.pc.id)
        assertEquals("Living room PC", Pairing.parse("flingo://pair?h=10.0.2.2&c=000111&n=Living%20room%20PC&fp=$fp")!!.pc.name)
    }

    @Test fun otherQrCodesAreNotPairingCodes() {
        for (text in listOf(
            "https://example.com/menu", "WIFI:S:Home;T:WPA;P:secret;;", "hello", "",
            "flingo://send?h=10.0.0.5&c=123456", "http://pair?h=10.0.0.5&c=123456",
        )) assertNull(text, Pairing.parse(text))
    }

    @Test fun aCodeThatIsIncompleteOrWrongIsRefused() {
        assertNull("no address", Pairing.parse("flingo://pair?c=123456&fp=$fp"))
        assertNull("no code", Pairing.parse("flingo://pair?h=10.0.0.5&fp=$fp"))
        assertNull("five digits", Pairing.parse("flingo://pair?h=10.0.0.5&c=12345&fp=$fp"))
        assertNull("letters in the code", Pairing.parse("flingo://pair?h=10.0.0.5&c=12a456&fp=$fp"))
        assertNull("a port that cannot exist", Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&p=70000&fp=$fp"))
        assertNull("an address that is not one", Pairing.parse("flingo://pair?h=evil.example/path%3Fx&c=123456&fp=$fp"))
    }

    @Test fun aCodeWithoutThePcsFingerprintIsRefused() {
        // Without it the phone would have to trust whatever answered at that address.
        assertNull(Pairing.parse("flingo://pair?h=10.0.0.5&c=123456"))
        assertNull(Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp="))
        assertNull(Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=tooshort"))
        assertNull(Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=${fp}A"))
        assertNull(Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=${fp.dropLast(1)}%2B"))
    }

    @Test fun aCodeCanOnlyPointAtTheLocalNetwork() {
        // A link made by another app must not send the phone to a server on the internet, to a
        // name, or back to the phone itself.
        for (host in listOf("8.8.8.8", "203.0.113.9", "example.com", "evil.example", "127.0.0.1", "localhost", "0.0.0.0", "::1", "[fe80::1]", "172.32.0.1", "192.169.1.1", "999.1.1.1", "10.0.0")) {
            assertNull(host, Pairing.parse("flingo://pair?h=$host&c=123456&fp=$fp"))
        }
        for (host in listOf("10.0.0.5", "10.0.2.2", "172.16.0.9", "172.31.255.1", "192.168.43.1", "169.254.10.20", "100.64.0.3")) {
            assertEquals(host, Pairing.parse("flingo://pair?h=$host&c=123456&fp=$fp")!!.pc.host)
        }
        // One good address among bad ones is enough, and only the good one is kept.
        assertEquals(listOf("192.168.1.11"), Pairing.parse("flingo://pair?h=8.8.8.8,192.168.1.11,evil.example&c=123456&fp=$fp")!!.pc.hosts)
    }

    @Test fun aNameCannotCarryInvisibleCharacters() {
        val link = Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=$fp&n=Home%E2%80%AE-PC%E2%80%8B")!!
        assertEquals("Home-PC", link.pc.name)
    }

    @Test fun addressesThatAreNotAddressesAreDroppedAndTheRestKept() {
        val link = Pairing.parse("flingo://pair?h=10.0.0.5,%20,bad/host,192.168.1.11&c=123456&fp=$fp")!!
        assertEquals(listOf("10.0.0.5", "192.168.1.11"), link.pc.hosts)
    }

    @Test fun aLongNameIsCutAndARepeatedPartCannotReplaceTheFirst() {
        assertEquals(40, Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=$fp&n=${"x".repeat(200)}")!!.pc.name.length)
        // A second "h" or "c" added to the end does not override what came first.
        val link = Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&fp=$fp&h=6.6.6.6&c=999999")!!
        assertEquals(listOf("10.0.0.5"), link.pc.hosts)
        assertEquals("123456", link.code)
    }
}
