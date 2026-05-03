package com.sirascreenshare.support

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.MotionEvent
import android.view.View
import org.json.JSONObject

// Transparent view added as the last child of the activity's content view.
// Touches pass through to the host app (returns false from onTouchEvent).
//
// Holds the latest annotation state and redraws it on every invalidate().
// Frame-by-frame parsing is left as a stub here — the v0.0.1 surface ships
// with this overlay wired in JS and bridged through showAnnotation.

class SiraAnnotationOverlay(ctx: Context) : View(ctx) {
  // Stroke paint reused per draw call; only its color and (for highlights)
  // alpha change between shapes. Cheaper than allocating a Paint per
  // annotation and avoids fighting Android's antialias caching.
  private val strokePaint = Paint().apply {
    strokeWidth = 6f
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    isAntiAlias = true
  }
  private val fillPaint = Paint().apply {
    style = Paint.Style.FILL
    isAntiAlias = true
  }
  // Pointer dot color is fixed (red) — matches the dashboard's pointer-dot
  // styling at session-stage.tsx and is independent of the user's selected
  // tool color.
  private val pointerColor = Color.RED

  // Each shape carries its own color (the dashboard's color picker sends
  // it as `#RRGGBB` per message). Falls back to red if missing/invalid.
  //
  // Shapes are keyed by their `id` from the wire. Pen strokes emit many
  // messages for the same id with progressively-longer paths; using a
  // map keeps the overlay's render cost O(unique-shapes) regardless of
  // how many incremental updates each shape received. LinkedHashMap so
  // insertion order is preserved (important for z-stacking — earlier
  // highlights render under later strokes). Mirrors the web SDK's
  // overlay/renderer.ts which uses a Map<id, msg> for the same reason.
  private val paths = LinkedHashMap<String, Pair<Path, Int>>()
  private val arrows = LinkedHashMap<String, Pair<FloatArray, Int>>() // (([x1,y1,x2,y2]), color)
  private val highlights = LinkedHashMap<String, Pair<FloatArray, Int>>() // (([x,y,w,h]), color)
  private var pointer: FloatArray? = null

  // Coordinate space the dashboard's annotations were sent in. Set via
  // SiraSupportNative.setAnnotationViewport(w, h) right after the SDK
  // emits its own viewport message. Until set (or if 0), we draw at the
  // raw received coordinates — which is correct only when viewport ==
  // overlay-pixel-size. See onDraw for the scale.
  private var viewportW: Float = 0f
  private var viewportH: Float = 0f
  private var loggedDimsOnce = false
  // Reused buffer for getLocationOnScreen so we don't allocate per frame.
  private val locationBuf = IntArray(2)

