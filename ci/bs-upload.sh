#!/usr/bin/env bash
# Uploads an APK or .app to BrowserStack App Automate. Echoes app_url to
# the GitHub Actions output.
set -euo pipefail
ARTIFACT="${1:?artifact path required}"

resp=$(curl -s -u "${BROWSERSTACK_USERNAME}:${BROWSERSTACK_ACCESS_KEY}" \
  -X POST https://api-cloud.browserstack.com/app-automate/upload \
  -F "file=@${ARTIFACT}")
url=$(printf '%s' "$resp" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).app_url))")

if [[ -z "$url" || "$url" == "undefined" ]]; then
  echo "BrowserStack upload failed: $resp" >&2
  exit 1
fi

echo "app_url=$url" >> "${GITHUB_OUTPUT:-/dev/stdout}"
echo "uploaded $url"
