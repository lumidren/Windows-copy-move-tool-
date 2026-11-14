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
        assertEquals("Living room PC", Pairing.parse("flingo://pair?h=10.0.2.2&c=000111&n=Living%20room%20PC")!!.pc.name)
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
        assertNull("five digits", Pairing.parse("flingo://pair?h=10.0.0.5&c=12345"))
        assertNull("letters in the code", Pairing.parse("flingo://pair?h=10.0.0.5&c=12a456"))
        assertNull("a port that cannot exist", Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&p=70000"))
        assertNull("an address that is not one", Pairing.parse("flingo://pair?h=evil.example/path%3Fx&c=123456"))
    }

    @Test fun addressesThatAreNotAddressesAreDroppedAndTheRestKept() {
        val link = Pairing.parse("flingo://pair?h=10.0.0.5,%20,bad/host,192.168.1.11&c=123456")!!
        assertEquals(listOf("10.0.0.5", "192.168.1.11"), link.pc.hosts)
    }

    @Test fun aLongNameIsCutAndARepeatedPartCannotReplaceTheFirst() {
        assertEquals(40, Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&n=${"x".repeat(200)}")!!.pc.name.length)
        // A second "h" or "c" added to the end does not override what came first.
        val link = Pairing.parse("flingo://pair?h=10.0.0.5&c=123456&h=6.6.6.6&c=999999")!!
        assertEquals(listOf("10.0.0.5"), link.pc.hosts)
        assertEquals("123456", link.code)
    }
}
