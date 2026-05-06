import Foundation
import React
import ReplayKit
import UIKit

// SiraSupport native module (iOS).
//
// Captures via ReplayKit's RPScreenRecorder.startCapture — silent, no system
// dialog, no notification. Captures only the app's own surface, which is
// what the spec calls for. Hardware-surface limitations don't apply on iOS;
// ReplayKit handles them transparently.
//
// Frames are encoded to WebP on the device, base64-encoded, and emitted to
// JS via the SiraFrame event. JS forwards them over the data channel.

@objc(SiraSupport)
class SiraSupport: RCTEventEmitter, RPScreenRecorderDelegate {

  private let recorder = RPScreenRecorder.shared()
  private var maxDimension: CGFloat = 1280
  private var targetFps: Int = 8
  private var maxFps: Int = 15
  // Mutated only on `encodeQueue` (see processFrame). ReplayKit calls our
  // sample-buffer handler on a background queue; without serialization the
  // motion-gate read of lastFrameTime/lastFrameHash races with stopCapture
  // resetting them and with itself across overlapping invocations.
  private var lastFrameTime: TimeInterval = 0
  private var lastFrameHash: UInt64 = 0
  // ~5% pixel-hash delta is a reliable "something visibly changed" threshold
  // without being so sensitive that font anti-aliasing trips it.
  private let motionThreshold: Int = 4
  private var seq: Int = 0

  // Serial queue for the entire encode pipeline: pHash, fps gate, scale,
  // WebP encode, sendEvent. Frames arrive on ReplayKit's callback queue at
  // up to ~60 fps; the gate inside processFrame ensures most are dropped
  // quickly (just the pHash work) and only ~targetFps actually encode.
  private let encodeQueue = DispatchQueue(
    label: "team.sira.support.encode",
    qos: .userInitiated
  )
  // Single shared CIContext (Metal-backed by default). Recreating one per
  // frame inside perceptualHash + encodeWebP defeats command-buffer reuse
  // and adds ~5–10ms per frame on older devices.
  private let ciContext = CIContext(options: nil)

