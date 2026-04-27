# @sira-screen-share/support-react-native

Sira-style screen-share-with-annotation support for React Native and Expo apps.

Same 6-digit code handoff as the [web SDK](https://npmjs.com/package/@sira-screen-share/support), same agent dashboard, same annotation protocol — built for native apps.

- One npm package, one config plugin, one provider component.
- Silent UX by default (no OS dialogs) for apps with standard RN components.
- Optional full-screen mode for apps with maps, video, camera previews, or other hardware-accelerated content.
- iOS 13+, Android 8+ (API 26+).

---

## Install

```bash
npm install @sira-screen-share/support-react-native react-native-webrtc
```

Add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["@sira-screen-share/support-react-native", { "android": { "captureMode": "full-screen" } }]
    ]
  }
}
```

Mount the provider at the app root:

```tsx
import { SiraSupport } from "@sira-screen-share/support-react-native";

export default function App() {
  return (
    <SiraSupport
      publicKey={process.env.EXPO_PUBLIC_SIRA_KEY}
      android={{ captureMode: "full-screen" }}
      appName="MyApp"
    >
      <RootNavigator />
    </SiraSupport>
  );
}
```

Trigger code entry from anywhere:

```tsx
import { useSiraSupport } from "@sira-screen-share/support-react-native";

function HelpButton() {
  const { openCodeEntry } = useSiraSupport();
  return <Button title="Enter support code" onPress={openCodeEntry} />;
}
```

Wrap PII you don't want captured:

```tsx
import { SiraRedact } from "@sira-screen-share/support-react-native";

<SiraRedact>
  <Text>SSN: {user.ssn}</Text>
</SiraRedact>;
```

---

## Capture modes

The single most important integrator decision.

| Mode          | iOS                       | Android                                                 | Captures hardware surfaces?                |
| ------------- | ------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `in-app`      | ReplayKit (silent)        | PixelCopy (silent)                                      | iOS yes, Android **no**                    |
| `full-screen` | ReplayKit (silent, no-op) | MediaProjection (system dialog, foreground notif)       | yes                                        |

Pick `full-screen` if your app has live maps, video, camera previews, AR, or any other hardware-surface content that's relevant to support cases. Otherwise `in-app` is the better default.

The mode is set once via the `android.captureMode` prop and the matching plugin option. No code outside that prop changes.

---

## Public API

| Surface                   | What it does                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<SiraSupport>`           | Root provider. Owns the session state machine, in-session banner, redaction pipeline.                   |
| `useSiraSupport()`        | `{ openCodeEntry, end }`. Safe to call before mount (no-ops).                                           |
| `<SiraRedact>`            | Subtree wrapper. Bounds are painted opaque before encoding; redacted bytes never leave the device.      |
| `<SiraSupportTrigger>`    | Optional unstyled button that wraps `openCodeEntry()`.                                                  |

### Provider props

```ts
<SiraSupport
  publicKey="pk_live_..."
  serverUrl="https://api.sira-screen-share.com"      // optional — for self-hosted

  android={{
    captureMode: "in-app" | "full-screen",            // default "in-app"
    priming: true,                                    // default true
  }}

  mask={{
    secureTextEntryAuto: true,                        // default true
    testIDPatterns: ["password-*", "ssn-*"],          // default []
  }}

  banner={{                                           // defaults are loud and recommended
    background: "#b00020", foreground: "#fff",
    copy: "...", endLabel: "End",
  }}

  appName="MyApp"

  onSessionStart={(sid) => analytics.track("sira_start", { sid })}
  onSessionEnd={(reason, sid) => analytics.track("sira_end", { reason, sid })}
/>
```

---

## What gets captured

Three layers of redaction compose at capture time:

1. **Auto** — every `TextInput` with `secureTextEntry={true}` (when `mask.secureTextEntryAuto` is on, the default).
2. **Explicit** — anything inside `<SiraRedact>`.
3. **Pattern-based** — elements whose `testID` matches any glob in `mask.testIDPatterns`.

All three apply before the frame is encoded to WebP. There is no path by which redacted content reaches the network.

---

## Bandwidth

