#!/usr/bin/env bash
# §2 — Run the smoke against the bootstrapped integration app on both platforms.
set -euo pipefail
cd /tmp/integ-app

for plat in ios android; do
  artifact=$([[ "$plat" == "ios" ]] && echo "build/ios/harness.app" || echo "build/android/harness.apk")
  if [[ ! -e "$artifact" ]]; then
    echo "missing $artifact"; exit 1
  fi
  app_url=$(curl -s -u "${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}" \
    -X POST https://api-cloud.browserstack.com/app-automate/upload \
    -F "file=@${artifact}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).app_url))")
  BS_APP_URL="$app_url" PLATFORM="$plat" node "$GITHUB_WORKSPACE/ci/appium/smoke.js"
done
