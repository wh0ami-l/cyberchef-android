#!/usr/bin/env bash
#
# Prepares a fresh clone so it can build the APK.
#
#   1. checks the host tools the build needs
#   2. downloads the pinned JDK / Android SDK / Gradle
#   3. clones CyberChef at the exact revision in CYBERCHEF_VERSION
#   4. builds the web bundle
#   5. creates the release keystore if there is none
#
# Safe to re-run: every step is skipped when its output already exists.
#
# Usage: scripts/bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== [1/5] Host prerequisites =="
missing=0
for tool in git node npm curl unzip; do
    if command -v "$tool" >/dev/null 2>&1; then
        printf '   %-6s %s\n' "$tool" "$("$tool" --version 2>&1 | head -1)"
    else
        printf '   %-6s MISSING\n' "$tool"
        missing=1
    fi
done
[ "$missing" -eq 0 ] || { echo "error: install the missing tools first" >&2; exit 1; }

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ] || [ "$node_major" -gt 26 ]; then
    echo "warning: CyberChef expects Node >=24 <27, found $(node -v)" >&2
fi

echo
echo "== [2/5] Toolchain =="
# shellcheck source=/dev/null
bash scripts/setup-toolchain.sh

echo
echo "== [3/5] Upstream CyberChef =="
# shellcheck source=/dev/null
. "$ROOT/CYBERCHEF_VERSION"

if [ -d "$ROOT/CyberChef/.git" ]; then
    echo "   already cloned at $(git -C "$ROOT/CyberChef" rev-parse --short HEAD)"
else
    echo "   cloning $REPOSITORY at $COMMIT"
    git clone "$REPOSITORY" "$ROOT/CyberChef"
fi
git -C "$ROOT/CyberChef" fetch --quiet origin "$COMMIT" 2>/dev/null || true
git -C "$ROOT/CyberChef" checkout --quiet "$COMMIT"
echo "   checked out $(git -C "$ROOT/CyberChef" describe --tags --always)"

echo
echo "== [4/5] Web bundle =="
if [ -f "$ROOT/CyberChef/build/prod/index.html" ]; then
    echo "   already built (delete CyberChef/build to force a rebuild)"
else
    ( cd "$ROOT/CyberChef" && npm ci && npm run build )
fi

echo
echo "== [5/5] Signing key =="
if [ -f "$ROOT/android/keystore.properties" ]; then
    echo "   already present"
else
    bash scripts/make-keystore.sh
fi

cat <<EOF

Bootstrap complete. Next:

    scripts/build-apk.sh                 # package the web layer + assembleRelease
    node scripts/package-web.mjs         # repackage the web assets only
    node scripts/test-web.mjs            # 62 checks in headless Chrome

The APK lands in the repository root as CyberChef-app-release.apk.
EOF