  // Gate diagnostic logs behind the host app's debuggable flag so a
  // production integrator never sees `adb logcat` chatter from the SDK.
  // ApplicationInfo.FLAG_DEBUGGABLE is set by the manifest's
  // `android:debuggable` (true in debug builds, false in release) — exactly
  // what we want here. No assumptions about RN/Expo dev mode.
  private val isDebuggable: Boolean =
    (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  init {
    setWillNotDraw(false)
    setBackgroundColor(Color.TRANSPARENT)
  }

  override fun onTouchEvent(event: MotionEvent?): Boolean = false

  fun setViewport(w: Float, h: Float) {
    viewportW = w
    viewportH = h
    postInvalidateOnAnimation()
  }

  fun applyMessage(payload: String) {
    try {
      val obj = JSONObject(payload)
      // Hex `#RRGGBB` from the dashboard. parseColor throws on invalid
      // input, so we wrap it; absent / malformed → red default.
      val color = parseHexColor(obj.optString("color", ""))
      when (obj.optString("t")) {
        "pointer" -> {
          pointer = floatArrayOf(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat())
        }
        "draw" -> {
          // Path arrives as [[x,y], [x,y], ...] tuple array.
          val id = shapeId(obj)
          val pts = obj.getJSONArray("path")
          val path = Path()
          for (i in 0 until pts.length()) {
            val p = pts.getJSONArray(i)
            val x = p.getDouble(0).toFloat()
            val y = p.getDouble(1).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
          }
          paths[id] = path to color
        }
        "arrow" -> {
          val id = shapeId(obj)
          val from = obj.getJSONArray("from")
          val to = obj.getJSONArray("to")
          arrows[id] = floatArrayOf(
            from.getDouble(0).toFloat(), from.getDouble(1).toFloat(),
            to.getDouble(0).toFloat(), to.getDouble(1).toFloat()
          ) to color
        }
        "highlight" -> {
          val id = shapeId(obj)
          val rect = obj.getJSONArray("rect")
          highlights[id] = floatArrayOf(
            rect.getDouble(0).toFloat(), rect.getDouble(1).toFloat(),
            rect.getDouble(2).toFloat(), rect.getDouble(3).toFloat()
          ) to color
        }
        "clear" -> {
          val idsArr = obj.optJSONArray("ids")
          val ids = if (idsArr != null && idsArr.length() > 0) {
            (0 until idsArr.length()).map { idsArr.getString(it) }
          } else null
          clear(ids)
        }
      }
      postInvalidateOnAnimation()
    } catch (e: Throwable) {
      // Debug-build-only breadcrumb so a protocol drift between dashboard
      // and SDK surfaces in `adb logcat | grep SiraOverlay` instead of
      // going dark on the overlay. Stripped (no log call) on release
      // builds so production integrators see nothing in their logs.
      if (isDebuggable) {
        android.util.Log.w("SiraOverlay", "dropped annotation: $payload", e)
      }
    }
  }

  // No-arg overload for the bridge module's clearAnnotations() — matches
  // legacy callers that don't carry an ids payload.
  fun clear() = clear(null)

  fun clear(ids: List<String>?) {
    if (ids.isNullOrEmpty()) {
      paths.clear()
      arrows.clear()
      highlights.clear()
      pointer = null
    } else {
      for (id in ids) {
        paths.remove(id)
        arrows.remove(id)
        highlights.remove(id)
      }
    }
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    // The dashboard's annotations arrive in *physical-screen* coordinate
    // space (the customer SDK reports `Dimensions.get("screen") * dpr`,
    // and the captured frame's aspect ratio matches that). Our overlay
    // view, however, only covers the content area below system bars
    // (status bar / camera cutout / nav bar / gesture inset / etc.).
    //
    // To make a shape arriving at viewport (X, Y) appear at SCREEN (X, Y)
    // on the customer's phone, we translate the canvas so that drawing
    // at canvas (X, Y) renders the shape AT screen (X, Y). The overlay's
    // top-left position on screen is queried at draw time via
    // getLocationOnScreen — that's the canonical Android API for it,
    // works on every API level since 1, and adapts automatically to
    // whatever insets / cutouts / windowing mode the device is in. No
    // hardcoded magic numbers, no version-specific assumptions.
    val onScreen = locationBuf
    getLocationOnScreen(onScreen)
    val offsetX = onScreen[0].toFloat()
    val offsetY = onScreen[1].toFloat()

    if (isDebuggable && !loggedDimsOnce && (paths.isNotEmpty() || arrows.isNotEmpty() ||
          highlights.isNotEmpty() || pointer != null)) {
      loggedDimsOnce = true
      android.util.Log.i(
        "SiraOverlay",
        "first annotation; canvas=${width}x${height} screen-origin=(${offsetX}, ${offsetY}) viewport=${viewportW}x${viewportH}"
      )
    }

    canvas.save()
    // Negative translate = shapes drawn at viewport (screen) coords land
    // at the equivalent position on the overlay view. Drawings outside
    // the view's bounds are clipped naturally by the View's drawing
    // rectangle.
    canvas.translate(-offsetX, -offsetY)
    // Highlights at 40% alpha (matches iOS `highlightColor` at alpha 0.4
    // and the dashboard preview) — render under everything else so the
    // shapes drawn over them stay crisp.
    for ((rect, color) in highlights.values) {
      fillPaint.color = withAlpha(color, 102) // ~40%
      canvas.drawRect(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3], fillPaint)
    }
    for ((path, color) in paths.values) {
      strokePaint.color = color
      canvas.drawPath(path, strokePaint)
    }
    for ((line, color) in arrows.values) {
      strokePaint.color = color
      canvas.drawLine(line[0], line[1], line[2], line[3], strokePaint)
      // Arrowhead — two short segments forming a 30° wedge. Mirrors the
      // iOS arrow renderer at SiraSupport.swift:421.
      val angle = Math.atan2((line[3] - line[1]).toDouble(), (line[2] - line[0]).toDouble())
      val head = 14f
      val wing = Math.PI / 6
      canvas.drawLine(
        line[2], line[3],
        (line[2] - head * Math.cos(angle - wing)).toFloat(),
        (line[3] - head * Math.sin(angle - wing)).toFloat(),
        strokePaint
      )
      canvas.drawLine(
        line[2], line[3],
        (line[2] - head * Math.cos(angle + wing)).toFloat(),
        (line[3] - head * Math.sin(angle + wing)).toFloat(),
        strokePaint
      )
    }
    pointer?.let {
      fillPaint.color = pointerColor
      canvas.drawCircle(it[0], it[1], 18f, fillPaint)
    }
    canvas.restore()
  }

  // Read the shape id from the JSON, falling back to a synthetic id if
  // missing so a malformed-but-otherwise-valid payload still renders
  // (rather than silently overwriting whatever was at the empty-string
  // key). The dashboard always sends a real id today.
  private fun shapeId(obj: JSONObject): String {
    val id = obj.optString("id", "")
    return if (id.isNotEmpty()) id else "_anon-${System.nanoTime()}"
  }

  private fun parseHexColor(raw: String): Int {
    if (raw.isEmpty()) return Color.RED
    return try {
      Color.parseColor(raw)
    } catch (_: Throwable) {
      Color.RED
    }
  }

  private fun withAlpha(color: Int, alpha: Int): Int {
    return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
  }
}
