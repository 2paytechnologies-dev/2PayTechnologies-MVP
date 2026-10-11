package com.twopay.merchant.nfc

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A minimal NFC Forum Type 4 Tag *reader*, written from the T4T spec, to exercise the emulator end to end. */
private class Reader(private val tag: NdefTagEmulator, private val chunk: Int = 0xFF) {
    fun tx(vararg bytes: Int): ByteArray = tag.process(ByteArray(bytes.size) { bytes[it].toByte() })
    fun ok(r: ByteArray) = r.size >= 2 && r[r.size - 2] == 0x90.toByte() && r.last() == 0x00.toByte()
    fun body(r: ByteArray) = r.copyOfRange(0, r.size - 2)

    /** Full read procedure. Returns the NDEF message bytes, or null on any protocol failure. */
    fun readNdef(): ByteArray? {
        val sel = tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
        if (!ok(sel)) return null
        if (!ok(tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03))) return null
        val cc = tx(0x00, 0xB0, 0x00, 0x00, 0x0F)
        if (!ok(cc)) return null
        val ccBody = body(cc)
        if (ccBody.size != 15 || ccBody[9] != 0xE1.toByte() || ccBody[10] != 0x04.toByte()) return null
        if (!ok(tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04))) return null
        val nlenResp = tx(0x00, 0xB0, 0x00, 0x00, 0x02)
        if (!ok(nlenResp)) return null
        val nlen = ((body(nlenResp)[0].toInt() and 0xFF) shl 8) or (body(nlenResp)[1].toInt() and 0xFF)
        val out = java.io.ByteArrayOutputStream()
        var offset = 2
        while (out.size() < nlen) {
            val le = minOf(chunk, nlen - out.size())
            val r = tx(0x00, 0xB0, offset shr 8, offset and 0xFF, le)
            if (!ok(r)) return null
            out.write(body(r))
            offset += le
        }
        return out.toByteArray()
    }
}

class NdefTagEmulatorTest {
    private val url = "https://2-pay-technologies-mvp.vercel.app/pay/959e5a0d-f4c8-4a16-b917-faa1c7645cc9"

    private fun tagFor(u: String?): NdefTagEmulator {
        val msg = u?.let { NdefUri.build(it) }
        return NdefTagEmulator { msg }
    }

    @Test
    fun readerRecoversThePayLinkExactly() {
        val read = Reader(tagFor(url)).readNdef()
        assertNotNull(read)
        assertEquals(url, NdefUri.parse(read!!))
    }

    @Test
    fun readingInSmallChunksStillWorks() {
        // Phones may read 16, 32 or 59 bytes at a time depending on the stack.
        for (chunk in listOf(1, 7, 16, 32, 59, 255)) {
            val read = Reader(tagFor(url), chunk).readNdef()
            assertEquals("chunk=$chunk", url, NdefUri.parse(read!!))
        }
    }

    @Test
    fun ndefRecordIsWellFormed() {
        val msg = NdefUri.build(url)!!
        assertEquals(0xD1.toByte(), msg[0])        // MB|ME|SR|TNF=well-known
        assertEquals(0x01.toByte(), msg[1])        // type length
        assertEquals(0x55.toByte(), msg[3])        // 'U'
        assertEquals(0x04.toByte(), msg[4])        // "https://" abbreviation
        assertEquals(msg.size - 4, msg[2].toInt() and 0xFF) // 4-byte header, then payload = prefix code + rest
    }

    @Test
    fun uriPrefixAbbreviationsPickTheLongestMatch() {
        assertEquals(0x02.toByte(), NdefUri.build("https://www.example.com/x")!![4])
        assertEquals(0x04.toByte(), NdefUri.build("https://example.com/x")!![4])
        assertEquals(0x03.toByte(), NdefUri.build("http://example.com/x")!![4])
        assertEquals("https://www.example.com/x", NdefUri.parse(NdefUri.build("https://www.example.com/x")!!))
    }

    @Test
    fun rejectsUrlsThatCannotBeEncoded() {
        assertNull(NdefUri.build(""))
        assertNull(NdefUri.build("https://example.com/መክፈል"))
        assertNull(NdefUri.build("https://example.com/" + "a".repeat(300)))
    }

