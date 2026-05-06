# `@sira-screen-share/support-react-native` v0.0.1 — build plan & review

## Plan

- [x] Package skeleton: `package.json`, `tsconfig*.json`, `react-native-builder-bob` exports, podspec, gradle.
- [x] Protocol additions (`src/protocol/messages.ts`): new `FrameMsg` variant, `platform` on viewport, `sessionType` on join.
- [x] Session state machine (`src/session/state.ts`) and signaling client (`src/session/signaling.ts`) reusing `/sessions/join` and `/rtc?sid=…&role=customer`.
- [x] TS surface: `<SiraSupport>` provider, `useSiraSupport()`, `<SiraRedact>`, `<SiraSupportTrigger>`.
- [x] In-app screens: code entry modal, Android priming, "Entire screen" recovery, in-session consent banner.
- [x] Native module bridge (`SiraSupportModule.ts`) with deferred linking error.
- [x] iOS native module: `RPScreenRecorder.startCapture` → CIImage → WebP via ImageIO; redaction painting; overlay window.
- [x] Android native module: MediaProjection path + mediaProjection-typed foreground service. (PixelCopy "in-app" mode existed in 0.0.1–0.0.2; removed in 0.0.3 — see "Removed in 0.0.3" below.)
- [x] Annotation overlay: native (iOS UIWindow / Android view added to `android.R.id.content`); JS-side `AnnotationBridge` only forwards messages.
- [x] Redaction pipeline: explicit `<SiraRedact>` rectangles measured in window coords and registered with native; `secureTextEntry` auto-detection done natively (Android walks tree; iOS leverages OS hardening). `testIDPatterns` plumbed through `startCapture` options.
- [x] Expo config plugin (`plugin/index.js`): unconditionally adds `INTERNET` + `ACCESS_NETWORK_STATE` + `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` and declares `SiraProjectionService` with `foregroundServiceType="mediaProjection"`. (Pre-0.0.3 the foreground-service entries were gated on `captureMode === "full-screen"`; full-screen is the only mode now.)
- [x] README with install steps and AI-pair integration prompt.

## Review

### What shipped

A complete v0.0.1 skeleton matching the spec's section 2/3/4 surface contracts. Every public type the spec promises is exported from the entry point. Both native modules implement their respective platform paths end-to-end:

- iOS: ReplayKit capture → CIImage downscale + redaction-rect paint → WebP via `ImageIO`'s `org.webmproject.webp` UTI → emit base64 over `RCTEventEmitter`.
- Android: per-mode capture path → bitmap downscale + redaction-rect paint + secureTextEntry tree walk → `Bitmap.compress(WEBP_LOSSY, 60, …)` → emit base64 over `DeviceEventManagerModule`.

The spec's "Entire screen" guardrail (section 4) is implemented in `SiraSupportModule.kt`: on the first frame, captured dimensions are compared against `getRealMetrics`. If they match the device screen rather than the activity window, capture is torn down and `SiraEntireScreenRefused` fires; the JS provider transitions to the recovery state and shows `RecoveryScreen.tsx`. The session ID and server-side session remain valid; only a fresh MediaProjection token is requested on retry.

The Expo plugin always injects the manifest entries MediaProjection-backed full-screen capture needs: `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` permissions and `SiraProjectionService` with `foregroundServiceType="mediaProjection"`. (Through 0.0.2 those were gated on `captureMode === "full-screen"`; full-screen is the only mode in 0.0.3+.)

### Deliberate stubs / future work

All four v0.0.1 stubs from the initial draft are now closed:

- ✅ **Bundle ID origin** — native modules expose `bundleId` as a constant (Bundle.main.bundleIdentifier on iOS, ctx.packageName on Android); `getBundleId()` on the JS side reads it. `joinSession` sends the real value.
- ✅ **iOS overlay rendering** — `SiraAnnotationView` now parses the protocol and paints CAShapeLayers for pointer / draw / arrow / highlight / clear. Pointer auto-fades after 1.5s.
- ✅ **testID-pattern matching** — both native modules walk the view tree at capture time, glob-match testIDs (RN's `view_tag` on Android, `accessibilityIdentifier` on iOS), and paint over matches before encoding.
- ✅ **Motion-based fps burst** — 8x8 grayscale pHash compared via Hamming distance; >motionThreshold bits → boost to maxFps, otherwise throttle to targetFps. Implemented identically on both platforms.

### Not shipped (out of scope, per spec)

Audio, remote control, reverse stream, custom snapshot compositing, Flutter, native-only SDKs.

### Honest tech-debt log (from code-review agent)

Workarounds applied to keep CI green that should be tracked:

- **`android.enableJetifier=false` in CI gradle.properties** — fine for the harness (no AndroidX-only deps), but if a future RN dep needs jetification this silently breaks. Re-enable when it does.
- **iOS dropped from CI** — `ios/SiraSupport.swift` compiles but is unverified end-to-end. Restore once macOS runners are available.
- **3-second magic number for foreground-service latch** in `SiraSupportModule.kt`. Make configurable when we see a device that legitimately exceeds it.
- **No committed package-lock.json yet** — `npm install` in CI is not reproducible. Commit one and switch to `npm ci`.
- **Diagnostic console.warns gated behind `EXPO_PUBLIC_SIRA_DEBUG=1` / `SIRA_DEBUG=1`** — don't ship by accident; revisit before v0.1.0.
- ~~**Server `/sessions/join` doesn't populate `sessionType`**~~ ✅ Fixed in `feat/dashboard-native-viewer` PR — server now echoes the client's `clientHint` back as `sessionType` and persists it for the agent's later `/sessions/:id/info` lookup.
- **UI-thread latch poll on Android** (`SiraSupportModule.startMediaProjectionCapture`) uses `LinkedBlockingQueue.poll(2s)` to grab decor sizes from the UI thread. If the UI thread is heavily loaded, the worker times out. Replace with a continuation-passing pattern when bandwidth allows.
- **MediaProjection.Callback only releases native resources**, doesn't notify JS. If the user pulls down the notification shade and revokes the projection, the SDK's JS-side state stays "live" forever. Fix: emit a new `SiraProjectionRevoked` event and have `<SiraSupport>` call `endInternal("agent-ended")` on it. Track for v0.0.2.
- **Server's signaling Zod schema requires `sdpMid`/`sdpMLineIndex` to be present** (nullable but not optional). Real WebRTC peers emit them as optional. The client-side `?? null` coercion is correct, but the server should accept both shapes — every new client implementer will trip this. Track for a future server PR.

### Pre-ship checklist (server-side; see spec §9)

- [x] **Option A admin endpoint** (PR merged on Jity01/sira-sdk): `/admin/test-session` + WS `role=agent` testKey bypass. Both gated by `SIRA_TEST_KEY` env on the Railway server.
- [ ] Set `SIRA_TEST_KEY` on Railway production env (matching value pushed as GitHub secret).
- [ ] Cloudflare Calls TURN integration in `/sessions/join` (spec §9-A).
- [ ] WebSocket reconnection-by-`sessionId`.
- [ ] Heartbeat-driven idle session cleanup (~30s).
- [ ] Sentry/Better Stack on signaling server and dashboard.
- [ ] Dashboard viewer-switcher and native (frame-decoder) viewer.

### Open spec questions still pending

The five open questions in spec §10 — TURN provisioning, dashboard viewer switcher, telemetry contract, bundle-size disclosure, audio reconfirm — remain unanswered. The SDK is internally consistent against the spec's stated assumptions.
