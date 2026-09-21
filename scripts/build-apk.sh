#!/usr/bin/env bash
# Builds the CyberChef Android APK end to end:
#   1. packages CyberChef/build/prod into the app's assets (+ mobile layer)
#   2. runs the Gradle release build
#   3. copies the APK to the workspace root for convenience
#
# Usage:
#   scripts/build-apk.sh                 # package + assembleRelease
#   scripts/build-apk.sh --skip-web      # Java/resources only (fast iteration)
#   scripts/build-apk.sh --debug         # assembleDebug instead
set -euo pipefail

ROOT=/home/loswer/Cy
JAVA_HOME="$ROOT/toolchain/jdk17"
ANDROID_HOME="$ROOT/sdk"
GRADLE="$ROOT/toolchain/gradle-8.10.2/bin/gradle"
# Keep the Gradle cache and its extracted native libraries inside the project so
# the build is self-contained (and works when $HOME is not writable).
GRADLE_USER_HOME="$ROOT/.gradle"
export JAVA_HOME ANDROID_HOME GRADLE_USER_HOME

TASK=assembleRelease
SKIP_WEB=0
for arg in "$@"; do
    case "$arg" in
        --skip-web) SKIP_WEB=1 ;;
        --debug)    TASK=assembleDebug ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [ "$SKIP_WEB" -eq 0 ]; then
    echo "==> Packaging web assets"
    node "$ROOT/scripts/package-web.mjs"
fi

echo
echo "==> Gradle: $TASK"
cd "$ROOT/android"
"$GRADLE" "$TASK" --console=plain --stacktrace

# Locate the produced APK and mirror it to the workspace root.
APK_DIR="$ROOT/android/app/build/outputs/apk"
APK=$(find "$APK_DIR" -name '*.apk' -newer "$ROOT/android/settings.gradle" | sort | tail -1 || true)
if [ -z "$APK" ]; then
    APK=$(find "$APK_DIR" -name '*.apk' | sort | tail -1)
fi

if [ -n "$APK" ]; then
    OUT="$ROOT/CyberChef-$(basename "$APK")"
    cp "$APK" "$OUT"
    echo
    echo "==> APK: $OUT"
    ls -lh "$OUT"
fi
