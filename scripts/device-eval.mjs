#!/usr/bin/env node
/**
 * Evaluates JavaScript inside the WebView of the debug build running on a
 * connected device, and prints the result as JSON.
 *
 * This inspects the *real* app on real hardware, which is the only way to catch
 * things the headless harness cannot: the device WebView version, its actual
 * viewport, and how real touch input is dispatched.
 *
 * Requires the debug build (see MainActivity: WebView debugging is enabled only
 * when the app is debuggable) and a device visible to adb.
 *
 * Usage:
 *   node scripts/device-eval.mjs "<expression>"
 *   node scripts/device-eval.mjs --tap "<css selector>" "<expression>"
 *   node scripts/device-eval.mjs --adb <path-to-adb>
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

const PACKAGE = "com.cyberchef.mobile.debug";
const PORT = 9222;

function adb(...args) {
    return execFileSync(ADB, args, {encoding: "utf8"}).trim();
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

// ---- locate the page -------------------------------------------------

let pid;
try {
    pid = adb("shell", "pidof", PACKAGE);
} catch (err) {
    fail(`could not run adb (${ADB})`);
}
if (!pid) fail(`${PACKAGE} is not running — install and launch the debug build first`);

adb("forward", "--remove-all");
adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page");
if (!page) fail("no page target in the WebView devtools list");

// The viewport geometry lives in a JSON string on `description`, not in
// top-level fields.
let view = {};
try {
    view = JSON.parse(page.description || "{}");
} catch (err) { /* older WebView may not supply it */ }

// ---- CDP -------------------------------------------------------------

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", () => reject(new Error("websocket failed")), {once: true});
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    }
});
const send = (method, params = {}) => new Promise(r => {
    const id = ++nextId;
    pending.set(id, r);
    socket.send(JSON.stringify({id, method, params}));
});

async function ev(expression) {
    const r = await send("Runtime.evaluate", {
        expression, returnByValue: true, userGesture: true, awaitPromise: true
    });
    if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- arguments -------------------------------------------------------
//
//   --tap "<css selector>"   tap that element
//   --text "<visible text>"  tap the smallest visible element with that text
//   --find "<visible text>"  list every match with its screen rect (no tap)

const argv = process.argv.slice(2).filter((a, i, all) =>
    a !== "--adb" && all[i - 1] !== "--adb");

let tapSelector = null;
let tapText = null;
let findText = null;
while (argv.length && argv[0].startsWith("--")) {
    const flag = argv.shift();
    if (flag === "--tap") tapSelector = argv.shift();
    else if (flag === "--text") tapText = argv.shift();
    else if (flag === "--find") findText = argv.shift();
    else fail(`unknown option ${flag}`);
}
const expression = argv[0];
if (!expression) {
    fail('usage: node scripts/device-eval.mjs [--tap SEL | --text TXT | --find TXT] "<expression>"');
}

/**
 * Page CSS pixels -> screen pixels for `adb shell input`.
 *
 * getBoundingClientRect() works in page CSS pixels, while adb takes screen
 * pixels. The WebView sits below the status bar — an offset the page cannot see
 * (window.screenY is 0 inside a WebView) — and CSS pixels are scaled by the
 * device pixel ratio. Both come from the DevTools target description plus the
 * page's own viewport, so nothing is hard-coded.
 */
async function coordMapper() {
    const metrics = await ev("({w: window.innerWidth, dpr: window.devicePixelRatio})");
    const scale = (view.width || metrics.w * metrics.dpr) / metrics.w;
    const ox = view.screenX || 0;
    const oy = view.screenY || 0;
    return (x, y) => ({x: Math.round(ox + x * scale), y: Math.round(oy + y * scale)});
}

/** Script that finds visible elements by their rendered text. */
function textQuery(query, exact) {
    return `(()=>{
        const query=${JSON.stringify(query)};
        const exact=${exact ? "true" : "false"};
        const out=[];
        for (const el of document.querySelectorAll("button,a,li,label,span,div,td,th,h1,h2,h3,input,select")) {
            const txt=(el.textContent||"").trim().replace(/\\s+/g," ");
            if (!txt) continue;
            if (exact ? txt!==query : txt.indexOf(query)<0) continue;
            const r=el.getBoundingClientRect();
            if (r.width<2 || r.height<2) continue;
            if (r.right<1 || r.bottom<1 || r.left>window.innerWidth || r.top>window.innerHeight) continue;
            const cs=getComputedStyle(el);
            if (cs.visibility==="hidden" || cs.display==="none" || cs.opacity==="0") continue;
            if (el.disabled) continue;
            out.push({tag:el.tagName, cls:(typeof el.className==="string"?el.className:""),
                      txt:txt.slice(0,60), x:r.left+r.width/2, y:r.top+r.height/2,
                      w:Math.round(r.width), h:Math.round(r.height),
                      area:r.width*r.height});
        }
        // Smallest match first: a button beats the container that holds it.
        out.sort((a,b)=>a.area-b.area);
        return out;
    })()`;
}

async function findByText(query) {
    let hits = await ev(textQuery(query, true));
    if (!hits.length) hits = await ev(textQuery(query, false));
    return hits;
}

async function tapAt(pageX, pageY, label) {
    const toScreen = await coordMapper();
    const pt = toScreen(pageX, pageY);
    console.error(`tap ${label} -> screen(${pt.x}, ${pt.y})`);
    adb("shell", "input", "tap", String(pt.x), String(pt.y));
    await sleep(800);
}

// ---- run -------------------------------------------------------------

if (findText) {
    const hits = await findByText(findText);
    const toScreen = await coordMapper();
    console.log(JSON.stringify(hits.map(h => ({
        ...h,
        screenX: toScreen(h.x, h.y).x,
        screenY: toScreen(h.x, h.y).y
    })), null, 2));
    socket.close();
    process.exit(0);
}

if (tapText) {
    const hits = await findByText(tapText);
    if (!hits.length) fail(`no visible element whose text matches ${JSON.stringify(tapText)}`);
    const hit = hits[0];
    await tapAt(hit.x, hit.y, `<${hit.tag}.${hit.cls}> "${hit.txt}"`);
}

if (tapSelector) {
    const box = await ev(`(()=>{
        const el=document.querySelector(${JSON.stringify(tapSelector)});
        if(!el) return null;
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        return {
            x: r.left + r.width/2,
            y: r.top + r.height/2,
            w: r.width,
            h: r.height,
            label: el.tagName + '.' + (typeof el.className === 'string' ? el.className : ''),
            text: (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40)
        };
    })()`);
    if (!box) fail(`selector not found: ${tapSelector}`);
    if (box.w < 1 || box.h < 1) {
        fail(`${tapSelector} has no layout — is its pane visible?`);
    }
    await tapAt(box.x, box.y, `${box.label} "${box.text}"`);
}

try {
    console.log(JSON.stringify(await ev(expression), null, 2));
} catch (err) {
    console.error("evaluate failed:", err.message);
    process.exitCode = 1;
}

socket.close();
process.exit(process.exitCode || 0);
