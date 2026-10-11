package com.twopay.merchant.nfc

/** Builds a single short NDEF URI record (NFC Forum URI RTD) for a pay link. */
object NdefUri {
    // NFC Forum URI identifier codes. Longest matching prefix wins so the record stays small.
    private val PREFIXES = listOf(
        "https://www." to 0x02,
        "http://www." to 0x01,
        "https://" to 0x04,
        "http://" to 0x03,
    )

    /** Largest NDEF message that fits the advertised file (minus the 2-byte NLEN). */
    const val MAX_MESSAGE = NdefTagEmulator.MAX_NDEF_FILE - 2

    /** Returns the NDEF message bytes, or null if the URL is empty, non-ASCII, or too long to fit the tag. */
    fun build(url: String): ByteArray? {
        if (url.isEmpty() || url.any { it.code !in 0x20..0x7E }) return null
        val (prefix, code) = PREFIXES.firstOrNull { url.startsWith(it.first, ignoreCase = true) } ?: ("" to 0x00)
        val rest = url.substring(prefix.length).toByteArray(Charsets.US_ASCII)
        val payloadLen = 1 + rest.size
        if (payloadLen > 255) return null
        // MB=1 ME=1 SR=1 TNF=001 (well-known) = 0xD1; type length 1; payload length; type 'U'
        val record = byteArrayOf(0xD1.toByte(), 0x01, payloadLen.toByte(), 0x55, code.toByte()) + rest
        return if (record.size <= MAX_MESSAGE) record else null
    }

    /** Test/diagnostic helper: reads a URL back out of a message built by [build]. */
    fun parse(message: ByteArray): String? {
        if (message.size < 5 || message[0] != 0xD1.toByte() || message[3] != 0x55.toByte()) return null
        val len = message[2].toInt() and 0xFF
        if (message.size < 3 + 1 + len) return null
        val code = message[4].toInt() and 0xFF
        val prefix = PREFIXES.firstOrNull { it.second == code }?.first ?: ""
        return prefix + String(message, 5, len - 1, Charsets.US_ASCII)
    }
}
