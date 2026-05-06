# @sira-screen-share/support-react-native

Sira-style screen-share-with-annotation support for React Native and Expo apps.

Same 6-digit code handoff as the [web SDK](https://npmjs.com/package/@sira-screen-share/support), same agent dashboard, same annotation protocol — built for native apps.

- One npm package, one config plugin, one provider component.
- Android: full-screen MediaProjection capture — agent follows the customer across apps. One system consent dialog at session start.
- iOS: ReplayKit, app-only (no system dialog).
- Sessions only end on explicit End from the customer or the agent (no auto-end on backgrounding).
- iOS 14+, Android 8+ (API 26+).

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
      "@sira-screen-share/support-react-native"
    ]
  }
}
```

Mount the provider at the app root. **`publicKey` is required** — the
SDK has no production default because mobile apps send their bundle ID
as the origin, and a production key has to be allowlisted server-side
against your specific bundle ID:

```tsx
import { SiraSupport } from "@sira-screen-share/support-react-native";

export default function App() {
  return (
    <SiraSupport publicKey="pk_live_acme">
      <RootNavigator />
    </SiraSupport>
  );
}
```

**Three keys you can use:**

| Key                   | Use for                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `pk_test`             | localhost-port allowlisted; for the harness, sim/emulator dev, unit tests       |
| `pk_demo`             | localhost + the public Sira demo origin; for staging / preview builds           |
| `pk_live_<slug>`      | provisioned per integrator, allowlisted to your iOS+Android bundle IDs          |

To get a `pk_live_<slug>` for production, contact Sira with your bundle ID
(e.g., `com.acme.payroll` on both platforms) and we'll provision it.

Full prop surface:

```tsx
<SiraSupport
  publicKey="pk_live_acme"                 // required
  appName="MyApp"                          // optional; for the Android priming dialog
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

---

## Drop-in integration prompt

Paste this into Cursor / Claude Code / Copilot Chat / Cline / Windsurf or any coding agent. It has everything the agent needs to wire the SDK into an existing React Native or Expo codebase cleanly.

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
   that returns a navigator or layout — wrap that. publicKey is required.

   import { SiraSupport } from "@sira-screen-share/support-react-native";

   // dev / sim / emulator (localhost-allowlisted)
   <SiraSupport publicKey="pk_test">
     <RootNavigator />
   </SiraSupport>

   // production: ask Sira for a pk_live_<slug> tied to YOUR bundle ID
   <SiraSupport publicKey="pk_live_<slug>">
     <RootNavigator />
   </SiraSupport>

   Public keys at a glance (pass via the `publicKey` prop):
   - `pk_test`       → allowlists localhost ports. Use for sim/emulator dev.
   - `pk_demo`       → allowlists localhost + the public Sira demo origin.
   - `pk_live_<slug>` → provisioned per integrator, allowlisted to a specific
                       iOS+Android bundle ID. Required for shipping to the
                       App Store / Play Store. Ask Sira for one.

   IF YOU DON'T KNOW the right key for this project, default to "pk_test"
   and surface a TODO in your response asking the human to swap it for a
   pk_live_<slug> before publishing.

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

6. DON'T DO THESE THINGS:
   • Don't manually request screen-recording permissions — the SDK handles
     ReplayKit (iOS) and MediaProjection (Android) itself
   • Don't add any styling to the SDK's modal or banner from outside —
     they're isolated overlays, customize via the `banner` prop only
   • Don't add env vars, API routes, or backend wiring — the SDK talks to
     Sira's hosted server
   • Don't pass a custom `serverUrl` unless I tell you to
   • Don't refactor the existing Help UI — only add one new entry point

7. After the edits, tell me:
   • Which file you added <SiraSupport> to
   • Which file you added the trigger to and how it looks in context
   • Whether you used the default production key or passed publicKey="pk_test"
   • Whether the project required any AndroidManifest.xml / Info.plist edits
     (only matters for bare RN, not Expo)