  // Annotation overlay window. Above the status bar; never steals touches.
  private var overlayWindow: UIWindow?
  private var overlayView: SiraAnnotationView?

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return ["SiraFrame", "SiraEntireScreenRefused", "SiraCaptureState"]
  }
  // iOS doesn't need explicit addListener/removeListeners overrides:
  // RCTEventEmitter already registers them with RN. Android's base
  // class (ReactContextBaseJavaModule) doesn't, hence the stubs in
  // SiraSupportModule.kt.

  override func constantsToExport() -> [AnyHashable: Any]! {
    return ["bundleId": Bundle.main.bundleIdentifier ?? ""]
  }

  // MARK: - JS interface

  @objc(startCapture:resolver:rejecter:)
  func startCapture(
    options: NSDictionary,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    self.maxDimension = CGFloat((options["maxDimension"] as? Int) ?? 1280)
    self.targetFps = (options["targetFps"] as? Int) ?? 8
    self.maxFps = (options["maxFps"] as? Int) ?? 15

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.installOverlay()

      self.recorder.isMicrophoneEnabled = false
      // Wire the delegate so we get notified if iOS terminates capture
      // externally (Control Center toggle, Siri, low memory, screen-
      // recording restriction kicking in mid-session). Without this the
      // overlay stays installed and the JS provider believes capture is
      // still live when it isn't.
      self.recorder.delegate = self
      self.recorder.startCapture(handler: { [weak self] sampleBuffer, bufferType, error in
        guard let self = self, error == nil else { return }
        guard bufferType == .video else { return }
        self.handleSampleBuffer(sampleBuffer)
      }) { error in
        if let error = error {
          reject("E_CAPTURE", error.localizedDescription, error)
        } else {
          resolve(nil)
        }
      }
    }
  }

  @objc(stopCapture:rejecter:)
  func stopCapture(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.recorder.stopCapture { error in
        self.removeOverlay()
        // Clear the delegate so a stale RPScreenRecorder availability
        // event after teardown can't fire stale UI updates. Apple's docs
        // describe the delegate ref as weak, but the explicit nil-out is
        // cheap insurance against future framework changes.
        self.recorder.delegate = nil
        // Reset the per-session frame counters / motion-hash state on the
        // encode queue (the only place they're mutated). A second session
        // started after this one inherits a clean slate; otherwise its
        // first frame would compare against the *last* frame of the
        // previous session and might be incorrectly motion-gated.
        self.encodeQueue.async {
          self.seq = 0
          self.lastFrameTime = 0
          self.lastFrameHash = 0
        }
        if let error = error {
          reject("E_STOP", error.localizedDescription, error)
        } else {
          resolve(nil)
        }
      }
    }
  }

  @objc(showAnnotation:)
  func showAnnotation(_ payload: NSString) {
    DispatchQueue.main.async { [weak self] in
      self?.overlayView?.applyMessage(payload as String)
    }
  }

  @objc(clearAnnotations)
  func clearAnnotations() {
    DispatchQueue.main.async { [weak self] in
      self?.overlayView?.clear()
    }
  }

  // Tells the overlay the coordinate space that incoming annotations are
  // expressed in (the dashboard's viewport). Without this, every shape
  // lands offset/scaled because the overlay's `bounds` can differ from
  // the customer's reported viewport (safe-area insets, split view,
  // external display, etc.). With this, the overlay scales each draw
  // call to its own current bounds — robust across iOS versions.
  @objc(setAnnotationViewport:h:)
  func setAnnotationViewport(_ w: NSNumber, h: NSNumber) {
    let wF = CGFloat(truncating: w)
    let hF = CGFloat(truncating: h)
    DispatchQueue.main.async { [weak self] in
      self?.overlayView?.setViewport(width: wF, height: hF)
    }
  }

  // ReplayKit doesn't show a system dialog before startCapture (the OS
  // presents its own when capture begins). We treat consent as "available
  // to attempt" — resolve true iff the device can record at all. Devices
  // with screen recording disabled in Restrictions / Screen Time report
  // isAvailable=false, and we should fail fast rather than hand the JS
  // provider a doomed startCapture call.
  @objc(requestProjectionConsent:rejecter:)
  func requestProjectionConsent(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(recorder.isAvailable)
  }

  // RPScreenRecorderDelegate: fires when the system's recording
  // availability changes. The most important transition for us is
  // available -> unavailable mid-session: that signals iOS terminated
  // capture out from under us (Control Center toggle, low-memory kill,
  // Restrictions change, etc.). Emit a SiraCaptureState event so the JS
  // provider can tear down the session cleanly instead of waiting for
  // the WebRTC peer to time out.
  func screenRecorderDidChangeAvailability(_ screenRecorder: RPScreenRecorder) {
    guard !screenRecorder.isAvailable else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.removeOverlay()
      self.sendEvent(withName: "SiraCaptureState", body: [
        "state": "stopped",
        "reason": "ios-availability-changed",
      ])
    }
  }

  // MARK: - Capture

  private func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let ci = CIImage(cvPixelBuffer: imageBuffer)
    // Hop to the encode queue so the entire pipeline runs serially: motion
    // gate, scale, WebP encode, sendEvent, and seq/lastFrame* mutation.
    // CIImage retains the underlying CVPixelBuffer, so dropping the
    // sampleBuffer reference here is safe.
    encodeQueue.async { [weak self] in
      self?.processFrame(ci)
    }
  }

  // Runs on `encodeQueue`. All shared state mutation (seq, lastFrameTime,
  // lastFrameHash) happens here, eliminating the data race between the
  // ReplayKit callback queue and stopCapture's reset.
  private func processFrame(_ ci: CIImage) {
    let now = CACurrentMediaTime()

    // Cheap pHash-style: 8x8 grayscale samples, threshold against mean.
    let hash = perceptualHash(ci)
    let delta = hammingDistance(hash, lastFrameHash)
    let inMotion = delta > motionThreshold

    let fpsCap = inMotion ? maxFps : targetFps
    let interval = 1.0 / Double(fpsCap)
    if now - lastFrameTime < interval { return }
    lastFrameTime = now
    lastFrameHash = hash

    let scaled = scale(ci)
    guard let webp = encodeWebP(scaled) else { return }

    let dims = scaled.extent
    seq += 1
    sendEvent(withName: "SiraFrame", body: [
      "seq": seq,
      // Capture timestamp in epoch ms (matches Android's emitFrame body).
      // The dashboard uses this for jitter / latency calculations.
      "ts": Int(Date().timeIntervalSince1970 * 1000),
      "webp": webp.base64EncodedString(),
      "w": Int(dims.width),
      "h": Int(dims.height),
    ])
  }

  private func scale(_ image: CIImage) -> CIImage {
    let extent = image.extent
    let longest = max(extent.width, extent.height)
    if longest > maxDimension {
      let s = maxDimension / longest
      return image.transformed(by: CGAffineTransform(scaleX: s, y: s))
    }
    return image
  }

  private func perceptualHash(_ image: CIImage) -> UInt64 {
    // Downsample to 8x8 grayscale and threshold each pixel against the mean.
    // 64 bits, Hamming distance maps to "how different".
    // Uses the shared `ciContext` (cf. encodeWebP); we don't need
    // workingColorSpace=null here — for "did anything visibly change"
    // the small color-management cost vs the fixed Metal command-buffer
    // setup is irrelevant.
    let target = CGRect(x: 0, y: 0, width: 8, height: 8)
    let scale = min(8 / image.extent.width, 8 / image.extent.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = ciContext.createCGImage(scaled, from: target) else { return 0 }
    let cs = CGColorSpaceCreateDeviceGray()
    var bytes = [UInt8](repeating: 0, count: 64)
    guard let bmp = CGContext(data: &bytes, width: 8, height: 8, bitsPerComponent: 8,
                              bytesPerRow: 8, space: cs, bitmapInfo: 0) else { return 0 }
    bmp.draw(cg, in: target)
    let mean = bytes.reduce(0, { $0 + Int($1) }) / 64
    var bits: UInt64 = 0
    for i in 0..<64 where Int(bytes[i]) > mean { bits |= UInt64(1) << UInt64(i) }
    return bits
  }

  private func hammingDistance(_ a: UInt64, _ b: UInt64) -> Int {
    return (a ^ b).nonzeroBitCount
  }

  private func encodeWebP(_ image: CIImage) -> Data? {
    // iOS 14+ supports WebP via ImageIO. The UTI is "public.webp" (the
    // system-registered identifier) — NOT "org.webmproject.webp", which
    // is the open-source webp project's identifier and is not registered
    // by ImageIO; passing it makes CGImageDestinationCreateWithData return
    // nil, silently dropping every frame. (This was the bug in 0.0.3.)
    //
    // Quality 0.6 → ~30–60 KB at 1280px on the longest edge, well under
    // our 200–400 kbps target at 8 fps.
    guard let cg = ciContext.createCGImage(image, from: image.extent) else { return nil }
    let mutableData = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(
      mutableData, "public.webp" as CFString, 1, nil
    ) else { return nil }
    let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.6]
    CGImageDestinationAddImage(dest, cg, opts as CFDictionary)
    if !CGImageDestinationFinalize(dest) { return nil }
    return mutableData as Data
  }

  // MARK: - Overlay

  private func installOverlay() {
    guard overlayWindow == nil else { return }
    let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive })
    guard let windowScene = scene as? UIWindowScene else { return }

    let win = UIWindow(windowScene: windowScene)
    win.windowLevel = .alert + 1
    win.backgroundColor = .clear
    win.isUserInteractionEnabled = false

    let view = SiraAnnotationView(frame: win.bounds)
    view.backgroundColor = .clear
    win.rootViewController = SiraPassthroughVC(overlay: view)
    win.isHidden = false

    self.overlayWindow = win
    self.overlayView = view
  }

  private func removeOverlay() {
    overlayWindow?.isHidden = true
    overlayWindow = nil
    overlayView = nil
  }
}

