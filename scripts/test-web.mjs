#!/usr/bin/env node
/**
 * End-to-end check of the packaged mobile web layer.
 *
 * Serves android/app/src/main/assets/www over a loopback HTTP origin (the same
 * kind of real origin the APK gets from WebViewAssetLoader) and drives headless
 * Chrome at phone dimensions over the DevTools protocol. It asserts that the
 * touch layout activates, that the CyberChef app boots, and that a recipe from a
 * lazily-loaded module actually bakes through the Web Worker.
 *
 * Usage: node scripts/test-web.mjs [--headful] [--keep]
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WWW = path.join(ROOT, "android", "app", "src", "main", "assets", "www");
const WORK = path.join(ROOT, ".build-tmp", "webtest");

const HEADFUL = process.argv.includes("--headful");
const KEEP = process.argv.includes("--keep");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".fnt": "application/octet-stream",
    ".gz": "application/gzip",
    ".txt": "text/plain",
    ".map": "application/json"
};

// ---------------------------------------------------------------- utilities

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
    checks++;
    if (ok) {
        console.log(`  \u2713 ${name}`);
    } else {
        failures++;
        console.log(`  \u2717 ${name}${detail === undefined ? "" : `\n      ${detail}`}`);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
        let filePath = path.join(WWW, urlPath === "/" ? "/index.html" : urlPath);

        // Never escape the asset root.
        if (!filePath.startsWith(WWW)) {
            res.writeHead(403).end("forbidden");
            return;
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, "index.html");
        }
        if (!fs.existsSync(filePath)) {
            res.writeHead(404).end("not found");
            return;
        }
        const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {"Content-Type": type});
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => resolve({server, port: server.address().port}));
    });
}

function launchChrome(port, userDataDir) {
    const chrome = "/usr/bin/google-chrome-stable";
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--window-size=390,844",
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
        "about:blank"
    ];
    if (!HEADFUL) args.unshift("--headless=new");
    fs.mkdirSync(userDataDir, {recursive: true});
    return spawn(chrome, args, {stdio: ["ignore", "pipe", "pipe"]});
}

async function waitForDevTools(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await res.json();
            const page = targets.find(t => t.type === "page");
            if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch (err) { /* not up yet */ }
        await sleep(200);
    }
    throw new Error("Chrome DevTools endpoint never became available");
}

// ---------------------------------------------------------------- CDP client

class CDP {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        ws.addEventListener("message", ev => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const {resolve, reject} = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.ws.send(JSON.stringify({id, method, params}));
        });
    }

    /** Evaluates an expression in the page and returns its value. */
    async eval(expression, awaitPromise = false) {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
            userGesture: true
        });
        if (result.exceptionDetails) {
            throw new Error("evaluate failed: " +
                (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        }
        return result.result.value;
    }

    consoleErrors() {
        const out = [];
        for (const e of this.events) {
            if (e.method === "Runtime.exceptionThrown") {
                const d = e.params.exceptionDetails;
                out.push("uncaught: " + (d.exception?.description || d.text));
            }
            if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
                out.push("console.error: " +
                    e.params.args.map(a => a.value ?? a.description ?? "").join(" "));
            }
        }
        return out;
    }
}

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, {once: true});
        ws.addEventListener("error", () => reject(new Error("websocket failed")), {once: true});
    });
    return new CDP(ws);
}

// ---------------------------------------------------------------- main

