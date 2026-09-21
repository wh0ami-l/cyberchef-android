#!/usr/bin/env bash
# Generates the Android launcher icon set from the upstream CyberChef logo.
#
# Run from anywhere; outputs into android/app/src/main/res/.
set -euo pipefail

ROOT=/home/loswer/Cy
SRC="$ROOT/CyberChef/src/web/static/images/logo/cyberchef.svg"
RES="$ROOT/android/app/src/main/res"
BG="#1F3A5F"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert is required" >&2; exit 1; }
[ -f "$SRC" ] || { echo "Logo not found: $SRC" >&2; exit 1; }

# --- Adaptive icon foreground (108dp canvas, logo inside the 72dp safe zone) ---
# density  canvas  logo  offset
gen_fg() {
    local dir="$1" canvas="$2" logo="$3" off="$4"
    mkdir -p "$RES/mipmap-$dir"
    rsvg-convert -w "$logo" -h "$logo" \
        --page-width "$canvas" --page-height "$canvas" \
        --left "$off" --top "$off" \
        "$SRC" -o "$RES/mipmap-$dir/ic_launcher_foreground.png"
}

gen_fg mdpi     108 62 23
gen_fg hdpi     162 93 35
gen_fg xhdpi    216 124 46
gen_fg xxhdpi   324 186 69
gen_fg xxxhdpi  432 248 92

# --- Legacy (pre-adaptive) square + round icons, composited on the brand colour ---
gen_legacy() {
    local dir="$1" size="$2"
    mkdir -p "$RES/mipmap-$dir"
    rsvg-convert -w "$size" -h "$size" --page-width "$size" --page-height "$size" \
        --left 0 --top 0 --background-color "$BG" \
        "$SRC" -o "$RES/mipmap-$dir/ic_launcher.png"
    rsvg-convert -w "$size" -h "$size" --page-width "$size" --page-height "$size" \
        --left 0 --top 0 --background-color "$BG" \
        "$SRC" -o "$RES/mipmap-$dir/ic_launcher_round.png"
}

gen_legacy mdpi    48
gen_legacy hdpi    72
gen_legacy xhdpi   96
gen_legacy xxhdpi  144
gen_legacy xxxhdpi 192

# --- Adaptive icon descriptors ---
mkdir -p "$RES/mipmap-anydpi-v26"
for name in ic_launcher ic_launcher_round; do
    cat > "$RES/mipmap-anydpi-v26/$name.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML
done

echo "Icons written to $RES/mipmap-*"
find "$RES" -name 'ic_launcher*' | sort
