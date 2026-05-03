# @sira-screen-share/support-react-native

Sira-style screen-share-with-annotation support for React Native and Expo apps.

Same 6-digit code handoff as the [web SDK](https://npmjs.com/package/@sira-screen-share/support), same agent dashboard, same annotation protocol — built for native apps.

- One npm package, one config plugin, one provider component.
- Silent UX by default (no OS dialogs) for apps with standard RN components.
- Optional full-screen mode for apps with maps, video, camera previews, or other hardware-accelerated content.
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
      ["@sira-screen-share/support-react-native", { "android": { "captureMode": "full-screen" } }]
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
  android={{ captureMode: "full-screen" }} // optional; default in-app
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

6. If the app supports Android and uses live maps, video, camera, or other
   hardware-accelerated surfaces and you want those captured during
   sessions, set captureMode to "full-screen" on the provider AND in the
   plugin options (both must agree):

   <SiraSupport android={{ captureMode: "full-screen" }} appName="MyApp">

   Otherwise leave the default "in-app" — silent, no system dialog. The
   default works for any RN app that doesn't render hardware surfaces.

7. DON'T DO THESE THINGS:
   • Don't manually request screen-recording permissions — the SDK handles
     ReplayKit (iOS) and MediaProjection (Android) itself
   • Don't add any styling to the SDK's modal or banner from outside —
     they're isolated overlays, customize via the `banner` prop only
   • Don't add env vars, API routes, or backend wiring — the SDK talks to
     Sira's hosted server
   • Don't pass a custom `serverUrl` unless I tell you to
   • Don't refactor the existing Help UI — only add one new entry point

8. After the edits, tell me:
   • Which file you added <SiraSupport> to
   • Which file you added the trigger to and how it looks in context
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

On Android with `full-screen`, the SDK shows a brief priming screen
explaining what the user will see in the system dialog. The agent then
sees only the host app (not the entire device) — the priming screen
walks the user through picking "A single app" → your app in the system
picker. To capture the entire device instead, customize the priming
screen's copy and pass `priming: false` if you want to skip it.

iOS uses ReplayKit and shows no system dialog — only the OS-level red
recording bar at the top of the screen. If your users may be surprised,
consider rendering your own pre-session explanation (the SDK doesn't
mount a priming screen on iOS).

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
    captureMode: "in-app" | "full-screen",             // default "in-app"
    priming: true,                                     // default true
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

## License

MIT.
