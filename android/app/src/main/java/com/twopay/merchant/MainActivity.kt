package com.twopay.merchant

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
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

    private companion object {
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }

    private lateinit var web: WebView
    private var splash: ImageView? = null
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
        // The logo is on screen from the first frame and goes the instant the page paints, so opening the app never shows
        // an empty dark screen while the page is fetched.
        val size = (96 * resources.displayMetrics.density).toInt()
        splash = ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher_foreground)
            layoutParams = FrameLayout.LayoutParams(size, size, Gravity.CENTER)
        }
        setContentView(
            FrameLayout(this).apply {
                setBackgroundColor(0xFF020617.toInt())
                addView(web)
                addView(splash)
            },
        )

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

    /**
     * Deep links open in-app. https links on our host load as they are. A team activation link
     * `twopay://activate/<token>` becomes the activation page on our own host; the token must be exactly the shape we issue
     * (43 URL-safe characters), so nothing else can be smuggled in. A ride-hailing checkout link `twopay://checkout?token=<token>` opens the
     * terminal with the fare filled in (same token shape). Anything else falls back to the start page.
     */
    private fun openFromIntent(intent: Intent?) {
        val data = intent?.data
        if (data != null && data.scheme == "https" && data.host.equals(siteHost, ignoreCase = true)) {
            web.loadUrl(data.toString())
        } else if (data != null && data.scheme == "twopay" && data.host == "activate") {
            val token = data.pathSegments?.firstOrNull().orEmpty()
            if (TOKEN.matches(token)) web.loadUrl("https://$siteHost/join/$token") else loadStart()
        } else if (data != null && data.scheme == "twopay" && data.host == "checkout") {
            // A ride-hailing app hands the driver a checkout link: the terminal opens with the fare already filled in.
            val token = data.getQueryParameter("token").orEmpty()
            if (TOKEN.matches(token)) web.loadUrl("https://$siteHost/terminal?session_token=$token") else loadStart()
        } else {
            loadStart()
        }
    }

    /**
     * Node mode (waiters and cashiers): the app is a payment terminal and nothing else. It can only show the 2Pay terminal,
     * sign-in and activation pages, and never hands anything to another app. The real lock is on the server (a team
     * session is refused every settings, money-routing and staff call); this keeps the phone itself on the terminal too.
     */
    @Volatile var nodeMode = false

    private fun allowedInNodeMode(path: String) = path.startsWith("/dashboard/merchant") || path.startsWith("/terminal") || path.startsWith("/signin") || path.startsWith("/join") || path.startsWith("/pay/")

    fun loadStart() {
        web.loadUrl(startUrl)
    }

    /** WebView has no window.print(); hand the page to the system print service instead. */
    fun printPage() {
        try {
            val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
            val name = "2Pay-${System.currentTimeMillis()}"
            manager.print(name, web.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
        } catch (_: Exception) {
        }
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

    private fun hideSplash() {
        splash?.let { (it.parent as? ViewGroup)?.removeView(it) }
        splash = null
    }

    private inner class Client : WebViewClient() {
        override fun onPageCommitVisible(view: WebView, url: String) = hideSplash()
        override fun onPageFinished(view: WebView, url: String) = hideSplash()

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme.orEmpty()
            val ours = (scheme == "https" || scheme == "http") && uri.host.equals(siteHost, ignoreCase = true)
            if (nodeMode) return !(scheme == "file" || (ours && allowedInNodeMode(uri.path.orEmpty()))) // stay on the terminal; never hand off to another app
            if (ours || scheme == "file") return false // keep our own pages (and the offline page) in the app
            // Everything else (tel:, maps, other websites) is handed to the system, never loaded in this WebView.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
            }
            return true
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                hideSplash()
                view.loadUrl("file:///android_asset/offline.html")
            }
        }
    }
}
