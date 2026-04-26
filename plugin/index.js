// Expo config plugin for @sira-screen-share/support-react-native.
//
// Only effect (per spec section 8): when captureMode = "full-screen", add the
// MediaProjection-related permissions and declare the foreground service in
// AndroidManifest.xml. For "in-app" mode, no permissions are added.

const {
  withAndroidManifest,
  AndroidConfig,
  createRunOncePlugin,
} = require("@expo/config-plugins");

const pkg = require("../package.json");

function withSiraSupport(config, props) {
  const captureMode = (props && props.android && props.android.captureMode) || "in-app";

  // Always-needed permissions regardless of capture mode. WebRTC requires
  // ACCESS_NETWORK_STATE to query connectivity for ICE; without it the
  // native code throws SecurityException → JNI assertion → process kill
  // (caught in CI device logs).
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
  ]);

  if (captureMode !== "full-screen") {
    return config;
  }

  config = AndroidConfig.Permissions.withPermissions(config, [
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
