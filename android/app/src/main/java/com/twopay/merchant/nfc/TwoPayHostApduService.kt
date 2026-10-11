package com.twopay.merchant.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * Android Host Card Emulation entry point. While the terminal is waiting for a customer, a tap from any
 * phone makes Android route the reader's APDUs here; [NdefTagEmulator] answers as an NDEF tag carrying
 * the current pay link from [TapPayload].
 */
class TwoPayHostApduService : HostApduService() {

    private val emulator = NdefTagEmulator { TapPayload.ndefMessage() }.also {
        it.onTapCompleted = { TapPayload.notifyTap() }
    }

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray =
        emulator.process(commandApdu ?: ByteArray(0))

    override fun onDeactivated(reason: Int) {
        emulator.reset()
    }
}
