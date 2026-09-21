#!/usr/bin/env node
/**
 * Functional test of the debug build running on a connected device.
 *
 * Unlike scripts/test-web.mjs, which drives headless Chrome, every interaction
 * here is a real `adb shell input tap` / `swipe`. That goes through Android's
 * input stack into the WebView, so it reproduces what a finger actually does —
 * including the synthetic-click cancellation that sortable lists perform, which
 * a JavaScript-dispatched MouseEvent silently hides.
 *
 * The script also reads the page back through the DevTools protocol, so it can
 * assert on application state rather than pixels.
 *
 * Requires: the debug build installed and in the foreground, a device visible
 * to adb, and WebView debugging enabled (see MainActivity).
 *
 * Usage: node scripts/test-device.mjs [--adb <path>] [--verbose]
 */

import {execFileSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argIndex = (name) => process.argv.indexOf(name);
const ADB = argIndex("--adb") >= 0
    ? process.argv[argIndex("--adb") + 1]
    : path.join(ROOT, "sdk", "platform-tools", "adb");
const VERBOSE = process.argv.includes("--verbose");

const PACKAGE = "com.cyberchef.mobile.debug";
const PORT = 9223;

const adb = (...args) => execFileSync(ADB, args, {encoding: "utf8"}).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
    checks++;
    if (ok) {
        console.log(`  \u2713 ${name}`);
    } else {
        failures++;
        console.log(`  \u2717 ${name}${detail === undefined ? "" : `\n      ${detail}`}`);
    }
}

// ---- connect ---------------------------------------------------------

const pid = adb("shell", "pidof", PACKAGE);
if (!pid) {
    console.error(`error: ${PACKAGE} is not running. Install the debug build and launch it.`);
    process.exit(2);
}
adb("forward", "--remove-all");
adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === "page");
if (!target) {
    console.error("error: no page target found in the WebView");
    process.exit(2);
}
let view = {};
try {
    view = JSON.parse(target.description || "{}");
} catch (err) { /* not fatal */ }

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", () => reject(new Error("websocket failed")), {once: true});
});

let nextId = 0;
const pendingCalls = new Map();
const pageErrors = [];
socket.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pendingCalls.has(m.id)) {
        pendingCalls.get(m.id)(m);
        pendingCalls.delete(m.id);
        return;
    }
    if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        pageErrors.push("uncaught: " + (d.exception?.description || d.text));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        pageErrors.push("console.error: " +
            m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
    }
});

const send = (method, params = {}) => new Promise(r => {
    const id = ++nextId;
    pendingCalls.set(id, r);
    socket.send(JSON.stringify({id, method, params}));
});

async function page(expression) {
    const r = await send("Runtime.evaluate", {
        expression, returnByValue: true, userGesture: true, awaitPromise: true
    });
    if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
}

// ---- real input ------------------------------------------------------

/** Converts page CSS coordinates into screen pixels for `adb shell input`. */
async function toScreen(x, y) {
    const metrics = await page("({w: window.innerWidth, dpr: window.devicePixelRatio})");
    const scale = (view.width || metrics.w * metrics.dpr) / metrics.w;
    return {
        x: Math.round((view.screenX || 0) + x * scale),
        y: Math.round((view.screenY || 0) + y * scale)
    };
}

async function boxOf(selector) {
    const box = await page(`(()=>{
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el) return null;
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};
    })()`);
    if (!box) throw new Error(`no element matched ${selector}`);
    if (box.w < 1 || box.h < 1) throw new Error(`${selector} has no layout (${box.w}x${box.h})`);
    return box;
}

/** Taps an element with a genuine Android touch event. */
async function tap(selector, settle = 700) {
    const box = await boxOf(selector);
    const pt = await toScreen(box.x, box.y);
    if (VERBOSE) console.log(`    tap ${selector} -> screen(${pt.x}, ${pt.y})`);
    adb("shell", "input", "tap", String(pt.x), String(pt.y));
    await sleep(settle);
}

/** Swipes between two elements or points with a genuine Android gesture. */
async function swipe(fromSelector, dx, dy, duration = 700) {
    const box = await boxOf(fromSelector);
    const a = await toScreen(box.x, box.y);
    const b = await toScreen(box.x + dx, box.y + dy);
    if (VERBOSE) console.log(`    swipe (${a.x},${a.y}) -> (${b.x},${b.y})`);
    adb("shell", "input", "swipe", String(a.x), String(a.y), String(b.x), String(b.y), String(duration));
    await sleep(700);
}

async function waitFor(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await page(expression)) return true;
        } catch (err) { /* settling */ }
        await sleep(300);
    }
    return false;
}

const visiblePanes = `(()=>{
    const ids=['operations','recipe','input','output'];
    return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none');
})()`;

// ---- run -------------------------------------------------------------

console.log(`\nTesting ${PACKAGE} on device ${adb("shell", "getprop", "ro.product.model")} ` +
    `(Android ${adb("shell", "getprop", "ro.build.version.release")})`);
