#!/usr/bin/env bash
# Run an iOS simulator on the macos-latest GitHub runner and start a local
# Appium server pointed at it. Subsequent steps in the workflow set
# USE_LOCAL_APPIUM=1 and LOCAL_IOS_APP_PATH so ci/appium/_lib.js connects
# to localhost:4723 instead of BrowserStack — no signing, no Apple
# Developer account, no BrowserStack iOS quota.

set -euo pipefail

DEVICE="${IOS_SIM_DEVICE:-iPhone 15}"
APP_PATH="${1:?path to .app required}"

# Auto-discover whatever iOS runtime is actually installed on this
# runner — macos-latest gets iOS SDK bumps regularly and hardcoding
# (e.g. iOS-17-2) breaks each time.
RUNTIME="${IOS_SIM_RUNTIME:-$(xcrun simctl list runtimes available -j \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const r=JSON.parse(d).runtimes.filter(x=>x.platform==='iOS'&&x.isAvailable!==false).sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))[0];
      console.log(r ? r.identifier : '');
    })")}"
[[ -n "$RUNTIME" ]] || { echo "no iOS simulator runtime available"; xcrun simctl list runtimes; exit 1; }
echo "Using runtime: $RUNTIME"

# 1) Find or create a simulator on that runtime.
UDID="$(xcrun simctl list devices "$DEVICE" 2>/dev/null \
  | grep -E "^\s*$DEVICE \(" | grep -v "unavailable" | head -1 \
  | awk -F'[()]' '{print $2}')" || true

if [[ -z "$UDID" ]]; then
  echo "creating new $DEVICE simulator on $RUNTIME"
  UDID="$(xcrun simctl create "$DEVICE" "$DEVICE" "$RUNTIME")"
fi
echo "UDID=$UDID"
# Export to GitHub Actions env so subsequent steps can pin Appium to
# this exact simulator (avoids 'platformVersion does not exist'
# mismatch between hardcoded caps and whatever SDKs are installed).
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "IOS_SIM_UDID=$UDID" >> "$GITHUB_ENV"
fi

# 2) Boot it (no-op if already booted).
xcrun simctl boot "$UDID" 2>&1 | grep -v "already booted" || true

# 3) Wait until it's actually ready to accept installs.
xcrun simctl bootstatus "$UDID" -b

# 3a) Pre-warm SpringBoard. `bootstatus -b` returns when CoreSimulator
#     reports "booted", but Appium's internal boot wait additionally
#     polls for SpringBoard to be responsive — on cold macos-latest
#     runners this can lag the CoreSimulator status by 30-60s and trip
#     Appium's 120s timeout. Force the sim to come up visually now so
#     SpringBoard is alive before Appium ever asks.
open -a Simulator --args -CurrentDeviceUDID "$UDID" || true
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if xcrun simctl spawn "$UDID" launchctl print system 2>/dev/null | grep -q com.apple.springboard; then
    echo "SpringBoard up after ${i}s"
    break
  fi
  sleep 2
done

# 4) Install + don't auto-launch (Appium handles launch).
xcrun simctl install "$UDID" "$APP_PATH"

# 5) Install Appium + xcuitest driver. Latest xcuitest driver requires
#    Appium 3 (server ^3.0.0-rc.2), so install that instead of the
#    obsolete 2.x line. webdriverio 9 supports both.
if ! command -v appium >/dev/null 2>&1; then
  npm install -g appium@next --silent
fi
# Always try to install the driver — `appium driver install` is a no-op
# if the driver is already present at the right version.
appium driver install xcuitest 2>&1 | tail -5 || true

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
