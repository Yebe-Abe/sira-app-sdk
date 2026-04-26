#!/usr/bin/env bash
# Run an iOS simulator on the macos-latest GitHub runner and start a local
# Appium server pointed at it. Subsequent steps in the workflow set
# USE_LOCAL_APPIUM=1 and LOCAL_IOS_APP_PATH so ci/appium/_lib.js connects
# to localhost:4723 instead of BrowserStack — no signing, no Apple
# Developer account, no BrowserStack iOS quota.

set -euo pipefail

DEVICE="${IOS_SIM_DEVICE:-iPhone 15}"
RUNTIME="${IOS_SIM_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-17-2}"
APP_PATH="${1:?path to .app required}"

# 1) Pick or create a simulator. xcrun returns an existing UDID if the
#    name is already registered, otherwise we create one.
UDID="$(xcrun simctl list devices "iPhone 15" 2>/dev/null \
  | grep -E "^\s*$DEVICE \(" | grep -v "unavailable" | head -1 \
  | awk -F'[()]' '{print $2}')" || true

if [[ -z "$UDID" ]]; then
  echo "creating new $DEVICE simulator on $RUNTIME"
  UDID="$(xcrun simctl create "$DEVICE" "$DEVICE" "$RUNTIME")"
fi
echo "UDID=$UDID"

# 2) Boot it (no-op if already booted).
xcrun simctl boot "$UDID" 2>&1 | grep -v "already booted" || true

# 3) Wait until it's actually ready to accept installs.
xcrun simctl bootstatus "$UDID" -b

# 4) Install + don't auto-launch (Appium handles launch).
xcrun simctl install "$UDID" "$APP_PATH"

# 5) Install Appium + xcuitest driver if not already present.
if ! command -v appium >/dev/null 2>&1; then
  npm install -g appium@2 --silent
  appium driver install xcuitest
fi

# 6) Start Appium in the background. The test script blocks on it.
mkdir -p ci/artifacts
appium --port 4723 --log ci/artifacts/appium.log --log-level info &
APPIUM_PID=$!
echo "$APPIUM_PID" > ci/artifacts/appium.pid

# 7) Wait until Appium responds (typically <2s).
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:4723/status" >/dev/null 2>&1; then
    echo "Appium ready"
    exit 0
  fi
  sleep 1
done
echo "Appium failed to come up" >&2
cat ci/artifacts/appium.log >&2 || true
exit 1
