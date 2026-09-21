#!/usr/bin/env node
/**
 * Captures screenshots of the packaged mobile UI in headless Chrome.
 *
 * Serves the same assets the APK ships and drives the same WebView-sized
 * viewport the test harness uses, then walks through the workspace states and
 * writes PNGs into .build-tmp/shots/.
 *
 * Usage: node scripts/screenshot.mjs [--width 390] [--height 844] [--tag name]
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WWW = path.join(ROOT, "android", "app", "src", "main", "assets", "www");
const OUT = path.join(ROOT, ".build-tmp", "shots");
const WORK = path.join(ROOT, ".build-tmp", "shots-profile");

const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const WIDTH = parseInt(arg("--width", "390"), 10);
const HEIGHT = parseInt(arg("--height", "844"), 10);
const TAG = arg("--tag", `${WIDTH}x${HEIGHT}`);

const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".wasm": "application/wasm",
    ".png": "image/png", ".ico": "image/x-icon", ".gz": "application/gzip",
    ".ttf": "font/ttf", ".fnt": "application/octet-stream"
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    let f = path.join(WWW, p === "/" ? "/index.html" : p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end("nf"); return; }
    res.writeHead(200, {"Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream"});
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

fs.rmSync(WORK, {recursive: true, force: true, maxRetries: 5});
fs.mkdirSync(OUT, {recursive: true});

const chrome = spawn("/usr/bin/google-chrome-stable", [
    "--headless=new", "--remote-debugging-port=9555", `--user-data-dir=${WORK}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-dev-shm-usage", "--no-sandbox",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`, "--force-device-scale-factor=1", "about:blank"
], {stdio: ["ignore", "ignore", "ignore"]});

async function devtools() {
    for (let i = 0; i < 150; i++) {
        try {
            const r = await fetch("http://127.0.0.1:9555/json/list");
            const t = (await r.json()).find(x => x.type === "page");
            if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
        } catch (err) { /* not up yet */ }
        await sleep(200);
    }
    throw new Error("no devtools endpoint");
}

const socket = new WebSocket(await devtools());
await new Promise(r => socket.addEventListener("open", r, {once: true}));

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params = {}) {
    const id = ++nextId;
    return new Promise(r => { pending.set(id, r); socket.send(JSON.stringify({id, method, params})); });
}
async function ev(expression) {
    const r = await send("Runtime.evaluate", {expression, returnByValue: true, userGesture: true});
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
}
async function waitFor(expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (await ev(expression)) return true; } catch (err) { /* settling */ }
        await sleep(200);
    }
    return false;
}

async function shot(name) {
    await sleep(350);
    const r = await send("Page.captureScreenshot", {format: "png"});
    const file = path.join(OUT, `${TAG}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log("  " + path.relative(ROOT, file));
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride",
    {width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true});
await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/index.html`});

console.log(`\nCapturing at ${WIDTH}x${HEIGHT}`);
await waitFor("!!(window.app && window.app.appLoaded && window.app.waitersLoaded && window.app.workerLoaded)", 90000);
await waitFor("document.documentElement.classList.contains('cc-mobile')", 15000);
await sleep(1200);

// Seed something worth looking at.
await ev(`document.querySelector('#cc-tabbar .cc-tab[data-tab=operations]').click()`);
await shot("01-operations");

await ev(`(()=>{
  const li=[...document.querySelectorAll('#categories .op-list li.operation')]
    .find(e=>e.textContent.trim().startsWith('From Base64'));
  if(li) li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
})()`);
await sleep(600);
await ev(`document.querySelector('#cc-tabbar .cc-tab[data-tab=recipe]').click()`);
await shot("02-recipe");

await ev(`document.querySelector('#cc-tabbar .cc-tab[data-tab=output]').click()`);
await shot("03-output");

await ev(`document.querySelector('#cc-tabbar .cc-tab[data-tab=input]').click()`);
await shot("04-input");

// Workspace sheet.
await ev("document.getElementById('cc-workspace-btn').click()");
await sleep(400);
await shot("05-sheet");

// Split layout, then drag the divider up to prove it resizes.
await ev("document.querySelector('#cc-workspace-sheet .cc-seg button[data-value=split]').click()");
await sleep(400);
await ev("document.querySelector('#cc-workspace-sheet .cc-sheet-close').click()");
await sleep(400);
await shot("06-split");

const box = await ev(`(()=>{const r=document.getElementById('cc-splitter').getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
await send("Input.dispatchMouseEvent",
    {type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1});
for (let i = 1; i <= 8; i++) {
    await send("Input.dispatchMouseEvent",
        {type: "mouseMoved", x: box.x, y: box.y - i * 14, button: "left", buttons: 1});
    await sleep(20);
}
await send("Input.dispatchMouseEvent",
    {type: "mouseReleased", x: box.x, y: box.y - 112, button: "left", buttons: 0, clickCount: 1});
await sleep(400);
await shot("07-split-dragged");

// Pane menu.
await ev("document.querySelector('.cc-slot-picker[data-slot=second]').click()");
await sleep(400);
await shot("08-pane-menu");
await ev("document.body.click()");

socket.close();
chrome.kill("SIGKILL");
server.close();
fs.rmSync(WORK, {recursive: true, force: true, maxRetries: 5});
console.log("\nDone.");
process.exit(0);
