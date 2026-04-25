#!/usr/bin/env bash
# Read .env, push every non-empty secret to GitHub Actions via API.
# Encrypts values with the repo's libsodium public key.
# Safe to re-run.

set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "no .env in $(pwd)"; exit 1; }
set -a; . .env; set +a

REPO="${GITHUB_REPO:?GITHUB_REPO not set}"
PAT="${GITHUB_PAT:?GITHUB_PAT not set}"

declare -a MAP=(
  "BROWSERSTACK_USERNAME=BROWSERSTACK_USERNAME"
  "BROWSERSTACK_ACCESS_KEY=BROWSERSTACK_ACCESS_KEY"
  "NPM_TOKEN=NPM_TOKEN"
  "SIRA_SERVER_URL=SIRA_SERVER_URL"
  "SIRA_DASHBOARD_URL=SIRA_DASHBOARD_URL"
  "SIRA_TEST_PUBLIC_KEY=SIRA_TEST_PUBLIC_KEY"
  "SIRA_TEST_KEY=SIRA_TEST_KEY"
  "CLOUDFLARE_TURN_TOKEN_ID=CLOUDFLARE_TURN_TOKEN_ID"
  "CLOUDFLARE_TURN_API_TOKEN=CLOUDFLARE_TURN_API_TOKEN"
  "BETTERSTACK_TELEMETRY_TOKEN=BETTERSTACK_TELEMETRY_TOKEN"
  "BETTERSTACK_TELEMETRY_INGEST_URL=BETTERSTACK_TELEMETRY_INGEST_URL"
  "BETTERSTACK_UPTIME_TOKEN=BETTERSTACK_UPTIME_TOKEN"
)

PUBKEY_RESP=$(curl -fsS -H "Authorization: Bearer $PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/secrets/public-key")
KEY_ID=$(printf '%s' "$PUBKEY_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).key_id))")
PUB_KEY=$(printf '%s' "$PUBKEY_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).key))")

if ! node -e "require('libsodium-wrappers')" 2>/dev/null; then
  echo "installing libsodium-wrappers..."
  npm install --no-save --silent libsodium-wrappers >/dev/null
fi

ENC_SCRIPT="$(pwd)/.sira-encrypt.js"
cat > "$ENC_SCRIPT" <<'EOF'
const sodium = require("libsodium-wrappers");
const [, , pubB64, valStr] = process.argv;
(async () => {
  await sodium.ready;
  const key = sodium.from_base64(pubB64, sodium.base64_variants.ORIGINAL);
  const msg = sodium.from_string(valStr);
  process.stdout.write(sodium.to_base64(sodium.crypto_box_seal(msg, key), sodium.base64_variants.ORIGINAL));
})();
EOF
trap 'rm -f "$ENC_SCRIPT"' EXIT

set_secret() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    printf "  - skip %s (empty)\n" "$name"; return
  fi
  local encrypted
  encrypted=$(node "$ENC_SCRIPT" "$PUB_KEY" "$value")
  local body
  body=$(node -e "console.log(JSON.stringify({encrypted_value: process.argv[1], key_id: process.argv[2]}))" "$encrypted" "$KEY_ID")
  curl -fsS -X PUT \
    -H "Authorization: Bearer $PAT" \
    -H "Accept: application/vnd.github+json" \
    -d "$body" \
    "https://api.github.com/repos/${REPO}/actions/secrets/${name}" \
    -o /dev/null -w "  ✓ %{http_code} ${name}\n" || \
    printf "  ✗ FAILED %s\n" "$name"
}

for entry in "${MAP[@]}"; do
  name="${entry%%=*}"
  var="${entry##*=}"
  set_secret "$name" "${!var:-}"
done

echo "done"