console.log(`WebView: ${(await page("navigator.userAgent")).match(/Chrome\/[\d.]+/)[0]}\n`);

await send("Runtime.enable");
await sleep(500);

// Reset to a known state. CyberChef writes the recipe and input into the URL
// hash as you work, so a plain reload would restore whatever the last run left
// behind; navigating to the bare URL is what actually clears it.
const APP_URL = "https://appassets.androidplatform.net/assets/www/index.html";

async function loadClean() {
    await send("Page.navigate", {url: APP_URL});
    await waitFor("!!(window.app && window.app.appLoaded && window.app.waitersLoaded && window.app.workerLoaded)", 60000);
    await waitFor("document.documentElement.classList.contains('cc-mobile')", 20000);
    await sleep(1200);
}

await loadClean();
await page(`(()=>{
    for (const k of Object.keys(localStorage)) {
        if (k.indexOf('cc') === 0) localStorage.removeItem(k);
    }
    return true;
})()`);
await loadClean();

console.log("Layout");
check("touch layout is active",
    await page("document.documentElement.classList.contains('cc-mobile')"));
check("the class survives the theme being applied",
    await page("document.documentElement.className").then(c => c.includes("classic") && c.includes("cc-mobile")));
check("four-tab bottom bar exists",
    await page("document.querySelectorAll('#cc-tabbar .cc-tab').length") === 4);
check("the page never scrolls",
    await page("document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth"));
check("no element overflows the viewport horizontally",
    await page(`[...document.querySelectorAll('body *')].filter(e=>{
        const r=e.getBoundingClientRect();
        return r.width>0 && getComputedStyle(e).position!=='fixed' && (r.right>window.innerWidth+1||r.left<-1);
    }).length`) === 0);

console.log("\nOperations and recipe (real touches)");
await tap("#cc-tabbar .cc-tab[data-tab=operations]");
check("operations tab shows its pane",
    await page("document.getElementById('operations').classList.contains('cc-pane-active')"));

const stepCount = () => page("document.querySelectorAll('#rec-list li.operation').length");

const firstOp = await page("document.querySelector('#categories .op-list li.operation').textContent.trim()");
const stepsBefore = await stepCount();
await tap("#categories .op-list li.operation");
const stepsAfter = await stepCount();
check(`one real tap on "${firstOp}" adds it to the recipe`,
    stepsAfter === stepsBefore + 1, `${stepsBefore} -> ${stepsAfter}`);
check("the recipe tab shows a step-count badge",
    await page("document.querySelector('#cc-tabbar [data-badge=recipe]').textContent") === String(stepsAfter));

// A second step, so the reorder controls are both enabled.
await tap("#categories .op-list li.operation:nth-child(2)");
check("a second tap adds a second step",
    await stepCount() === stepsAfter + 1);

await tap("#cc-tabbar .cc-tab[data-tab=recipe]");
check("recipe pane shows the added operations",
    await page("document.querySelectorAll('#rec-list li.operation .cc-op-actions').length") === stepsAfter + 1);

const orderBefore = await page("[...document.querySelectorAll('#rec-list .op-title')].map(e=>e.textContent.trim())");
await tap("#rec-list li.operation:last-child .cc-op-up");
const orderAfter = await page("[...document.querySelectorAll('#rec-list .op-title')].map(e=>e.textContent.trim())");
check("the move-up control reorders the recipe",
    orderBefore.length === orderAfter.length &&
    orderAfter[orderAfter.length - 1] === orderBefore[orderBefore.length - 2] &&
    orderAfter[orderAfter.length - 2] === orderBefore[orderBefore.length - 1],
    `${JSON.stringify(orderBefore)} -> ${JSON.stringify(orderAfter)}`);

await tap("#rec-list li.operation:last-child .cc-op-delete");
check("the delete control removes a step", await stepCount() === stepsAfter);
check("the badge follows the deletion",
    await page("document.querySelector('#cc-tabbar [data-badge=recipe]').textContent") === String(stepsAfter));

console.log("\nBake through the worker (real touches)");
// Build a deterministic recipe through the real UI: clear, search, tap the
// result. The Operations pane has to be showing for its list to have layout.
await page("window.app.manager.recipe.clearRecipe()");
await sleep(500);
await tap("#cc-tabbar .cc-tab[data-tab=operations]");
await page(`(()=>{
    const s=document.getElementById('search');
    s.value='From Base64';
    s.dispatchEvent(new Event('search',{bubbles:true}));
    return true;
})()`);
await sleep(800);
await tap("#search-results li.operation");
check("searching and tapping a result adds it to the recipe",
    await page("document.querySelectorAll('#rec-list li.operation').length") === 1,
    `steps=${await page("document.querySelectorAll('#rec-list li.operation').length")}`);

// Base64 of "Hello".
await page("window.app.manager.input.setInput('SGVsbG8=')");
await sleep(600);
await page("document.getElementById('bake').click()");
const baked = await waitFor(
    "document.querySelector('#output-text .cm-content') && "
    + "document.querySelector('#output-text .cm-content').innerText.indexOf('Hello')>=0", 30000);
