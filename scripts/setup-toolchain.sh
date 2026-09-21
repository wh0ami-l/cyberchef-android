#!/usr/bin/env bash
#
# Downloads the pinned build toolchain into this directory:
#
#   toolchain/jdk17          JDK 17 (AGP 8.x refuses anything newer for the build JVM)
#   toolchain/gradle-8.10.2  Gradle
#   sdk/                     Android SDK: platform-tools, android-35, build-tools 35
#
# Everything lands inside the repository so the build does not depend on a
# system SDK and does not need write access to $HOME. Both directories are
# gitignored.
#
# Idempotent: anything already present is left alone.
#
# Usage: scripts/setup-toolchain.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/toolchain"
SDK="$ROOT/sdk"

JDK_DIR="$TC/jdk17"
GRADLE_DIR="$TC/gradle-8.10.2"
GRADLE_VERSION=8.10.2
CMDTOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

mkdir -p "$TC" "$SDK"

echo "== [1/4] JDK 17 =="
if [ -x "$JDK_DIR/bin/java" ]; then
    echo "   already present"
else
    curl -fsSL -o "$TC/jdk17.tar.gz" \
        "https://corretto.aws/downloads/latest/amazon-corretto-17-x64-linux-jdk.tar.gz"
    tar xzf "$TC/jdk17.tar.gz" -C "$TC"
    mv "$(find "$TC" -maxdepth 1 -type d -name 'amazon-corretto-17*' | head -1)" "$JDK_DIR"
    rm -f "$TC/jdk17.tar.gz"
fi
"$JDK_DIR/bin/java" -version 2>&1 | head -1 | sed 's/^/   /'

echo "== [2/4] Android command-line tools =="
if [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "   already present"
else
    curl -fsSL -o "$TC/cmdtools.zip" "$CMDTOOLS_URL"
    rm -rf "$SDK/cmdline-tools/latest" "$TC/cmdtools-tmp"
    unzip -q "$TC/cmdtools.zip" -d "$TC/cmdtools-tmp"
    mkdir -p "$SDK/cmdline-tools"
    mv "$TC/cmdtools-tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
    rm -rf "$TC/cmdtools-tmp" "$TC/cmdtools.zip"
fi

export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK"
export PATH="$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$PATH"

echo "== [3/4] Android SDK packages =="
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0" 2>&1 | tail -2 | sed 's/^/   /'

echo "== [4/4] Gradle $GRADLE_VERSION =="
if [ -x "$GRADLE_DIR/bin/gradle" ]; then
    echo "   already present"
else
    curl -fsSL -o "$TC/gradle.zip" \
        "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
    unzip -q "$TC/gradle.zip" -d "$TC"
    rm -f "$TC/gradle.zip"
fi

# The Android build reads the SDK location from here (gitignored).
echo "sdk.dir=$SDK" > "$ROOT/android/local.properties"

echo
echo "Toolchain ready."
echo "  JAVA_HOME=$JDK_DIR"
echo "  ANDROID_HOME=$SDK"
