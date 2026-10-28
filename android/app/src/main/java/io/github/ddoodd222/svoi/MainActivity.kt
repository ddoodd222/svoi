package io.github.ddoodd222.svoi

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.IntentFilter
import android.content.res.Configuration
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.Icon
import android.media.AudioManager
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Rational
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
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayOutputStream
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
        const val ACTION_PIP_MIC = "io.github.ddoodd222.svoi.PIP_MIC"
        const val ACTION_PIP_CAM = "io.github.ddoodd222.svoi.PIP_CAM"
        private val LINK = Regex("""\S*#\S*k=[A-Za-z0-9_-]{43}\S*""")
    }

    private lateinit var web: WebView
    private var reply: JavaScriptReplyProxy? = null
    private var pendingLink: String? = null
    private val pendingPermissions = mutableListOf<PermissionRequest>()
    private var askingPermissions = false
    private var inCall = false
    private var micOn = false
    private var camOn = false
    // Окошко поверх других приложений и громкое видео в них, пока звонок свёрнут.
    private var inPip = false
    private var videoSound = true
    private var internalLaunch = false // свой выбор фото или «Поделиться» — не повод сворачивать звонок
    private var savedAudioMode = -1
    private val audio by lazy { getSystemService(AudioManager::class.java) }
    private val pipReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_PIP_MIC -> send(JSONObject().put("ev", "pip-action").put("action", "mic"))
                ACTION_PIP_CAM -> send(JSONObject().put("ev", "pip-action").put("action", "cam"))
            }
        }
    }
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

    // Фото для чата: системный выбор фото, без доступа ко всей галерее.
    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) {
            send(JSONObject().put("ev", "image").put("cancel", true))
            return@registerForActivityResult
        }
        Thread {
            val json = try {
                encodeImage(uri)
            } catch (e: Throwable) {
                JSONObject().put("ev", "image").put("error", true)
            }
            main.post { send(json) }
        }.start()
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
                // «Назад» во время звонка сворачивает звонок в окошко, а не закрывает его.
                if (inCall) { if (!enterPip()) moveTaskToBack(true) } else finish()
            }
        })
        ContextCompat.registerReceiver(this, pipReceiver,
            IntentFilter().apply { addAction(ACTION_PIP_MIC); addAction(ACTION_PIP_CAM) },
            ContextCompat.RECEIVER_NOT_EXPORTED)

        web.loadUrl(START_URL)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        internalLaunch = false
    }

    // Человек ушёл на главный экран или в другое приложение во время звонка: звонок — в окошко.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (inCall && !internalLaunch) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
        send(JSONObject().put("ev", "pip").put("on", inPip))
        mediaMode(inPip && inCall && videoSound)
    }

    private fun enterPip(): Boolean {
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
        return try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) { false }
    }

    private fun pipParams(): PictureInPictureParams {
        fun action(icon: Int, title: String, act: String, code: Int) = RemoteAction(
            Icon.createWithResource(this, icon), title, title,
            PendingIntent.getBroadcast(this, code, Intent(act).setPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        val actions = if (!inCall) emptyList() else listOf(
            if (micOn) action(R.drawable.ic_pip_mic, "Выключить микрофон", ACTION_PIP_MIC, 1)
            else action(R.drawable.ic_pip_mic_off, "Включить микрофон", ACTION_PIP_MIC, 1),
            if (camOn) action(R.drawable.ic_pip_cam, "Выключить камеру", ACTION_PIP_CAM, 2)
            else action(R.drawable.ic_pip_cam_off, "Включить камеру", ACTION_PIP_CAM, 2),
        )
        return PictureInPictureParams.Builder().setAspectRatio(Rational(3, 4)).setActions(actions).build()
    }

    /**
     * Во время звонка Android держит режим разговора: видео в YouTube и других приложениях звучит тихо
     * или в верхний динамик. Пока звонок свёрнут в окошко, переводим звук в обычный режим, а при возврате — обратно.
     */
    private fun mediaMode(on: Boolean) {
        try {
            if (on && savedAudioMode == -1) {
                savedAudioMode = audio.mode
                if (savedAudioMode != AudioManager.MODE_NORMAL) audio.mode = AudioManager.MODE_NORMAL
            } else if (!on && savedAudioMode != -1) {
                if (inCall && audio.mode == AudioManager.MODE_NORMAL) audio.mode = savedAudioMode
                savedAudioMode = -1
            }
        } catch (_: Exception) {}
    }

    override fun onDestroy() {
        try { unregisterReceiver(pipReceiver) } catch (_: Exception) {}
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
                send(JSONObject().put("ev", "hello").put("screen", true).put("images", true).put("version", BuildConfig.VERSION_NAME))
                pendingLink?.let { send(JSONObject().put("ev", "link").put("url", it)) }
                pendingLink = null
            }
            "share" -> share(msg.optString("text"))
            "open" -> Uri.parse(msg.optString("url")).takeIf { it.scheme == "https" }?.let { openExternal(it) }
            "call" -> onCall(msg.optBoolean("active"), msg.optBoolean("mic"), msg.optBoolean("cam"))
            "video-sound" -> {
                videoSound = msg.optBoolean("on", true)
                mediaMode(inPip && inCall && videoSound)
            }
            "screen-start" -> {
                internalLaunch = true
                val mpm = getSystemService(MediaProjectionManager::class.java)
                askScreen.launch(mpm.createScreenCaptureIntent())
            }
            "screen-stop" -> CallService.stopScreen(this)
            "clipboard" -> send(JSONObject().put("ev", "clipboard").put("text", clipboardText()))
            "pick-image" -> {
                internalLaunch = true
                pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
            "save-image" -> saveImage(msg.optString("data"), msg.optString("mime"), msg.optString("name"))
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

    private fun onCall(active: Boolean, mic: Boolean, cam: Boolean) {
        inCall = active
        micOn = mic
        camOn = cam
        try { setPictureInPictureParams(pipParams()) } catch (_: Exception) {}
        if (!active) mediaMode(false)
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
        internalLaunch = true
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        startActivity(Intent.createChooser(send, getString(R.string.share_title)))
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {}
    }

    // ---------- Фото в чате ----------

    /**
     * Фото уменьшается до 2048 точек по длинной стороне и пересжимается в JPEG.
     * Так открывается и HEIC, а метки места и модель телефона из файла не уходят собеседникам.
     */
    private fun encodeImage(uri: Uri): JSONObject {
        val max = 2048
        var bitmap: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
            // ImageDecoder сам поворачивает снимок по метке ориентации.
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri)) { decoder, info, _ ->
                val w = info.size.width
                val h = info.size.height
                val k = minOf(1.0, max.toDouble() / maxOf(w, h))
                decoder.setTargetSize(maxOf(1, (w * k).toInt()), maxOf(1, (h * k).toInt()))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= max) sample *= 2
            val raw = contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
            } ?: throw IllegalStateException("decode")
            val degrees = contentResolver.openInputStream(uri)?.use {
                when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            } ?: 0f
            val k = minOf(1f, max.toFloat() / maxOf(raw.width, raw.height))
            val m = Matrix().apply { postScale(k, k); postRotate(degrees) }
            Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
        }
        if (bitmap.hasAlpha()) {
            // У JPEG нет прозрачности: прозрачное станет белым, а не чёрным.
            val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            Canvas(flat).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
            bitmap = flat
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 86, out)
        return JSONObject().put("ev", "image")
            .put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
            .put("w", bitmap.width).put("h", bitmap.height)
    }

    /** Сохранить фото из чата в галерею, в папку «Pictures/Svoi». Без разрешений: так умеет Android 10 и новее. */
    private fun saveImage(data: String, mime: String, name: String) {
        if (mime !in setOf("image/jpeg", "image/png", "image/gif", "image/webp")) return
        Thread {
            val ok = try {
                if (Build.VERSION.SDK_INT < 29) throw IllegalStateException("old android")
                val bytes = Base64.decode(data, Base64.DEFAULT)
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80))
                    put(MediaStore.Images.Media.MIME_TYPE, mime)
                    put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Svoi")
                }
                val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("insert")
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("write")
                true
            } catch (e: Throwable) {
                false
            }
            main.post { send(JSONObject().put("ev", "saved").put("ok", ok)) }
        }.start()
    }

    private fun clipboardText(): String {
        val cm = getSystemService(ClipboardManager::class.java) ?: return ""
        return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
    }
}
