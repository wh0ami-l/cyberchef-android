#!/usr/bin/env node
/**
 * Packages the CyberChef production web build into the Android app's assets
 * and injects the mobile adaptation layer.
 *
 *   CyberChef/build/prod/**  ->  android/app/src/main/assets/www/**
 *
 * Injected into the copied index.html:
 *   - a viewport meta tag (upstream has none, so the WebView would otherwise
 *     lay out at ~980px and scale everything down)
 *   - cc-preinit.js, inlined into <head> so the touch layout is chosen before
 *     the first paint
 *   - cc-mobile.css, loaded last so it wins the cascade
 *   - cc-mobile.js, loaded last so CyberChef's bundle is already registered
 *
 * Pre-compressed .gz/.br siblings and the standalone single-file build are
 * skipped: the APK compresses assets itself and shipping both would roughly
 * triple the download.
 *
 * Usage: node scripts/package-web.mjs
 */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BUILD_DIR = path.join(ROOT, "CyberChef", "build", "prod");
const MOBILE_DIR = path.join(ROOT, "mobile");
const WWW_DIR = path.join(ROOT, "android", "app", "src", "main", "assets", "www");

/**
 * Files that are redundant or developer-only.
 *
 * Note the deliberate precision on the first pattern: only the .gz/.br siblings
 * that webpack generates for its own .js/.css/.html output are redundant. Other
 * .gz assets are real payloads — notably tesseract's eng.traineddata.gz, which
 * the OCR operation needs.
 */
const EXCLUDE_PATTERNS = [
    /\.(?:js|css|html)\.(?:gz|br)$/,
    /\.zip$/,
    /^BundleAnalyzerReport\.html$/,
    /^CyberChef_v.*\.html$/,
    /^sha256digest\.txt$/,
    /^sitemap\.xml$/
];

function fail(message) {
    console.error(`\n  error: ${message}\n`);
    process.exit(1);
}

/** Recursively copies a directory, honouring EXCLUDE_PATTERNS. */
function copyTree(src, dest, stats) {
    fs.mkdirSync(dest, {recursive: true});
    for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyTree(from, to, stats);
        } else if (entry.isFile()) {
            if (EXCLUDE_PATTERNS.some(re => re.test(entry.name))) {
                stats.skipped++;
                continue;
            }
            fs.copyFileSync(from, to);
            stats.files++;
            stats.bytes += fs.statSync(to).size;
        }
    }
}

/**
 * Inserts markup into an HTML document.
 *
 * @param {string} html
 * @param {RegExp} marker - anchor tag to insert before
 * @param {string} snippet
 * @returns {string}
 */
function injectBefore(html, marker, snippet) {
    if (!marker.test(html)) fail(`could not find ${marker} in index.html`);
    return html.replace(marker, (match) => `${snippet}\n${match}`);
}

/**
 * Inserts markup immediately after an anchor tag.
 *
 * @param {string} html
 * @param {RegExp} marker
 * @param {string} snippet
 * @returns {string}
 */
function injectAfter(html, marker, snippet) {
    if (!marker.test(html)) fail(`could not find ${marker} in index.html`);
    return html.replace(marker, (match) => `${match}\n${snippet}`);
}

function readMobileFile(name) {
    const file = path.join(MOBILE_DIR, name);
    if (!fs.existsSync(file)) fail(`missing mobile layer file: ${file}`);
    return fs.readFileSync(file, "utf8");
}

// ---------------------------------------------------------------- main

if (!fs.existsSync(path.join(BUILD_DIR, "index.html"))) {
    fail(`no production build found at ${BUILD_DIR}\n  Run:  cd CyberChef && npm run build`);
}

const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, "CyberChef", "package.json"), "utf8")
).version;

console.log(`Packaging CyberChef v${version}`);
console.log(`  from  ${BUILD_DIR}`);
console.log(`  to    ${WWW_DIR}`);

fs.rmSync(WWW_DIR, {recursive: true, force: true});
fs.mkdirSync(WWW_DIR, {recursive: true});

const stats = {files: 0, bytes: 0, skipped: 0};
copyTree(BUILD_DIR, WWW_DIR, stats);

// --- mobile layer assets ---
fs.writeFileSync(path.join(WWW_DIR, "cc-mobile.css"), readMobileFile("mobile.css"));
fs.writeFileSync(path.join(WWW_DIR, "cc-mobile.js"), readMobileFile("mobile.js"));
stats.files += 2;

// --- index.html surgery ---
const indexPath = path.join(WWW_DIR, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

// Guard against double-injection if this ever runs twice on the same tree.
if (html.includes("cc-mobile.js")) {
    fail("index.html already contains the mobile layer");
}

const preinit = `${readMobileFile("preinit.js").trim()}\nwindow.__ccVersion = ${JSON.stringify(version)};`;

// The viewport tag must be static and early — a JS-inserted one can be missed
// by the first layout pass. It is placed inside <head> (rather than just before
// it, which the parser would silently repair) so the emitted HTML is valid.
html = injectAfter(
    html,
    /<head[^>]*>/i,
    '<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, viewport-fit=cover">'
);

html = injectBefore(
    html,
    /<\/head>/i,
    `<link rel="stylesheet" href="cc-mobile.css">\n<script id="cc-preinit">${preinit}</script>`
);

html = injectBefore(
    html,
    /<\/body>/i,
    // `defer` makes this run after CyberChef's own deferred bundle, in document
    // order, so window.app exists by the time it executes.
    '<script defer src="cc-mobile.js"></script>'
);

fs.writeFileSync(indexPath, html);

// ---------------------------------------------------------------- report

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const largest = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else largest.push([path.relative(WWW_DIR, full), fs.statSync(full).size]);
    }
})(WWW_DIR);
largest.sort((a, b) => b[1] - a[1]);

console.log(`\n  ${stats.files} files, ${mb(stats.bytes)} of assets`);
console.log(`  ${stats.skipped} redundant files skipped (.gz/.br/standalone)`);
console.log("\n  largest assets:");
for (const [name, size] of largest.slice(0, 8)) {
    console.log(`    ${mb(size).padStart(10)}  ${name}`);
}
console.log("\nPackaging complete.");
