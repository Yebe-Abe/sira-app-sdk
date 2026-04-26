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
  # Pre-bundle JS into main.jsbundle so the .app boots without Metro,
  # mirroring the Android export:embed flow.
  mkdir -p ios/main.jsbundle.dir
  npx expo export:embed \
    --platform ios \
    --dev false \
    --entry-file index.js \
    --bundle-output ios/main.jsbundle \
    --assets-dest ios/

  cd ios
  # CocoaPods already pinned at the top of the iOS branch; expo prebuild
  # already ran `pod install` internally with the right version. Re-run
  # to be safe (idempotent if everything is up-to-date).
  pod install
  # NOTE: this is a SIMULATOR build (-sdk iphonesimulator). It runs in
  # BrowserStack's "App Live" interactive sessions, not App Automate.
  # For App Automate on a real iPhone we need a signed .ipa — requires
  # an Apple Developer account ($99/yr) + provisioning profile, then
  # add: -sdk iphoneos + -archivePath + xcodebuild -exportArchive.
  # Until then this builds the simulator artifact for diagnostics.
  xcodebuild -workspace harness.xcworkspace -scheme harness \
    -configuration Debug -sdk iphonesimulator \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO
  mkdir -p ../build/ios
  cp -R build/Build/Products/Debug-iphonesimulator/harness.app ../build/ios/
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
