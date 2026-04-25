package com.sirascreenshare.support

import android.content.Context
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
  private val drawPaint = Paint().apply {
    color = Color.RED
    strokeWidth = 6f
    style = Paint.Style.STROKE
    isAntiAlias = true
  }
  private val pointerPaint = Paint().apply {
    color = Color.RED
    style = Paint.Style.FILL
    isAntiAlias = true
  }
  private val highlightPaint = Paint().apply {
    color = Color.argb(102, 255, 235, 59)
    style = Paint.Style.FILL
  }

  // Most recent annotations to render. Cleared on `clear`.
  private val paths = mutableListOf<Path>()
  private val arrows = mutableListOf<FloatArray>() // [x1,y1,x2,y2]
  private val highlights = mutableListOf<FloatArray>() // [x,y,w,h]
  private var pointer: FloatArray? = null

  init {
    setWillNotDraw(false)
    setBackgroundColor(Color.TRANSPARENT)
  }

  override fun onTouchEvent(event: MotionEvent?): Boolean = false

  fun applyMessage(payload: String) {
    try {
      val obj = JSONObject(payload)
      when (obj.optString("t")) {
        "pointer" -> {
          pointer = floatArrayOf(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat())
        }
        "draw" -> {
          val pts = obj.getJSONArray("points")
          val path = Path()
          for (i in 0 until pts.length()) {
            val p = pts.getJSONObject(i)
            val x = p.getDouble("x").toFloat()
            val y = p.getDouble("y").toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
          }
          paths.add(path)
        }
        "arrow" -> arrows.add(
          floatArrayOf(
            obj.getDouble("x1").toFloat(), obj.getDouble("y1").toFloat(),
            obj.getDouble("x2").toFloat(), obj.getDouble("y2").toFloat()
          )
        )
        "highlight" -> highlights.add(
          floatArrayOf(
            obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(),
            obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat()
          )
        )
      }
      postInvalidateOnAnimation()
    } catch (_: Throwable) {
      // Malformed payloads are silently ignored; protocol is internal.
    }
  }

  fun clear() {
    paths.clear()
    arrows.clear()
    highlights.clear()
    pointer = null
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    for (h in highlights) {
      canvas.drawRect(h[0], h[1], h[0] + h[2], h[1] + h[3], highlightPaint)
    }
    for (p in paths) canvas.drawPath(p, drawPaint)
    for (a in arrows) canvas.drawLine(a[0], a[1], a[2], a[3], drawPaint)
    pointer?.let { canvas.drawCircle(it[0], it[1], 18f, pointerPaint) }
  }
}