// MARK: - Overlay primitives

private class SiraPassthroughVC: UIViewController {
  init(overlay: UIView) {
    super.init(nibName: nil, bundle: nil)
    self.view = overlay
  }
  required init?(coder: NSCoder) { fatalError() }
}

private class SiraAnnotationView: UIView {
  // Renders agent annotations on a transparent CALayer above the host app.
  // Shapes accumulate across messages; `clear` wipes them.
  //
  // Pointer fades after POINTER_TTL_S of inactivity so a stale cursor
  // doesn't stay on screen forever after the agent goes quiet.

  private let pointerTTLSec: TimeInterval = 1.5
  private var pointerLayer: CAShapeLayer?
  private var pointerTimer: Timer?

  // Shape layers keyed by id. Pen strokes emit many messages with the
  // same id (progressively-longer paths) — `upsertShape` removes any
  // prior layer for that id and adds the new one, keeping render cost
  // O(unique-shapes) regardless of incremental update count. Mirrors
  // the web SDK's overlay/renderer.ts Map<id, msg>.
  private var shapeLayers: [String: CAShapeLayer] = [:]

  // Coordinate space the dashboard is sending in (the same w/h that the
  // SDK reported in its `viewport` message). Set via the bridge. Until
  // set, falls back to 1:1 — correct only when the customer's reported
  // viewport happens to equal `bounds.size`. Querying `bounds` at draw
  // time means we adapt to safe-area insets, split view, external
  // displays, etc. without iOS-version-specific assumptions.
  private var viewportW: CGFloat = 0
  private var viewportH: CGFloat = 0
  private var loggedDimsOnce = false

