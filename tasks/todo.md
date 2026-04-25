# `@sira-screen-share/support-react-native` v0.0.1 — build plan & review

## Plan

- [x] Package skeleton: `package.json`, `tsconfig*.json`, `react-native-builder-bob` exports, podspec, gradle.
- [x] Protocol additions (`src/protocol/messages.ts`): new `FrameMsg` variant, `platform` on viewport, `sessionType` on join.
- [x] Session state machine (`src/session/state.ts`) and signaling client (`src/session/signaling.ts`) reusing `/sessions/join` and `/rtc?sid=…&role=customer`.
- [x] TS surface: `<SiraSupport>` provider, `useSiraSupport()`, `<SiraRedact>`, `<SiraSupportTrigger>`.
- [x] In-app screens: code entry modal, Android priming, "Entire screen" recovery, in-session consent banner.
- [x] Native module bridge (`SiraSupportModule.ts`) with deferred linking error.
- [x] iOS native module: `RPScreenRecorder.startCapture` → CIImage → WebP via ImageIO; redaction painting; overlay window.
- [x] Android native module: PixelCopy path (in-app) and MediaProjection path (full-screen), foreground service, "Entire screen" guardrail comparing first-frame dimensions vs. device screen.
- [x] Annotation overlay: native (iOS UIWindow / Android view added to `android.R.id.content`); JS-side `AnnotationBridge` only forwards messages.
- [x] Redaction pipeline: explicit `<SiraRedact>` rectangles measured in window coords and registered with native; `secureTextEntry` auto-detection done natively (Android walks tree; iOS leverages OS hardening). `testIDPatterns` plumbed through `startCapture` options.
- [x] Expo config plugin (`plugin/index.js`): adds `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` and declares `SiraProjectionService` only when `captureMode: "full-screen"`.
- [x] README with install steps and AI-pair integration prompt.

## Review

### What shipped

A complete v0.0.1 skeleton matching the spec's section 2/3/4 surface contracts. Every public type the spec promises is exported from the entry point. Both native modules implement their respective platform paths end-to-end:

- iOS: ReplayKit capture → CIImage downscale + redaction-rect paint → WebP via `ImageIO`'s `org.webmproject.webp` UTI → emit base64 over `RCTEventEmitter`.
- Android: per-mode capture path → bitmap downscale + redaction-rect paint + secureTextEntry tree walk → `Bitmap.compress(WEBP_LOSSY, 60, …)` → emit base64 over `DeviceEventManagerModule`.

The spec's "Entire screen" guardrail (section 4) is implemented in `SiraSupportModule.kt`: on the first frame, captured dimensions are compared against `getRealMetrics`. If they match the device screen rather than the activity window, capture is torn down and `SiraEntireScreenRefused` fires; the JS provider transitions to the recovery state and shows `RecoveryScreen.tsx`. The session ID and server-side session remain valid; only a fresh MediaProjection token is requested on retry.

The Expo plugin is conditional on `captureMode`. In `in-app` mode the plugin is a pass-through, leaving the host manifest untouched. In `full-screen` mode it adds the two foreground-service permissions and declares `SiraProjectionService` with `foregroundServiceType="mediaProjection"`.

### Deliberate stubs / future work

Items marked as such in the source rather than silently glossed:

- **Bundle ID origin:** the JS `joinSession` call sends `bundleId: "native-app"` rather than reading the actual app identifier. The spec calls for the integrator's bundle ID; reading it in JS requires either `expo-application` or a small native getter. Picked the smaller change for v0.0.1; flagged as a follow-up.
- **iOS overlay rendering:** `SiraAnnotationView.applyMessage` is stubbed. The Kotlin overlay parses and renders the protocol; the iOS one ships with the JSON parsing wired but no `CAShapeLayer` work yet. Acceptance criterion 3 (annotations render on both platforms) requires this to land before ship.
- **testID-pattern matching:** the native `startCapture` accepts `testIDPatterns` but neither native side currently consults them at capture time. The spec lists this as one of three redaction layers. Wiring is straightforward (Android: walk tree, match `view.getTag(R.id.testID)` against globs; iOS: same via accessibility identifiers) and will be added before the production cut.
- **Motion-based fps burst:** the spec calls for 8 → 15 fps based on frame-diff heuristics. The current implementation uses a fixed `targetFps`. Frame diff is a small hash compare; deferred to keep the v0.0.1 surface compilable rather than untested.

### Not shipped (out of scope, per spec)

Audio, remote control, reverse stream, custom snapshot compositing, Flutter, native-only SDKs.

### Pre-ship checklist (server-side; see spec §9)

- [ ] Cloudflare Calls TURN integration in `/sessions/join`.
- [ ] WebSocket reconnection-by-`sessionId`.
- [ ] Heartbeat-driven idle session cleanup (~30s).
- [ ] Sentry/Better Stack on signaling server and dashboard.
- [ ] Dashboard viewer-switcher and native (frame-decoder) viewer.

These are tracked separately and are not blockers for SDK code review, but they ARE blockers for the v0.0.1 acceptance criteria.

### Open spec questions still pending

The five open questions in spec §10 — TURN provisioning, dashboard viewer switcher, telemetry contract, bundle-size disclosure, audio reconfirm — remain unanswered. The SDK is internally consistent against the spec's stated assumptions.
