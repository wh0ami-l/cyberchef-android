/**
 * CyberChef Mobile — pre-init.
 *
 * This snippet is inlined into the <head> of the packaged index.html so that it
 * runs before the first paint. It decides whether the touch layout should be
 * used and sets `cc-mobile` on <html>, which is the single switch that
 * cc-mobile.css keys off. Doing it here avoids a flash of the desktop
 * multi-pane layout.
 *
 * It also installs the viewport meta tag, which upstream CyberChef does not
 * have: without it the WebView would lay the page out at ~980px and scale it
 * down, making everything tiny.
 *
 * @copyright Crown Copyright 2016-2026
 * @license Apache-2.0
 */

(function () {
    "use strict";

    /** Width below which touch-primary devices get the mobile layout. */
    var COARSE_MAX_WIDTH = 1280;
    /** Width below which pointer-primary devices get the mobile layout. */
    var FINE_MAX_WIDTH = 820;

    var doc = document;
    var root = doc.documentElement;

    // ---- viewport ------------------------------------------------------
    if (!doc.querySelector('meta[name="viewport"]')) {
        var viewport = doc.createElement("meta");
        viewport.name = "viewport";
        viewport.content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, viewport-fit=cover";
        // The viewport meta has to be in <head> and seen before the first
        // layout pass. package-web.mjs normally injects this statically; this
        // is only a fallback for an index.html that was not post-processed.
        var head = doc.head || doc.getElementsByTagName("head")[0];
        if (head) {
            head.insertBefore(viewport, head.firstChild);
        } else {
            root.appendChild(viewport);
        }
    }

    // ---- layout mode ---------------------------------------------------
    function forcedMode() {
        try {
            return localStorage.getItem("ccLayoutMode") || "auto";
        } catch (err) {
            return "auto";
        }
    }

    function isCoarsePointer() {
        try {
            return window.matchMedia("(pointer: coarse)").matches;
        } catch (err) {
            return "ontouchstart" in window;
        }
    }

    /**
     * Decides whether the touch layout should be used.
     *
     * @returns {boolean}
     */
    function useMobileLayout() {
        var mode = forcedMode();
        if (mode === "mobile") return true;
        if (mode === "desktop") return false;

        var width = window.innerWidth || root.clientWidth || 0;
        // A touch device gets the touch layout well into tablet sizes; a mouse
        // driven desktop browser only gets it in a genuinely narrow window.
        return isCoarsePointer() ? width < COARSE_MAX_WIDTH : width < FINE_MAX_WIDTH;
    }

    function applyLayout() {
        var mobile = useMobileLayout();
        root.classList.toggle("cc-mobile", mobile);
        window.__ccMobile = mobile;
        return mobile;
    }

    applyLayout();

    // Consumed by cc-mobile.js to detect a structural layout change.
    window.__ccIsMobile = useMobileLayout;
    window.__ccApplyLayout = applyLayout;

    // ---- defend the class ----------------------------------------------
    // CyberChef's OptionsWaiter assigns the theme with
    //     document.querySelector(":root").className = theme;
    // which *replaces* the whole class list and silently removes cc-mobile
    // moments after startup. That regression is invisible in a browser console
    // but leaves the app rendering the desktop four-pane layout on a phone,
    // so the class is re-asserted here instead of relying on it surviving.
    //
    // A MutationObserver is used rather than a one-shot call because the theme
    // can be applied again later (Options -> Theme, importing settings, a
    // system dark-mode change), and each application wipes the class again.
    if (window.MutationObserver) {
        var guarding = false;
        var observer = new MutationObserver(function () {
            if (guarding) return;
            if (root.classList.contains("cc-mobile") === useMobileLayout()) return;
            guarding = true;
            applyLayout();
            guarding = false;
        });
        observer.observe(root, {attributes: true, attributeFilter: ["class"]});
        window.__ccClassObserver = observer;
    }
})();