  func setViewport(width: CGFloat, height: CGFloat) {
    viewportW = width
    viewportH = height
  }

  private static let drawColor = UIColor.systemRed.cgColor
  private static let highlightColor = UIColor(red: 1, green: 0.92, blue: 0.23, alpha: 0.4).cgColor

  func applyMessage(_ json: String) {
    guard let data = json.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let t = raw["t"] as? String else {
      drop("parse failure", json)
      return
    }

    logDimsIfNeeded()

    // Wire-format note: shape keys (`path` / `from` / `to` / `rect`)
    // mirror the @sira/shared AnnotationMsg Zod schema. Coordinates are
    // 2-element number tuples on the wire (smaller payloads on long pen
    // paths than `{x, y}` objects). Color is `#RRGGBB`. All coords below
    // are scaled into the view's bounds via `scalePoint` / `scaleRect`.
    switch t {
    case "pointer":
      guard let x = raw["x"] as? Double, let y = raw["y"] as? Double else {
        drop("malformed pointer", json); return
      }
      drawPointer(at: translatePoint(CGPoint(x: x, y: y)))
    case "draw":
      guard let pts = doublePairs(raw["path"]), !pts.isEmpty else {
        drop("malformed draw", json); return
      }
      let cgPts: [CGPoint] = pts.compactMap {
        guard $0.count >= 2 else { return nil }
        return translatePoint(CGPoint(x: $0[0], y: $0[1]))
      }
      guard !cgPts.isEmpty else {
        drop("draw with no valid points", json); return
      }
      drawPath(id: shapeId(raw), points: cgPts,
               color: (raw["color"] as? String).flatMap { parseColor($0) } ?? Self.drawColor)
    case "arrow":
      guard let from = doubles(raw["from"]), from.count >= 2,
            let to = doubles(raw["to"]), to.count >= 2 else {
        drop("malformed arrow", json); return
      }
      drawArrow(id: shapeId(raw),
                from: translatePoint(CGPoint(x: from[0], y: from[1])),
                to: translatePoint(CGPoint(x: to[0], y: to[1])),
                color: (raw["color"] as? String).flatMap { parseColor($0) } ?? Self.drawColor)
    case "highlight":
      guard let rect = doubles(raw["rect"]), rect.count >= 4 else {
        drop("malformed highlight", json); return
      }
      // Highlight at 40% alpha — a "highlight" should let underlying
      // content show through. Without `alpha: 0.4` we'd render an opaque
      // rectangle of the agent's chosen color over the captured screen.
      // (Android's overlay does the equivalent with Color.argb(102, ...).)
      let color = (raw["color"] as? String).flatMap { parseColor($0, alpha: 0.4) } ?? Self.highlightColor
      let translated = translateRect(CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]))
      drawHighlight(id: shapeId(raw), rect: translated, color: color)
    case "clear":
      let ids = raw["ids"] as? [String]
      clear(ids: ids)
    default:
      drop("unknown type \(t)", json)
    }
  }

  // Read shape id, falling back to a synthetic id if missing — keeps a
  // malformed-but-otherwise-valid payload from silently overwriting the
  // empty-string key. Dashboard always sends a real id today.
  private func shapeId(_ raw: [String: Any]) -> String {
    if let id = raw["id"] as? String, !id.isEmpty { return id }
    return "_anon-\(Date().timeIntervalSince1970)"
  }
  // Replace any prior layer for `id` and insert the new one.
  private func upsertShape(id: String, layer: CAShapeLayer) {
    shapeLayers[id]?.removeFromSuperlayer()
    shapeLayers[id] = layer
    self.layer.addSublayer(layer)
  }

  // Annotations arrive in physical-screen coord space (the SDK reports
  // `Dimensions.get("screen") * dpr` and the captured frame matches
  // that). Our overlay view's local (0, 0) usually equals screen (0, 0)
  // for full-screen apps, but on iPad split view the window itself sits
  // at a screen offset, and on multi-window scenes the view may not fill
  // its window. We translate every incoming point/rect by the view's
  // current screen-origin so a shape sent at SCREEN (X, Y) lands at
  // SCREEN (X, Y) regardless of windowing mode. Queried at draw time via
  // `convert(_:to:)` — the canonical UIKit API for this, no version-
  // specific assumptions.
  private func screenOrigin() -> CGPoint {
    guard let window = self.window else { return .zero }
    let inWindow = self.convert(CGPoint.zero, to: window)
    // window.frame is in screen coords (the screen's coordinate space),
    // even on split-view iPad. Adding gets us screen coords for view's
    // local (0, 0).
    return CGPoint(x: inWindow.x + window.frame.origin.x,
                   y: inWindow.y + window.frame.origin.y)
  }
  private func translatePoint(_ p: CGPoint) -> CGPoint {
    let off = screenOrigin()
    return CGPoint(x: p.x - off.x, y: p.y - off.y)
  }
  private func translateRect(_ r: CGRect) -> CGRect {
    let off = screenOrigin()
    return CGRect(x: r.origin.x - off.x, y: r.origin.y - off.y,
                  width: r.width, height: r.height)
  }

  // Stripped from release builds via `#if DEBUG`. Xcode defines DEBUG=1
  // for Debug configurations by default; integrators shipping a Release
  // build see no log statements compiled in.
  private func drop(_ reason: String, _ json: String) {
    #if DEBUG
    print("[Sira] dropped annotation (\(reason)): \(json)")
    #endif
  }
  private func logDimsIfNeeded() {
    #if DEBUG
    if loggedDimsOnce { return }
    loggedDimsOnce = true
    let off = screenOrigin()
    print("[Sira] overlay first annotation; bounds=\(bounds.size) screen-origin=\(off) viewport=(\(viewportW), \(viewportH))")
    #endif
  }

  // No-arg overload for the bridge module's clearAnnotations() — matches
  // legacy callers that don't carry an ids payload.
  func clear() { clear(ids: nil) }

  func clear(ids: [String]?) {
    if let ids, !ids.isEmpty {
      for id in ids {
        shapeLayers[id]?.removeFromSuperlayer()
        shapeLayers.removeValue(forKey: id)
      }
    } else {
      shapeLayers.values.forEach { $0.removeFromSuperlayer() }
      shapeLayers.removeAll()
      pointerLayer?.removeFromSuperlayer()
      pointerLayer = nil
      pointerTimer?.invalidate()
      pointerTimer = nil
    }
  }

  private func drawPointer(at p: CGPoint) {
    pointerLayer?.removeFromSuperlayer()
    let dot = CAShapeLayer()
    dot.path = UIBezierPath(arcCenter: p, radius: 12, startAngle: 0, endAngle: .pi * 2, clockwise: true).cgPath
    dot.fillColor = Self.drawColor
    self.layer.addSublayer(dot)
    pointerLayer = dot
    pointerTimer?.invalidate()
    pointerTimer = Timer.scheduledTimer(withTimeInterval: pointerTTLSec, repeats: false) { [weak self] _ in
      self?.pointerLayer?.removeFromSuperlayer()
      self?.pointerLayer = nil
    }
  }

  private func drawPath(id: String, points: [CGPoint], color: CGColor) {
    let path = UIBezierPath()
    if let first = points.first { path.move(to: first) }
    for p in points.dropFirst() { path.addLine(to: p) }
    let layer = CAShapeLayer()
    layer.path = path.cgPath
    layer.strokeColor = color
    layer.fillColor = UIColor.clear.cgColor
    layer.lineWidth = 3
    layer.lineCap = .round
    upsertShape(id: id, layer: layer)
  }

  private func drawArrow(id: String, from a: CGPoint, to b: CGPoint, color: CGColor) {
    let path = UIBezierPath()
    path.move(to: a); path.addLine(to: b)
    // Arrowhead — two short segments forming a 30° wedge.
    let angle = atan2(b.y - a.y, b.x - a.x)
    let head: CGFloat = 14
    let wing: CGFloat = .pi / 6
    path.move(to: b)
    path.addLine(to: CGPoint(x: b.x - head * cos(angle - wing), y: b.y - head * sin(angle - wing)))
    path.move(to: b)
    path.addLine(to: CGPoint(x: b.x - head * cos(angle + wing), y: b.y - head * sin(angle + wing)))
    let layer = CAShapeLayer()
    layer.path = path.cgPath
    layer.strokeColor = color
    layer.fillColor = UIColor.clear.cgColor
    layer.lineWidth = 3
    upsertShape(id: id, layer: layer)
  }

  private func drawHighlight(id: String, rect: CGRect, color: CGColor) {
    let layer = CAShapeLayer()
    layer.path = UIBezierPath(rect: rect).cgPath
    layer.fillColor = color
    upsertShape(id: id, layer: layer)
  }

  private func parseColor(_ s: String, alpha: CGFloat = 1) -> CGColor? {
    var hex = s
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return nil }
    let r = CGFloat((v >> 16) & 0xff) / 255
    let g = CGFloat((v >> 8) & 0xff) / 255
    let b = CGFloat(v & 0xff) / 255
    return UIColor(red: r, green: g, blue: b, alpha: alpha).cgColor
  }

  // JSONSerialization decodes JSON numbers as NSNumber-bridged values. Casting
  // straight to `[Double]` works for fractional inputs but silently fails when
  // the JSON contains integer literals (e.g. `[1, 2]` instead of `[1.5, 2.7]`)
  // because the array bridges as `[Int]` and Swift won't down-cast a
  // heterogeneous numeric array. Convert via NSNumber, which always works.
  private func doubles(_ v: Any?) -> [Double]? {
    if let d = v as? [Double] { return d }
    if let n = v as? [NSNumber] { return n.map { $0.doubleValue } }
    if let arr = v as? [Any] {
      let mapped = arr.compactMap { ($0 as? NSNumber)?.doubleValue }
      return mapped.count == arr.count ? mapped : nil
    }
    return nil
  }
  private func doublePairs(_ v: Any?) -> [[Double]]? {
    if let d = v as? [[Double]] { return d }
    if let arr = v as? [[NSNumber]] { return arr.map { $0.map { $0.doubleValue } } }
    if let arr = v as? [[Any]] {
      return arr.map { $0.compactMap { ($0 as? NSNumber)?.doubleValue } }
    }
    return nil
  }
}
