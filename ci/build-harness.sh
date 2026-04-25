#!/usr/bin/env bash
# Builds the test harness Expo app for the given platform.
# Output: examples/harness/build/{ios,android}/harness.{app,apk}
#
# Honors env:
#   REDACTION_FIXTURES=1   — render the §3 marker-string screens
#   CAPTURE_MODE=…         — override the default in app config

set -euo pipefail
PLATFORM="${1:?platform required}"

cd examples/harness
npm ci

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
