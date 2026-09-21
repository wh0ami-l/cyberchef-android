package com.cyberchef.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

/**
 * The CyberChef Android shell.
 *
 * <p>CyberChef is a self-contained client-side web app, so the native layer only
 * has to provide the things a browser would otherwise give it: a real origin for
 * Web Workers (via WebViewAssetLoader), file open/save, clipboard access, native
 * dialogs for {@code window.prompt} and friends, and Back button handling.
 *
 * <p>Assets are served over {@code https://appassets.androidplatform.net/assets/www/}
 * rather than {@code file://}. A file origin is opaque, which breaks Web Workers
 * and localStorage — both of which CyberChef depends on.
 */
public class MainActivity extends Activity {

    private static final String TAG = "CyberChef";

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_PREFIX = "/assets/";
    private static final String START_URL =
            "https://" + ASSET_HOST + ASSET_PREFIX + "www/index.html";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_FOLDER_CHOOSER = 1002;
    private static final int REQ_STORAGE_PERMISSION = 1003;

    /**
     * Chromium's "open a folder" chooser mode.
     *
     * <p>The Android SDK only exposes MODE_OPEN, MODE_OPEN_MULTIPLE and
     * MODE_SAVE, so the value has to be written out here. The mobile layer
     * normally intercepts folder requests before they reach WebView (see
     * pickFolder), so this is a fallback.
     */
    private static final int MODE_OPEN_FOLDER = 3;

    private WebView webView;
    private FrameLayout root;
    private SaveController saveController;
    private ValueCallback<Uri[]> filePathCallback;

    /** Kept so it can be destroyed; popups are handed to the system browser. */
    private WebView popupWebView;

