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
  # Simulator build. Unsigned, fine for BrowserStack App Automate.
  npx expo prebuild --platform ios --clean
  cd ios
  xcodebuild -workspace harness.xcworkspace -scheme harness \
    -configuration Debug -sdk iphonesimulator \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO
  mkdir -p ../build/ios
  cp -R build/Build/Products/Debug-iphonesimulator/harness.app ../build/ios/
elif [[ "$PLATFORM" == "android" ]]; then
  npx expo prebuild --platform android --clean
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
