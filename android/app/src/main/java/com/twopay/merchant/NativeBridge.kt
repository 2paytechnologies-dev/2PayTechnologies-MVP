package com.twopay.merchant

import android.content.ContentValues
import android.content.Context
import android.content.Intent
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

    /** Native speech, because WebView has no speechSynthesis. Used for the Amharic "ተከፍሏል" sale announcement. */
    @JavascriptInterface
    fun speak(text: String, lang: String) {
        activity.runOnUiThread {
            val say = {
                val locale = Locale.forLanguageTag(lang.ifEmpty { "en" })
                val engine = tts
                if (engine != null && engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) {
                    engine.language = locale
                    engine.speak(text.take(200), TextToSpeech.QUEUE_FLUSH, null, "twopay-speak")
                }
            }
            if (ttsReady) say() else {
                tts = TextToSpeech(activity.applicationContext) { status ->
                    ttsReady = status == TextToSpeech.SUCCESS
                    if (ttsReady) say()
                }
            }
        }
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