const outText = await page("(document.querySelector('#output-text .cm-content')||{}).innerText || ''");
check("From Base64 bakes through the Web Worker", baked, `output=${JSON.stringify(outText.slice(0, 80))}`);

// A lazily-loaded module, to prove module chunks load from the asset origin.
await page("window.app.manager.recipe.clearRecipe()");
await sleep(400);
await page("window.app.manager.recipe.addOperation('MD5')");
await page("window.app.manager.input.setInput('Hello')");
await sleep(500);
await page("document.getElementById('bake').click()");
const hashed = await waitFor(
    "document.querySelector('#output-text .cm-content') && "
    + "document.querySelector('#output-text .cm-content').innerText.indexOf('8b1a9953c4611296a827abf8c47804d7')>=0", 30000);
check("MD5 bakes from the lazily loaded Hashing module", hashed,
    `output=${JSON.stringify((await page("(document.querySelector('#output-text .cm-content')||{}).innerText || ''")).slice(0, 60))}`);

console.log("\nSplit workspace (real touches)");
await tap("#cc-workspace-btn");
check("workspace sheet opens",
    await page("!!document.getElementById('cc-workspace-sheet')"));
await tap("#cc-workspace-sheet .cc-seg button[data-value=split]");
const splitPanes = await page(visiblePanes);
check("split shows exactly two panes", splitPanes.length === 2, JSON.stringify(splitPanes));
check("the divider exists",
    await page("!!document.getElementById('cc-splitter')"));
check("the tab bar is hidden in split mode",
    await page("getComputedStyle(document.getElementById('cc-tabbar')).display") === "none");
await tap("#cc-workspace-sheet .cc-sheet-close");
await sleep(400);

const geom = () => page(`(()=>{
    const w=document.getElementById('workspace-wrapper').getBoundingClientRect();
    const p=document.getElementById('operations').getBoundingClientRect();
    return {wrapper:Math.round(w.height), pane:Math.round(p.height),
            size:document.getElementById('workspace-wrapper').style.getPropertyValue('--cc-split-size')};
})()`);

const beforeDrag = await geom();
await swipe("#cc-splitter", 0, -120);
const afterDrag = await geom();
check("a real finger drag resizes the algorithm-selection pane",
    afterDrag.pane < beforeDrag.pane - 40,
    `before=${beforeDrag.pane}px after=${afterDrag.pane}px`);
check("the new ratio is persisted",
    parseFloat(await page("localStorage.getItem('ccSplitSize')")) < 50,
    `ccSplitSize=${await page("localStorage.getItem('ccSplitSize')")}`);
check("the pane still fills its share of the workspace",
    Math.abs(afterDrag.wrapper - (beforeDrag.wrapper)) < 2 && afterDrag.pane > 0,
    JSON.stringify(afterDrag));

await tap(".cc-slot-picker[data-slot=second]");
check("the slot picker opens on a real tap",
    await page("document.querySelectorAll('.cc-pane-menu .cc-pane-menu-item').length") === 4);
await tap(".cc-pane-menu-item[data-pane=output]");
check("choosing a pane re-points the slot",
    await page("document.getElementById('output').classList.contains('cc-pane-active')"));

// Persistence across a restart of the page.
await send("Page.reload", {});
await waitFor("!!(window.app && window.app.appLoaded && window.app.waitersLoaded && window.app.workerLoaded)", 60000);
await sleep(1500);
check("split layout is restored after a reload",
    await page("document.documentElement.classList.contains('cc-split')"));
check("the restored ratio matches what was saved",
    Math.abs(parseFloat(await page("document.getElementById('workspace-wrapper').style.getPropertyValue('--cc-split-size')")) - parseFloat(afterDrag.size)) < 0.01,
    `saved=${afterDrag.size} restored=${await page("document.getElementById('workspace-wrapper').style.getPropertyValue('--cc-split-size')")}`);

await tap("#cc-workspace-btn");
await tap("#cc-workspace-reset");
check("reset returns to the single-pane layout",
    await page("!document.documentElement.classList.contains('cc-split')"));
await tap("#cc-workspace-sheet .cc-sheet-close");

console.log("\nHealth");
check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 5).join("\n      "));

const perf = await page(`(()=>{
    const n=performance.getEntriesByType('navigation')[0]||{};
    const mem=performance.memory||{};
    return {
        domContentLoaded: Math.round(n.domContentLoadedEventEnd||0),
        loadEvent: Math.round(n.loadEventEnd||0),
        usedHeapMB: mem.usedJSHeapSize ? Math.round(mem.usedJSHeapSize/1048576) : null
    };
})()`);
console.log(`  timing: DOMContentLoaded ${perf.domContentLoaded} ms, load ${perf.loadEvent} ms`
    + (perf.usedHeapMB === null ? "" : `, JS heap ${perf.usedHeapMB} MiB`));

socket.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
