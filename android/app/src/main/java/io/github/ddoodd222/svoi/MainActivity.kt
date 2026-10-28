package io.github.ddoodd222.svoi

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Окно приложения: встроенная веб-версия «Своих» плюс то, чего браузер на телефоне не умеет:
 * показ экрана, звонок в фоне, «Поделиться», ссылки из мессенджеров.
 *
 * Страница лежит внутри приложения и открывается по служебному адресу appassets.androidplatform.net.
 * Мост к телефону открыт только для этой страницы: чужой сайт до него не дотянется.
 */
class MainActivity : ComponentActivity() {

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val START_URL = "$ORIGIN/assets/www/index.html"
        private val LINK = Regex("""\S*#\S*k=[A-Za-z0-9_-]{43}\S*""")
    }

    private lateinit var web: WebView
    private var reply: JavaScriptReplyProxy? = null
    private var pendingLink: String? = null
    private val pendingPermissions = mutableListOf<PermissionRequest>()
    private var askingPermissions = false
    private var inCall = false
    private val main = Handler(Looper.getMainLooper())
    private val frameInFlight = AtomicBoolean(false)
    private val binaryFrames by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER) }

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        askingPermissions = false
        val list = pendingPermissions.toList()
        pendingPermissions.clear()
        list.forEach { grantAllowed(it) }
    }

    private val askScreen = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) CallService.startScreen(this, result.resultCode, data)
        else send(JSONObject().put("ev", "screen-denied"))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        web.setBackgroundColor(0xFF12100E.toInt())
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(web.settings, true)
        }
        // Звонок не должен засыпать, когда приложение свёрнуто.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
                request?.url?.let { assetLoader.shouldInterceptRequest(it) }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return true
                if (url.host == HOST) return false
                openExternal(url) // любые чужие адреса — только во внешнем браузере
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { onMediaPermission(request) }
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "SvoiNative", setOf(ORIGIN)) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                if (isMainFrame && sourceOrigin.host == HOST) onNativeMessage(message.data, replyProxy)
            }
        }

        CallService.frameSink = { bytes ->
            // Кадр экрана: если предыдущий ещё не ушёл на страницу, новый пропускаем, а не копим.
            if (frameInFlight.compareAndSet(false, true)) {
                main.post {
                    try { sendFrame(bytes) } finally { frameInFlight.set(false) }
                }
            }
        }
        CallService.events = { ev -> main.post { send(JSONObject().put("ev", ev)) } }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (inCall) moveTaskToBack(true) else finish()
            }
        })

        web.loadUrl(START_URL)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        CallService.frameSink = null
        CallService.events = null
        CallService.update(this, active = false, cam = false)
        web.destroy()
        super.onDestroy()
    }

    // ---------- Сообщения со страницы ----------

    private fun onNativeMessage(data: String?, proxy: JavaScriptReplyProxy) {
        reply = proxy
        val msg = try {
            JSONObject(data ?: return)
        } catch (e: Exception) {
            return
        }
        when (msg.optString("cmd")) {
            "hello" -> {
                send(JSONObject().put("ev", "hello").put("screen", true).put("version", BuildConfig.VERSION_NAME))
                pendingLink?.let { send(JSONObject().put("ev", "link").put("url", it)) }
                pendingLink = null
            }
            "share" -> share(msg.optString("text"))
            "open" -> Uri.parse(msg.optString("url")).takeIf { it.scheme == "https" }?.let { openExternal(it) }
            "call" -> onCall(msg.optBoolean("active"), msg.optBoolean("cam"))
            "screen-start" -> {
                val mpm = getSystemService(MediaProjectionManager::class.java)
                askScreen.launch(mpm.createScreenCaptureIntent())
            }
            "screen-stop" -> CallService.stopScreen(this)
            "clipboard" -> send(JSONObject().put("ev", "clipboard").put("text", clipboardText()))
        }
    }

    private fun send(json: JSONObject) {
        try { reply?.postMessage(json.toString()) } catch (_: Exception) {}
    }

    @SuppressLint("RequiresFeature")
    private fun sendFrame(bytes: ByteArray) {
        val r = reply ?: return
        try {
            if (binaryFrames) r.postMessage(bytes)
            else r.postMessage("F" + Base64.encodeToString(bytes, Base64.NO_WRAP))
        } catch (_: Exception) {}
    }

    private fun onCall(active: Boolean, cam: Boolean) {
        inCall = active
        if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        CallService.update(this, active, cam)
    }

    // ---------- Камера и микрофон ----------

    private fun has(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun neededFor(request: PermissionRequest): List<String> = request.resources.mapNotNull {
        when (it) {
            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
            else -> null
        }
    }

    private fun onMediaPermission(request: PermissionRequest) {
        if (request.origin.host != HOST) {
            request.deny()
            return
        }
        if (neededFor(request).all { has(it) }) {
            grantAllowed(request)
            return
        }
        pendingPermissions += request
        if (askingPermissions) return
        askingPermissions = true
        // Спрашиваем камеру и микрофон разом: страница просит их двумя запросами почти одновременно.
        val ask = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).filter { !has(it) }.toMutableList()
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) ask += Manifest.permission.POST_NOTIFICATIONS
        askPermissions.launch(ask.toTypedArray())
    }

    private fun grantAllowed(request: PermissionRequest) {
        val allowed = request.resources.filter {
            (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && has(Manifest.permission.CAMERA)) ||
                (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && has(Manifest.permission.RECORD_AUDIO))
        }
        if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
    }

    // ---------- Ссылки, «Поделиться», буфер обмена ----------

    private fun handleIntent(intent: Intent?) {
        val text = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return
        val link = LINK.find(text)?.value ?: return
        if (reply != null) send(JSONObject().put("ev", "link").put("url", link)) else pendingLink = link
    }

    private fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        startActivity(Intent.createChooser(send, getString(R.string.share_title)))
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {}
    }

    private fun clipboardText(): String {
        val cm = getSystemService(ClipboardManager::class.java) ?: return ""
        return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
    }
}