    /** A file handed to us by a share/open intent, waiting for the web layer. */
    private Uri pendingExternalUri;
    private String pendingExternalName;
    private String pendingExternalMime;
    private boolean webLayerReady;

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        saveController = new SaveController(this);

        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);

        // The web layer owns the entire screen; the root view paints the system
        // bar areas in the CyberChef brand colour.
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.cc_brand));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.WHITE);
        root.addView(webView);
        setContentView(root);

        applyWindowInsets();
        configureWebView();

        // Restore state (scroll position, form state) on an in-place recreate.
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        captureIncomingIntent(getIntent());
    }

    /**
     * Pads the WebView so that no content is ever drawn underneath the status
     * bar, the navigation bar or the keyboard. Android 15 enforces edge-to-edge
     * for apps targeting SDK 35, so this has to be handled explicitly.
     */
    private void applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());

            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        // Honour the viewport meta tag injected into index.html; without
        // useWideViewPort the page would be laid out at ~980px and scaled down.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        // Local assets only, but file inputs may hand back file:// or
        // content:// URIs that the renderer has to read.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        // CyberChef has a handful of operations that intentionally reach the
        // network, including plain-HTTP endpoints.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setDefaultTextEncodingName("UTF-8");

        CookieManager.getInstance().setAcceptCookie(true);

        // Debug builds expose the WebView to chrome://inspect (and to
        // `adb forward ... webview_devtools_remote_*`), which is the only way to
        // inspect the page on a real device. Release builds must not: the
        // debugging socket would let anything on the phone drive the app.
        boolean debuggable =
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                .addPathHandler(ASSET_PREFIX, new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.addJavascriptInterface(new Bridge(), "CCAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    Log.e(TAG, "Main frame failed to load: " + error.getDescription());
                    Toast.makeText(MainActivity.this,
                            "CyberChef failed to load: " + error.getDescription(),
                            Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, "console: " + message.message()
                        + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            /**
             * CyberChef uses window.prompt to ask for filenames when saving
             * output and recipes. WebView has no default prompt dialog, so
             * without this the save flow would silently cancel.
             */
            @Override
            public boolean onJsPrompt(WebView view, String url, String message,
                                      String defaultValue, JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue == null ? "" : defaultValue);
                input.setSingleLine(true);
                input.setSelectAllOnFocus(true);

                int pad = Math.round(20 * getResources().getDisplayMetrics().density);
                FrameLayout holder = new FrameLayout(MainActivity.this);
                holder.setPadding(pad, pad / 2, pad, 0);
                holder.addView(input);

                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.dialog_prompt_title)
                        .setMessage(message)
                        .setView(holder)
                        .setPositiveButton(R.string.dialog_ok,
                                (dialog, which) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(R.string.dialog_cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                return startFileChooser(callback, params);
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                return openPopupInBrowser(resultMsg);
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureIncomingIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (popupWebView != null) {
            popupWebView.destroy();
            popupWebView = null;
        }
        if (saveController != null) saveController.abort();
        if (webView != null) {
            webView.removeJavascriptInterface("CCAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------

    /**
     * Keeps in-app asset navigation inside the WebView and sends everything else
     * to the system browser, so external links can never replace the app UI.
     *
     * @return true when the WebView should not load the URL itself
     */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) return false;

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost();

        if (ASSET_HOST.equals(host)) return false;
        if ("blob".equals(scheme) || "data".equals(scheme)
                || "about".equals(scheme) || "javascript".equals(scheme)) {
            return false;
        }

        openExternally(uri);
        return true;
    }

    /** Hands a URL to another app, ignoring anything that cannot be handled. */
    private void openExternally(Uri uri) {
        if (uri == null) return;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)
                && !"mailto".equals(scheme) && !"tel".equals(scheme)) {
            Log.w(TAG, "Ignoring unsupported scheme: " + uri);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open " + uri, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * window.open() and target=_blank produce a popup. Loading it in a hidden
     * WebView would leave a stray window, so the first URL is sent to the
     * browser instead.
     */
    private boolean openPopupInBrowser(Message resultMsg) {
        if (popupWebView != null) {
            popupWebView.destroy();
        }
        popupWebView = new WebView(this);
        popupWebView.getSettings().setJavaScriptEnabled(true);
        popupWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                openExternally(request.getUrl());
                return true;
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                openExternally(Uri.parse(url));
                return true;
            }
        });

        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(popupWebView);
        resultMsg.sendToTarget();
        return true;
    }

    // ------------------------------------------------------------------
    // Back button
    // ------------------------------------------------------------------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }

        // Give the web layer the first chance to handle Back: close a modal,
        // leave a tab, clear a search.
        webView.evaluateJavascript(
                "(window.CCAndroidBack && window.CCAndroidBack()) === true",
                handled -> {
                    if (!"true".equals(handled)) {
                        confirmExit();
                    }
                });
    }

    private void confirmExit() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.exit_title)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> finish())
                .setNegativeButton(R.string.dialog_cancel, null)
                .show();
    }

    // ------------------------------------------------------------------
    // File chooser
    // ------------------------------------------------------------------

    private boolean startFileChooser(ValueCallback<Uri[]> callback,
                                     WebChromeClient.FileChooserParams params) {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
        }
        filePathCallback = callback;

        int mode = params.getMode();

        if (mode == MODE_OPEN_FOLDER) {
            // WebView cannot consume a document tree as a file input value, so
            // the folder is enumerated natively and pushed into the app instead.
            filePathCallback = null;
            callback.onReceiveValue(null);
            openFolderPicker();
            return true;
        }

        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        try {
            startActivityForResult(
                    Intent.createChooser(intent, getString(R.string.chooser_title)),
                    REQ_FILE_CHOOSER);
        } catch (ActivityNotFoundException e) {
            filePathCallback = null;
            callback.onReceiveValue(null);
            Toast.makeText(this, "No file manager available", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    /**
     * Opens the system folder picker and loads every file it contains.
     *
     * <p>Called directly from the mobile layer, which intercepts CyberChef's
     * "Open folder as input" button. Returning a document tree through
     * onShowFileChooser does not work, because WebView cannot turn a tree URI
     * into the File objects a file input expects.
     */
    void openFolderPicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(intent, REQ_FOLDER_CHOOSER);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No file manager available", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] results = null;
            if (resultCode == RESULT_OK) {
                results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }

        if (requestCode == REQ_FOLDER_CHOOSER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                final Uri treeUri = data.getData();
                new Thread(() -> {
                    final int count = FilePusher.pushTree(MainActivity.this, webView, treeUri);
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            count == 1 ? "Loaded 1 file" : "Loaded " + count + " files",
                            Toast.LENGTH_SHORT).show());
                }, "cc-folder-push").start();
            }
            return;
        }

        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------
    // Incoming share / open-with intents
    // ------------------------------------------------------------------

    private void captureIncomingIntent(Intent intent) {
        if (intent == null) return;

        Uri uri = null;
        String mime = intent.getType();

        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (mime == null) mime = "application/octet-stream";
        } else if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        }

        if (uri == null) return;

        pendingExternalUri = uri;
        pendingExternalMime = mime;
        pendingExternalName = null;
        deliverPendingExternal();
    }

    private void deliverPendingExternal() {
        if (!webLayerReady || pendingExternalUri == null || webView == null) return;

        final Uri uri = pendingExternalUri;
        final String mime = pendingExternalMime;
        pendingExternalUri = null;
        pendingExternalMime = null;

        new Thread(() -> FilePusher.pushUri(MainActivity.this, webView, uri, null, mime),
                "cc-intent-push").start();
    }

    // ------------------------------------------------------------------
    // JavaScript bridge
    // ------------------------------------------------------------------

    /**
     * Exposed to the web layer as {@code window.CCAndroid}. Every method here
     * runs on the WebView's JavaScript bridge thread, never the UI thread.
     */
    public class Bridge {

        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                webLayerReady = true;
                deliverPendingExternal();
            });
        }

        @JavascriptInterface
        public void log(String message) {
            Log.i(TAG, "[web] " + message);
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }

        // --- saving output ------------------------------------------------

        @JavascriptInterface
        public void saveStart(final String name, final String mime) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && !hasLegacyStoragePermission()) {
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this,
                            R.string.toast_need_storage, Toast.LENGTH_LONG).show();
                    requestPermissions(
                            new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},
                            REQ_STORAGE_PERMISSION);
                });
                return;
            }

            if (!saveController.begin(name, mime)) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        R.string.toast_save_failed_simple, Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void saveChunk(String base64) {
            saveController.write(base64);
        }

        @JavascriptInterface
        public void saveFinish() {
            final String name = saveController.finish();
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    name == null
                            ? getString(R.string.toast_save_failed_simple)
                            : getString(R.string.toast_saved, name),
                    Toast.LENGTH_LONG).show());
        }

        @JavascriptInterface
        public void saveAbort(String message) {
            saveController.abort();
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    getString(R.string.toast_save_failed_simple), Toast.LENGTH_LONG).show());
        }

        // --- clipboard ----------------------------------------------------

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager clipboard =
                        (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) return;
                clipboard.setPrimaryClip(ClipData.newPlainText("CyberChef", text));
                if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
                    Toast.makeText(MainActivity.this, R.string.toast_copied, Toast.LENGTH_SHORT).show();
                }
            });
        }

        // --- misc ---------------------------------------------------------

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openExternally(Uri.parse(url)));
        }

        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(MainActivity.this::openFolderPicker);
        }
    }

    private boolean hasLegacyStoragePermission() {
        return checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }
}
