#!/usr/bin/env node
/**
 * Diagnostic: boots the packaged app in headless Chrome at a phone viewport and
 * evaluates one JavaScript expression against the live page, printing the
 * result as JSON. Used to measure layout problems without guessing.
 *
 * Usage:
 *   node .build-tmp/eval.mjs "<expression>"
 *   node .build-tmp/eval.mjs --setup "<expr>" "<expression>"
 *
 * --setup runs first (e.g. to switch layout or open a pane) and is awaited.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {spawn} from "node:child_process";

const ROOT = "/home/loswer/Cy";
const WWW = path.join(ROOT, "android/app/src/main/assets/www");
const WORK = path.join(ROOT, ".build-tmp/eval-profile");

const MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".wasm": "application/wasm",
    ".png": "image/png", ".ico": "image/x-icon", ".gz": "application/gzip",
    ".ttf": "font/ttf", ".fnt": "application/octet-stream"};

const sleep = ms => new Promise(r => setTimeout(r, ms));

let setup = null;
let expression = null;
let WIDTH = 390;
let HEIGHT = 844;
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--width") WIDTH = parseInt(process.argv[++i], 10);
    else if (a === "--height") HEIGHT = parseInt(process.argv[++i], 10);
    else if (a === "--setup") setup = process.argv[++i];
    else expression = a;
}
if (!expression) {
    console.error("usage: node .build-tmp/eval.mjs [--width N] [--height N] [--setup <expr>] <expression>");
    process.exit(2);
}

const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    const f = path.join(WWW, p === "/" ? "/index.html" : p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end("nf"); return; }
    res.writeHead(200, {"Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream"});
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

fs.rmSync(WORK, {recursive: true, force: true, maxRetries: 5});
const chrome = spawn("/usr/bin/google-chrome-stable", [
    "--headless=new", "--remote-debugging-port=9666", `--user-data-dir=${WORK}`,
    "--no-first-run", "--no-sandbox", "--disable-dev-shm-usage", "about:blank"
], {stdio: ["ignore", "ignore", "ignore"]});

async function devtools() {
    for (let i = 0; i < 150; i++) {
        try {
            const r = await fetch("http://127.0.0.1:9666/json/list");
            const t = (await r.json()).find(x => x.type === "page");
            if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
        } catch (err) { /* not up */ }
        await sleep(200);
    }
    throw new Error("no devtools");
}

const socket = new WebSocket(await devtools());
await new Promise(r => socket.addEventListener("open", r, {once: true}));
let id = 0;
const pending = new Map();
socket.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(r => {
    const i = ++id;
    pending.set(i, r);
    socket.send(JSON.stringify({id: i, method, params}));
});
async function ev(expr) {
    const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, userGesture: true, awaitPromise: true});
    if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
}
async function waitFor(expr, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (await ev(expr)) return true; } catch (err) { /* settling */ }
        await sleep(200);
    }
    return false;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true});
await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/index.html#input=SGVsbG8%3D&recipe=From_Base64('A-Za-z0-9%2B/%3D',true)`});

await waitFor("!!(window.app && window.app.appLoaded && window.app.waitersLoaded && window.app.workerLoaded)", 90000);
await waitFor("document.documentElement.classList.contains('cc-mobile')", 15000);
await sleep(1000);

if (setup) {
    await ev(setup);
    await sleep(600);
}

try {
    console.log(JSON.stringify(await ev(expression), null, 2));
} catch (err) {
    console.error("evaluate failed:", err.message);
    process.exitCode = 1;
}

socket.close();
chrome.kill("SIGKILL");
server.close();
fs.rmSync(WORK, {recursive: true, force: true, maxRetries: 5});
process.exit(process.exitCode || 0);