- 8 fps steady state, bursting to 15 fps on detected motion.
- WebP-encoded, ~30–60 KB per frame at 1280px on the longest edge.
- Target steady-state: 200–400 kbps. Comfortable on mobile networks.

---

## AI-pair integration prompt

Paste the following into your coding assistant in your repo to install and integrate the SDK in one pass.

````markdown
You are integrating @sira-screen-share/support-react-native into this RN/Expo app.

Steps:

1. Install the package:
   `npm install @sira-screen-share/support-react-native react-native-webrtc`

2. Add the config plugin to `app.json`'s `expo.plugins` array:
   ```json
   ["@sira-screen-share/support-react-native", { "android": { "captureMode": "full-screen" } }]
   ```
   Use `"in-app"` instead if this app has no maps, video, camera previews, or other hardware-accelerated content.

3. Find the app root component (where the navigator is wrapped). Mount `<SiraSupport>` directly outside the navigator. Pass `publicKey` from an env var, `android.captureMode` matching the plugin option, and `appName` set to the user-facing app name.

4. Add an "Enter support code" item to the existing Help/Settings screen. It should call `openCodeEntry()` from `useSiraSupport()`.

5. Audit the codebase for sensitive PII: SSN, full bank account, salary, DOB, government ID, driver's license, full credit card. Wrap each occurrence in `<SiraRedact>`. Be conservative — over-redact rather than under-redact. List every wrapping change you made.

6. After all changes, run the type-checker. Fix any errors.

Report back:
- the chosen captureMode and why
- every file you wrapped in <SiraRedact>
- any sensitive data you spotted but did NOT wrap, and why
````

---

## Pre-launch infra (server-side)

The SDK assumes the following are in place on the server:

- A TURN provider (Cloudflare Calls recommended) integrated into `/sessions/join`. Without it, the majority of native sessions cannot establish a peer connection.
- A WebSocket signaling endpoint at `/rtc?sid=…&role=customer`.
- The `JoinSessionResponse` includes a `sessionType: "native"` field so the dashboard mounts the native viewer.

See section 9 of the v0.0.1 spec for the full pre-launch checklist.

---

## CI coverage and platform parity

| Layer                                | Android (auto)             | iOS (auto)                              |
| ------------------------------------ | -------------------------- | --------------------------------------- |
| Type-check + build                   | ✅ ubuntu-latest           | ✅ macos-latest (Release config)        |
| Native compilation                   | ✅ gradle                  | ✅ xcodebuild + CocoaPods 1.16.2        |
| Mint session + WS connect            | ✅ real Pixel 8 (BS)       | ✅ iOS Simulator                        |
| WebRTC SDP/ICE negotiation           | ✅ end-to-end              | ✅ end-to-end                           |
| Data channel open                    | ✅                         | ✅                                      |
| Frame capture → encode → send        | ✅ MediaProjection/PixelCopy | ⚠️ ReplayKit silent on headless sim    |
| OCR + redaction marker assertion     | ✅ §3 redaction CI gate    | ⚠️ Verified manually on real device    |

The iOS gap is structural, not a bug:

- **Headless macOS GitHub runner**: no display server → ReplayKit's
  sample-buffer handler doesn't fire → nothing to encode → nothing to
  send. The signaling + peer + data-channel layers verify clean.
- **Real-device iOS via BrowserStack**: requires a signed .ipa, which
  requires an Apple Developer account ($99/yr). Out of scope for
  v0.0.1.

### Pre-launch verification (one-time, manual)

Before publishing, do a real-device iOS smoke once:

1. Install the SDK in your app on a physical iPhone (any iOS 13+).
2. Trigger a session with a known support code from the dashboard.
3. Verify frames appear in the dashboard live viewer (proves capture
   + encode + data-channel work end-to-end).
4. Wrap a Text in `<SiraRedact>`, start a session, verify the rect is
   black in the dashboard's recorded frame (proves redaction).

That's a 5-minute ceremony and it's the same surface the Android CI
exercises automatically.

---

## Versioning

This package follows the same beta cadence as the web SDK. Breaking changes possible in `0.0.x`; first stable surface is `0.1.0`.

## License

MIT.
