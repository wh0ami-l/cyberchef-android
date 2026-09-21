package com.cyberchef.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Pushes files that originate outside the WebView (share/open intents, folder
 * trees) into CyberChef's input.
 *
 * <p>The picker-driven path ({@code <input type="file">}) does not use this
 * class: WebView hands those content URIs to the renderer directly, so files of
 * any size can be loaded without a copy. This bridge exists for the cases where
 * the browser has no such mechanism.
 */
final class FilePusher {

    private static final String TAG = "CyberChefPusher";

    /** Base64 payload per bridge call. Kept small so the JS string stays cheap. */
    private static final int CHUNK = 192 * 1024;

    /** Guard against pushing something that will exhaust the WebView heap. */
    private static final long MAX_PUSH_BYTES = 128L * 1024 * 1024;

    /** Guard against a huge folder selection. */
    private static final int MAX_TREE_FILES = 200;
    private static final int MAX_TREE_DEPTH = 8;

    private FilePusher() {
    }

    /**
     * Streams a single content/file URI into the web layer as a File object.
     *
     * @return the number of bytes pushed, or -1 on failure
     */
    static long pushUri(Context context, WebView webView, Uri uri, String displayName, String mimeType) {
        if (uri == null) return -1;

        String name = displayName != null ? displayName : queryDisplayName(context, uri);
        if (name == null || name.isEmpty()) name = "input.bin";
        if (mimeType == null || mimeType.isEmpty()) mimeType = queryMimeType(context, uri);
        if (mimeType == null) mimeType = "application/octet-stream";

        try (InputStream in = openStream(context, uri)) {
            if (in == null) {
                Log.e(TAG, "Could not open " + uri);
                return -1;
            }

            eval(webView, "window.CCOpenFileBegin && window.CCOpenFileBegin("
                    + quote(name) + "," + quote(mimeType) + ")");

            byte[] buffer = new byte[CHUNK];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                if (total + read > MAX_PUSH_BYTES) {
                    Log.w(TAG, "Refusing to push more than " + MAX_PUSH_BYTES + " bytes");
                    eval(webView, "window.CCOpenFileEnd && window.CCOpenFileEnd()");
                    return total;
                }
                byte[] slice = new byte[read];
                System.arraycopy(buffer, 0, slice, 0, read);
                eval(webView, "window.CCOpenFileChunk && window.CCOpenFileChunk("
                        + quote(Base64.encodeToString(slice, Base64.NO_WRAP)) + ")");
                total += read;
            }

            eval(webView, "window.CCOpenFileEnd && window.CCOpenFileEnd()");
            return total;
        } catch (Exception e) {
            Log.e(TAG, "Failed to push " + uri, e);
            eval(webView, "window.CCOpenFileEnd && window.CCOpenFileEnd()");
            return -1;
        }
    }

    /**
     * Pushes every file in a document tree, recursing into sub-directories.
     *
     * @return the number of files pushed
     */
    static int pushTree(Context context, WebView webView, Uri treeUri) {
        List<Uri> files = new ArrayList<>();
        collectTree(context, treeUri, files);

        eval(webView, "window.CCOpenBatchBegin && window.CCOpenBatchBegin(" + files.size() + ")");
        int pushed = 0;
        for (Uri file : files) {
            if (pushUri(context, webView, file, null, null) >= 0) pushed++;
        }
        eval(webView, "window.CCOpenBatchEnd && window.CCOpenBatchEnd()");
        return pushed;
    }

    /** Breadth-first walk of a document tree, bounded in depth and file count. */
    private static void collectTree(Context context, Uri treeUri, List<Uri> out) {
        String rootId;
        try {
            rootId = DocumentsContract.getTreeDocumentId(treeUri);
        } catch (Exception e) {
            Log.e(TAG, "Not a tree URI: " + treeUri, e);
            return;
        }

        Deque<String> pending = new ArrayDeque<>();
        Deque<Integer> depths = new ArrayDeque<>();
        pending.add(rootId);
        depths.add(0);

        ContentResolver resolver = context.getContentResolver();
        String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
        };

        while (!pending.isEmpty() && out.size() < MAX_TREE_FILES) {
            String docId = pending.poll();
            Integer depthBox = depths.poll();
            int depth = depthBox == null ? 0 : depthBox;
            if (depth > MAX_TREE_DEPTH) continue;

            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
            try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
                if (cursor == null) continue;
                while (cursor.moveToNext() && out.size() < MAX_TREE_FILES) {
                    String childId = cursor.getString(0);
                    String mime = cursor.getString(2);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        pending.add(childId);
                        depths.add(depth + 1);
                    } else {
                        out.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, childId));
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to list children of " + docId, e);
            }
        }
    }

    private static InputStream openStream(Context context, Uri uri) throws Exception {
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            return new FileInputStream(new File(uri.getPath()));
        }
        return context.getContentResolver().openInputStream(uri);
    }

    private static String queryDisplayName(Context context, Uri uri) {
        return queryString(context, uri, DocumentsContract.Document.COLUMN_DISPLAY_NAME);
    }

    private static String queryMimeType(Context context, Uri uri) {
        return context.getContentResolver().getType(uri);
    }

    private static String queryString(Context context, Uri uri, String column) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{column}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception e) {
            Log.w(TAG, "Could not query " + column + " for " + uri, e);
        }
        return null;
    }

    /** Runs JavaScript on the UI thread. */
    private static void eval(WebView webView, String script) {
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (Exception e) {
                Log.e(TAG, "evaluateJavascript failed", e);
            }
        });
    }

    /** Quotes a Java string as a JavaScript single-quoted literal. */
    private static String quote(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 16);
        sb.append('\'');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\'':
                case '\\':
                    sb.append('\\').append(c);
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\u2028':
                case '\u2029':
                    sb.append("\\u2028");
                    break;
                default:
                    sb.append(c);
            }
        }
        sb.append('\'');
        return sb.toString();
    }
}
