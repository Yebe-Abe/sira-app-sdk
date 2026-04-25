#!/usr/bin/env bash
# §2 — Run the smoke against the bootstrapped integration app. Android only
# until macOS runners exist for the iOS leg.
set -euo pipefail
cd /tmp/integ-app

artifact="build/android/harness.apk"
[[ -e "$artifact" ]] || { echo "missing $artifact"; exit 1; }

app_url=$(curl -s -u "${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}" \
  -X POST https://api-cloud.browserstack.com/app-automate/upload \
  -F "file=@${artifact}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).app_url))")

BS_APP_URL="$app_url" PLATFORM=android node "$GITHUB_WORKSPACE/ci/appium/smoke.js"
