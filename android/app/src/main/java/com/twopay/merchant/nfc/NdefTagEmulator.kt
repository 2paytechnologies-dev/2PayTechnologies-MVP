package com.twopay.merchant.nfc

/**
 * NFC Forum Type 4 Tag emulation (the "NDEF tag application", AID D2760000850101), as a pure state machine
 * with no Android dependencies so it can be unit tested on the JVM.
 *
 * A phone that taps this one sees an ordinary NFC tag holding a single NDEF URI record (the pay link).
 * Any NFC-capable Android phone, and iPhones from the XS onward, read that natively and open the link, so the
 * payer needs no app. The link is the single-use pay node, so the tap itself carries no money and no secret.
 *
 * Command flow a reader performs:
 *   SELECT application (AID) -> SELECT capability container (E103) -> READ it -> SELECT NDEF file (E104) -> READ it.
 */
class NdefTagEmulator(private val message: () -> ByteArray?) {

    private enum class Selected { NONE, CC, NDEF }

    private var appSelected = false
    private var selected = Selected.NONE

    /** Invoked when a reader has read the whole NDEF file, i.e. a customer's phone has completed a tap. */
    var onTapCompleted: (() -> Unit)? = null

    fun reset() {
        appSelected = false
        selected = Selected.NONE
    }

    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return SW_WRONG_LENGTH
        val ins = apdu[1].toInt() and 0xFF
        return when (ins) {
            INS_SELECT -> select(apdu)
            INS_READ_BINARY -> readBinary(apdu)
            INS_UPDATE_BINARY -> SW_SECURITY_NOT_SATISFIED // the tag is read-only
            else -> SW_INS_NOT_SUPPORTED
        }
    }

    private fun select(apdu: ByteArray): ByteArray {
        val p1 = apdu[2].toInt() and 0xFF
        if (apdu.size < 5) return SW_WRONG_LENGTH
        val lc = apdu[4].toInt() and 0xFF
        if (apdu.size < 5 + lc) return SW_WRONG_LENGTH
        val data = apdu.copyOfRange(5, 5 + lc)

        return when (p1) {
            0x04 -> { // select by DF name (AID)
                if (data.contentEquals(AID)) {
                    appSelected = true
                    selected = Selected.NONE
                    SW_OK
                } else {
                    appSelected = false
                    SW_FILE_NOT_FOUND
                }
            }
            0x00 -> { // select by file id
                if (!appSelected) return SW_FILE_NOT_FOUND
                when {
                    data.contentEquals(FILE_CC) -> { selected = Selected.CC; SW_OK }
                    data.contentEquals(FILE_NDEF) -> { selected = Selected.NDEF; SW_OK }
                    else -> SW_FILE_NOT_FOUND
                }
            }
            else -> SW_WRONG_PARAMS
        }
    }

    private fun readBinary(apdu: ByteArray): ByteArray {
        if (!appSelected || selected == Selected.NONE) return SW_CONDITIONS_NOT_SATISFIED
        val file = if (selected == Selected.CC) CAPABILITY_CONTAINER else ndefFile()
        val offset = ((apdu[2].toInt() and 0x7F) shl 8) or (apdu[3].toInt() and 0xFF)
        // Short-APDU Le: absent means "as much as fits", 0x00 means 256.
        val le = if (apdu.size >= 5) (apdu[4].toInt() and 0xFF).let { if (it == 0) 256 else it } else 256
        if (offset > file.size) return SW_WRONG_PARAMS

        val end = minOf(offset + le, file.size)
        val chunk = file.copyOfRange(offset, end)
        if (selected == Selected.NDEF && end >= file.size && file.size > 2) onTapCompleted?.invoke()
        return chunk + SW_OK
    }

    /** NDEF file = 2-byte big-endian NLEN followed by the NDEF message. An empty tag has NLEN = 0. */
    private fun ndefFile(): ByteArray {
        val msg = message() ?: return byteArrayOf(0, 0)
        return byteArrayOf((msg.size shr 8).toByte(), msg.size.toByte()) + msg
    }

    companion object {
        val AID = byteArrayOf(0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01)
        private val FILE_CC = byteArrayOf(0xE1.toByte(), 0x03)
        private val FILE_NDEF = byteArrayOf(0xE1.toByte(), 0x04)

        /** Largest NDEF file we advertise, including the 2-byte NLEN. */
        const val MAX_NDEF_FILE = 0x0100

        /**
         * Capability container (15 bytes): CCLEN=15, mapping version 2.0, MLe=255, MLc=255,
         * then the NDEF File Control TLV (T=04, L=06): file E104, max size 256, read access 00, write access FF (none).
         */
        val CAPABILITY_CONTAINER = byteArrayOf(
            0x00, 0x0F, 0x20, 0x00, 0xFF.toByte(), 0x00, 0xFF.toByte(),
            0x04, 0x06, 0xE1.toByte(), 0x04, 0x01, 0x00, 0x00, 0xFF.toByte(),
        )

        private const val INS_SELECT = 0xA4
        private const val INS_READ_BINARY = 0xB0
        private const val INS_UPDATE_BINARY = 0xD6

        private fun sw(a: Int, b: Int) = byteArrayOf(a.toByte(), b.toByte())
        val SW_OK = sw(0x90, 0x00)
        val SW_FILE_NOT_FOUND = sw(0x6A, 0x82)
        val SW_WRONG_PARAMS = sw(0x6B, 0x00)
        val SW_WRONG_LENGTH = sw(0x67, 0x00)
        val SW_SECURITY_NOT_SATISFIED = sw(0x69, 0x82)
        val SW_CONDITIONS_NOT_SATISFIED = sw(0x69, 0x85)
        val SW_INS_NOT_SUPPORTED = sw(0x6D, 0x00)
    }
}
