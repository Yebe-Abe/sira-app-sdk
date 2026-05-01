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

Mount the provider at the app root. **Production needs no props** — the
default key (`pk_live_sira`) and default server URL route to Sira's
production tenant, identical to the web SDK's `<SiraSupport />`:

```tsx
import { SiraSupport } from "@sira-screen-share/support-react-native";

export default function App() {
  return (
    <SiraSupport>
      <RootNavigator />
    </SiraSupport>
  );
}
```

For local dev / staging, pass the shared test key (accepts any origin):

```tsx
<SiraSupport publicKey="pk_test">
  <RootNavigator />
</SiraSupport>
```

Full prop surface for apps that need to override defaults:

```tsx
<SiraSupport
  publicKey="pk_live_acme"               // optional; default pk_live_sira
  android={{ captureMode: "full-screen" }} // optional; default in-app
  appName="MyApp"                        // optional; for the Android priming dialog
>
  <RootNavigator />
</SiraSupport>
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

## Drop-in integration prompt

Paste this into Cursor / Claude Code / Copilot Chat / Cline / Windsurf or any coding agent. It has everything the agent needs to wire the SDK into an existing React Native or Expo codebase cleanly — no back-and-forth, no regressions.

```text
I want to integrate the npm package `@sira-screen-share/support-react-native`
into this codebase. It's a drop-in SDK that lets our support team view and
annotate a customer's screen via a 6-digit code the customer enters from a
Help menu.

Reference docs + source (fetch these if anything below is ambiguous):
- npm:    https://www.npmjs.com/package/@sira-screen-share/support-react-native
- GitHub: https://github.com/Yebe-Abe/sira-app-sdk

Please do the full integration. Follow these rules carefully:

1. INSTALL the package and its WebRTC peer dep with the right package
   manager for this repo (npm / pnpm / yarn / bun — infer from lockfiles):
     @sira-screen-share/support-react-native
     react-native-webrtc

2. ADD the Expo config plugin to app.json (or app.config.js / .ts). If the
   project is bare React Native (no Expo config plugin support), skip this
   step — the SDK still works, but the integrator must edit
   AndroidManifest.xml and Info.plist by hand. Surface that to me if it
   applies.

   {
     "expo": {
       "plugins": [
         "@sira-screen-share/support-react-native"
       ]
     }
   }

3. MOUNT the provider once at the very top of the app tree, wrapping the
   rest of the app. Most RN apps have a single root component (App.tsx)
   that returns a navigator or layout — wrap that. The SDK defaults to
   Sira's production public key + API URL, so production needs no props.

   import { SiraSupport } from "@sira-screen-share/support-react-native";

   // production
   <SiraSupport>
     <RootNavigator />
   </SiraSupport>

   // localhost dev / staging — use the shared test key
   <SiraSupport publicKey="pk_test">
     <RootNavigator />
   </SiraSupport>

   Public keys at a glance (pass via the `publicKey` prop):
   - `pk_live_sira`  → production. This is the default, no prop needed.
   - `pk_test` / `pk_demo` → accept any origin; use for localhost,
     preview/staging builds, or quick trials.
   - Custom live keys tied to a specific app are provisioned server-side;
     ask before inventing new keys.

4. FIND the existing Help affordance in this codebase — it's usually one
   of: a "Help" / "Support" item in a settings screen, a "?" icon in a
   header, a menu item inside a drawer or profile sheet, a chat-with-us
   row in account settings. Search for "help", "support", "contact",
   "faq", "assistance".

5. ADD a new item/button called "Enter support code" next to whatever you
   found. The click handler opens the SDK's modal via the
   `useSiraSupport()` hook:

   import { useSiraSupport } from "@sira-screen-share/support-react-native";

   function SupportCodeRow() {
     const { openCodeEntry } = useSiraSupport();
     return (
       <Pressable onPress={openCodeEntry}>
         <Text>Enter support code</Text>
       </Pressable>
     );
   }

   Match the existing component / styling patterns exactly — if the
   project uses NativeBase / Tamagui / styled-components / a custom design
   system, use that. If it uses StyleSheet.create, use that. DO NOT
   introduce a new styling approach.

6. WRAP screens that show PII with <SiraRedact> so they're masked from the
   agent during a live session:

   import { SiraRedact } from "@sira-screen-share/support-react-native";

   <SiraRedact>
     <Text>SSN: {user.ssn}</Text>
   </SiraRedact>

   Find the obvious candidates: SSN, full bank/account numbers, date of
   birth, full credit card, security questions, anything labeled "private"
   or "confidential". When in doubt, wrap it.

7. If the app supports Android and uses live maps, video, camera, or other
   hardware-accelerated surfaces and you want those captured during
   sessions, set captureMode to "full-screen" on the provider AND in the
   plugin options (both must agree):

   <SiraSupport android={{ captureMode: "full-screen" }} appName="MyApp">

   Otherwise leave the default "in-app" — silent, no system dialog. The
   default works for any RN app that doesn't render hardware surfaces.

8. DON'T DO THESE THINGS:
   • Don't manually request screen-recording or microphone permissions —
     the SDK handles ReplayKit (iOS) and MediaProjection (Android) itself
   • Don't add any styling to the SDK's modal or banner from outside —
     they're isolated overlays, customize via the `banner` prop only
   • Don't add env vars, API routes, or backend wiring — the SDK talks to
     Sira's hosted server
   • Don't pass a custom `serverUrl` unless I tell you to
   • Don't refactor the existing Help UI — only add one new entry point

9. After the edits, tell me:
   • Which file you added <SiraSupport> to
   • Which file you added the trigger to and how it looks in context
   • Which screens you added <SiraRedact> to (list the field names)
   • Whether you used the default production key or passed publicKey="pk_test"
   • Whether the project required any AndroidManifest.xml / Info.plist edits
     (only matters for bare RN, not Expo)

That's it.
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
  publicKey="pk_live_..."                              // optional — defaults to pk_live_sira
  serverUrl="https://api.sira-screen-share.com"       // optional — for self-hosted

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
