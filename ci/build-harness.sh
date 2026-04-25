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

# Pack the SDK and rewrite the harness's local file: dep to point at the
# tarball. This gives the harness exactly the structure an integrator
# would get via `npm install @sira-screen-share/support-react-native`,
# avoiding npm-version-specific symlink-vs-copy quirks for `file:` deps.
cd "$REPO_ROOT"
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
  ./gradlew assembleDebug
  mkdir -p ../build/android
  cp app/build/outputs/apk/debug/app-debug.apk ../build/android/harness.apk
else
  echo "unknown platform: $PLATFORM" >&2; exit 1
fi