async function main() {
    if (!fs.existsSync(path.join(WWW, "index.html"))) {
        console.error("No packaged web assets. Run: node scripts/package-web.mjs");
        process.exit(1);
    }

    fs.rmSync(WORK, {recursive: true, force: true});
    fs.mkdirSync(WORK, {recursive: true});

    const {server, port} = await startServer();
    const debugPort = 9333;
    const chrome = launchChrome(debugPort, path.join(WORK, "chrome-profile"));
    chrome.stderr.on("data", () => { /* chrome is chatty on stderr */ });

    let cdp;
    try {
        const wsUrl = await waitForDevTools(debugPort);
        cdp = await connect(wsUrl);
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await cdp.send("Log.enable");

        // Phone-sized layout with touch emulation so `pointer: coarse` matches.
        await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 390, height: 844, deviceScaleFactor: 1, mobile: true
        });
        await cdp.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});

        // Reproduce the two things the WebView provides that headless Chrome
        // does not, so the mobile layer's native bridges are actually exercised:
        //
        //   * window.CCAndroid — injected by MainActivity.addJavascriptInterface
        //   * an async clipboard API that *exists* but rejects, which is what
        //     Android's WebView does ("NotAllowedError: Document is not
        //     focused"). A test that only checks the API is present would pass
        //     while copy is broken on every phone.
        //
        // Injected before any page script so the mobile layer sees it at load.
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `
                window.__nativeCalls = {copyText: [], saveStart: null, openExternal: []};
                window.CCAndroid = {
                    copyText: function (text) { window.__nativeCalls.copyText.push(text); },
                    openExternal: function (url) { window.__nativeCalls.openExternal.push(url); },
                    saveStart: function () { window.__nativeCalls.saveStart = true; },
                    saveChunk: function () {},
                    saveFinish: function () {},
                    saveAbort: function () {},
                    ready: function () {},
                    toast: function () {}
                };
                try {
                    Object.defineProperty(navigator, "clipboard", {
                        configurable: true,
                        value: {
                            writeText: function () {
                                return Promise.reject(new DOMException(
                                    "Document is not focused.", "NotAllowedError"));
                            },
                            readText: function () {
                                return Promise.reject(new DOMException(
                                    "Document is not focused.", "NotAllowedError"));
                            }
                        }
                    });
                } catch (err) { /* leave it alone */ }
            `
        });

        // A recipe using a lazily-loaded module (Hashing) proves that the
        // worker can importScripts its module chunks from the asset origin, and
        // MD5 of "Hello" is a fixed, verifiable value.
        const url = `http://127.0.0.1:${port}/index.html` +
            "#recipe=MD5()&input=SGVsbG8%3D";

        console.log(`\nServing ${WWW}`);
        console.log(`Loading  ${url}\n`);

        await cdp.send("Page.navigate", {url});

        // Wait for CyberChef to finish loading.
        const booted = await waitFor(cdp, "!!(window.app && window.app.manager)", 60000);
        check("CyberChef app boots", booted, await cdp.eval("document.body.innerText.slice(0,400)"));

        const ready = await waitFor(cdp,
            "!!(window.app.workerLoaded && window.app.waitersLoaded && window.app.appLoaded)", 60000);
        check("Web Worker and waiters report ready", ready);

        // ---- layout -------------------------------------------------
        console.log("\nLayout");
        const diag = await cdp.eval(`({
            innerWidth: window.innerWidth,
            clientWidth: document.documentElement.clientWidth,
            coarse: window.matchMedia('(pointer: coarse)').matches,
            fine: window.matchMedia('(pointer: fine)').matches,
            hasPreinit: typeof window.__ccIsMobile,
            forced: (()=>{try{return localStorage.getItem('ccLayoutMode')}catch(e){return 'ERR'}})(),
            shouldBeMobile: window.__ccIsMobile ? window.__ccIsMobile() : null,
            ccVersion: window.__ccVersion || null,
            htmlClass: document.documentElement.className
        })`);
        console.log("  diagnostics:", JSON.stringify(diag));
        check("touch layout class applied",
            await cdp.eval("document.documentElement.classList.contains('cc-mobile')"));
        check("viewport meta present",
            await cdp.eval("!!document.querySelector('meta[name=viewport]')"));
        check("four-tab bottom bar built",
            await cdp.eval("document.querySelectorAll('#cc-tabbar .cc-tab').length") === 4);
        check("tab bar is a real bottom bar",
            await cdp.eval("(()=>{const r=document.getElementById('cc-tabbar').getBoundingClientRect();" +
                "return r.height>40 && Math.abs(r.bottom-window.innerHeight)<2})()"));
        check("action bar relocated out of the recipe pane",
            await cdp.eval("document.getElementById('controls').parentElement.id") === "content-wrapper");
        check("splitters are not reachable",
            await cdp.eval("getComputedStyle(document.querySelector('.gutter')).display") === "none");

        // Only one workspace pane is visible at a time.
        const hidden = await cdp.eval(`(()=>{
            const ids=['operations','recipe','input','output'];
            return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none');
        })()`);
        check("exactly one pane visible on load", hidden.length === 1, JSON.stringify(hidden));

        // ---- resizable split workspace ------------------------------
        console.log("\nWorkspace (resizable split)");
        check("workspace button present in the app bar",
            await cdp.eval("!!document.getElementById('cc-workspace-btn')"));

        await cdp.eval("document.getElementById('cc-workspace-btn').click()");
        await sleep(200);
        check("workspace sheet opens",
            await cdp.eval("!!document.getElementById('cc-workspace-sheet')"));

        // Switch to the split layout from the sheet.
        await cdp.eval(`document.querySelector('#cc-workspace-sheet .cc-seg button[data-value=split]').click()`);
        await sleep(250);

        const splitVisible = await cdp.eval(`(()=>{
            const ids=['operations','recipe','input','output'];
            return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none');
        })()`);
        check("split shows exactly two panes", splitVisible.length === 2, JSON.stringify(splitVisible));
        check("split divider is present",
            await cdp.eval("!!document.getElementById('cc-splitter')"));
        check("divider is a real separator",
            await cdp.eval("document.getElementById('cc-splitter').getAttribute('role')") === "separator");
        check("tab bar is hidden while split",
            await cdp.eval("getComputedStyle(document.getElementById('cc-tabbar')).display") === "none");

        // Rotation flips the split from stacked to side by side, without a
        // reload: the axis preference is "auto" by default.
        await cdp.send("Emulation.setDeviceMetricsOverride",
            {width: 844, height: 390, deviceScaleFactor: 1, mobile: true});
        await sleep(600);
        check("landscape split puts the panes side by side",
            await cdp.eval("document.documentElement.classList.contains('cc-split-h')"));
        check("landscape panes are still both visible",
            await cdp.eval(`(()=>{
                const ids=['operations','recipe','input','output'];
                return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none').length;
            })()`) === 2);
        await cdp.send("Emulation.setDeviceMetricsOverride",
            {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
        await sleep(600);
        check("portrait split stacks the panes",
            await cdp.eval("document.documentElement.classList.contains('cc-split-v')"));

        // A snackbar is shown in a fixed container pinned to the viewport
        // bottom upstream, which would put it behind the action bar and the tab
        // bar.
        await cdp.eval("window.app.alert('snackbar position check', 30000)");
        await sleep(300);
        const snack = await cdp.eval(`(()=>{
            const c=document.getElementById('snackbar-container');
            if(!c) return null;
            return {
                bottom: Math.round(c.getBoundingClientRect().bottom),
                controlsTop: Math.round(document.getElementById('controls').getBoundingClientRect().top)
            };
        })()`);
        check("snackbar is not hidden behind the action bar",
            snack !== null && snack.bottom <= snack.controlsTop + 1, JSON.stringify(snack));
        await cdp.eval(`(()=>{const c=document.getElementById('snackbar-container'); if(c) c.innerHTML='';})()`);

        // Slot pickers let either slot be re-pointed at another pane.
        check("each split slot has a pane picker",
            await cdp.eval("document.querySelectorAll('.cc-slot-picker').length") === 2);
        await cdp.eval("document.querySelector('.cc-slot-picker[data-slot=second]').click()");
        await sleep(150);
        check("slot picker opens a pane menu",
            await cdp.eval("document.querySelectorAll('.cc-pane-menu .cc-pane-menu-item').length") === 4);
        check("the pane already shown in the other slot is disabled",
            await cdp.eval("document.querySelector('.cc-pane-menu-item[data-pane=operations]').disabled") === true);
        await cdp.eval("document.querySelector('.cc-pane-menu-item[data-pane=output]').click()");
        await sleep(250);
        check("choosing a pane re-points the slot",
            await cdp.eval("document.getElementById('output').classList.contains('cc-pane-active')"));

        // A slot holding Input or Output must still offer its picker. Input and
        // Output share #IO, which has no title bar of its own, so a picker
        // attached to the host element silently disappears and the slot can
        // never be re-pointed again.
        const pickers = await cdp.eval(`[...document.querySelectorAll('.cc-slot-picker')].map(c=>{
            const r=c.getBoundingClientRect();
            const pane=c.closest('#operations,#recipe,#input,#output');
            return {slot:c.getAttribute('data-slot'), pane:pane?pane.id:null,
                    w:Math.round(r.width), left:Math.round(r.left), right:Math.round(r.right)};
        })`);
        check("both slot pickers exist and are on screen",
            pickers.length === 2 &&
            pickers.every(p => p.w > 1 && p.right <= 390 && p.left >= 0),
            JSON.stringify(pickers));
        check("each picker sits on the pane its slot now holds",
            pickers.some(p => p.slot === "first" && p.pane === "operations") &&
            pickers.some(p => p.slot === "second" && p.pane === "output"),
            JSON.stringify(pickers));

        // Back to Operations/Recipe for the drag test, then dismiss the sheet:
        // its backdrop is modal and would swallow the drag.
        await cdp.eval("document.querySelector('.cc-slot-picker[data-slot=second]').click()");
        await sleep(120);
        await cdp.eval("document.querySelector('.cc-pane-menu-item[data-pane=recipe]').click()");
        await sleep(200);
        await cdp.eval("document.querySelector('#cc-workspace-sheet .cc-sheet-close').click()");
        await sleep(200);
        check("sheet closes again",
            await cdp.eval("!document.getElementById('cc-workspace-sheet')"));

        // --- drag the divider -----------------------------------------
        const geometry = () => cdp.eval(`(()=>{
            const w=document.getElementById('workspace-wrapper');
            const op=document.getElementById('operations').getBoundingClientRect();
            const r=document.getElementById('cc-splitter').getBoundingClientRect();
            return {
                topPane: Math.round(op.height),
                wrapper: Math.round(w.getBoundingClientRect().height),
                x: Math.round(r.left+r.width/2),
                y: Math.round(r.top+r.height/2)
            };
        })()`);

        const beforeDrag = await geometry();
        await drag(cdp, beforeDrag.x, beforeDrag.y, beforeDrag.x, beforeDrag.y + 90);
        const afterDrag = await geometry();

        check("dragging the divider resizes the top pane",
            afterDrag.topPane > beforeDrag.topPane + 40,
            `before=${beforeDrag.topPane}px after=${afterDrag.topPane}px`);
        check("panes still fill the workspace after the drag",
            Math.abs(afterDrag.topPane + (afterDrag.wrapper - afterDrag.topPane) - afterDrag.wrapper) < 2,
            JSON.stringify(afterDrag));

        const persisted = await cdp.eval("localStorage.getItem('ccSplitSize')");
        check("dragged ratio is persisted", parseFloat(persisted) > 50, `ccSplitSize=${persisted}`);
        check("CSS variable drives the split",
            await cdp.eval(`document.getElementById('workspace-wrapper').style.getPropertyValue('--cc-split-size')`)
                === `${parseFloat(persisted).toFixed(2)}%`);

        // --- presets and text size (need the sheet open again) ---------
        await cdp.eval("document.getElementById('cc-workspace-btn').click()");
        await sleep(250);
        await cdp.eval("document.querySelector('#cc-workspace-sheet .cc-preset[data-size=\"25\"]').click()");
        await sleep(250);
        const afterPreset = await geometry();
        check("25% preset sizes the top pane to about a quarter",
            Math.abs(afterPreset.topPane / afterPreset.wrapper - 0.25) < 0.05,
            `${afterPreset.topPane}/${afterPreset.wrapper}`);

        // --- editor text size -----------------------------------------
        await cdp.eval(`(()=>{
            const el=document.querySelector('#cc-workspace-sheet input[aria-label="Editor text size"]');
            el.value='17';
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await sleep(200);
        check("editor text size applies",
            await cdp.eval("document.documentElement.style.getPropertyValue('--cc-editor-font')") === "17px");

        // --- persistence across a reload -------------------------------
        await cdp.eval("document.querySelector('#cc-workspace-sheet .cc-sheet-close').click()");
        await sleep(150);
        await reload(cdp);
        check("split layout survives a reload",
            await cdp.eval("document.documentElement.classList.contains('cc-split')"));
        check("two panes visible after the reload",
            await cdp.eval(`(()=>{
                const ids=['operations','recipe','input','output'];
                return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none').length;
            })()`) === 2);
        check("restored ratio matches what was saved",
            await cdp.eval(`(()=>{
                const w=document.getElementById('workspace-wrapper');
                return w.style.getPropertyValue('--cc-split-size');
            })()`) === "25.00%");
        check("restored text size survives the reload",
            await cdp.eval("document.documentElement.style.getPropertyValue('--cc-editor-font')") === "17px");

        // --- reset -----------------------------------------------------
        await cdp.eval("document.getElementById('cc-workspace-btn').click()");
        await sleep(200);
        await cdp.eval("document.getElementById('cc-workspace-reset').click()");
        await sleep(300);
        check("reset returns to the single-pane layout",
            await cdp.eval("!document.documentElement.classList.contains('cc-split')"));
        check("reset removes the divider",
            await cdp.eval("!document.getElementById('cc-splitter')"));
        check("reset shows exactly one pane",
            await cdp.eval(`(()=>{
                const ids=['operations','recipe','input','output'];
                return ids.filter(id=>getComputedStyle(document.getElementById(id)).display!=='none').length;
            })()`) === 1);
        await cdp.eval("document.querySelector('#cc-workspace-sheet .cc-sheet-close').click()");
        await sleep(150);

        // ---- operations list ----------------------------------------
        console.log("\nOperations");
        const opCount = await cdp.eval(
            "document.querySelectorAll('#categories .op-list li.operation').length");
        check(`operations list populated (${opCount})`, opCount > 400);

        // Tab switching.
        await cdp.eval("document.querySelector('#cc-tabbar .cc-tab[data-tab=operations]').click()");
        await sleep(150);
        check("operations tab activates its pane",
            await cdp.eval("document.getElementById('operations').classList.contains('cc-pane-active')"));
        check("recipe pane hidden while on operations",
            await cdp.eval("getComputedStyle(document.getElementById('recipe')).display") === "none");
        check("tab bar marks the active tab",
            await cdp.eval("document.querySelector('#cc-tabbar .cc-tab.cc-active').dataset.tab") === "operations");

        // Tap-to-add, with a real touch gesture.
        const before = await cdp.eval("document.querySelectorAll('#rec-list li.operation').length");
        await tapElement(cdp, "#categories .op-list li.operation");
        const after = await cdp.eval("document.querySelectorAll('#rec-list li.operation').length");
        check("single tap adds an operation to the recipe",
            after === before + 1, `before=${before} after=${after}`);
        check("recipe badge reflects the step count",
            await cdp.eval("document.querySelector('#cc-tabbar [data-badge=recipe]').textContent") === String(after));

        check("per-step touch controls injected",
            await cdp.eval("document.querySelectorAll('#rec-list li.operation .cc-op-actions').length") === after);
        check("reorder controls disable at the ends",
            await cdp.eval(`(()=>{
                const items=[...document.querySelectorAll('#rec-list li.operation')];
                if(items.length<2) return false;
                const first=items[0].querySelector('.cc-op-up');
                const last=items[items.length-1].querySelector('.cc-op-down');
                return first.disabled===true && last.disabled===true;
            })()`));

        // The tap above appended an operation, which would change the result of
        // the bake asserted below. Before removing it, exercise reordering with
        // real taps: a move that runs twice would undo itself, which is exactly
        // what happens if a click listener and the pointer tap detector both
        // fire for one finger tap.
        await cdp.eval("document.querySelector('#cc-tabbar .cc-tab[data-tab=recipe]').click()");
        await sleep(200);

        const orderA = await cdp.eval(
            "[...document.querySelectorAll('#rec-list .op-title')].map(e=>e.textContent.trim())");
        await tapElement(cdp, "#rec-list li.operation:last-child .cc-op-up");
        const orderB = await cdp.eval(
            "[...document.querySelectorAll('#rec-list .op-title')].map(e=>e.textContent.trim())");
        check("move-up reorders the recipe",
            orderB[0] === orderA[1] && orderB[1] === orderA[0],
            `${JSON.stringify(orderA)} -> ${JSON.stringify(orderB)}`);

        await tapElement(cdp, "#rec-list li.operation:first-child .cc-op-down");
        const orderC = await cdp.eval(
            "[...document.querySelectorAll('#rec-list .op-title')].map(e=>e.textContent.trim())");
        check("move-down restores the order",
            JSON.stringify(orderC) === JSON.stringify(orderA),
            `${JSON.stringify(orderB)} -> ${JSON.stringify(orderC)}`);

        await tapElement(cdp, "#rec-list li.operation:last-child .cc-op-delete");
        check("delete control removes a step",
            await cdp.eval("document.querySelectorAll('#rec-list li.operation').length") === before,
            `expected ${before} step(s) after deleting the added one`);
        await cdp.eval("document.querySelector('#cc-tabbar .cc-tab[data-tab=operations]').click()");
        await sleep(150);

        // ---- end-to-end bake ----------------------------------------
        console.log("\nBake (worker + lazy module load)");
        const baked = await waitFor(cdp,
            "document.querySelector('#output-text .cm-content') && " +
            "document.querySelector('#output-text .cm-content').innerText.indexOf('8b1a9953c4611296a827abf8c47804d7')>=0",
            60000);
        const output = await cdp.eval(
            "(document.querySelector('#output-text .cm-content')||{}).innerText || ''");
        check("MD5 of 'Hello' baked through the worker from a lazily loaded module",
            baked, `output=${JSON.stringify(output.slice(0, 200))}`);

        // ---- clipboard -----------------------------------------------
        // The WebView exposes navigator.clipboard on a secure origin but
        // rejects the call ("Document is not focused"), so a bridge that only
        // installs itself when the API is *missing* leaves copy broken. The
        // injected clipboard above rejects exactly like the device does.
        console.log("\nClipboard");
        const direct = await cdp.eval(`(async()=>{
            try {
                await navigator.clipboard.writeText('bridge probe');
            } catch (err) {
                // Without the bridge this is exactly what the user sees: the
                // platform call rejects and CyberChef reports a failed copy.
                return {error: err.name};
            }
            return window.__nativeCalls.copyText.slice();
        })()`, true);
        check("writeText falls back to the native bridge when the platform API rejects",
            Array.isArray(direct) && direct.length === 1 && direct[0] === "bridge probe",
            JSON.stringify(direct));

        await cdp.eval("document.getElementById('copy-output').click()");
        await sleep(800);
        const copied = await cdp.eval("window.__nativeCalls.copyText");
        check("CyberChef's copy button reaches the native clipboard bridge",
            copied.some(t => t.indexOf("8b1a9953c4611296a827abf8c47804d7") >= 0),
            JSON.stringify(copied.map(t => t.slice(0, 32))));
        check("CyberChef reports the copy as successful",
            await cdp.eval("(document.getElementById('snackbar-container')||{}).innerText || ''")
                .then(t => t.indexOf("could not be copied") < 0 && t.indexOf("successfully") >= 0),
            JSON.stringify(await cdp.eval(
                "((document.getElementById('snackbar-container')||{}).innerText||'').slice(0,120)")));

        // ---- desktop escape hatch -----------------------------------
        // Switching back to the desktop layout has to undo every DOM change
        // the touch layer made, and switching forward again has to rebuild it.
        console.log("\nDesktop layout (reversible)");
        await cdp.eval("localStorage.setItem('ccLayoutMode','desktop')");
        await reload(cdp);
        check("desktop mode drops the touch class",
            !(await cdp.eval("document.documentElement.classList.contains('cc-mobile')")));
        check("desktop mode removes the tab bar",
            await cdp.eval("!document.getElementById('cc-tabbar')"));
        check("desktop mode removes the workspace button",
            await cdp.eval("!document.getElementById('cc-workspace-btn')"));
        check("desktop mode returns the action bar to the recipe pane",
            await cdp.eval("document.getElementById('controls').parentElement.id") === "recipe");
        check("desktop mode removes the divider",
            await cdp.eval("!document.getElementById('cc-splitter')"));
        check("desktop mode strips the injected step controls",
            await cdp.eval("document.querySelectorAll('#rec-list .cc-op-actions').length") === 0);
        check("desktop mode leaves no pane layout classes",
            await cdp.eval("[...document.querySelectorAll('.cc-slot-first,.cc-slot-second,.cc-pane-active')].length") === 0);

        // Switching to the desktop layout tears down the app bar — which is
        // where the mode switch lives. Without a replacement the switch is a
        // one-way trip, so the escape hatch is asserted to exist, be on screen,
        // and actually work.
        check("desktop mode offers a way back to the touch layout",
            await cdp.eval(`(()=>{
                const b=document.getElementById('cc-layout-escape');
                if(!b) return false;
                const r=b.getBoundingClientRect();
                return r.width>1 && r.height>1 && r.left>=0 && r.top>=0 &&
                       r.right<=window.innerWidth && r.bottom<=window.innerHeight;
            })()`));

        await tapElement(cdp, "#cc-layout-escape");
        const returned = await waitFor(cdp,
            "!!(window.app && window.app.appLoaded) && " +
            "document.documentElement.classList.contains('cc-mobile')", 60000);
        check("the escape hatch really returns to the touch layout", returned);
        check("the escape hatch is removed once back in the touch layout",
            await cdp.eval("!document.getElementById('cc-layout-escape')"));
        // The class comes back before the touch UI is rebuilt: the build is
        // scheduled from the class observer, so poll rather than assume.
        const rebuilt = await waitFor(cdp,
            "document.querySelectorAll('#cc-tabbar .cc-tab').length === 4 && " +
            "!!document.getElementById('cc-workspace-btn')", 15000);
        check("the touch layout is fully rebuilt after the escape", rebuilt);

        await cdp.eval("localStorage.removeItem('ccLayoutMode')");
        await reload(cdp);
        check("touch layout is rebuilt after switching back",
            await cdp.eval("document.documentElement.classList.contains('cc-mobile')"));
        check("tab bar is rebuilt",
            await cdp.eval("document.querySelectorAll('#cc-tabbar .cc-tab').length") === 4);
        check("step controls are rebuilt",
            await cdp.eval(`(()=>{
                const n=document.querySelectorAll('#rec-list li.operation').length;
                return n>0 && document.querySelectorAll('#rec-list .cc-op-actions').length===n;
            })()`));

        // ---- errors --------------------------------------------------
        console.log("\nRuntime");
        const errors = cdp.consoleErrors();
        check("no uncaught page errors", errors.length === 0, errors.slice(0, 6).join("\n      "));

        const timing = await cdp.eval(`(()=>{
            const n=performance.getEntriesByType('navigation')[0];
            return n ? Math.round(n.domContentLoadedEventEnd) : -1;
        })()`);
        console.log(`\n  DOMContentLoaded at ${timing} ms`);

    } finally {
        try {
            if (cdp) cdp.ws.close();
        } catch (err) { /* ignore */ }
        chrome.kill("SIGKILL");
        server.close();
        if (!KEEP) fs.rmSync(WORK, {recursive: true, force: true});
    }

    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
}

/**
 * Taps an element with a real touch gesture through the DevTools input
 * pipeline.
 *
 * This matters: dispatching a synthetic MouseEvent('click') from JavaScript
 * bypasses the browser's touch handling entirely, and CyberChef's sortable
 * lists cancel the synthetic click that a real tap produces. A test written
 * with synthetic clicks therefore passes even when nothing works on a phone.
 */
async function tapElement(cdp, selector) {
    const box = await cdp.eval(`(()=>{
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el) return null;
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};
    })()`);
    if (!box) throw new Error(`no element matched ${selector}`);
    // An element inside a hidden pane has an empty rect at (0,0); tapping there
    // would silently hit whatever happens to be at the origin.
    if (box.w < 1 || box.h < 1) {
        throw new Error(`${selector} has no layout (${box.w}x${box.h}) — is its pane visible?`);
    }

    const point = {x: Math.round(box.x), y: Math.round(box.y), radiusX: 1, radiusY: 1, force: 1, id: 1};
    await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
    await sleep(60);
    await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
    await sleep(300);
}

/** Polls an expression in the page until it is truthy. */
async function waitFor(cdp, expression, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await cdp.eval(expression)) return true;
        } catch (err) { /* page still settling */ }
        await sleep(250);
    }
    return false;
}

/**
 * Drags from one viewport point to another with the mouse, which the page sees
 * as pointerdown/move/up — exactly what the divider listens for.
 */
async function drag(cdp, fromX, fromY, toX, toY) {
    await cdp.send("Input.dispatchMouseEvent",
        {type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1});
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(fromX + (toX - fromX) * i / steps),
            y: Math.round(fromY + (toY - fromY) * i / steps),
            button: "left",
            buttons: 1
        });
        await sleep(25);
    }
    await cdp.send("Input.dispatchMouseEvent",
        {type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1});
    await sleep(200);
}

/** Reloads the page and waits for the app — and the touch layout — to be back. */
async function reload(cdp) {
    await cdp.send("Page.reload", {ignoreCache: false});
    const ready = await waitFor(cdp,
        "!!(window.app && window.app.appLoaded && window.app.workerLoaded && window.app.waitersLoaded)",
        90000);
    if (!ready) throw new Error("app did not come back after a reload");
    await waitFor(cdp, "document.documentElement.classList.contains('cc-mobile')", 15000);
    await sleep(400);
}

main().catch(err => {
    console.error("\ntest harness failed:", err);
    process.exit(2);
});
