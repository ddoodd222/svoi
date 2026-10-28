package io.github.ficusficusov.svoi

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Служба звонка. Пока она работает, Android не отбирает микрофон и камеру у свёрнутого приложения,
 * а в шторке висит уведомление «Идёт звонок». Здесь же живёт показ экрана.
 */
class CallService : Service() {

    companion object {
        private const val CHANNEL = "call"
        private const val NOTIFICATION_ID = 7
        private const val ACTION_CALL = "svoi.call"
        private const val ACTION_SCREEN_START = "svoi.screen.start"
        private const val ACTION_SCREEN_STOP = "svoi.screen.stop"

        @Volatile var frameSink: ((ByteArray) -> Unit)? = null
        @Volatile var events: ((String) -> Unit)? = null

        private var running = false
        private var sharing = false
        private var lastCam: Boolean? = null

        private fun granted(ctx: Context, p: String) =
            ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

        fun update(ctx: Context, active: Boolean, cam: Boolean) {
            val intent = Intent(ctx, CallService::class.java)
            if (!active) {
                if (running) ctx.stopService(intent)
                lastCam = null
                return
            }
            // Службе нужен хотя бы один разрешённый тип: микрофон или включённая камера.
            // Иначе Android закроет приложение, потому что служба не сможет стать «передней».
            val canRun = granted(ctx, Manifest.permission.RECORD_AUDIO) || (cam && granted(ctx, Manifest.permission.CAMERA))
            if (!canRun) {
                if (running && !sharing) ctx.stopService(intent) // показ экрана держит службу сам
                lastCam = null
                return
            }
            if (running && lastCam == cam) return
            lastCam = cam
            try {
                ContextCompat.startForegroundService(ctx, intent.setAction(ACTION_CALL).putExtra("cam", cam))
            } catch (_: Exception) {}
        }

        fun startScreen(ctx: Context, code: Int, data: Intent) {
            val intent = Intent(ctx, CallService::class.java)
                .setAction(ACTION_SCREEN_START)
                .putExtra("code", code)
                .putExtra("data", data)
            ContextCompat.startForegroundService(ctx, intent)
        }

        fun stopScreen(ctx: Context) {
            if (running) ctx.startService(Intent(ctx, CallService::class.java).setAction(ACTION_SCREEN_STOP))
        }
    }

    private var cam = false
    private var capture: ScreenCapture? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        when (intent?.action) {
            ACTION_CALL -> {
                cam = intent.getBooleanExtra("cam", false)
                foreground()
            }
            ACTION_SCREEN_START -> startCapture(intent)
            ACTION_SCREEN_STOP -> {
                // Остановили кнопкой в шторке или со страницы — в любом случае сообщаем странице.
                val wasSharing = capture != null
                stopCapture()
                foreground()
                if (wasSharing) events?.invoke("screen-stopped")
            }
            else -> foreground()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopCapture()
        running = false
        lastCam = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun startCapture(intent: Intent) {
        val code = intent.getIntExtra("code", 0)
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra("data")
        }
        stopCapture()
        try {
            // Android 14: служба с типом «показ экрана» должна подняться до того, как мы получим доступ к экрану.
            foreground(projection = true)
            val mpm = getSystemService(MediaProjectionManager::class.java)
            val projection = mpm.getMediaProjection(code, data ?: throw IllegalStateException("no consent"))
            val c = ScreenCapture(
                this,
                projection,
                onFrame = { frameSink?.invoke(it) },
                onStopped = {
                    main.post {
                        capture = null
                        sharing = false
                        foreground()
                        events?.invoke("screen-stopped")
                    }
                },
            )
            capture = c
            c.start()
            sharing = true
            events?.invoke("screen-started")
        } catch (e: Exception) {
            capture = null
            foreground()
            events?.invoke("screen-denied")
        }
    }

    private fun stopCapture() {
        capture?.stop()
        capture = null
        sharing = false
    }

    private fun has(p: String) = granted(this, p)

    private fun foreground(projection: Boolean = capture != null) {
        var type = 0
        if (Build.VERSION.SDK_INT >= 30) {
            if (has(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (cam && has(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        if (projection && Build.VERSION.SDK_INT >= 29) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (type == 0 && Build.VERSION.SDK_INT >= 30) {
            stopSelf()
            return
        }
        val note = notification(projection)
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, note, type)
        } catch (e: Exception) {
            // Свёрнутому приложению Android 14 не даёт добавить камеру. Тогда держим хотя бы звук.
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, note, type and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA.inv())
            } catch (_: Exception) {
                stopSelf()
            }
        }
    }

    private fun notification(sharing: Boolean): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_call), NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(if (sharing) R.string.note_sharing_title else R.string.note_call_title))
            .setContentText(getString(if (sharing) R.string.note_sharing_text else R.string.note_call_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (sharing) {
            val stop = PendingIntent.getService(
                this, 1,
                Intent(this, CallService::class.java).setAction(ACTION_SCREEN_STOP),
                PendingIntent.FLAG_IMMUTABLE,
            )
            b.addAction(0, getString(R.string.note_stop_sharing), stop)
        }
        return b.build()
    }
}
