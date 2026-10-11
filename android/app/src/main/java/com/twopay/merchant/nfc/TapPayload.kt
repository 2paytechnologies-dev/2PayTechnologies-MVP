package com.twopay.merchant.nfc

import android.os.Handler
import android.os.Looper

/**
 * The one piece of shared state between the web terminal (via [com.twopay.merchant.NativeBridge]) and the
 * NFC service: the pay link the phone should currently present. The terminal's rotating QR updates it every
 * time a fresh single-use node is minted, so the tap and the QR always agree.
 */
object TapPayload {
    @Volatile
    private var message: ByteArray? = null

    @Volatile
    var url: String? = null
        private set

    /** Called on the main thread whenever a customer's phone finishes reading the tag. */
    @Volatile
    var onTap: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())

    /** Returns false (and leaves the previous link in place) if the URL can't be encoded onto the tag. */
    fun set(newUrl: String): Boolean {
        val built = NdefUri.build(newUrl) ?: return false
        message = built
        url = newUrl
        return true
    }

    fun clear() {
        message = null
        url = null
    }

    fun ndefMessage(): ByteArray? = message

    fun notifyTap() {
        val cb = onTap ?: return
        main.post { cb() }
    }
}
