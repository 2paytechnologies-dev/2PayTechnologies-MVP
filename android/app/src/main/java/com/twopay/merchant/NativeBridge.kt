package com.twopay.merchant

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.audiofx.LoudnessEnhancer
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Bundle
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

    private companion object {
        const val CHIME_LEVEL = 0.8        // fraction of full scale (was 0.55)
        const val SPEECH_BOOST_MB = 600    // +6 dB on the spoken word, in millibels
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private fun adapter(): NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    /** JSON: { native, version, nfc: "READY" | "DISABLED" | "UNSUPPORTED", hce } */
    @JavascriptInterface
    fun info(): String {
        warmUpSpeech() // the terminal asks for info as soon as it opens, so the voice and the sounds are ready before the first sale
        warmUpAudio()
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

    private var louder: LoudnessEnhancer? = null

    private fun say(text: String, lang: String) {
        val locale = Locale.forLanguageTag(lang.ifEmpty { "en" })
        val engine = tts ?: return
        if (engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) {
            engine.language = locale
            val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f) }
            // Speech engines already play at full level, so lift it a few dB with an audio effect on this utterance's own session.
            try {
                louder?.release()
                louder = null
                val session = (activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager).generateAudioSessionId()
                params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, session)
                louder = LoudnessEnhancer(session).apply { setTargetGain(SPEECH_BOOST_MB); enabled = true }
            } catch (_: Exception) {
                params.remove(TextToSpeech.Engine.KEY_PARAM_SESSION_ID)
            }
            engine.speak(text.take(200), TextToSpeech.QUEUE_FLUSH, params, "twopay-speak")
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

    // ------------------------------------------------------------------ the sale sounds, ready BEFORE the sale
    // The chime and the recorded Amharic word are built and kept ready when the terminal opens, so the moment a sale clears
    // they only have to START. (Building an audio track or preparing a player at that moment cost 100 ms or more.)
    private val audioLock = Any()
    private var chimeTrack: AudioTrack? = null
    private var amPlayer: MediaPlayer? = null
    private var amReady = false

    /** The two soft tones, about half a second, as a ready-to-play static track. */
    private fun buildChime(): AudioTrack? = try {
        val rate = 44100
        fun tone(freq: Double, ms: Int): ShortArray {
            val n = rate * ms / 1000
            return ShortArray(n) { i ->
                val t = i.toDouble() / rate
                val attack = minOf(1.0, i / (rate * 0.012))      // 12 ms fade-in: no click
                val release = minOf(1.0, (n - i) / (rate * 0.12)) // gentle fade-out
                (Math.sin(2 * Math.PI * freq * t) * CHIME_LEVEL * attack * release * Short.MAX_VALUE).toInt().toShort()
            }
        }
        val data = tone(880.0, 170) + tone(1318.5, 330)
        AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(data.size * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
            .also { it.write(data, 0, data.size) }
    } catch (_: Exception) {
        null
    }

    private fun buildAmharicPlayer(): MediaPlayer? = try {
        val afd = activity.resources.openRawResourceFd(R.raw.paid_am)
        MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            afd.close()
            setVolume(1f, 1f)
            setOnErrorListener { mp, _, _ -> synchronized(audioLock) { amReady = false; amPlayer = null }; mp.release(); true }
            prepare() // on the worker thread; the file is 13 KB
        }
    } catch (_: Exception) {
        null
    }

    private fun warmUpAudio() {
        Thread {
            synchronized(audioLock) {
                if (chimeTrack == null) chimeTrack = buildChime()
                if (amPlayer == null) {
                    amPlayer = buildAmharicPlayer()
                    amReady = amPlayer != null
                }
            }
        }.start()
    }

    /** The settlement chime, played by the phone itself (the WebView's own audio can be held back or delayed). Starts at once. */
    @JavascriptInterface
    fun chime() {
        val track = synchronized(audioLock) { chimeTrack ?: buildChime().also { chimeTrack = it } } ?: return
        try {
            track.stop()
            track.reloadStaticData() // rewind the ready-made sound
            track.play()
        } catch (_: Exception) {
            synchronized(audioLock) { chimeTrack = null } // rebuilt on the next call
            warmUpAudio()
        }
    }

    /**
     * Plays the recorded Amharic "ተከፍሏል" (res/raw/paid_am.mp3). Phones have no Amharic voice, so the word is a recording.
     * The player is prepared in advance, so this only starts it. Returns false if it could not, so the page can fall back.
     */
    @JavascriptInterface
    fun playPaidAmharic(): Boolean {
        val p = synchronized(audioLock) { if (amReady) amPlayer else null }
        if (p == null) {
            warmUpAudio()
            return false
        }
        return try {
            p.seekTo(0)
            p.start()
            true
        } catch (_: Exception) {
            synchronized(audioLock) { amReady = false; amPlayer = null }
            warmUpAudio()
            false
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

    /**
     * A random id for THIS installation (made once, kept in the app's private storage, gone on uninstall). It is what
     * "this phone" means for a team member's account: the server stores only a hash of it.
     */
    @JavascriptInterface
    fun deviceId(): String {
        val prefs = activity.getSharedPreferences("twopay_node", Context.MODE_PRIVATE)
        prefs.getString("device_id", null)?.let { return it }
        val bytes = ByteArray(24).also { java.security.SecureRandom().nextBytes(it) }
        val id = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        prefs.edit().putString("device_id", id).apply()
        return id
    }

    /** Called by the page for team members (not the owner): keep this phone on the payment terminal only. */
    @JavascriptInterface
    fun setNodeMode(on: Boolean) {
        activity.nodeMode = on
    }

    @JavascriptInterface
    fun reload() {
        activity.runOnUiThread { activity.loadStart() }
    }

    fun shutdown() {
        synchronized(audioLock) {
            try { chimeTrack?.release() } catch (_: Exception) {}
            try { amPlayer?.release() } catch (_: Exception) {}
            chimeTrack = null
            amPlayer = null
            amReady = false
        }
        louder?.release()
        louder = null
        tts?.shutdown()
        tts = null
    }
}
