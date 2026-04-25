import Foundation
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
class SiraSupport: RCTEventEmitter {

  private let recorder = RPScreenRecorder.shared()
  private let frameQueue = DispatchQueue(label: "com.sira.support.frame", qos: .userInitiated)
  private var redactionRects: [String: CGRect] = [:]
  private var redactSecureEntry: Bool = true
  private var testIDPatterns: [NSRegularExpression] = []
  private var maxDimension: CGFloat = 1280
  private var targetFps: Int = 8
  private var maxFps: Int = 15
  private var lastFrameTime: TimeInterval = 0
  private var lastFrameHash: UInt64 = 0
  // ~5% pixel-hash delta is a reliable "something visibly changed" threshold
  // without being so sensitive that font anti-aliasing trips it.
  private let motionThreshold: Int = 4
  private var seq: Int = 0

  // Annotation overlay window. Above the status bar; never steals touches.
  private var overlayWindow: UIWindow?
  private var overlayView: SiraAnnotationView?

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return ["SiraFrame", "SiraEntireScreenRefused", "SiraCaptureState"]
  }

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
    self.redactSecureEntry = (options["redactSecureTextEntry"] as? Bool) ?? true
    self.testIDPatterns = ((options["testIDPatterns"] as? [String]) ?? []).compactMap {
      // Glob → regex. * matches anything (incl. empty); ? matches one char.
      let escaped = NSRegularExpression.escapedPattern(for: $0)
        .replacingOccurrences(of: "\\*", with: ".*")
        .replacingOccurrences(of: "\\?", with: ".")
      return try? NSRegularExpression(pattern: "^" + escaped + "$")
    }

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.installOverlay()

      self.recorder.isMicrophoneEnabled = false
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

  @objc(registerRedactionRect:x:y:w:h:)
  func registerRedactionRect(
    _ id: NSString, x: NSNumber, y: NSNumber, w: NSNumber, h: NSNumber
  ) {
    let rect = CGRect(x: CGFloat(truncating: x), y: CGFloat(truncating: y),
                      width: CGFloat(truncating: w), height: CGFloat(truncating: h))
    frameQueue.async { [weak self] in
      self?.redactionRects[id as String] = rect
    }
  }

  @objc(unregisterRedactionRect:)
  func unregisterRedactionRect(_ id: NSString) {
    frameQueue.async { [weak self] in
      self?.redactionRects.removeValue(forKey: id as String)
    }
  }

  // ReplayKit on iOS does not require a system dialog. Resolves true.
  @objc(requestProjectionConsent:rejecter:)
  func requestProjectionConsent(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(true)
  }

  // MARK: - Capture

  private func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
    let now = CACurrentMediaTime()
    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let ci = CIImage(cvPixelBuffer: imageBuffer)

    // Cheap pHash-style: take 8x8 grayscale samples, threshold against mean.
    let hash = perceptualHash(ci)
    let delta = hammingDistance(hash, lastFrameHash)
    let inMotion = delta > motionThreshold

    let fpsCap = inMotion ? maxFps : targetFps
    let interval = 1.0 / Double(fpsCap)
    if now - lastFrameTime < interval { return }
    lastFrameTime = now
    lastFrameHash = hash

    let scaled = scaleAndRedact(ci)
    guard let webp = encodeWebP(scaled) else { return }

    let dims = scaled.extent
    self.seq += 1
    self.sendEvent(withName: "SiraFrame", body: [
      "webp": webp.base64EncodedString(),
      "w": Int(dims.width),
      "h": Int(dims.height),
      "seq": self.seq,
    ])
  }

  private func scaleAndRedact(_ image: CIImage) -> CIImage {
    var out = image
    let extent = image.extent

    // Downscale so the longer edge equals maxDimension.
    let longest = max(extent.width, extent.height)
    if longest > maxDimension {
      let scale = maxDimension / longest
      out = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }

    // Paint over registered SiraRedact rects.
    for (_, rect) in redactionRects {
      let block = CIImage(color: CIColor(red: 0, green: 0, blue: 0))
        .cropped(to: rect)
      out = block.composited(over: out)
    }

    // Pattern-based redaction: walk the key window and match accessibility
    // identifiers (which RN sets from testID) against each compiled pattern.
    if !testIDPatterns.isEmpty {
      var patternRects: [CGRect] = []
      DispatchQueue.main.sync {
        if let root = UIApplication.shared.connectedScenes
          .compactMap({ ($0 as? UIWindowScene)?.windows.first(where: { $0.isKeyWindow }) })
          .first {
          collectMatchingRects(in: root, into: &patternRects)
        }
      }
      for rect in patternRects {
        let block = CIImage(color: CIColor(red: 0, green: 0, blue: 0))
          .cropped(to: rect)
        out = block.composited(over: out)
      }
    }

    return out
  }

  private func collectMatchingRects(in view: UIView, into rects: inout [CGRect]) {
    if let id = view.accessibilityIdentifier, !id.isEmpty {
      let range = NSRange(location: 0, length: id.utf16.count)
      if testIDPatterns.contains(where: { $0.firstMatch(in: id, options: [], range: range) != nil }) {
        rects.append(view.convert(view.bounds, to: nil))
        return // matched ancestor covers descendants — no need to recurse
      }
    }
    for sub in view.subviews { collectMatchingRects(in: sub, into: &rects) }
  }

  private func perceptualHash(_ image: CIImage) -> UInt64 {
    // Downsample to 8x8 grayscale and threshold each pixel against the mean.
    // 64 bits, Hamming distance maps to "how different".
    let ctx = CIContext(options: [.workingColorSpace: NSNull()])
    let target = CGRect(x: 0, y: 0, width: 8, height: 8)
    let scale = min(8 / image.extent.width, 8 / image.extent.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = ctx.createCGImage(scaled, from: target) else { return 0 }
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
    // iOS 14+ supports WebP via ImageIO. We use a quality of 0.6 which gives
    // ~30-60 KB frames at 1280px on the longest edge, well under the 200-400
    // kbps target at 8 fps.
    let context = CIContext()
    guard let cg = context.createCGImage(image, from: image.extent) else { return nil }
    let mutableData = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(
      mutableData, "org.webmproject.webp" as CFString, 1, nil
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

  private static let drawColor = UIColor.systemRed.cgColor
  private static let highlightColor = UIColor(red: 1, green: 0.92, blue: 0.23, alpha: 0.4).cgColor

  func applyMessage(_ json: String) {
    guard let data = json.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let t = raw["t"] as? String else { return }

    switch t {
    case "pointer":
      guard let x = raw["x"] as? Double, let y = raw["y"] as? Double else { return }
      drawPointer(at: CGPoint(x: x, y: y))
    case "draw":
      guard let pts = raw["points"] as? [[String: Any]], !pts.isEmpty else { return }
      let cgPts: [CGPoint] = pts.compactMap {
        guard let px = $0["x"] as? Double, let py = $0["y"] as? Double else { return nil }
        return CGPoint(x: px, y: py)
      }
      drawPath(points: cgPts, color: (raw["color"] as? String).flatMap(parseColor) ?? Self.drawColor)
    case "arrow":
      guard let x1 = raw["x1"] as? Double, let y1 = raw["y1"] as? Double,
            let x2 = raw["x2"] as? Double, let y2 = raw["y2"] as? Double else { return }
      drawArrow(from: CGPoint(x: x1, y: y1), to: CGPoint(x: x2, y: y2),
                color: (raw["color"] as? String).flatMap(parseColor) ?? Self.drawColor)
    case "highlight":
      guard let x = raw["x"] as? Double, let y = raw["y"] as? Double,
            let w = raw["w"] as? Double, let h = raw["h"] as? Double else { return }
      drawHighlight(rect: CGRect(x: x, y: y, width: w, height: h),
                    color: (raw["color"] as? String).flatMap(parseColor) ?? Self.highlightColor)
    case "clear":
      clear()
    default: break
    }
  }

  func clear() {
    self.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    pointerLayer = nil
    pointerTimer?.invalidate()
    pointerTimer = nil
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

  private func drawPath(points: [CGPoint], color: CGColor) {
    let path = UIBezierPath()
    if let first = points.first { path.move(to: first) }
    for p in points.dropFirst() { path.addLine(to: p) }
    let layer = CAShapeLayer()
    layer.path = path.cgPath
    layer.strokeColor = color
    layer.fillColor = UIColor.clear.cgColor
    layer.lineWidth = 3
    layer.lineCap = .round
    self.layer.addSublayer(layer)
  }

  private func drawArrow(from a: CGPoint, to b: CGPoint, color: CGColor) {
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
    self.layer.addSublayer(layer)
  }

  private func drawHighlight(rect: CGRect, color: CGColor) {
    let layer = CAShapeLayer()
    layer.path = UIBezierPath(rect: rect).cgPath
    layer.fillColor = color
    self.layer.addSublayer(layer)
  }

  private func parseColor(_ s: String) -> CGColor? {
    var hex = s
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return nil }
    let r = CGFloat((v >> 16) & 0xff) / 255
    let g = CGFloat((v >> 8) & 0xff) / 255
    let b = CGFloat(v & 0xff) / 255
    return UIColor(red: r, green: g, blue: b, alpha: 1).cgColor
  }
}
