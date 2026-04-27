#!/usr/bin/env bash
# Builds the test harness Expo app for the given platform.
# Output: examples/harness/build/{ios,android}/harness.{app,apk}
#
# Honors env:
#   REDACTION_FIXTURES=1   — render the §3 marker-string screens
#   CAPTURE_MODE=…         — override the default in app config

set -euo pipefail
PLATFORM="${1:?platform required}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Build the SDK so lib/commonjs/index.js exists. Expo's plugin resolver
# uses resolveFrom which checks that the package's `main` entry actually
# exists on disk before recognizing the package — without lib/, prebuild
# can't find the plugin even if app.plugin.js sits right next to it.
cd "$REPO_ROOT"
# Ensure devDependencies are present (bob, tsc) before building. Top-level
# `npm install` typically runs before this script in CI, but we don't rely
# on that.
[[ -d node_modules ]] || npm install --no-audit --no-fund
npm run build

# Pack and rewrite the harness's local file: dep to point at the tarball.
# Mirrors the published-package structure an integrator would get via
# `npm install @sira-screen-share/support-react-native`.
TARBALL="$(npm pack --silent)"
echo "packed $TARBALL"

cd "$REPO_ROOT/examples/harness"
node -e "const fs=require('fs');const p='./package.json';const j=JSON.parse(fs.readFileSync(p));j.dependencies['@sira-screen-share/support-react-native']='file:../../$TARBALL';fs.writeFileSync(p,JSON.stringify(j,null,2));"
# No lockfile yet — full install. Once we commit one, switch to npm ci.
npm install --no-audit --no-fund

if [[ "$PLATFORM" == "ios" ]]; then
  # Install the right CocoaPods version FIRST — expo prebuild calls
  # `pod install` internally on the system version, which on macos-latest
  # is too old for Expo SDK 51's Podfile keywords.
  sudo gem install cocoapods -v 1.16.2 --no-document
  pod --version
  npx expo prebuild --platform ios --clean

  cd ios
  pod install

  # Expo names the workspace + scheme after the app slug (e.g.
  # sira-harness.xcworkspace). Auto-discover instead of hardcoding so
  # this script doesn't break if the harness's app.json slug changes.
  WORKSPACE="$(ls -d *.xcworkspace | head -1)"
  SCHEME="${WORKSPACE%.xcworkspace}"
  echo "iOS workspace: $WORKSPACE  scheme: $SCHEME"

  # SIMULATOR build — runs on the macOS GitHub runner via xcrun simctl,
  # no signing or Apple Developer needed.
  #
  # MUST be Release config: Expo's generated AppDelegate uses
  # `RCTBundleURLProvider.jsBundleURL(forBundleRoot:)` in DEBUG (expects
  # Metro to be running) and `Bundle.main.url(forResource:"main",
  # withExtension:"jsbundle")` in RELEASE. Debug builds without Metro
  # show a "No bundle URL present" redbox. Release also runs the
  # "Bundle React Native code and images" build phase which embeds
  # main.jsbundle into the .app — no separate export:embed step needed.
  xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -configuration Release -sdk iphonesimulator \
    -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    EXPANDED_CODE_SIGN_IDENTITY=""
  mkdir -p ../build/ios
  cp -R "build/Build/Products/Release-iphonesimulator/${SCHEME}.app" ../build/ios/harness.app
elif [[ "$PLATFORM" == "android" ]]; then
  npx expo prebuild --platform android --clean
  # Bundle the JS into the debug APK so the harness doesn't need Metro
  # running. expo export:embed is the Expo-aware version of
  # react-native bundle (handles Expo's metro defaults without needing a
  # standalone metro.config.js).
  mkdir -p android/app/src/main/assets
  npx expo export:embed \
    --platform android \
    --dev false \
    --entry-file index.js \
    --bundle-output android/app/src/main/assets/index.android.bundle \
    --assets-dest android/app/src/main/res/
  cd android
  # Default heap is too small for Hermes jetify on a 7 GB GH Actions
  # runner. GRADLE_OPTS only affects the launcher; the transform workers
  # (where jetify runs) read org.gradle.jvmargs from gradle.properties,
  # so we patch both.
  export GRADLE_OPTS="-Xmx4g -XX:MaxMetaspaceSize=1g -Dorg.gradle.daemon=false"
  cat >> gradle.properties <<'GP'
org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g
android.enableJetifier=false
GP
  ./gradlew assembleDebug --no-daemon
  mkdir -p ../build/android
  cp app/build/outputs/apk/debug/app-debug.apk ../build/android/harness.apk
else
  echo "unknown platform: $PLATFORM" >&2; exit 1
fi
