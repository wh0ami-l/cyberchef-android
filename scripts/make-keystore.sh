#!/usr/bin/env bash
#
# Generates the release signing keystore.
#
# The keystore and its password are secrets: anyone who has both can sign an
# APK that Android will accept as a legitimate update to an installed app. They
# are therefore written outside version control — the keystore path is
# gitignored and the password lives in android/keystore.properties (also
# gitignored). Never commit either.
#
# Run once, then back the two files up somewhere safe. Losing them means you
# can never publish an update that existing installs will accept.
#
# Usage: scripts/make-keystore.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="$ROOT/android/keystore/cyberchef-release.jks"
PROPS="$ROOT/android/keystore.properties"
JAVA_HOME="${JAVA_HOME:-$ROOT/toolchain/jdk17}"
KEYTOOL="$JAVA_HOME/bin/keytool"

if [ ! -x "$KEYTOOL" ]; then
    KEYTOOL="$(command -v keytool || true)"
fi
[ -x "$KEYTOOL" ] || { echo "error: keytool not found (set JAVA_HOME)" >&2; exit 1; }

if [ -f "$KEYSTORE" ]; then
    echo "error: $KEYSTORE already exists." >&2
    echo "       Refusing to overwrite a signing key — existing installs depend on it." >&2
    echo "       Delete it yourself if you really mean to rotate." >&2
    exit 1
fi

# 32 bytes of base64 is far more than the 6 characters Android requires, and
# avoids shell-hostile characters.
PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-28)"

mkdir -p "$(dirname "$KEYSTORE")"

"$KEYTOOL" -genkeypair \
    -keystore "$KEYSTORE" \
    -alias cyberchef \
    -keyalg RSA -keysize 4096 -validity 10950 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -dname "CN=CyberChef Mobile (unofficial), OU=Android port, O=unofficial build, C=GB"

cat > "$PROPS" <<EOF
# Release signing credentials. GITIGNORED — never commit this file.
#
# Keep a backup: if it is lost you cannot publish an update that already
# installed copies will accept as an upgrade.
storeFile=keystore/cyberchef-release.jks
storePassword=$PASSWORD
keyAlias=cyberchef
keyPassword=$PASSWORD
EOF

chmod 600 "$PROPS" "$KEYSTORE"

cat <<EOF

Keystore created.

  keystore : $KEYSTORE
  password : $PROPS   (gitignored, mode 600)

Your signing password is:

    $PASSWORD

Save it in a password manager now, and add it to your repository's GitHub
secrets as KEYSTORE_PASSWORD / KEY_PASSWORD so CI can sign releases.

Both files are already excluded by .gitignore. Verify before your first push:

    git check-ignore -v android/keystore.properties android/keystore/cyberchef-release.jks
EOF
