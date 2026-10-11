package com.twopay.merchant

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.twopay.merchant.nfc.TapPayload
import com.twopay.merchant.nfc.TwoPayHostApduService

/**
 * The whole 2Pay merchant experience (terminal, dashboards, settings, ads) is the live web app running in a
 * WebView, so there is one codebase and every deploy reaches the phone instantly. What the web can't do on its
 * own, namely Host Card Emulation for tap-to-pay, the native bridge provides.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var bridge: NativeBridge
    private val siteHost = BuildConfig.SITE_HOST
    private val startUrl = "https://$siteHost${BuildConfig.START_PATH}"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(0xFF020617.toInt())
        }
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // the sale chime must play when settlement arrives, untouched
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString TwoPayMerchantApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }

        bridge = NativeBridge(this)
        web.addJavascriptInterface(bridge, "TwoPayNative")
        web.webViewClient = Client()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else openFromIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openFromIntent(intent)
    }

    /** Deep links (https on our host) open in-app; anything else falls back to the start page. */
    private fun openFromIntent(intent: Intent?) {
        val data = intent?.data
        if (data != null && data.scheme == "https" && data.host.equals(siteHost, ignoreCase = true)) {
            web.loadUrl(data.toString())
        } else {
            loadStart()
        }
    }

    fun loadStart() {
        web.loadUrl(startUrl)
    }

    override fun onStart() {
        super.onStart()
        // When a customer's phone finishes reading our tag, tell the page so it can show "customer tapped".
        TapPayload.onTap = {
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('twopay:tap'))", null)
        }
    }

    override fun onStop() {
        TapPayload.onTap = null
        CookieManager.getInstance().flush()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // While we're in front, our tag service wins over any other app that also claims NDEF emulation.
        NfcAdapter.getDefaultAdapter(this)?.let { nfc ->
            try {
                CardEmulation.getInstance(nfc).setPreferredService(this, ComponentName(this, TwoPayHostApduService::class.java))
            } catch (_: Exception) {
            }
        }
    }

    override fun onPause() {
        NfcAdapter.getDefaultAdapter(this)?.let { nfc ->
            try {
                CardEmulation.getInstance(nfc).unsetPreferredService(this)
            } catch (_: Exception) {
            }
        }
        web.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        TapPayload.clear()
        bridge.shutdown()
        web.destroy()
        super.onDestroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme.orEmpty()
            val ours = (scheme == "https" || scheme == "http") && uri.host.equals(siteHost, ignoreCase = true)
            if (ours || scheme == "file") return false // keep our own pages (and the offline page) in the app
            // Everything else (tel:, maps, other websites) is handed to the system, never loaded in this WebView.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) view.loadUrl("file:///android_asset/offline.html")
        }
    }
}
