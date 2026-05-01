package com.sirascreenshare.support

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Looper
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.DisplayMetrics
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

// Android side of the SDK.
//
// Two capture paths:
//   - "in-app":      PixelCopy against the activity's window. Silent, no
//                    dialog, no service. Misses hardware surfaces (maps,
//                    video, camera) — they appear as black rectangles.
//   - "full-screen": MediaProjection. System dialog at session start;
//                    foreground service required while running. Captures
//                    everything in the chosen app.
//
// "Entire screen" guardrail: when the first frame's dimensions equal the
// device screen rather than the activity window, we emit
// SiraEntireScreenRefused and stop the projection. JS shows recovery UI.

class SiraSupportModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), ActivityEventListener {

  override fun getName() = "SiraSupport"

  override fun getConstants(): MutableMap<String, Any> {
    return mutableMapOf("bundleId" to ctx.packageName)
  }

  init {
    ctx.addActivityEventListener(this)
  }

  // RN 0.65+ requires every native module that backs a NativeEventEmitter
  // to expose addListener/removeListeners — even as no-ops — so the JS side
  // can verify the event-emitter contract. Without these the JS console
  // logs `new NativeEventEmitter() was called with a non-null argument
  // without the required removeListeners method` on every mount.
  // The actual subscription bookkeeping happens on the JS side.
  @ReactMethod
  fun addListener(eventName: String) { /* keep: NativeEventEmitter contract */ }

  @ReactMethod
  fun removeListeners(count: Int) { /* keep: NativeEventEmitter contract */ }

  // Capture state
  private var captureMode: String = "in-app"
  private var maxDimension: Int = 1280
  private var targetFps: Int = 8
  private var maxFps: Int = 15
  private var redactSecureEntry: Boolean = true
  private val redactionRects = ConcurrentHashMap<String, Rect>()
  private var testIDPatterns: List<Regex> = emptyList()
  private var seq: Int = 0
  private var lastFrameAtMs: Long = 0
  private var lastFrameHash: Long = 0
  private val motionThreshold = 4 // bits of pHash difference

  // UI-thread-cached redaction rects. View-tree traversal must happen on
  // the main thread; the frame worker reads this cache. Refreshed by a
  // periodic UI-thread sweep below.
  private val cachedSecureRects = java.util.concurrent.CopyOnWriteArrayList<Rect>()
  private val cachedTestIdRects = java.util.concurrent.CopyOnWriteArrayList<Rect>()
  private var rectSweepRunnable: Runnable? = null
  private var rectSweepHandler: Handler? = null

  // PixelCopy path
  private var pixelCopyHandler: Handler? = null
  private var pixelCopyThread: HandlerThread? = null
  private var pixelCopyTimer: Runnable? = null

  // MediaProjection path
  private var projectionManager: MediaProjectionManager? = null
  private var projection: MediaProjection? = null
  // Android 14+ requires getMediaProjection() to be invoked AFTER the
  // mediaProjection-typed foreground service is up (the token only stays
  // valid for ~2s). So we stash the consent result and call
  // getMediaProjection later, inside startMediaProjectionCapture.
  private var pendingConsentResultCode: Int = 0
  private var pendingConsentData: Intent? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var consentResolve: Promise? = null
  private var firstFrameSeen: Boolean = false

  // Annotation overlay
  private var overlay: SiraAnnotationOverlay? = null

  // ----- JS interface -----

  @ReactMethod
  fun startCapture(options: ReadableMap, promise: Promise) {
    captureMode = options.getString("captureMode") ?: "in-app"
    maxDimension = if (options.hasKey("maxDimension")) options.getInt("maxDimension") else 1280
    targetFps = if (options.hasKey("targetFps")) options.getInt("targetFps") else 8
    maxFps = if (options.hasKey("maxFps")) options.getInt("maxFps") else 15
    redactSecureEntry =
      if (options.hasKey("redactSecureTextEntry")) options.getBoolean("redactSecureTextEntry") else true

    testIDPatterns = if (options.hasKey("testIDPatterns")) {
      val arr = options.getArray("testIDPatterns")
      val list = mutableListOf<Regex>()
      for (i in 0 until (arr?.size() ?: 0)) {
        val pat = arr?.getString(i) ?: continue
        // Glob → regex
        val regex = Regex.escape(pat)
          .replace("\\*", ".*").replace("\\?", ".")
        list.add(Regex("^$regex$"))
      }
      list
    } else emptyList()

    val activity = currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No current activity")
      return
    }

