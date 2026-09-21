/**
 * CyberChef Mobile — touch UI and native bridge.
 *
 * Loaded from the production build's index.html, after the CyberChef bundle.
 * Together with cc-mobile.css and cc-preinit.js this turns the desktop web app
 * into a phone-shaped application without touching a single upstream source
 * file, so the bundle can be rebuilt from the CyberChef repository at any time.
 *
 * Layout
 * ------
 *   +--------------------------------+
 *   | app bar   (CyberChef #banner)  |
 *   +--------------------------------+
 *   |                                |
 *   |   active pane, full bleed      |
 *   |   (operations/recipe/input/    |
 *   |    output)                     |
 *   |                                |
 *   +--------------------------------+
 *   | action bar (CyberChef #controls)|
 *   +--------------------------------+
 *   | tab bar (injected)             |
 *   +--------------------------------+
 *
 * @copyright Crown Copyright 2016-2026
 * @license Apache-2.0
 */

(function () {
    "use strict";

    /** The native bridge, injected by MainActivity via addJavascriptInterface. */
    var NATIVE = window.CCAndroid || null;

    /** Panes exposed as tabs, in tab-bar order. */
    var PANES = [
        {id: "operations", label: "Operations", icon: "apps"},
        {id: "recipe", label: "Recipe", icon: "format_list_numbered"},
        {id: "input", label: "Input", icon: "input"},
        {id: "output", label: "Output", icon: "output"}
    ];

    /** Tabs the user has visited, used by the hardware back button. */
    var tabHistory = [];
    var activeTab = "input";
    var tabbar = null;
    /** One-time wiring (native bridges, global listeners) has been done. */
    var booted = false;
    /** The touch layout is currently built into the DOM. */
    var mobileActive = false;
    /** Original DOM parent of #controls, so desktop mode can be restored. */
    var controlsHome = null;

    /** Pane ids addressable from the workspace UI. */
    var PANE_IDS = ["operations", "recipe", "input", "output"];

    /** Divider limits, as a percentage given to the first slot. */
    var MIN_SPLIT = 15;
    var MAX_SPLIT = 85;
    /** Divider positions offered by the grip button and the ratio presets. */
    var SPLIT_PRESETS = [25, 50, 75];

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function $(sel) {
        return document.querySelector(sel);
    }

    function isMobileLayout() {
        return document.documentElement.classList.contains("cc-mobile");
    }

    function readPref(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (err) {
            return fallback;
        }
    }

    function writePref(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (err) { /* private mode / storage full */ }
    }

    // ------------------------------------------------------------------
    // Workspace state
    //
    // The workspace can be shown either as one full-bleed pane at a time
    // ("tabs") or as two panes with a divider the user drags ("split"). The
    // split ratio is what makes the algorithm-selection area resizable, so it
    // is persisted and exposed in the Workspace sheet as well as the grip.
    // ------------------------------------------------------------------

    /** The element that hosts a pane. Input and Output share #IO. */
    function hostFor(paneId) {
        return paneId === "input" || paneId === "output" ? "IO" : paneId;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    var workspace = {
        mode: "tabs",
        first: "operations",
        second: "recipe",
        size: 50,
        axis: "auto",
        font: 13
    };

    /**
     * Loads the persisted workspace preferences, discarding anything that is
     * not a legal combination (a corrupt value must not be able to wedge the
     * layout into a state with no visible panes).
     */
    function loadWorkspacePrefs() {
        var mode = readPref("ccWorkspaceMode", "tabs");
        workspace.mode = mode === "split" ? "split" : "tabs";

        var first = readPref("ccSplitFirst", "operations");
        var second = readPref("ccSplitSecond", "recipe");
        if (PANE_IDS.indexOf(first) < 0) first = "operations";
        if (PANE_IDS.indexOf(second) < 0) second = "recipe";
        // Input and Output share a host element, so they cannot both be shown.
        if (hostFor(first) === hostFor(second)) second = hostFor(first) === "recipe" ? "operations" : "recipe";
        workspace.first = first;
        workspace.second = second;

        var size = parseFloat(readPref("ccSplitSize", "50"));
        workspace.size = isFinite(size) ? clamp(size, MIN_SPLIT, MAX_SPLIT) : 50;

        var axis = readPref("ccSplitAxis", "auto");
        workspace.axis = axis === "v" || axis === "h" ? axis : "auto";

        var font = parseInt(readPref("ccEditorFont", "13"), 10);
        workspace.font = isFinite(font) ? clamp(font, 10, 20) : 13;
    }

    function saveWorkspacePrefs() {
        writePref("ccWorkspaceMode", workspace.mode);
        writePref("ccSplitFirst", workspace.first);
        writePref("ccSplitSecond", workspace.second);
        writePref("ccSplitSize", workspace.size);
        writePref("ccSplitAxis", workspace.axis);
        writePref("ccEditorFont", workspace.font);
    }

    /** Resolves "auto" to a concrete axis for the current viewport. */
    function resolveAxis() {
        if (workspace.axis === "v" || workspace.axis === "h") return workspace.axis;
        return window.innerWidth > window.innerHeight ? "h" : "v";
    }

    function alertUser(message, timeout) {
        if (window.app && typeof window.app.alert === "function") {
            window.app.alert(message, timeout || 2000);
        } else if (NATIVE && NATIVE.toast) {
            NATIVE.toast(message);
        }
    }

    function defer(fn) {
        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(fn);
        } else {
            setTimeout(fn, 16);
        }
    }

    // ------------------------------------------------------------------
    // Pane / tab management
    // ------------------------------------------------------------------

    /**
     * Shows one workspace pane and hides the others (single-pane "tabs" mode).
     *
     * @param {string} id - operations | recipe | input | output
     * @param {boolean} [record=true] - push onto the back-navigation stack
     */
    function showPane(id, record) {
        if (!isMobileLayout()) return;
        if (record !== false && id !== activeTab) tabHistory.push(activeTab);
        activeTab = id;
        renderWorkspace();
    }

    /**
     * Applies the current workspace mode to the DOM: which panes are visible,
     * where the divider sits and whether the tab bar is shown. Everything is
     * derived from `workspace`, so this is safe to call at any time and on
     * every environment change.
     */
    function renderWorkspace() {
        if (!isMobileLayout()) return;

        var root = document.documentElement;
        var split = workspace.mode === "split";
        var axis = resolveAxis();

        root.classList.toggle("cc-split", split);
        root.classList.toggle("cc-split-v", split && axis === "v");
        root.classList.toggle("cc-split-h", split && axis === "h");
        root.style.setProperty("--cc-editor-font", workspace.font + "px");

        // Clear every layout class, then re-derive visibility from scratch.
        // The CSS decides what is visible purely from these classes. Input and
        // Output are cleared too: they are children of #IO and would otherwise
        // stay visible from a previous tabs-mode selection.
        ["operations", "recipe", "IO", "input", "output"].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove("cc-slot-first", "cc-slot-second", "cc-pane-active");
        });

        if (split) {
            // Pin the two panes into the two slots and, for Input/Output, make
            // sure the right editor inside #IO is the visible one.
            assignSlot("first", workspace.first);
            assignSlot("second", workspace.second);
            showInnerPane(workspace.first);
            showInnerPane(workspace.second);
            setSplitSize(workspace.size);
            buildSplitter();
            buildSlotPickers();
        } else {
            var host = document.getElementById(hostFor(activeTab));
            if (host) host.classList.add("cc-pane-active");
            showInnerPane(activeTab);
            removeSplitter();
            removeSlotPickers();
        }

        syncTabBar();
        remeasure();
    }

    /** Puts a pane's host element into one of the two split slots. */
    function assignSlot(slot, paneId) {
        var host = document.getElementById(hostFor(paneId));
        if (host) host.classList.add(slot === "first" ? "cc-slot-first" : "cc-slot-second");
    }

    /** Makes the editor inside #IO visible when the pane is input/output. */
    function showInnerPane(paneId) {
        if (paneId !== "input" && paneId !== "output") return;
        var el = document.getElementById(paneId);
        if (el) el.classList.add("cc-pane-active");
    }

    /** Mirrors the active pane (or the split) onto the bottom tab bar. */
    function syncTabBar() {
        if (!tabbar) return;
        var split = workspace.mode === "split";
        var tabs = tabbar.querySelectorAll(".cc-tab");
        for (var i = 0; i < tabs.length; i++) {
            var id = tabs[i].getAttribute("data-tab");
            var on = split
                ? (id === workspace.first || id === workspace.second)
                : (id === activeTab);
            tabs[i].classList.toggle("cc-active", on);
        }
    }

    /**
     * CodeMirror measures its viewport when it becomes visible again, but it
     * needs a nudge when a pane is re-shown after display:none or after the
     * divider has moved.
     */
    function remeasure() {
        var m = window.app && window.app.manager;
        defer(function () {
            try {
                if (m && m.input && m.input.inputEditorView) {
                    m.input.inputEditorView.requestMeasure();
                    if (m.input.calcMaxTabs) m.input.calcMaxTabs();
                }
            } catch (err) { /* not ready yet */ }
            try {
                if (m && m.output && m.output.outputEditorView) {
                    m.output.outputEditorView.requestMeasure();
                }
            } catch (err) { /* not ready yet */ }
            try {
                if (window.app && window.app.adjustComponentSizes) {
                    window.app.adjustComponentSizes();
                }
            } catch (err) { /* not ready yet */ }
        });
    }

    /**
     * Builds the bottom tab bar.
     */
    function buildTabBar() {
        if (tabbar || !isMobileLayout()) return;

        tabbar = document.createElement("nav");
        tabbar.id = "cc-tabbar";
        tabbar.setAttribute("role", "tablist");

        PANES.forEach(function (pane) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cc-tab";
            btn.setAttribute("data-tab", pane.id);
            btn.setAttribute("role", "tab");
            btn.setAttribute("aria-label", pane.label);

            var icon = document.createElement("i");
            icon.className = "material-icons";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = pane.icon;

            var label = document.createElement("span");
            label.textContent = pane.label;

            var badge = document.createElement("span");
            badge.className = "cc-badge";
            badge.setAttribute("data-badge", pane.id);

            btn.appendChild(icon);
            btn.appendChild(label);
            btn.appendChild(badge);

            btn.addEventListener("click", function () {
                showPane(pane.id);
            });

            tabbar.appendChild(btn);
        });

        document.body.appendChild(tabbar);
        showPane(activeTab, false);
        updateBadges();
    }

    function destroyTabBar() {
        if (tabbar && tabbar.parentNode) tabbar.parentNode.removeChild(tabbar);
        tabbar = null;
    }

    // ------------------------------------------------------------------
    // Split workspace: two panes and a divider the user can drag
    //
    // The divider is the "resize the algorithm-selection area" control: it
    // writes one CSS custom property, so a drag costs a single style
    // recalculation of the workspace subtree and no JavaScript layout work.
    // ------------------------------------------------------------------

    var splitter = null;
    var paneMenu = null;
    var paneMenuDismiss = null;

    function setSplitSize(percent, persist) {
        workspace.size = clamp(percent, MIN_SPLIT, MAX_SPLIT);
        var wrapper = $("#workspace-wrapper");
        if (wrapper) {
            wrapper.style.setProperty("--cc-split-size", workspace.size.toFixed(2) + "%");
        }
        if (splitter) {
            splitter.setAttribute("aria-valuenow", String(Math.round(workspace.size)));
        }
        if (sheetRefs.sizeLabel) {
            sheetRefs.sizeLabel.textContent = Math.round(workspace.size) + "%";
        }
        if (sheetRefs.sizeInput && !persist) {
            sheetRefs.sizeInput.value = String(Math.round(workspace.size));
        }
        if (persist) saveWorkspacePrefs();
    }

    function buildSplitter() {
        var wrapper = $("#workspace-wrapper");
        if (!wrapper) return;

        if (!splitter) {
            splitter = document.createElement("div");
            splitter.id = "cc-splitter";
            splitter.setAttribute("role", "separator");
            splitter.setAttribute("tabindex", "0");
            splitter.setAttribute("aria-label", "Resize workspace panes");
            splitter.setAttribute("aria-valuemin", String(MIN_SPLIT));
            splitter.setAttribute("aria-valuemax", String(MAX_SPLIT));

            var grip = document.createElement("button");
            grip.type = "button";
            grip.className = "cc-splitter-grip";
            grip.setAttribute("aria-label", "Cycle divider position");
            grip.setAttribute("title", "Drag to resize, tap to cycle 25/50/75%");
            grip.innerHTML = "<i class=\"material-icons\" aria-hidden=\"true\">drag_handle</i>";
            splitter.appendChild(grip);

            installSplitterDrag(splitter, grip);
        }

        if (splitter.parentNode !== wrapper) wrapper.appendChild(splitter);
        splitter.setAttribute("aria-orientation", resolveAxis() === "v" ? "horizontal" : "vertical");
        setSplitSize(workspace.size);
    }

    function removeSplitter() {
        if (splitter && splitter.parentNode) splitter.parentNode.removeChild(splitter);
    }

    /**
     * Wires pointer dragging, the tap-to-cycle grip and the keyboard arrows.
     *
     * @param {HTMLElement} el - the separator element
     * @param {HTMLElement} grip - the visible handle inside it
     */
    function installSplitterDrag(el, grip) {
        var dragging = false;
        var moved = false;
        var startPoint = 0;
        var pending = 0;
        var rect = null;
        var wrapper = null;
        var frame = 0;

        function axisIsVertical() {
            return resolveAxis() === "v";
        }

        function pointOf(e) {
            return axisIsVertical() ? e.clientY : e.clientX;
        }

        function paint() {
            frame = 0;
            if (!wrapper || !rect) return;
            var total = axisIsVertical() ? rect.height : rect.width;
            if (total <= 0) return;
            var origin = axisIsVertical() ? rect.top : rect.left;
            setSplitSize(((pending - origin) / total) * 100, false);
        }

        function onMove(e) {
            if (!dragging) return;
            if (e.cancelable) e.preventDefault();
            var point = pointOf(e);
            if (Math.abs(point - startPoint) > 4) moved = true;
            pending = point;
            if (!frame) frame = window.requestAnimationFrame(paint);
        }

        function onUp(e) {
            if (!dragging) return;
            dragging = false;
            document.documentElement.classList.remove("cc-dragging");
            if (frame) {
                window.cancelAnimationFrame(frame);
                frame = 0;
                paint();
            }
            wrapper = null;
            rect = null;
            if (moved) {
                setSplitSize(workspace.size, true);
            } else {
                cycleSplitSize();
            }
            if (e && e.pointerId !== undefined && el.releasePointerCapture) {
                try {
                    el.releasePointerCapture(e.pointerId);
                } catch (err) { /* already released */ }
            }
        }

        el.addEventListener("pointerdown", function (e) {
            if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
            var wrapperEl = $("#workspace-wrapper");
            if (!wrapperEl) return;

            dragging = true;
            moved = false;
            startPoint = pointOf(e);
            pending = startPoint;
            wrapper = wrapperEl;
            rect = wrapperEl.getBoundingClientRect();
            document.documentElement.classList.add("cc-dragging");

            if (el.setPointerCapture) {
                try {
                    el.setPointerCapture(e.pointerId);
                } catch (err) { /* not supported */ }
            }
            if (e.cancelable) e.preventDefault();
        });

        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);

        // Touch fallback for a WebView without Pointer Events: the same
        // handlers, driven by the first touch.
        if (!window.PointerEvent) {
            el.addEventListener("touchstart", function (e) {
                if (!e.touches.length) return;
                el.dispatchEvent(new Event("pointerdown"));
                dragging = true;
                moved = false;
                startPoint = pointOf(e.touches[0]);
                pending = startPoint;
                wrapper = $("#workspace-wrapper");
                rect = wrapper ? wrapper.getBoundingClientRect() : null;
                document.documentElement.classList.add("cc-dragging");
            }, {passive: false});

            el.addEventListener("touchmove", function (e) {
                if (!dragging || !e.touches.length) return;
                e.preventDefault();
                var point = pointOf(e.touches[0]);
                if (Math.abs(point - startPoint) > 4) moved = true;
                pending = point;
                if (!frame) frame = window.requestAnimationFrame(paint);
            }, {passive: false});

            el.addEventListener("touchend", onUp);
        }

        grip.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            // A click also follows every successful drag; `moved` is reset by
            // the pointerup handler, which runs first, so only a genuine tap
            // reaches the cycling behaviour.
            if (moved) return;
            cycleSplitSize();
        });

        el.addEventListener("keydown", function (e) {
            var step = e.shiftKey ? 10 : 2;
            var handled = true;
            if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                setSplitSize(workspace.size - step, true);
            } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                setSplitSize(workspace.size + step, true);
            } else if (e.key === "Home") {
                setSplitSize(MIN_SPLIT, true);
            } else if (e.key === "End") {
                setSplitSize(MAX_SPLIT, true);
            } else {
                handled = false;
            }
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
                renderWorkspace();
                refreshWorkspaceSheet();
            }
        });
    }

    /** Steps the divider through 25% / 50% / 75%. */
    function cycleSplitSize() {
        var next = SPLIT_PRESETS[0];
        for (var i = 0; i < SPLIT_PRESETS.length; i++) {
            if (Math.abs(workspace.size - SPLIT_PRESETS[i]) < 4) {
                next = SPLIT_PRESETS[(i + 1) % SPLIT_PRESETS.length];
                break;
            }
            if (workspace.size > SPLIT_PRESETS[i]) next = SPLIT_PRESETS[i];
        }
        setSplitSize(next, true);
        renderWorkspace();
        refreshWorkspaceSheet();
    }

    // ------------------------------------------------------------------
    // Slot pickers — choose what each split slot shows
    // ------------------------------------------------------------------

    function paneLabel(id) {
        for (var i = 0; i < PANES.length; i++) {
            if (PANES[i].id === id) return PANES[i].label;
        }
        return id;
    }

    function slotElement(slot) {
        return document.getElementById(hostFor(slot === "first" ? workspace.first : workspace.second));
    }

    function buildSlotPickers() {
        if (!isMobileLayout() || workspace.mode !== "split") return;

        // Rebuild from scratch. A slot can be re-pointed at another pane at any
        // time, and reusing an existing chip would leave it behind on the pane
        // the slot just left — hidden there, and impossible to tap.
        removeSlotPickers();

        [["first", workspace.first], ["second", workspace.second]].forEach(function (pair) {
            // The title bar is looked up on the pane itself rather than on its
            // host: Input and Output share #IO, and #IO has no title of its own.
            var pane = document.getElementById(pair[1]);
            var title = pane && pane.querySelector(":scope > .title");
            if (!title) return;

            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "cc-slot-picker";
            chip.setAttribute("data-slot", pair[0]);
            chip.setAttribute("aria-label",
                "Change the pane in this slot (currently " + paneLabel(pair[1]) + ")");
            chip.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                openPaneMenu(chip, chip.getAttribute("data-slot"));
            });

            var icon = document.createElement("i");
            icon.className = "material-icons";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = "unfold_more";
            var label = document.createElement("span");
            label.textContent = paneLabel(pair[1]);

            chip.appendChild(icon);
            chip.appendChild(label);
            title.appendChild(chip);
        });
    }

    function removeSlotPickers() {
        var chips = document.querySelectorAll(".cc-slot-picker");
        for (var i = 0; i < chips.length; i++) {
            if (chips[i].parentNode) chips[i].parentNode.removeChild(chips[i]);
        }
    }

    function closePaneMenu() {
        if (paneMenuDismiss) {
            document.removeEventListener("pointerdown", paneMenuDismiss, true);
            paneMenuDismiss = null;
        }
        if (paneMenu && paneMenu.parentNode) paneMenu.parentNode.removeChild(paneMenu);
        paneMenu = null;
    }

    /**
     * Offers the four panes for one slot. Panes that would need a host element
     * already used by the other slot are disabled rather than hidden, so the
     * menu keeps a stable shape.
     *
     * @param {HTMLElement} anchor
     * @param {string} slot - "first" | "second"
     */
    function openPaneMenu(anchor, slot) {
        closePaneMenu();

        var other = slot === "first" ? workspace.second : workspace.first;
        var current = slot === "first" ? workspace.first : workspace.second;

        var menu = document.createElement("div");
        menu.className = "cc-pane-menu";
        menu.setAttribute("role", "menu");

        PANE_IDS.forEach(function (id) {
            var item = document.createElement("button");
            item.type = "button";
            item.className = "cc-pane-menu-item";
            item.setAttribute("role", "menuitem");
            item.setAttribute("data-pane", id);
            item.textContent = paneLabel(id);

            var taken = hostFor(id) === hostFor(other);
            if (id === current) item.classList.add("cc-on");
            if (taken) {
                item.disabled = true;
                item.setAttribute("title", "Already shown in the other pane");
            }

            item.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (taken) return;
                if (slot === "first") workspace.first = id;
                else workspace.second = id;
                saveWorkspacePrefs();
                closePaneMenu();
                renderWorkspace();
                refreshWorkspaceSheet();
            });

            menu.appendChild(item);
        });

        document.body.appendChild(menu);
        paneMenu = menu;

        var rect = anchor.getBoundingClientRect();
        var left = clamp(rect.left, 8, Math.max(8, window.innerWidth - menu.offsetWidth - 8));
        var top = rect.bottom + 6;
        if (top + menu.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - menu.offsetHeight - 6);
        }
        menu.style.left = Math.round(left) + "px";
        menu.style.top = Math.round(top) + "px";

        paneMenuDismiss = function (e) {
            if (menu.contains(e.target) || anchor.contains(e.target)) return;
            closePaneMenu();
        };
        document.addEventListener("pointerdown", paneMenuDismiss, true);
    }

    // ------------------------------------------------------------------
    // Workspace sheet — explicit controls for everything above
    // ------------------------------------------------------------------

    var sheetEl = null;
    var sheetBackdrop = null;
    var sheetRefs = {};

    function isWorkspaceSheetOpen() {
        return !!sheetEl;
    }

    function closeWorkspaceSheet() {
        closePaneMenu();
        if (sheetBackdrop && sheetBackdrop.parentNode) sheetBackdrop.parentNode.removeChild(sheetBackdrop);
        if (sheetEl && sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
        sheetEl = null;
        sheetBackdrop = null;
        sheetRefs = {};
        document.documentElement.classList.remove("cc-sheet-open");
        if (mobileActive) remeasure();
    }

    /** Persists the current workspace state and repaints everything. */
    function commitWorkspace() {
        saveWorkspacePrefs();
        renderWorkspace();
        refreshWorkspaceSheet();
    }

    /** Returns every workspace preference to its default. */
    function resetWorkspace() {
        workspace.mode = "tabs";
        workspace.first = "operations";
        workspace.second = "recipe";
        workspace.size = 50;
        workspace.axis = "auto";
        workspace.font = 13;
        document.documentElement.style.setProperty("--cc-editor-font", "13px");
        commitWorkspace();
    }

    function sheetRow(labelText, control) {
        var row = document.createElement("div");
        row.className = "cc-sheet-row";
        var label = document.createElement("div");
        label.className = "cc-sheet-label";
        label.textContent = labelText;
        row.appendChild(label);
        row.appendChild(control);
        return row;
    }

    function segmented(options, current, onPick) {
        var group = document.createElement("div");
        group.className = "cc-seg";
        group.setAttribute("role", "group");
        options.forEach(function (option) {
            var button = document.createElement("button");
            button.type = "button";
            button.textContent = option.label;
            button.setAttribute("data-value", option.value);
            button.classList.toggle("cc-on", option.value === current);
            button.addEventListener("click", function (e) {
                e.preventDefault();
                onPick(option.value);
            });
            group.appendChild(button);
        });
        return group;
    }

    function buildWorkspaceSheet() {
        var sheet = document.createElement("div");
        sheet.id = "cc-workspace-sheet";
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "true");
        sheet.setAttribute("aria-label", "Workspace settings");

        var header = document.createElement("div");
        header.className = "cc-sheet-header";
        var heading = document.createElement("h2");
        heading.textContent = "Workspace";
        var close = document.createElement("button");
        close.type = "button";
        close.className = "cc-sheet-close";
        close.setAttribute("aria-label", "Close");
        close.innerHTML = "<i class=\"material-icons\" aria-hidden=\"true\">close</i>";
        close.addEventListener("click", closeWorkspaceSheet);
        header.appendChild(heading);
        header.appendChild(close);
        sheet.appendChild(header);

        // --- layout mode ---
        var modeSeg = segmented([
            {value: "tabs", label: "One pane"},
            {value: "split", label: "Split"}
        ], workspace.mode, function (value) {
            workspace.mode = value;
            commitWorkspace();
        });
        sheetRefs.modeSeg = modeSeg;
        sheet.appendChild(sheetRow("Layout", modeSeg));

        var hint = document.createElement("p");
        hint.className = "cc-sheet-hint";
        hint.textContent = "Split shows two panes at once and lets you drag the divider "
            + "to size them. One pane gives the whole workspace to a single pane.";
        sheet.appendChild(hint);

        // --- which pane sits in each slot ---
        sheetRefs.firstSelect = paneSelect("first");
        sheetRefs.secondSelect = paneSelect("second");
        sheetRefs.slotRows = [
            sheetRow("Upper pane", sheetRefs.firstSelect),
            sheetRow("Lower pane", sheetRefs.secondSelect)
        ];
        sheetRefs.slotRows.forEach(function (row) { sheet.appendChild(row); });

        // --- divider position ---
        var sizeWrap = document.createElement("div");
        sizeWrap.className = "cc-sheet-slider";
        var sizeInput = document.createElement("input");
        sizeInput.type = "range";
        sizeInput.min = String(MIN_SPLIT);
        sizeInput.max = String(MAX_SPLIT);
        sizeInput.step = "1";
        sizeInput.value = String(Math.round(workspace.size));
        sizeInput.setAttribute("aria-label", "Divider position");
        var sizeLabel = document.createElement("span");
        sizeLabel.className = "cc-sheet-value";
        sizeLabel.textContent = Math.round(workspace.size) + "%";
        sizeInput.addEventListener("input", function () {
            setSplitSize(parseFloat(sizeInput.value), false);
            if (workspace.mode !== "split") {
                workspace.mode = "split";
                renderWorkspace();
                refreshWorkspaceSheet();
            }
        });
        sizeInput.addEventListener("change", function () {
            setSplitSize(parseFloat(sizeInput.value), true);
            commitWorkspace();
        });
        sizeWrap.appendChild(sizeInput);
        sizeWrap.appendChild(sizeLabel);
        sheetRefs.sizeInput = sizeInput;
        sheetRefs.sizeLabel = sizeLabel;
        sheetRefs.sizeRow = sheetRow("Divider position", sizeWrap);
        sheet.appendChild(sheetRefs.sizeRow);

        var presets = document.createElement("div");
        presets.className = "cc-preset-row";
        [[25, "1:3"], [50, "1:1"], [75, "3:1"]].forEach(function (pair) {
            var button = document.createElement("button");
            button.type = "button";
            button.className = "cc-preset";
            button.textContent = pair[1];
            button.setAttribute("data-size", String(pair[0]));
            button.setAttribute("aria-label", "Divider at " + pair[0] + " percent");
            button.addEventListener("click", function () {
                workspace.mode = "split";
                setSplitSize(pair[0], false);
                commitWorkspace();
            });
            presets.appendChild(button);
        });
        sheetRefs.presets = presets;
        sheetRefs.presetRow = sheetRow("Presets", presets);
        sheet.appendChild(sheetRefs.presetRow);

        // --- divider direction ---
        var axisSeg = segmented([
            {value: "auto", label: "Auto"},
            {value: "v", label: "Stacked"},
            {value: "h", label: "Side by side"}
        ], workspace.axis, function (value) {
            workspace.axis = value;
            commitWorkspace();
        });
        sheetRefs.axisSeg = axisSeg;
        sheetRefs.axisRow = sheetRow("Direction", axisSeg);
        sheet.appendChild(sheetRefs.axisRow);

        // --- editor text size ---
        var fontWrap = document.createElement("div");
        fontWrap.className = "cc-sheet-slider";
        var fontInput = document.createElement("input");
        fontInput.type = "range";
        fontInput.min = "10";
        fontInput.max = "20";
        fontInput.step = "1";
        fontInput.value = String(workspace.font);
        fontInput.setAttribute("aria-label", "Editor text size");
        var fontLabel = document.createElement("span");
        fontLabel.className = "cc-sheet-value";
        fontLabel.textContent = workspace.font + "px";
        fontInput.addEventListener("input", function () {
            workspace.font = parseInt(fontInput.value, 10);
            fontLabel.textContent = workspace.font + "px";
            document.documentElement.style.setProperty("--cc-editor-font", workspace.font + "px");
            remeasure();
        });
        fontInput.addEventListener("change", function () {
            workspace.font = parseInt(fontInput.value, 10);
            commitWorkspace();
        });
        fontWrap.appendChild(fontInput);
        fontWrap.appendChild(fontLabel);
        sheetRefs.fontInput = fontInput;
        sheetRefs.fontLabel = fontLabel;
        sheet.appendChild(sheetRow("Editor text size", fontWrap));

        // --- reset ---
        var reset = document.createElement("button");
        reset.type = "button";
        reset.className = "cc-sheet-btn";
        reset.id = "cc-workspace-reset";
        reset.textContent = "Reset workspace";
        reset.addEventListener("click", resetWorkspace);
        sheet.appendChild(reset);

        sheetRefs.reset = reset;
        return sheet;
    }

    function paneSelect(slot) {
        var select = document.createElement("select");
        select.className = "cc-select";
        select.setAttribute("data-slot", slot);
        PANE_IDS.forEach(function (id) {
            var option = document.createElement("option");
            option.value = id;
            option.textContent = paneLabel(id);
            select.appendChild(option);
        });
        select.addEventListener("change", function () {
            if (slot === "first") workspace.first = select.value;
            else workspace.second = select.value;
            // A legal combination is enforced here rather than relying on the
            // <select> to prevent it.
            if (hostFor(workspace.first) === hostFor(workspace.second)) {
                if (slot === "first") workspace.second = hostFor(workspace.first) === "recipe" ? "operations" : "recipe";
                else workspace.first = hostFor(workspace.second) === "recipe" ? "operations" : "recipe";
            }
            workspace.mode = "split";
            commitWorkspace();
        });
        return select;
    }

    /** Keeps the sheet's control states in step with `workspace`. */
    function refreshWorkspaceSheet() {
        if (!sheetEl) return;
        var split = workspace.mode === "split";

        markSegmented(sheetRefs.modeSeg, workspace.mode);
        markSegmented(sheetRefs.axisSeg, workspace.axis);

        if (sheetRefs.firstSelect) sheetRefs.firstSelect.value = workspace.first;
        if (sheetRefs.secondSelect) sheetRefs.secondSelect.value = workspace.second;

        if (sheetRefs.sizeInput) sheetRefs.sizeInput.value = String(Math.round(workspace.size));
        if (sheetRefs.sizeLabel) sheetRefs.sizeLabel.textContent = Math.round(workspace.size) + "%";
        if (sheetRefs.fontInput) sheetRefs.fontInput.value = String(workspace.font);
        if (sheetRefs.fontLabel) sheetRefs.fontLabel.textContent = workspace.font + "px";

        sheetRefs.slotRows.forEach(function (row) { row.classList.toggle("cc-muted", !split); });
        sheetRefs.sizeRow.classList.toggle("cc-muted", !split);
        sheetRefs.presetRow.classList.toggle("cc-muted", !split);
        sheetRefs.axisRow.classList.toggle("cc-muted", !split);

        if (sheetRefs.presets) {
            var buttons = sheetRefs.presets.querySelectorAll(".cc-preset");
            for (var i = 0; i < buttons.length; i++) {
                var size = parseFloat(buttons[i].getAttribute("data-size"));
                buttons[i].classList.toggle("cc-on", split && Math.abs(size - workspace.size) < 4);
            }
        }
    }

    function markSegmented(group, value) {
        if (!group) return;
        var buttons = group.querySelectorAll("button");
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle("cc-on", buttons[i].getAttribute("data-value") === value);
        }
    }

    function openWorkspaceSheet() {
        if (sheetEl) return;

        sheetBackdrop = document.createElement("div");
        sheetBackdrop.id = "cc-sheet-backdrop";
        sheetBackdrop.addEventListener("click", closeWorkspaceSheet);

        sheetEl = buildWorkspaceSheet();
        document.body.appendChild(sheetBackdrop);
        document.body.appendChild(sheetEl);
        document.documentElement.classList.add("cc-sheet-open");
        refreshWorkspaceSheet();
    }

    function toggleWorkspaceSheet() {
        if (sheetEl) closeWorkspaceSheet();
        else openWorkspaceSheet();
    }

    // ------------------------------------------------------------------
    // App bar
    // ------------------------------------------------------------------

    /**
     * Replaces the "Download CyberChef" column with the app title and adds the
     * workspace and layout-mode controls next to the Options / About links.
     */
    function buildAppBar() {
        var banner = $("#banner");
        if (!banner || banner.querySelector(".cc-app-title")) return;

        // Resolve the Options/About column *before* the title is appended:
        // adding a child to #banner would otherwise make it the last element
        // and `.col:last-child` would stop matching anything.
        var lastCol = banner.querySelector(".col:last-child") || banner.lastElementChild;

        var title = document.createElement("div");
        title.className = "cc-app-title";
        title.appendChild(document.createTextNode("CyberChef"));

        if (window.__ccVersion) {
            var version = document.createElement("span");
            version.className = "cc-version";
            version.textContent = "v" + window.__ccVersion;
            title.appendChild(version);
        }
        banner.appendChild(title);

        if (lastCol) {
            var workspaceBtn = document.createElement("a");
            workspaceBtn.href = "#";
            workspaceBtn.id = "cc-workspace-btn";
            workspaceBtn.setAttribute("role", "button");
            workspaceBtn.setAttribute("aria-label", "Workspace layout and sizes");
            workspaceBtn.setAttribute("title", "Workspace layout and sizes");
            workspaceBtn.innerHTML = "<i class=\"material-icons\">tune</i>";
            workspaceBtn.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleWorkspaceSheet();
            });
            lastCol.insertBefore(workspaceBtn, lastCol.firstChild);

            var layoutBtn = document.createElement("a");
            layoutBtn.href = "#";
            layoutBtn.id = "cc-layout-toggle";
            layoutBtn.setAttribute("role", "button");
            layoutBtn.setAttribute("aria-label", "Switch to desktop layout");
            layoutBtn.setAttribute("title", "Switch to desktop layout");
            layoutBtn.innerHTML = "<i class=\"material-icons\">desktop_windows</i>";
            layoutBtn.addEventListener("click", function (e) {
                e.preventDefault();
                setLayoutMode("desktop");
            });
            lastCol.insertBefore(layoutBtn, lastCol.firstChild);
        }
    }

    /** Removes the app-bar additions so the desktop layout is untouched. */
    function removeAppBar() {
        var extras = document.querySelectorAll(".cc-app-title, #cc-workspace-btn, #cc-layout-toggle");
        for (var i = 0; i < extras.length; i++) {
            if (extras[i].parentNode) extras[i].parentNode.removeChild(extras[i]);
        }
    }

    /** Floating "go back to the touch layout" button, shown in desktop mode. */
    var layoutEscape = null;

    /**
     * Keeps an escape hatch out of the desktop layout.
     *
     * In the touch layout the mode switch lives in the app bar — but that bar is
     * part of the touch chrome, so teardown removes it. Without a replacement,
     * switching to the desktop layout is a one-way trip: the control needed to
     * come back is deleted along with everything else. The desktop layout has no
     * room for an app bar, so this is a small floating button instead.
     */
    function syncLayoutEscape() {
        if (isMobileLayout()) {
            if (layoutEscape && layoutEscape.parentNode) {
                layoutEscape.parentNode.removeChild(layoutEscape);
            }
            layoutEscape = null;
            return;
        }

        if (layoutEscape && layoutEscape.parentNode) return;

        layoutEscape = document.createElement("button");
        layoutEscape.type = "button";
        layoutEscape.id = "cc-layout-escape";
        layoutEscape.setAttribute("aria-label", "Switch back to the touch layout");
        layoutEscape.setAttribute("title", "Switch back to the touch layout");
        layoutEscape.innerHTML =
            "<i class=\"material-icons\" aria-hidden=\"true\">smartphone</i><span>Touch layout</span>";
        layoutEscape.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            setLayoutMode("mobile");
        });
        document.body.appendChild(layoutEscape);
    }

    /**
     * Persists a layout preference and reloads. A reload is used because the
     * desktop and mobile layouts differ structurally (the action bar is
     * relocated), and this keeps the switch deterministic. Assets are served
     * from the APK, so the reload is cheap.
     *
     * @param {string} mode - "mobile" | "desktop" | "auto"
     */
    function setLayoutMode(mode) {
        try {
            localStorage.setItem("ccLayoutMode", mode);
        } catch (err) { /* private mode */ }
        window.location.reload();
    }

    // ------------------------------------------------------------------
    // CyberChef integration
    // ------------------------------------------------------------------

    /**
     * Relocates CyberChef's #controls (Step / Bake / Auto-bake) out of the
     * Recipe pane so it can act as a persistent action bar. Moving a node keeps
     * its event listeners, and CyberChef holds direct references to its
     * children, so this is safe.
     */
    function relocateControls() {
        var controls = $("#controls");
        if (!controls) return;
        if (!controlsHome) controlsHome = controls.parentNode;
        var wrapper = $("#content-wrapper");
        if (wrapper && controls.parentNode !== wrapper) {
            wrapper.appendChild(controls);
        }
    }

    function restoreControls() {
        var controls = $("#controls");
        if (controls && controlsHome && controls.parentNode !== controlsHome) {
            controlsHome.appendChild(controls);
        }
    }

    /**
     * CyberChef sizes panes from measurements that assume the desktop
     * multi-pane layout. Replace those calculations with mobile equivalents.
     */
    function patchLayoutCalculations() {
        var app = window.app;
        if (!app || !app.manager) return;
        var m = app.manager;

        if (m.controls && m.controls.calcControlsHeight) {
            m.controls.calcControlsHeight = function () {
                var recList = document.getElementById("rec-list");
                if (recList) recList.style.bottom = "0px";
            };
        }

        // adjustWidth() scales #controls-content with a transform to squeeze it
        // into the Recipe pane. On mobile it spans the whole screen, so the
        // scale must be cleared (the Bake-icon logic is still useful).
        if (m.recipe && m.recipe.adjustWidth) {
            var originalAdjustWidth = m.recipe.adjustWidth.bind(m.recipe);
            m.recipe.adjustWidth = function () {
                originalAdjustWidth();
                var content = document.getElementById("controls-content");
                if (content) content.style.transform = "";
            };
        }
    }

    /** Movement, in CSS pixels, that still counts as a tap rather than a drag. */
    var TAP_SLOP = 12;
    /** Longest press, in milliseconds, that still counts as a tap. */
    var TAP_TIMEOUT = 800;

    /**
     * On touch screens, a single tap adds an operation to the recipe. Upstream
     * binds dblclick, which is both awkward to perform and easy to trigger
     * accidentally, so it is suppressed here.
     *
     * A `click` listener is not enough on a real device. The operation list is
     * made sortable by SortableJS, whose touch handling cancels the synthetic
     * click a tap would otherwise produce: the sequence for a finger tap is
     * pointerdown, touchstart, pointerup, touchend and then nothing. Presses are
     * therefore tracked directly, which also covers a mouse. A press that
     * travels further than TAP_SLOP is ignored, so dragging an operation around
     * still works.
     */
    function installTapToAdd() {
        var press = null;

        document.addEventListener("dblclick", function (e) {
            if (!isMobileLayout()) return;
            var li = e.target && e.target.closest && e.target.closest(".op-list li.operation, #rec-list li.operation");
            if (li) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);

        document.addEventListener("pointerdown", function (e) {
            if (!isMobileLayout() || e.isPrimary === false) return;
            if (e.button !== undefined && e.button !== 0) return;
            press = {x: e.clientX, y: e.clientY, at: Date.now(), target: e.target};
        }, true);

        document.addEventListener("pointercancel", function () {
            press = null;
        }, true);

        document.addEventListener("pointerup", function (e) {
            var start = press;
            press = null;
            if (!start || !isMobileLayout()) return;
            if (Math.abs(e.clientX - start.x) > TAP_SLOP) return;
            if (Math.abs(e.clientY - start.y) > TAP_SLOP) return;
            if (Date.now() - start.at > TAP_TIMEOUT) return;
            handleTap(start.target);
        }, true);
    }

    /**
     * Runs the action bound to a completed tap.
     *
     * @param {Element} target - the element the press started on
     */
    function handleTap(target) {
        if (!target || !target.closest) return;

        // The per-step controls live inside the sortable recipe list, so they
        // suffer from the same cancelled click as the operation list.
        var actionBtn = target.closest(".cc-op-actions button");
        if (actionBtn) {
            if (actionBtn.disabled || !actionBtn.__ccActivate) return;
            actionBtn.__ccActivate();
            return;
        }

        var li = target.closest("#categories .op-list li.operation, #search-results li.operation");
        if (!li) return;

        // Let the category collapse links and favourites editor work normally.
        if (target.closest(".category-title, #edit-favourites, .remove-icon")) return;

        // The favourites editor decorates entries with a delete icon whose
        // label would otherwise leak into the operation name.
        var clone = li.cloneNode(true);
        var removeIcon = clone.querySelector(".remove-icon");
        if (removeIcon) removeIcon.parentNode.removeChild(removeIcon);
        var name = clone.textContent.trim();
        if (!name || !window.app || !window.app.manager) return;

        window.app.manager.recipe.addOperation(name);
        alertUser("Added: " + name, 1400);
    }

    /**
     * Recipe steps need explicit controls on touch: double-tap-to-delete is
     * dangerous and drag-to-reorder is unreliable with a finger.
     */
    var OP_ACTIONS_OBSERVER = null;

    function installRecipeOpControls() {
        var recList = $("#rec-list");
        if (!recList) return;

        var decorate = function (li) {
            if (!li.classList || !li.classList.contains("operation")) return;
            if (li.querySelector(":scope > .cc-op-actions")) return;

            var actions = document.createElement("div");
            actions.className = "cc-op-actions";

            actions.appendChild(actionButton("arrow_upward", "Move up", "cc-op-up", li, function () {
                moveOperation(li, -1);
            }));
            actions.appendChild(actionButton("arrow_downward", "Move down", "cc-op-down", li, function () {
                moveOperation(li, 1);
            }));
            actions.appendChild(actionButton("delete", "Remove step", "cc-op-delete", li, function () {
                removeOperation(li);
            }));

            li.appendChild(actions);
            refreshOpActionState(li);
        };

        var decorateAll = function () {
            var items = recList.querySelectorAll(":scope > li.operation");
            for (var i = 0; i < items.length; i++) decorate(items[i]);
        };

        if (OP_ACTIONS_OBSERVER) OP_ACTIONS_OBSERVER.disconnect();
        OP_ACTIONS_OBSERVER = new MutationObserver(function (records) {
            var structural = false;
            records.forEach(function (r) {
                if (r.addedNodes.length || r.removedNodes.length) structural = true;
            });
            if (!structural) return;
            decorateAll();
        });
        OP_ACTIONS_OBSERVER.observe(recList, {childList: true, subtree: false});

        decorateAll();
    }

    /**
     * Builds one of the per-step buttons.
     *
     * The action is stored on the element and run by the tap detector rather
     * than by a `click` listener. On a touch device the browser's own click
     * arrives *before* pointerup, so a click listener plus a pointerup
     * synthesiser would run every action twice — and a move-up followed by a
     * move-up again leaves the recipe exactly as it was.
     *
     * @param {string} icon - Material icon name
     * @param {string} label - accessible label
     * @param {string} cls - "cc-op-up" | "cc-op-down" | "cc-op-delete"
     * @param {HTMLElement} li - the recipe step this button belongs to
     * @param {Function} handler - the action to run
     * @returns {HTMLElement}
     */
    function actionButton(icon, label, cls, li, handler) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = cls;
        btn.setAttribute("aria-label", label);
        btn.setAttribute("title", label);
        btn.innerHTML = "<i class=\"material-icons\">" + icon + "</i>";
        btn.__ccActivate = handler;
        btn.addEventListener("click", function (e) {
            // Keyboard activation (Enter or Space on a focused button) is the
            // only click that reaches the action: it carries no detail, while a
            // click produced by a pointer gesture carries detail 1 and has
            // already been handled by the tap detector.
            if (e.detail !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            handler();
        });
        return btn;
    }

    function refreshOpActionState(li) {
        var up = li.querySelector(":scope > .cc-op-actions > .cc-op-up"),
            down = li.querySelector(":scope > .cc-op-actions > .cc-op-down");
        if (up) up.disabled = !li.previousElementSibling;
        if (down) down.disabled = !li.nextElementSibling;
    }

    function refreshAllOpActionState() {
        var recList = $("#rec-list");
        if (!recList) return;
        var items = recList.querySelectorAll(":scope > li.operation");
        for (var i = 0; i < items.length; i++) refreshOpActionState(items[i]);
    }

    function moveOperation(li, delta) {
        if (delta < 0 && li.previousElementSibling) {
            li.parentNode.insertBefore(li, li.previousElementSibling);
        } else if (delta > 0 && li.nextElementSibling) {
            li.parentNode.insertBefore(li.nextElementSibling, li);
        } else {
            return;
        }
        notifyRecipeChanged();
    }

    function removeOperation(li) {
        li.parentNode.removeChild(li);
        // CyberChef's own handler for this event dispatches statechange for us.
        try {
            var evt = window.app.manager.operationremove;
            var recList = $("#rec-list");
            if (evt && recList) recList.dispatchEvent(evt);
        } catch (err) {
            notifyRecipeChanged();
        }
        refreshAllOpActionState();
    }

    /** Tells CyberChef that the recipe changed so it re-bakes if needed. */
    function notifyRecipeChanged() {
        refreshAllOpActionState();
        defer(function () {
            try {
                document.dispatchEvent(window.app.manager.statechange);
            } catch (err) { /* not ready */ }
        });
    }

    // ------------------------------------------------------------------
    // Tab badges
    // ------------------------------------------------------------------

    function setBadge(name, value) {
        if (!tabbar) return;
        var badge = tabbar.querySelector('[data-badge="' + name + '"]');
        if (badge) badge.textContent = value === 0 || value === "" ? "" : String(value);
    }

    function updateBadges() {
        if (!tabbar) return;

        var opCount = document.querySelectorAll("#rec-list li.operation").length;
        setBadge("recipe", opCount);

        var inputTabs = document.querySelectorAll("#input-tabs li").length;
        setBadge("input", inputTabs > 1 ? inputTabs : 0);
    }

    function installBadgeUpdates() {
        var recList = $("#rec-list");
        if (recList) {
            new MutationObserver(function () {
                updateBadges();
                defer(refreshAllOpActionState);
            }).observe(recList, {childList: true});
        }

        var inputTabs = $("#input-tabs");
        if (inputTabs) {
            new MutationObserver(updateBadges).observe(inputTabs, {childList: true});
        }
    }

    // ------------------------------------------------------------------
    // Native bridge: file saving
    // ------------------------------------------------------------------

    /**
     * FileSaver (used by CyberChef to save outputs) builds an <a download> with
     * a blob: URL and dispatches a synthetic click. WebView cannot download
     * blob: URLs itself, so the blob is streamed to the native side in chunks.
     *
     * The anchor is never attached to the document, so its events do not
     * propagate to document listeners — the click has to be intercepted on the
     * element's own dispatch path instead.
     */
    var BLOB_CHUNK = 256 * 1024;
    var MAX_TRACKED_BLOBS = 24;
    var blobsByUrl = new Map();

    function takeBlobFor(anchor) {
        if (!anchor || !anchor.hasAttribute || !anchor.hasAttribute("download")) return null;
        var blob = blobsByUrl.get(anchor.getAttribute("href"));
        if (!blob) return null;
        blobsByUrl.delete(anchor.getAttribute("href"));
        return blob;
    }

    function startBlobSave(blob, name) {
        streamBlobToNative(blob, name).catch(function (err) {
            if (NATIVE.saveAbort) {
                NATIVE.saveAbort(String(err && err.message ? err.message : err));
            }
        });
    }

    function installBlobSaveBridge() {
        if (!NATIVE || !NATIVE.saveStart) return;

        var originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
            var url = originalCreateObjectURL.call(URL, obj);
            if (obj instanceof Blob) {
                if (blobsByUrl.size >= MAX_TRACKED_BLOBS) {
                    blobsByUrl.delete(blobsByUrl.keys().next().value);
                }
                blobsByUrl.set(url, obj);
            }
            return url;
        };

        // FileSaver calls dispatchEvent(new MouseEvent("click")) on a detached
        // anchor.
        var originalDispatchEvent = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event) {
            if (event && event.type === "click" && this instanceof HTMLAnchorElement) {
                var blob = takeBlobFor(this);
                if (blob) {
                    startBlobSave(blob, this.getAttribute("download") || "download");
                    return true;
                }
            }
            return originalDispatchEvent.call(this, event);
        };

        // Some callers use a.click() instead, which does not go through
        // dispatchEvent.
        var originalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            var blob = takeBlobFor(this);
            if (blob) {
                startBlobSave(blob, this.getAttribute("download") || "download");
                return;
            }
            return originalClick.call(this);
        };

        // Anchors that do live in the document are handled here.
        document.addEventListener("click", function (e) {
            var anchor = e.target && e.target.closest ? e.target.closest("a[download]") : null;
            if (!anchor) return;
            var blob = takeBlobFor(anchor);
            if (!blob) return;
            e.preventDefault();
            e.stopPropagation();
            startBlobSave(blob, anchor.getAttribute("download") || "download");
        }, true);
    }

    function bytesToBase64(bytes) {
        var binary = "";
        var STRIDE = 0x8000;
        for (var i = 0; i < bytes.length; i += STRIDE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + STRIDE, bytes.length)));
        }
        return btoa(binary);
    }

    async function streamBlobToNative(blob, name) {
        NATIVE.saveStart(name, blob.type || "application/octet-stream");
        for (var offset = 0; offset < blob.size; offset += BLOB_CHUNK) {
            var slice = blob.slice(offset, offset + BLOB_CHUNK);
            var buffer = await slice.arrayBuffer();
            NATIVE.saveChunk(bytesToBase64(new Uint8Array(buffer)));
        }
        NATIVE.saveFinish();
    }

    // ------------------------------------------------------------------
    // Native bridge: clipboard and external links
    // ------------------------------------------------------------------

    /**
     * Bridges navigator.clipboard to the native clipboard.
     *
     * It is tempting to skip this whenever the platform API exists — the app is
     * served from a secure origin, so navigator.clipboard is present and looks
     * usable. It is not: inside a WebView the call is rejected with
     * "NotAllowedError: Document is not focused". The page rarely holds focus,
     * and CyberChef copy is an async handler, so the transient user activation
     * has already been consumed. CyberChef only ever calls writeText, and
     * reports "Sorry, the output could not be copied." when it rejects.
     *
     * The platform implementation is therefore tried first — a WebView that
     * gets this right still uses the real API — and the native bridge takes
     * over whenever it fails.
     *
     * @see MainActivity.Bridge#copyText
     */
    function installClipboardBridge() {
        if (!NATIVE || !NATIVE.copyText) return;

        function writeNatively(text) {
            NATIVE.copyText(String(text));
            return Promise.resolve();
        }

        // Captured before the property is redefined, or the bridge would
        // recurse into itself.
        var platform = null;
        try {
            platform = navigator.clipboard;
        } catch (err) { /* not exposed at all */ }

        var bridged = {
            writeText: function (text) {
                if (!platform || typeof platform.writeText !== "function") {
                    return writeNatively(text);
                }
                var attempt;
                try {
                    attempt = platform.writeText.call(platform, text);
                } catch (err) {
                    // Some builds throw synchronously rather than rejecting.
                    return writeNatively(text);
                }
                if (!attempt || typeof attempt.then !== "function") {
                    return writeNatively(text);
                }
                return attempt.then(function () {
                    return undefined;
                }, function () {
                    return writeNatively(text);
                });
            },
            readText: function () {
                if (platform && typeof platform.readText === "function") {
                    return platform.readText.call(platform);
                }
                return Promise.reject(new Error("Reading the clipboard is not supported"));
            }
        };

        try {
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                get: function () {
                    return bridged;
                }
            });
        } catch (err) { /* leave the platform implementation alone */ }
    }

    /**
     * window.open / target=_blank would otherwise navigate the app away from
     * CyberChef. Send those to the system browser instead.
     */
    function installLinkGuard() {
        document.addEventListener("click", function (e) {
            var anchor = e.target && e.target.closest ? e.target.closest("a[href]") : null;
            if (!anchor) return;
            var href = anchor.getAttribute("href") || "";
            if (!/^https?:\/\//i.test(href)) return;
            if (anchor.hasAttribute("download")) return;

            e.preventDefault();
            e.stopPropagation();
            if (NATIVE && NATIVE.openExternal) {
                NATIVE.openExternal(href);
            } else {
                window.open(href, "_blank");
            }
        }, true);
    }

    /**
     * "Open folder as input" needs a document-tree picker, which WebView cannot
     * wire up to a file input. Intercept the button and let the native side
     * enumerate the folder and push the files back in.
     */
    function installFolderPicker() {
        if (!NATIVE || !NATIVE.pickFolder) return;

        document.addEventListener("click", function (e) {
            if (!isMobileLayout()) return;
            var btn = e.target && e.target.closest ? e.target.closest("#btn-open-folder") : null;
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();
            NATIVE.pickFolder();
        }, true);
    }

    // ------------------------------------------------------------------
    // Hardware back button
    // ------------------------------------------------------------------
    /**
     * Called by MainActivity when the user presses Back. Returning true means
     * the event was consumed.
     *
     * @returns {boolean}
     */
    window.CCAndroidBack = function () {
        // 0. Dismiss the workspace sheet or a pane menu first.
        if (isWorkspaceSheetOpen()) {
            closeWorkspaceSheet();
            return true;
        }
        if (paneMenu) {
            closePaneMenu();
            return true;
        }

        // 1. Close an open modal by clicking its own dismiss control, which is
        //    what Bootstrap's data-api listens for. Nothing here depends on
        //    jQuery being reachable from the global scope.
        var modal = document.querySelector(".modal.show, .modal.in");
        if (modal) {
            var dismiss = modal.querySelector('[data-dismiss="modal"]');
            if (dismiss) {
                dismiss.click();
            } else {
                // Escape is Bootstrap's other built-in close gesture.
                document.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true
                }));
                closeModalFallback(modal);
            }
            return true;
        }

        // 2. Tidy away an operation description popover.
        var popover = document.querySelector(".popover.show, .popover.in");
        if (popover && popover.parentNode) {
            popover.parentNode.removeChild(popover);
            return true;
        }

        // 3. Clear an active operation search before changing tab.
        var search = $("#search");
        if (isMobileLayout() && search && search.value) {
            search.value = "";
            search.dispatchEvent(new Event("search"));
            search.blur();
            return true;
        }

        // 4. Walk back through visited tabs.
        if (isMobileLayout() && tabHistory.length) {
            var previous = tabHistory.pop();
            showPane(previous, false);
            return true;
        }

        return false;
    };

    /** Last-resort modal teardown if Bootstrap does not respond. */
    function closeModalFallback(modal) {
        modal.classList.remove("show", "in");
        modal.style.display = "none";
        document.body.classList.remove("modal-open");
        var backdrops = document.querySelectorAll(".modal-backdrop");
        for (var i = 0; i < backdrops.length; i++) {
            if (backdrops[i].parentNode) backdrops[i].parentNode.removeChild(backdrops[i]);
        }
    }

    // ------------------------------------------------------------------
    // Native bridge: files opened from other apps
    // ------------------------------------------------------------------

    /** In-flight file pushed in by a share/open intent. */
    var incoming = null;
    /** Accumulator when several files arrive together (folder loading). */
    var incomingBatch = null;

    function deliverIncomingFiles(files) {
        if (!files.length || !window.app || !window.app.manager) return;
        window.app.manager.input.loadUIFiles(files);
        if (isMobileLayout()) showPane("input");
    }

    /** Starts a multi-file transfer, e.g. a whole folder. */
    window.CCOpenBatchBegin = function (total) {
        incomingBatch = [];
        incoming = null;
    };

    window.CCOpenFileBegin = function (name, mime) {
        incoming = {name: name, mime: mime, chunks: []};
    };

    window.CCOpenFileChunk = function (base64) {
        if (!incoming) return;
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        incoming.chunks.push(bytes);
    };

    window.CCOpenFileEnd = function () {
        if (!incoming) return;
        var file = new File(incoming.chunks, incoming.name,
            {type: incoming.mime || "application/octet-stream"});
        incoming = null;

        if (incomingBatch) {
            incomingBatch.push(file);
            return;
        }
        deliverIncomingFiles([file]);
    };

    /** Finishes a multi-file transfer and loads everything at once. */
    window.CCOpenBatchEnd = function () {
        var files = incomingBatch || [];
        incomingBatch = null;
        deliverIncomingFiles(files);
    };

    // ------------------------------------------------------------------
    // Boot
    //
    // The touch layout cannot be decided once and forgotten. CyberChef applies
    // the theme with `document.querySelector(":root").className = theme`,
    // which replaces the whole class list, and it does so in the same
    // synchronous block that dispatches `apploaded`. So at the moment the app
    // announces it is ready the `cc-mobile` class is briefly absent, and a
    // one-shot decision taken there would silently pick the desktop layout for
    // the rest of the session. Instead the layout is re-derived whenever the
    // class list changes, and the mobile UI can be built and torn down again.
    // ------------------------------------------------------------------

    /** One-time wiring that is needed whichever layout ends up active. */
    function installGlobalBridges() {
        installBlobSaveBridge();
        installClipboardBridge();
        installLinkGuard();
        installFolderPicker();
        installResetLayoutHook();
    }

    /** Hijacks CyberChef's "reset pane layout" button for the touch layout. */
    function installResetLayoutHook() {
        document.addEventListener("click", function (e) {
            if (!isMobileLayout()) return;
            var btn = e.target && e.target.closest ? e.target.closest("#reset-layout") : null;
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            resetWorkspace();
            alertUser("Workspace reset", 1500);
        }, true);
    }

    /** Builds the touch UI. Idempotent. */
    function buildMobileLayout() {
        if (mobileActive) return;
        if (!window.app || !window.app.manager) return;
        mobileActive = true;

        // Preferences are read here rather than at script load so that a
        // rebuild after a layout flip always reflects the persisted state.
        loadWorkspacePrefs();
        document.documentElement.style.setProperty("--cc-editor-font", workspace.font + "px");

        relocateControls();
        patchLayoutCalculations();
        buildAppBar();
        buildTabBar();
        installRecipeOpControls();
        renderWorkspace();
        defer(remeasure);
    }

    /** Removes every trace of the touch UI, leaving the desktop layout intact. */
    function teardownMobileLayout() {
        if (!mobileActive) return;
        mobileActive = false;

        closeWorkspaceSheet();
        closePaneMenu();
        removeSplitter();
        removeSlotPickers();
        destroyTabBar();
        removeAppBar();

        if (OP_ACTIONS_OBSERVER) {
            OP_ACTIONS_OBSERVER.disconnect();
            OP_ACTIONS_OBSERVER = null;
        }
        var actions = document.querySelectorAll(".cc-op-actions");
        for (var i = 0; i < actions.length; i++) {
            if (actions[i].parentNode) actions[i].parentNode.removeChild(actions[i]);
        }

        restoreControls();

        var root = document.documentElement;
        root.classList.remove("cc-split", "cc-split-v", "cc-split-h", "cc-dragging");
        ["operations", "recipe", "IO", "input", "output"].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove("cc-slot-first", "cc-slot-second", "cc-pane-active");
        });
        var wrapper = $("#workspace-wrapper");
        if (wrapper) wrapper.style.removeProperty("--cc-split-size");

        tabHistory.length = 0;
    }

    /** Brings the DOM in line with the layout mode currently in force. */
    function syncLayout() {
        if (isMobileLayout()) {
            if (isAppReady()) buildMobileLayout();
        } else {
            teardownMobileLayout();
        }
        syncLayoutEscape();
    }

    /** Re-derives the layout whenever <html>'s class list is rewritten. */
    function watchLayoutClass() {
        if (!window.MutationObserver) return;
        new MutationObserver(syncLayout).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"]
        });
    }

    function onReady() {
        if (!booted) {
            booted = true;
            installGlobalBridges();
            installTapToAdd();
            installBadgeUpdates();
            watchLayoutClass();

            if (NATIVE && NATIVE.ready) {
                try {
                    NATIVE.ready();
                } catch (err) { /* bridge is best-effort */ }
            }
        }

        syncLayout();

        // Nudge CodeMirror once the preloader has gone.
        defer(remeasure);
    }

    /**
     * True once CyberChef has built its UI, loaded a worker and set up every
     * waiter. Only then is it safe to move panes around.
     *
     * @returns {boolean}
     */
    function isAppReady() {
        var app = window.app;
        return !!(app && app.manager && app.workerLoaded && app.waitersLoaded && app.appLoaded);
    }

    function start() {
        // CyberChef dispatches `apploaded` from document exactly once, after the
        // preloader has been torn down.
        document.addEventListener("apploaded", onReady, {once: true});

        if (isAppReady()) {
            onReady();
            return;
        }

        // Safety net: the apploaded listener is attached while the document is
        // still parsing, so this normally never fires.
        var attempts = 0;
        var poll = setInterval(function () {
            attempts++;
            if (isAppReady()) {
                clearInterval(poll);
                onReady();
            } else if (attempts > 400) {
                clearInterval(poll);
            }
        }, 50);
    }

    // React to rotation. The layout verdict can change with the aspect ratio
    // (and with the split axis), so the class is re-derived and the workspace
    // repainted rather than reloading the whole app.
    var resizeTimer = null;
    window.addEventListener("resize", function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            var shouldBeMobile = window.__ccIsMobile ? window.__ccIsMobile() : isMobileLayout();
            if (shouldBeMobile !== isMobileLayout()) {
                if (window.__ccApplyLayout) window.__ccApplyLayout();
                return; // the class observer rebuilds or tears down for us
            }
            if (isMobileLayout() && mobileActive) renderWorkspace();
        }, 150);
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, false);
    } else {
        start();
    }
})();
