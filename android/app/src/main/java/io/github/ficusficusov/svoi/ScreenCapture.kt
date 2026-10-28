package io.github.ficusficusov.svoi

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Display
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min

/**
 * Снимает экран телефона системным MediaProjection и отдаёт кадры в JPEG около десяти раз в секунду.
 * Страница превращает кадры в обычную видеодорожку и отправляет её участникам по зашифрованному каналу.
 * Кадры не покидают телефон никаким другим путём и нигде не сохраняются.
 */
class ScreenCapture(
    private val ctx: Context,
    private val projection: MediaProjection,
    private val onFrame: (ByteArray) -> Unit,
    private val onStopped: () -> Unit,
) {
    private val thread = HandlerThread("svoi-screen").apply { start() }
    private val handler = Handler(thread.looper)
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var bitmap: Bitmap? = null
    private var lastFrame = 0L
    private val jpeg = ByteArrayOutputStream(256 * 1024)
    @Volatile private var stopped = false

    fun start() {
        // Android 14 требует подписаться на остановку до создания виртуального экрана.
        projection.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                handler.post { release() }
                if (!stopped) {
                    stopped = true
                    onStopped()
                }
            }
        }, handler)

        val metrics = DisplayMetrics()
        val dm = ctx.getSystemService(DisplayManager::class.java)
        @Suppress("DEPRECATION")
        dm.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        // Длинная сторона не больше 1280 точек: текст читается, а телефон не греется.
        val scale = min(1f, 1280f / max(metrics.widthPixels, metrics.heightPixels))
        val w = (metrics.widthPixels * scale).toInt() / 2 * 2
        val h = (metrics.heightPixels * scale).toInt() / 2 * 2

        val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ onImage(it) }, handler)
        reader = r
        display = projection.createVirtualDisplay(
            "svoi-screen", w, h, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            r.surface, null, handler,
        )
    }

    private fun onImage(r: ImageReader) {
        val img = try { r.acquireLatestImage() } catch (_: Exception) { null } ?: return
        try {
            val now = SystemClock.elapsedRealtime()
            if (now - lastFrame < 90) return
            lastFrame = now
            val plane = img.planes[0]
            val rowWidth = plane.rowStride / plane.pixelStride
            var bmp = bitmap
            if (bmp == null || bmp.width != rowWidth || bmp.height != img.height) {
                bmp?.recycle()
                bmp = Bitmap.createBitmap(rowWidth, img.height, Bitmap.Config.ARGB_8888)
                bitmap = bmp
            }
            plane.buffer.rewind()
            bmp!!.copyPixelsFromBuffer(plane.buffer)
            val frame = if (rowWidth != img.width) Bitmap.createBitmap(bmp, 0, 0, img.width, img.height) else bmp
            jpeg.reset()
            frame.compress(Bitmap.CompressFormat.JPEG, 70, jpeg)
            if (frame !== bmp) frame.recycle()
            onFrame(jpeg.toByteArray())
        } catch (_: Exception) {
        } finally {
            img.close()
        }
    }

    fun stop() {
        stopped = true
        try { projection.stop() } catch (_: Exception) {}
        handler.post { release() }
    }

    private fun release() {
        try { display?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        display = null
        reader = null
        bitmap?.recycle()
        bitmap = null
        thread.quitSafely()
    }
}