    activity.runOnUiThread {
      installOverlay(activity)
      // Kick off the periodic UI-thread rect sweep so the frame worker has
      // up-to-date redaction rects to paint over without ever touching
      // the View tree itself.
      startRectSweep(activity)
      if (captureMode == "in-app") {
        try {
          startPixelCopyCapture(activity)
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject("E_CAPTURE", e)
        }
        return@runOnUiThread
      }

      // Full-screen path needs to wait for the foreground service via a
      // CountDownLatch — must NOT happen on the UI thread or Android kills
      // the process for ANR. Push it to a worker.
      Thread {
        try {
          startMediaProjectionCapture(activity)
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject("E_CAPTURE", e)
        }
      }.start()
    }
  }

  @ReactMethod
  fun stopCapture(promise: Promise) {
    currentActivity?.runOnUiThread {
      stopAllCapture()
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun showAnnotation(payload: String) {
    currentActivity?.runOnUiThread { overlay?.applyMessage(payload) }
  }

  @ReactMethod
  fun clearAnnotations() {
    currentActivity?.runOnUiThread { overlay?.clear() }
  }

  @ReactMethod
  fun registerRedactionRect(id: String, x: Double, y: Double, w: Double, h: Double) {
    redactionRects[id] = Rect(x.toInt(), y.toInt(), (x + w).toInt(), (y + h).toInt())
  }

  @ReactMethod
  fun unregisterRedactionRect(id: String) {
    redactionRects.remove(id)
  }

  // Android needs an explicit MediaProjection consent in full-screen mode.
  // We launch the system dialog and resolve when the user makes a choice.
  // In in-app (PixelCopy) mode this is a no-op that resolves true.
  //
  // captureMode is passed in (rather than read from `this.captureMode`)
  // because the JS side calls this BEFORE startCapture, so the field
  // hasn't been set yet.
  @ReactMethod
  fun requestProjectionConsent(captureMode: String, promise: Promise) {
    if (captureMode != "full-screen") {
      promise.resolve(true)
      return
    }
    val activity = currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No current activity")
      return
    }
    val mgr = activity.getSystemService(Activity.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    projectionManager = mgr
    consentResolve = promise
    activity.startActivityForResult(mgr.createScreenCaptureIntent(), PROJECTION_REQ)
  }

  // ----- ActivityEventListener -----

  override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != PROJECTION_REQ) return
    val resolve = consentResolve ?: return
    consentResolve = null

    if (resultCode != Activity.RESULT_OK || data == null) {
      resolve.resolve(false)
      return
    }

    // Stash the consent — getMediaProjection happens later, inside the
    // foreground service window (Android 14 ordering rule).
    pendingConsentResultCode = resultCode
    pendingConsentData = data
    resolve.resolve(true)
  }

  override fun onNewIntent(intent: Intent?) { /* noop */ }

  // ----- PixelCopy capture -----

  private fun startPixelCopyCapture(activity: Activity) {
    pixelCopyThread = HandlerThread("SiraPixelCopy").apply { start() }
    pixelCopyHandler = Handler(pixelCopyThread!!.looper)

    // Tick at maxFps; emitFrame() decides per-frame whether to ship based on
    // the motion gate. That way a fast UI burst can use the full budget.
    val intervalMs = (1000L / maxFps).coerceAtLeast(33)
    pixelCopyTimer = object : Runnable {
      override fun run() {
        captureOneFrame(activity)
        pixelCopyHandler?.postDelayed(this, intervalMs)
      }
    }
    pixelCopyHandler?.post(pixelCopyTimer!!)
  }

  private fun captureOneFrame(activity: Activity) {
    val window = activity.window ?: return
    val decor = window.decorView ?: return
    val w = decor.width
    val h = decor.height
    if (w <= 0 || h <= 0) return

    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    PixelCopy.request(
      window,
      bitmap,
      { result ->
        try {
          if (result == PixelCopy.SUCCESS) {
            val processed = processBitmap(bitmap)
            emitFrame(processed)
            processed.recycle()
          }
        } catch (e: Throwable) {
          android.util.Log.e("SiraSupport", "pixel-copy frame error", e)
        } finally {
          bitmap.recycle()
        }
      },
      pixelCopyHandler!!
    )
  }

  // ----- MediaProjection capture -----

  private fun startMediaProjectionCapture(activity: Activity) {
    val data = pendingConsentData
      ?: throw IllegalStateException("No pending MediaProjection consent — call requestProjectionConsent first")
    firstFrameSeen = false

    // Capture the decor / display metrics on the UI thread (View access
    // from a worker would crash). We're called from a worker so post and
    // await via a holder.
    val sizes = java.util.concurrent.LinkedBlockingQueue<IntArray>(1)
    activity.runOnUiThread {
      val metrics = DisplayMetrics()
      val wm = activity.getSystemService(Activity.WINDOW_SERVICE) as WindowManager
      @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(metrics)
      val decorW = activity.window.decorView.width.coerceAtLeast(1)
      val decorH = activity.window.decorView.height.coerceAtLeast(1)
      sizes.offer(intArrayOf(decorW, decorH, metrics.widthPixels, metrics.heightPixels, metrics.densityDpi))
    }
    val raw = sizes.poll(2, java.util.concurrent.TimeUnit.SECONDS)
      ?: throw IllegalStateException("couldn't capture decor sizes")
    val decorW = raw[0]; val decorH = raw[1]
    val screenW = raw[2]; val screenH = raw[3]
    val densityDpi = raw[4]
    val scale = (maxDimension.toFloat() / maxOf(decorW, decorH)).coerceAtMost(1f)
    val captureW = (decorW * scale).toInt().coerceAtLeast(1)
    val captureH = (decorH * scale).toInt().coerceAtLeast(1)

    // Start the foreground service and wait for it to actually be foreground.
    // Android 14+ throws SecurityException if createVirtualDisplay runs
    // before the mediaProjection-typed service is up. CountDownLatch signal
    // from onStartCommand. We're already off the UI thread (caller pushes
    // us to a worker) so blocking is safe.
    SiraProjectionService.startedLatch = java.util.concurrent.CountDownLatch(1)
    val svc = Intent(ctx, SiraProjectionService::class.java)
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc)
    else ctx.startService(svc)
    val ok = SiraProjectionService.startedLatch?.await(3, java.util.concurrent.TimeUnit.SECONDS) ?: false
    if (!ok) throw IllegalStateException("foreground service didn't start within 3s")

    // Now that the mediaProjection-typed foreground service is up, it's
    // safe to obtain the MediaProjection and use it. Doing this earlier
    // (in onActivityResult) on Android 14+ throws SecurityException.
    val mgr = projectionManager
      ?: throw IllegalStateException("MediaProjectionManager missing")
    projection = mgr.getMediaProjection(pendingConsentResultCode, data)
    val proj = projection
      ?: throw IllegalStateException("getMediaProjection returned null")
    pendingConsentData = null
    pendingConsentResultCode = 0

    // Android 14+ requires a callback registered BEFORE createVirtualDisplay,
    // so the system can notify us when the projection ends (user pulls
    // notification, etc.). Without it createVirtualDisplay throws
    // "Must register a callback before starting capture".
    proj.registerCallback(object : MediaProjection.Callback() {
      override fun onStop() {
        // Projection ended externally (user revoked, system stopped).
        try { virtualDisplay?.release() } catch (_: Throwable) {}
        try { imageReader?.close() } catch (_: Throwable) {}
        virtualDisplay = null
        imageReader = null
      }
    }, Handler(Looper.getMainLooper()))

    // Run frame processing on a dedicated background HandlerThread —
    // bitmap conversion, perceptual-hash, WebP compression, base64 encode
    // all happen here. Putting it on the main looper would ANR within a
    // second or two and Android would kill the process.
    val frameThread = HandlerThread("SiraFrameWorker").apply { start() }
    val frameHandler = Handler(frameThread.looper)

    imageReader = ImageReader.newInstance(captureW, captureH, PixelFormat.RGBA_8888, 2).also { reader ->
      reader.setOnImageAvailableListener({ r ->
        val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
        try {
          val plane = image.planes[0]
          val buf = plane.buffer
          val pxStride = plane.pixelStride
          val rowStride = plane.rowStride
          val rowPad = rowStride - pxStride * image.width
          val bmp = Bitmap.createBitmap(
            image.width + rowPad / pxStride, image.height, Bitmap.Config.ARGB_8888
          )
          bmp.copyPixelsFromBuffer(buf)
          val cropped = Bitmap.createBitmap(bmp, 0, 0, image.width, image.height)
          bmp.recycle()

          if (!firstFrameSeen) {
            firstFrameSeen = true
            // Compare captured dimensions against device screen. If they
            // match (or are >>app-window), the user picked "Entire screen"
            // and we abort.
            val isEntireScreen = (image.width >= screenW * 0.95 && image.height >= screenH * 0.95)
              && (image.width > captureW * 1.5 || image.height > captureH * 1.5)
            if (isEntireScreen) {
              emitEntireScreenRefused(image.width, image.height, screenW, screenH)
              cropped.recycle()
              stopAllCapture()
              return@setOnImageAvailableListener
            }
          }

          val processed = processBitmap(cropped)
          emitFrame(processed)
          processed.recycle()
        } catch (e: Throwable) {
          // Anything that throws on the worker thread will otherwise reach
          // the default UncaughtExceptionHandler and kill the whole
          // process. Swallow + log; a single dropped frame is fine.
          android.util.Log.e("SiraSupport", "frame processing error", e)
        } finally {
          image.close()
        }
      }, frameHandler)

      virtualDisplay = proj.createVirtualDisplay(
        "SiraProjection",
        captureW,
        captureH,
        densityDpi,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        reader.surface,
        null,
        null
      )
    }
  }

  private fun stopAllCapture() {
    stopRectSweep()
    pixelCopyTimer?.let { pixelCopyHandler?.removeCallbacks(it) }
    pixelCopyTimer = null
    pixelCopyThread?.quitSafely()
    pixelCopyThread = null
    pixelCopyHandler = null

    virtualDisplay?.release()
    virtualDisplay = null
    imageReader?.close()
    imageReader = null
    projection?.stop()
    projection = null

    try {
      ctx.stopService(Intent(ctx, SiraProjectionService::class.java))
    } catch (_: Throwable) {}

    overlay?.let { o ->
      val parent = o.parent as? android.view.ViewGroup
      parent?.removeView(o)
    }
    overlay = null
  }

  // ----- Bitmap pipeline -----

  private fun startRectSweep(activity: Activity) {
    val handler = Handler(Looper.getMainLooper())
    rectSweepHandler = handler
    val decor = activity.window.decorView
    rectSweepRunnable = object : Runnable {
      override fun run() {
        try {
          if (redactSecureEntry) {
            val rects = mutableListOf<Rect>()
            collectSecureFieldRects(decor, rects)
            cachedSecureRects.clear()
            cachedSecureRects.addAll(rects)
          }
          if (testIDPatterns.isNotEmpty()) {
            val rects = mutableListOf<Rect>()
            collectTestIdRects(decor, rects)
            cachedTestIdRects.clear()
            cachedTestIdRects.addAll(rects)
          }
        } catch (_: Throwable) {} // never crash the UI thread
        handler.postDelayed(this, 250) // 4 sweeps/sec
      }
    }
    handler.post(rectSweepRunnable!!)
  }

  private fun stopRectSweep() {
    rectSweepRunnable?.let { rectSweepHandler?.removeCallbacks(it) }
    rectSweepRunnable = null
    rectSweepHandler = null
    cachedSecureRects.clear()
    cachedTestIdRects.clear()
  }

  private fun collectSecureFieldRects(view: View, out: MutableList<Rect>) {
    if (view is android.widget.EditText) {
      val it = view.inputType
      val isPassword = (it and android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD) != 0 ||
        (it and android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD) != 0
      if (isPassword) {
        val loc = IntArray(2); view.getLocationInWindow(loc)
        out.add(Rect(loc[0], loc[1], loc[0] + view.width, loc[1] + view.height))
      }
    }
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) collectSecureFieldRects(view.getChildAt(i), out)
    }
  }

  private fun collectTestIdRects(view: View, out: MutableList<Rect>) {
    if (reactTestIdTagKey != 0) {
      val tag = view.getTag(reactTestIdTagKey)
      if (tag is String && testIDPatterns.any { it.matches(tag) }) {
        val loc = IntArray(2); view.getLocationInWindow(loc)
        out.add(Rect(loc[0], loc[1], loc[0] + view.width, loc[1] + view.height))
        return
      }
    }
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) collectTestIdRects(view.getChildAt(i), out)
    }
  }

  private fun processBitmap(bmp: Bitmap): Bitmap {
    // Downscale.
    val longest = maxOf(bmp.width, bmp.height)
    val scaled = if (longest > maxDimension) {
      val s = maxDimension.toFloat() / longest
      Bitmap.createScaledBitmap(bmp, (bmp.width * s).toInt(), (bmp.height * s).toInt(), true)
    } else {
      bmp.copy(bmp.config ?: Bitmap.Config.ARGB_8888, true)
    }

    val canvas = Canvas(scaled)
    val paint = Paint().apply { color = Color.BLACK }
    val sx = scaled.width.toFloat() / bmp.width
    val sy = scaled.height.toFloat() / bmp.height

    // Explicit redactions (registered via JS SiraRedact wrapper).
    for (rect in redactionRects.values) {
      canvas.drawRect(
        rect.left * sx, rect.top * sy, rect.right * sx, rect.bottom * sy, paint
      )
    }
    // Cached secure-field + testID rects, populated on the UI thread by
    // the rect-sweep handler. Reading from the worker thread is safe
    // because we use CopyOnWriteArrayList.
    for (r in cachedSecureRects) {
      canvas.drawRect(r.left * sx, r.top * sy, r.right * sx, r.bottom * sy, paint)
    }
    for (r in cachedTestIdRects) {
      canvas.drawRect(r.left * sx, r.top * sy, r.right * sx, r.bottom * sy, paint)
    }

    return scaled
  }

  // RN Android stores testID as a tag on the view. The tag key is the
  // `view_tag` resource ID inside com.facebook.react. We resolve it
  // dynamically once and cache; if RN changes the convention we degrade
  // gracefully (testID matching is a no-op rather than a crash).
  private val reactTestIdTagKey: Int by lazy {
    try {
      val r = Class.forName("com.facebook.react.R\$id")
      val f = r.getDeclaredField("view_tag")
      f.getInt(null)
    } catch (_: Throwable) {
      0
    }
  }

  private fun emitFrame(bmp: Bitmap) {
    // Motion gate: pHash this frame, compare to last. If it's substantially
    // different (>motionThreshold bits) we let the burst-rate cap apply;
    // otherwise we hold to the steady targetFps to save bandwidth on idle
    // screens.
    val now = System.currentTimeMillis()
    val hash = perceptualHash(bmp)
    val delta = java.lang.Long.bitCount(hash xor lastFrameHash)
    val inMotion = delta > motionThreshold
    val fpsCap = if (inMotion) maxFps else targetFps
    val minIntervalMs = 1000L / fpsCap
    if (now - lastFrameAtMs < minIntervalMs) return
    lastFrameAtMs = now
    lastFrameHash = hash

    val out = ByteArrayOutputStream()
    @Suppress("DEPRECATION")
    val format = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
    bmp.compress(format, 60, out)
    val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)

    seq += 1
    val map = Arguments.createMap().apply {
      putString("webp", b64)
      putInt("w", bmp.width)
      putInt("h", bmp.height)
      putInt("seq", seq)
    }
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("SiraFrame", map)
  }

  // 8x8 grayscale, threshold against mean. 64-bit perceptual hash; Hamming
  // distance gives "how different is this frame from the previous?"
  private fun perceptualHash(bmp: Bitmap): Long {
    val small = Bitmap.createScaledBitmap(bmp, 8, 8, true)
    val pixels = IntArray(64)
    small.getPixels(pixels, 0, 8, 0, 0, 8, 8)
    small.recycle()
    var sum = 0
    val grays = IntArray(64)
    for (i in 0 until 64) {
      val p = pixels[i]
      val r = (p shr 16) and 0xff
      val g = (p shr 8) and 0xff
      val b = p and 0xff
      val gray = (r * 30 + g * 59 + b * 11) / 100
      grays[i] = gray
      sum += gray
    }
    val mean = sum / 64
    var bits = 0L
    for (i in 0 until 64) if (grays[i] > mean) bits = bits or (1L shl i)
    return bits
  }

  private fun emitEntireScreenRefused(cw: Int, ch: Int, sw: Int, sh: Int) {
    val map = Arguments.createMap().apply {
      putInt("capturedW", cw); putInt("capturedH", ch)
      putInt("screenW", sw); putInt("screenH", sh)
    }
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("SiraEntireScreenRefused", map)
  }

  // ----- Overlay -----

  private fun installOverlay(activity: Activity) {
    if (overlay != null) return
    val root = activity.findViewById<android.view.ViewGroup>(android.R.id.content) ?: return
    val o = SiraAnnotationOverlay(activity)
    root.addView(
      o,
      android.view.ViewGroup.LayoutParams(
        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        android.view.ViewGroup.LayoutParams.MATCH_PARENT
      )
    )
    overlay = o
  }

  companion object {
    private const val PROJECTION_REQ = 8131
  }
}
