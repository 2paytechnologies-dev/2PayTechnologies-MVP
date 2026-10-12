package com.twopay.merchant

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.widget.Toast
import com.twopay.merchant.nfc.TapPayload
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * What the web terminal can ask the phone to do. Exposed to the page as `window.TwoPayNative`.
 * The WebView only ever loads the 2Pay site (see MainActivity), and every input here is validated.
 */
class NativeBridge(private val activity: MainActivity) {

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private fun adapter(): NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    /** JSON: { native, version, nfc: "READY" | "DISABLED" | "UNSUPPORTED", hce } */
    @JavascriptInterface
    fun info(): String {
        warmUpSpeech() // the terminal asks for info as soon as it opens, so the voice is ready before the first sale
        val hasHce = activity.packageManager.hasSystemFeature("android.hardware.nfc.hce")
        val nfc = adapter()
        val state = when {
            nfc == null || !hasHce -> "UNSUPPORTED"
            !nfc.isEnabled -> "DISABLED"
            else -> "READY"
        }
        return JSONObject()
            .put("native", true)
            .put("version", BuildConfig.VERSION_NAME)
            .put("nfc", state)
            .put("hce", hasHce)
            .toString()
    }

    /** Present this pay link to any phone that taps. Only https links on the 2Pay host are accepted. */
    @JavascriptInterface
    fun setPayUrl(url: String): Boolean {
        val uri = try { java.net.URI(url) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || !uri.host.equals(BuildConfig.SITE_HOST, ignoreCase = true)) return false
        if (!uri.path.orEmpty().startsWith("/pay/")) return false
        return TapPayload.set(url)
    }

    @JavascriptInterface
    fun clearPayUrl() {
        TapPayload.clear()
    }

    /** HCE only answers reliably while the screen is on, so the terminal holds it on during a sale. */
    @JavascriptInterface
    fun keepAwake(on: Boolean) {
        activity.runOnUiThread {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @JavascriptInterface
    fun openNfcSettings() {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
                activity.startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    /** Saves a file generated in the page (for example the yearly CSV) to the Downloads folder. */
    @JavascriptInterface
    fun saveFile(name: String, mime: String, base64: String): String {
        return try {
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifEmpty { "download" }
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val where: String
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return "error:could not create file"
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return "error:could not write file"
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                where = "Downloads"
            } else {
                val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir
                File(dir, safe).writeBytes(bytes)
                where = dir.absolutePath
            }
            activity.runOnUiThread { Toast.makeText(activity, "Saved $safe to $where", Toast.LENGTH_LONG).show() }
            "ok:$where/$safe"
        } catch (e: Exception) {
            "error:${e.message}"
        }
    }

    private var ttsStarting = false
    private var pending: Pair<String, String>? = null // the latest thing to say once the engine has started

    /** Start the speech engine ahead of time: its first start takes a second or two, which would delay the first "Paid". */
    private fun warmUpSpeech() {
        activity.runOnUiThread {
            if (tts != null || ttsStarting) return@runOnUiThread
            ttsStarting = true
            tts = TextToSpeech(activity.applicationContext) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                ttsStarting = false
                pending?.let { (text, lang) -> pending = null; if (ttsReady) say(text, lang) }
            }
        }
    }

    private fun say(text: String, lang: String) {
        val locale = Locale.forLanguageTag(lang.ifEmpty { "en" })
        val engine = tts ?: return
        if (engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) {
            engine.language = locale
            engine.speak(text.take(200), TextToSpeech.QUEUE_FLUSH, null, "twopay-speak")
        }
    }

    /**
     * True when this phone can speak the language (or the engine is still starting, so the answer isn't known yet).
     * The page uses it to fall back to English "Paid" when the phone has no Amharic voice installed.
     */
    @JavascriptInterface
    fun canSpeak(lang: String): Boolean {
        warmUpSpeech()
        val engine = tts
        if (!ttsReady || engine == null) return true
        return engine.isLanguageAvailable(Locale.forLanguageTag(lang.ifEmpty { "en" })) >= TextToSpeech.LANG_AVAILABLE
    }

    /** Native speech, because WebView has no speechSynthesis. Used for the "Paid" / "ተከፍሏል" sale announcement. */
    @JavascriptInterface
    fun speak(text: String, lang: String) {
        activity.runOnUiThread {
            if (ttsReady) say(text, lang) else {
                pending = text to lang
                warmUpSpeech()
            }
        }
    }

    /**
     * The settlement chime, played by the phone itself rather than by the page. The WebView's own audio can be held
     * back (idle audio is suspended, autoplay rules), which made the chime late or silent. Two soft tones, about half a second.
     */
    @Volatile private var chiming = false

    @JavascriptInterface
    fun chime() {
        if (chiming) return
        chiming = true
        Thread {
            var track: AudioTrack? = null
            try {
                val rate = 44100
                fun tone(freq: Double, ms: Int): ShortArray {
                    val n = rate * ms / 1000
                    return ShortArray(n) { i ->
                        val t = i.toDouble() / rate
                        val attack = minOf(1.0, i / (rate * 0.012))      // 12 ms fade-in: no click
                        val release = minOf(1.0, (n - i) / (rate * 0.12)) // gentle fade-out
                        (Math.sin(2 * Math.PI * freq * t) * 0.55 * attack * release * Short.MAX_VALUE).toInt().toShort()
                    }
                }
                val data = tone(880.0, 170) + tone(1318.5, 330)
                track = AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build(),
                    )
                    .setBufferSizeInBytes(data.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track.write(data, 0, data.size)
                track.play()
                Thread.sleep(600)
            } catch (_: Exception) {
            } finally {
                try { track?.release() } catch (_: Exception) {}
                chiming = false
            }
        }.start()
    }

    @JavascriptInterface
    fun vibrate(ms: Int) {
        val v = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        val d = ms.coerceIn(10, 1000).toLong()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE))
        else @Suppress("DEPRECATION") v.vibrate(d)
    }

    /** Opens Android's print dialog for the current page (end-of-day report, shop poster). Can save as PDF too. */
    @JavascriptInterface
    fun print() {
        activity.runOnUiThread { activity.printPage() }
    }

    @JavascriptInterface
    fun reload() {
        activity.runOnUiThread { activity.loadStart() }
    }

    fun shutdown() {
        tts?.shutdown()
        tts = null
    }
}
