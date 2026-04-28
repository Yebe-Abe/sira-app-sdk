#!/usr/bin/env bash
# First-time publish of @sira-screen-share/support-react-native@0.0.1.
#
# Usage:
#   NPM_TOKEN=npm_xxxxxx ./ci/publish-v0.0.1.sh
#
# What this does (in order):
#   1. Verifies the working tree is clean and on main.
#   2. Ensures lib/ is freshly built.
#   3. Runs the same critical-CVE check the §9 workflow runs.
#   4. Verifies the registry doesn't already have v0.0.1.
#   5. Writes a TEMPORARY .npmrc with NPM_TOKEN, runs `npm publish --access public`,
#      then deletes the .npmrc no matter what (trap).
#   6. Tags `v0.0.1` locally and tells you how to push.
#
# We don't use --provenance here — that requires GitHub Actions OIDC and
# isn't available from a developer machine. v0.0.2 onward should publish
# through the §9 workflow which includes provenance.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "ERROR: set NPM_TOKEN before running. Example:"
  echo "  NPM_TOKEN=npm_xxxxxxxx ./ci/publish-v0.0.1.sh"
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
echo "▶ About to publish $NAME@$VERSION"
echo

# 1. Working tree clean check (warn, don't abort — user may have local lib/ artifacts).
if [[ -n "$(git status --porcelain)" ]]; then
  echo "  warn: working tree has uncommitted changes:"
  git status --short | sed 's/^/    /'
  echo
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "  warn: not on main (current: $BRANCH) — proceeding anyway"
fi

# 2. Build fresh
echo "▶ npm run build"
npm run build >/dev/null 2>&1 && echo "  ✓ lib/ rebuilt"

# 3. Critical-CVE audit (§9 gate)
echo "▶ npm audit --audit-level=critical"
if npm audit --audit-level=critical >/dev/null 2>&1; then
  echo "  ✓ no critical CVEs"
else
  echo "  ✗ critical CVE found — aborting"
  npm audit --audit-level=critical | tail -10
  exit 1
fi

# 4. Registry check — fail if v0.0.1 already exists
echo "▶ checking npm registry for $NAME@$VERSION"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  echo "  ✗ $NAME@$VERSION is already published. Bump the version in package.json first."
  exit 1
else
  echo "  ✓ $NAME@$VERSION not yet published"
fi

# 5. Temporary .npmrc with auth token. Trap deletes it on any exit path
#    (including npm publish errors, Ctrl-C, anything). Don't write to .npmrc
#    in the repo root anymore — bash trap behavior is unreliable when the
#    shell exits via `set -e` after a failed command, and we'd rather lose
#    a few config knobs than ever leak the token into a committed file.
#    Use a tempfile passed to npm via --userconfig instead.
NPMRC="$(mktemp -t sira-npmrc.XXXXXX)"
cleanup() { rm -f "$NPMRC"; }
trap cleanup EXIT INT TERM

cat > "$NPMRC" <<EOF
//registry.npmjs.org/:_authToken=$NPM_TOKEN
registry=https://registry.npmjs.org/
always-auth=true
EOF
chmod 600 "$NPMRC"

# Sanity: confirm token resolves to a real npm user before we attempt to
# publish. Surfaces "wrong token" / "scope-not-yours" early.
WHO="$(npm whoami --userconfig "$NPMRC" 2>&1 || true)"
if ! [[ "$WHO" =~ ^[a-z0-9._-]+$ ]]; then
  echo "  ✗ npm whoami failed: $WHO"
  echo "  (most likely the NPM_TOKEN is invalid or expired)"
  exit 1
fi
echo "  ✓ authenticated as $WHO"

echo "▶ npm publish --access public"
npm publish --access public --userconfig "$NPMRC"

# 6. Local tag
TAG="v$VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "  tag $TAG already exists locally"
else
  git tag -a "$TAG" -m "release: $TAG"
  echo "  ✓ tagged $TAG locally"
  echo
  echo "  push the tag with:"
  echo "    git push origin $TAG"
fi

echo
echo "✅ $NAME@$VERSION published."
echo "   Verify: https://www.npmjs.com/package/$NAME"
