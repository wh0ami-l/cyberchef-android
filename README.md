# CyberChef for Android

> **Unofficial port.** This is an independent Android build of CyberChef. It is
> not produced, endorsed, sponsored or approved by GCHQ, the Crown, or the
> CyberChef maintainers, and the Apache License grants no rights to the
> "CyberChef" name or logo (section 6). Please report bugs in *this* Android
> app here rather than in the upstream tracker.

A touch-first Android build of [CyberChef](https://github.com/gchq/CyberChef), the
Cyber Swiss Army Knife. The full operation set — all 500+ operations, including
the lazily-loaded ones and the OCR engine — runs locally in the app's WebView.

The upstream web app is **never modified**. The mobile experience is a separate
override layer that is injected into the production bundle at packaging time, so
`CyberChef/` can be pulled forward from upstream at any time and repackaged.

Chinese walkthrough with screenshots from a real phone:
[`docs/使用指南.md`](docs/使用指南.md).

## Layout

| Path | What it is |
| --- | --- |
| `CyberChef/` | Upstream checkout (unmodified, not committed). Pinned by `CYBERCHEF_VERSION`. |
| `mobile/` | The adaptation layer: `preinit.js`, `mobile.css`, `mobile.js`. |
| `android/` | The native shell (Java + Gradle) that hosts the WebView. |
| `scripts/` | Packaging, testing, screenshot and build tooling. |
| `docs/` | User guide and release process. |
| `toolchain/`, `sdk/` | Pinned JDK 17, Gradle and Android SDK (not committed). |

## Building

From a fresh clone:

```bash
scripts/bootstrap.sh        # toolchain + upstream checkout + web bundle + keystore
scripts/build-apk.sh        # package the web layer + Gradle release
```

`scripts/bootstrap.sh` is idempotent and does the whole setup: it downloads a
pinned JDK 17, Gradle and the Android SDK into `toolchain/` and `sdk/`, clones
CyberChef at the revision in `CYBERCHEF_VERSION`, runs the web build, and creates
the release keystore if there is none.

`scripts/build-apk.sh` copies `CyberChef/build/prod` into the app's assets,
injects the mobile layer, runs `assembleRelease`, and mirrors the signed APK to
the workspace root as `CyberChef-app-release.apk`.

Useful flags:

```bash
scripts/build-apk.sh --skip-web    # Java/resources only (fast iteration)
scripts/build-apk.sh --debug       # assembleDebug instead
```

The build is self-contained: `JAVA_HOME`, `ANDROID_HOME` and `GRADLE_USER_HOME`
all point inside this directory, so it does not depend on a system SDK.

## Signing

The release keystore and its password are **secrets and are gitignored**. If both
leak, anyone can sign an APK that Android will install as an update over yours,
so they must never be committed.

```bash
scripts/make-keystore.sh    # generates android/keystore/ + android/keystore.properties
```

Credentials are read from `android/keystore.properties`, or from the
`KEYSTORE_FILE` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` environment
variables (which is how CI supplies them). See
[`docs/发布指南.md`](docs/发布指南.md) and `.github/workflows/release.yml`.

> Rotating the signing key means existing installs cannot be upgraded in place —
> Android refuses an APK whose signer differs, so users have to uninstall first.
> Do it before the first public release rather than after.

## Testing

There is no emulator requirement. `scripts/test-web.mjs` serves the packaged
assets over a loopback origin — the same kind of real origin the APK gets from
`WebViewAssetLoader` — and drives headless Chrome over the DevTools protocol at
a phone viewport with touch emulation:

```bash
node scripts/package-web.mjs     # refresh android/app/src/main/assets/www
node scripts/test-web.mjs        # 60 end-to-end checks
node scripts/screenshot.mjs      # write PNGs of every UI state to .build-tmp/shots/
node scripts/screenshot.mjs --width 844 --height 390 --tag landscape
```

The suite covers the touch layout, the resizable split workspace, the workspace
settings sheet, tap-to-add, step reordering and deletion, and a real end-to-end
bake through the Web Worker that loads a lazily-imported module (MD5).

### On a real device

Headless Chrome is not enough. The debug build enables WebView debugging (the
release build deliberately does not), which makes the running app inspectable and
drivable over adb:

```bash
scripts/build-apk.sh --debug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.cyberchef.mobile.debug/com.cyberchef.mobile.MainActivity

node scripts/test-device.mjs     # 29 checks, every interaction a real touch
node scripts/device-eval.mjs "document.documentElement.className"
node scripts/device-eval.mjs --tap "#categories .op-list li.operation" \
  "document.querySelectorAll('#rec-list li.operation').length"
```

`test-device.mjs` performs every interaction with `adb shell input tap`/`swipe`,
so it exercises Android's input stack and the real (and older) system WebView
rather than desktop Chrome. Two bugs went undetected until it existed:

- **Tapping an operation did nothing.** The operation list is sortable, and
  SortableJS cancels the synthetic click a tap produces, so the `click` listener
  never ran. The headless suite missed it because dispatching a synthetic
  `MouseEvent("click")` from JavaScript bypasses touch handling altogether. Both
  suites now tap through the real input pipeline.
- **Move-up silently undid itself.** On a touch device the browser's click
  arrives *before* `pointerup`, so a click listener plus a pointerup synthesiser
  ran every action twice — and moving a step up and then up again leaves the
  recipe unchanged. The per-step controls are now driven only by the tap
  detector, with keyboard activation handled separately.

`scripts/eval-page.mjs` evaluates an arbitrary expression against the live page
and is the tool of choice for measuring a layout problem instead of guessing:

```bash
node scripts/eval-page.mjs --setup "document.querySelector('#cc-tabbar .cc-tab[data-tab=recipe]').click()" \
  "document.getElementById('recipe').scrollWidth"
```

One coordinate trap worth knowing: `adb shell input tap` takes screen pixels,
while `getBoundingClientRect()` returns page CSS pixels. The WebView sits below
the status bar, an offset the page cannot see (`window.screenY` is 0 inside a
WebView), so `device-eval.mjs --tap` derives both the scale and the offset from
the DevTools target description instead of hard-coding them.

## How this differs from other ways of running CyberChef on a phone

Upstream has no mobile UI, and the request has been open for years:

| Issue | Title | Opened | State |
| --- | --- | --- | --- |
| [gchq/CyberChef#181](https://github.com/gchq/CyberChef/issues/181) | Misc: Mobile UI | 2017-08-18 | open |
| [gchq/CyberChef#1416](https://github.com/gchq/CyberChef/issues/1416) | does not work properly on mobile phones | 2022-09-12 | open |
| [gchq/CyberChef#2051](https://github.com/gchq/CyberChef/issues/2051) | Feature request: Mobile Phone Support | 2025-05-24 | open |

#181 already framed the choice: *"1. Create an entirely separate UI for mobile
devices, 2. Make modifications to the current UI so that it adjusts better to fit
smaller screens."* This project takes route 1.

Existing packaging efforts take neither. The most complete one,
[`liudonghua123/cyberchef-app`](https://github.com/liudonghua123/cyberchef-app),
is a Tauri wrapper that ships an Android APK but contains **no mobile, touch or
responsive code** — CyberChef is a git submodule and the stock desktop four-pane
UI is what you get. Its own README says it works "quite well, actually - on
macOS, Windows, and Linux", conspicuously omitting the platform it ships an APK
for.

Concretely, the difference is:

| | Wrapping the desktop build | This project |
| --- | --- | --- |
| Layout | four panes squeezed into a phone | bottom tab bar, one pane at a time, or a **resizable split** |
| Adding an operation | double-click or drag | single tap |
| Reordering a recipe | drag with a finger | explicit move-up / move-down / delete buttons |
| Upstream sources | forked, or a submodule as-is | **never modified**; the touch layer is injected at packaging time |
| Verification | none | 69 automated checks, plus real-touch tests on a physical device |

That said, this is not a claim to be the best: it has been exercised on exactly
one device (OnePlus 8T, Android 12, WebView 103), has no users yet, and the
desktop layout it can switch to remains cramped on a phone by design — it is an
escape hatch, not a feature.

## Using it

A Chinese walkthrough with screenshots taken from a real phone lives in
[`docs/使用指南.md`](docs/使用指南.md) (interface tour, the input → operations →
output flow, the resizable split workspace, and the mobile-specific behaviours
such as the layered Back button and keyboard avoidance).

## The mobile layer

`mobile/preinit.js` runs before the first paint. It installs the viewport meta
tag and decides whether the touch layout applies, setting `cc-mobile` on
`<html>` — the single switch `mobile.css` keys off. It also defends that class
against CyberChef's theme code, which assigns
`document.querySelector(":root").className = theme` and so *replaces* the whole
class list (see "Layout races" below).

`mobile/mobile.css` is a pure override stylesheet scoped to `html.cc-mobile`.
Wide screens keep CyberChef's native four-pane desktop layout untouched.

`mobile/mobile.js` builds the touch UI and bridges to the native shell:

- **One-pane mode** — a bottom tab bar switches between Operations, Recipe,
  Input and Output, each full-bleed.
- **Split mode** — two panes at once with a draggable divider, so the
  algorithm-selection area can be sized to taste. The divider writes a single
  CSS custom property (`--cc-split-size`), so a drag costs one style
  recalculation of the workspace subtree and no JavaScript layout work.
  Stacked in portrait, side by side in landscape (or forced either way).
  Each slot has a picker for which pane it shows, and the position is
  persisted along with the rest of the workspace state.
- **Workspace sheet** — layout mode, slot panes, divider position with presets,
  direction, and editor text size. Everything persists in `localStorage`.
- **Touch affordances** — tap an operation to add it, explicit up/down/delete
  controls on each recipe step, and a step-count badge on the tab bar.
- **Native bridge** — file save (streamed to `MediaStore`/Downloads in chunks),
  clipboard, external links, folder picking, `Back` handling and files opened
  from other apps.

## Layout races

Two upstream behaviours make a one-shot "is this mobile?" decision unsafe, and
both are handled in the mobile layer rather than by patching CyberChef:

1. CyberChef applies the theme with
   `document.querySelector(":root").className = theme`, replacing the entire
   class list and removing `cc-mobile`. `preinit.js` watches the class attribute
   and re-asserts it.
2. That assignment happens in the *same synchronous block* that dispatches
   `apploaded`, so a MutationObserver callback has not run yet when the app
   announces it is ready. `mobile.js` therefore treats the layout as
   re-derivable state: it rebuilds or tears down the touch UI whenever the class
   list changes, instead of deciding once.

## Performance

- The action bar is CyberChef's own `#controls` element relocated in the DOM, so
  its event listeners and direct references survive — no re-binding.
- The split ratio is a CSS custom property, so resizing does not touch pane
  geometry from JavaScript.
- Divider drags are `requestAnimationFrame`-throttled and persist only on
  release.
- Packaging keeps every operation and asset the desktop build has; only webpack's
  redundant `.gz`/`.br` siblings and the standalone single-file build are
  dropped, since the APK compresses assets itself.
