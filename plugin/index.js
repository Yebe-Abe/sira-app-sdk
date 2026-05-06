// Expo config plugin for @sira-screen-share/support-react-native.
//
// Effect on Android: injects the permissions and foreground-service
// declaration MediaProjection needs, plus the WebRTC connectivity
// permissions. Runs unconditionally — full-screen capture is the only
// Android mode the SDK supports as of 0.0.3.

const {
  withAndroidManifest,
  AndroidConfig,
  createRunOncePlugin,
} = require("@expo/config-plugins");

const pkg = require("../package.json");

function withSiraSupport(config) {
  // WebRTC requires INTERNET + ACCESS_NETWORK_STATE; the native code
  // throws SecurityException → JNI assertion → process kill without
  // ACCESS_NETWORK_STATE (caught in CI device logs).
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    const existing = app.service.find(
      (s) => s.$ && s.$["android:name"] === "com.sirascreenshare.support.SiraProjectionService"
    );
    if (!existing) {
      app.service.push({
        $: {
          "android:name": "com.sirascreenshare.support.SiraProjectionService",
          "android:foregroundServiceType": "mediaProjection",
          "android:exported": "false",
        },
      });
    }
    return cfg;
  });

  return config;
}

module.exports = createRunOncePlugin(withSiraSupport, pkg.name, pkg.version);
