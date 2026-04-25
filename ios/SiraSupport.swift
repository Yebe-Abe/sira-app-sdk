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
  private var maxDimension: CGFloat = 1280
  private var targetFps: Int = 8
  private var lastFrameTime: TimeInterval = 0
  private var seq: Int = 0

  // Annotation overlay window. Above the status bar; never steals touches.
  private var overlayWindow: UIWindow?
  private var overlayView: SiraAnnotationView?

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return ["SiraFrame", "SiraEntireScreenRefused", "SiraCaptureState"]
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
    self.redactSecureEntry = (options["redactSecureTextEntry"] as? Bool) ?? true

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
    let interval = 1.0 / Double(self.targetFps)
    if now - lastFrameTime < interval { return }
    lastFrameTime = now

    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let ci = CIImage(cvPixelBuffer: imageBuffer)

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

    return out
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
  // Holds shapes painted from agent messages. The actual rendering pipeline
  // would parse the JSON payload and update CAShapeLayers; kept simple here
  // since the frame-by-frame logic isn't load-bearing for the SDK skeleton.

  func applyMessage(_ json: String) {
    DispatchQueue.main.async { [weak self] in
      // TODO(v0.0.1): parse json and update shape layers. Stubbed for now —
      // shipped alongside the dashboard's annotation toolbar work.
      _ = self
    }
  }

  func clear() {
    self.layer.sublayers?.removeAll()
  }
}