    @Test
    fun capabilityContainerAdvertisesAReadOnlyNdefFile() {
        val cc = NdefTagEmulator.CAPABILITY_CONTAINER
        assertEquals(15, cc.size)
        assertEquals(0x0F, ((cc[0].toInt() and 0xFF) shl 8) or (cc[1].toInt() and 0xFF)) // CCLEN
        assertEquals(0x20.toByte(), cc[2])                                                // mapping version 2.0
        assertArrayEquals(byteArrayOf(0xE1.toByte(), 0x04), cc.copyOfRange(9, 11))        // NDEF file id
        assertEquals(0x00.toByte(), cc[13])                                               // read access: open
        assertEquals(0xFF.toByte(), cc[14])                                               // write access: none
    }

    @Test
    fun tapCompletedFiresOnlyAfterTheWholeMessageIsRead() {
        val tag = tagFor(url)
        var taps = 0
        tag.onTapCompleted = { taps++ }
        val r = Reader(tag)
        r.tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
        r.tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)
        r.tx(0x00, 0xB0, 0x00, 0x00, 0x02)         // NLEN only
        assertEquals(0, taps)
        r.tx(0x00, 0xB0, 0x00, 0x02, 0x10)         // part of the message
        assertEquals(0, taps)
        r.tx(0x00, 0xB0, 0x00, 0x12, 0xFF)         // remainder
        assertEquals(1, taps)
    }

    @Test
    fun unknownApplicationIsRefusedAndNothingLeaks() {
        val tag = tagFor(url)
        val r = Reader(tag)
        val resp = r.tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x03, 0x10, 0x10, 0x00)
        assertArrayEquals(NdefTagEmulator.SW_FILE_NOT_FOUND, resp)
        // Without selecting our app, reads and file selects must fail.
        assertArrayEquals(NdefTagEmulator.SW_FILE_NOT_FOUND, r.tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04))
        assertArrayEquals(NdefTagEmulator.SW_CONDITIONS_NOT_SATISFIED, r.tx(0x00, 0xB0, 0x00, 0x00, 0x10))
    }

    @Test
    fun theTagIsReadOnly() {
        val r = Reader(tagFor(url))
        r.tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
        r.tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)
        assertArrayEquals(NdefTagEmulator.SW_SECURITY_NOT_SATISFIED, r.tx(0x00, 0xD6, 0x00, 0x00, 0x03, 0x01, 0x02, 0x03))
    }

    @Test
    fun unknownInstructionAndMalformedApdusAreHandled() {
        val tag = tagFor(url)
        assertArrayEquals(NdefTagEmulator.SW_INS_NOT_SUPPORTED, tag.process(byteArrayOf(0x00, 0x99.toByte(), 0x00, 0x00)))
        assertArrayEquals(NdefTagEmulator.SW_WRONG_LENGTH, tag.process(byteArrayOf(0x00, 0xA4.toByte())))
        assertArrayEquals(NdefTagEmulator.SW_WRONG_LENGTH, tag.process(ByteArray(0)))
        // SELECT claiming 7 data bytes but carrying 2
        assertArrayEquals(NdefTagEmulator.SW_WRONG_LENGTH, tag.process(byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00, 0x07, 0x01, 0x02)))
    }

    @Test
    fun readingPastTheEndIsRejected() {
        val r = Reader(tagFor(url))
        r.tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
        r.tx(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)
        assertArrayEquals(NdefTagEmulator.SW_WRONG_PARAMS, r.tx(0x00, 0xB0, 0x7F, 0xFF, 0x10))
    }

    @Test
    fun anEmptyTagReadsAsEmptyAndNeverSignalsATap() {
        val tag = tagFor(null)
        var taps = 0
        tag.onTapCompleted = { taps++ }
        val read = Reader(tag).readNdef()
        assertNotNull(read)
        assertEquals(0, read!!.size)
        assertEquals(0, taps)
    }

    @Test
    fun linkRotationIsPickedUpOnTheNextTap() {
        var current: ByteArray? = NdefUri.build("https://example.com/pay/aaaa")
        val tag = NdefTagEmulator { current }
        assertEquals("https://example.com/pay/aaaa", NdefUri.parse(Reader(tag).readNdef()!!))
        current = NdefUri.build("https://example.com/pay/bbbb") // the QR rotated
        tag.reset()
        assertEquals("https://example.com/pay/bbbb", NdefUri.parse(Reader(tag).readNdef()!!))
    }

    @Test
    fun deactivationResetsTheSession() {
        val tag = tagFor(url)
        val r = Reader(tag)
        r.tx(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
        tag.reset()
        assertFalse(r.ok(r.tx(0x00, 0xB0, 0x00, 0x00, 0x0F)))
        assertTrue(Reader(tag).readNdef() != null)
    }
}