That's it.
```

---

## Capture

- **Android**: MediaProjection. The customer accepts a system consent dialog at session start; a mediaProjection-typed foreground service runs for the duration of the session and posts a notification. Captures the entire device — the agent follows the customer across apps.
- **iOS**: ReplayKit. No system dialog (only the OS-level red recording bar). Captures the host app's surface only — system-wide capture would require a Broadcast Extension, which the SDK doesn't ship.

### Android system dialog

The SDK shows a brief priming screen explaining what's about to happen, then Android's MediaProjection picker appears. The customer must:

1. Choose **Entire screen** (not "A single app")
2. Tap **Start now**

Once they agree, the foreground service starts and the agent sees the customer's screen — even when the customer leaves your app. A foreground service notification appears in the system tray for the duration of the session.

### iOS

iOS uses ReplayKit and shows no system dialog — only the OS-level red recording bar at the top of the screen. iOS sessions capture **only the host app's surface** (no system-wide capture without a Broadcast Extension, which the SDK doesn't ship). When the customer backgrounds your app on iOS, the agent's view freezes at the last frame; capture resumes when the customer returns to your app.

### What happens when the customer leaves your app

| Platform   | While customer is in another app                                              | When they return to your app                          |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Android    | Agent sees the other app live (MediaProjection captures the whole device).    | Agent's prior annotations are still on the host app.  |
| iOS        | Agent's view freezes (ReplayKit suspends sample buffer delivery).             | Capture resumes; annotations persist.                 |

Sessions do **not** auto-end when the customer backgrounds your app. They end only when:
- The customer taps **End** in the consent banner
- The agent taps **End** on the dashboard
- The WebRTC connection has been confirmed dead for 30+ seconds (network-failure grace)

---

## Public API

| Surface                   | What it does                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<SiraSupport>`           | Root provider. Owns the session state machine + in-session banner.                                      |
| `useSiraSupport()`        | `{ openCodeEntry, end }`. Safe to call before mount (no-ops).                                           |
| `<SiraSupportTrigger>`    | Optional unstyled button that wraps `openCodeEntry()`.                                                  |

### Provider props

```ts
<SiraSupport
  publicKey="pk_live_..."                              // required
  serverUrl="https://api.sira-screen-share.com"        // optional — for self-hosted

  android={{
    priming: true,                                     // default true; show the brief explainer screen before the MediaProjection picker
  }}

  banner={{                                            // defaults are loud and recommended
    background: "#b00020", foreground: "#fff",
    copy: "...", endLabel: "End",
  }}

  appName="MyApp"

  onSessionStart={(sid) => analytics.track("sira_start", { sid })}
  onSessionEnd={(reason, sid) => analytics.track("sira_end", { reason, sid })}
/>
```

---

## Bandwidth

- 8 fps steady state, bursting to 15 fps on detected motion.
- WebP-encoded, ~30–60 KB per frame at 1280px on the longest edge.
- Target steady-state: 200–400 kbps. Comfortable on mobile networks.

---

## Versioning

This package follows the same beta cadence as the web SDK. Breaking changes possible in `0.0.x`; first stable surface is `0.1.0`.

### Migrating from 0.0.2

`0.0.3` removed the `"in-app"` Android capture mode — full-screen MediaProjection is the only Android path now. If your earlier integration looked like:

```jsonc
// app.json
["@sira-screen-share/support-react-native", { "android": { "captureMode": "full-screen" } }]
```

```tsx
<SiraSupport android={{ captureMode: "full-screen" }} ... />
```

…drop both `{ "android": { "captureMode": ... } }` and the `android={{ captureMode: ... }}` prop. The plugin entry is now just `"@sira-screen-share/support-react-native"` (no options) and the provider's `android` prop carries only `priming`. The `CaptureMode` type export is gone.

The plugin always injects `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` permissions and the `SiraProjectionService` declaration into the host manifest; that used to be conditional on `captureMode === "full-screen"`.

## License

MIT.
