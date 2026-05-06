import type { ConfigPlugin } from "@expo/config-plugins";

// The plugin takes no options. (Pre-0.0.3 it accepted
// `{ android: { captureMode } }` to gate manifest injection on full-screen
// vs in-app; in-app was removed and the plugin now unconditionally injects
// the manifest entries MediaProjection needs.)
declare const plugin: ConfigPlugin<void>;
export default plugin;
