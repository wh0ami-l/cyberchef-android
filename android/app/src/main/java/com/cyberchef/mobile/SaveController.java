package com.cyberchef.mobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Streams a file from the web layer into the device's Downloads collection.
 *
 * <p>CyberChef saves output by handing a Blob to FileSaver, which produces a
 * {@code blob:} URL that a WebView cannot download. The mobile layer therefore
 * reads the Blob in chunks and pushes base64 through the JavaScript bridge; this
 * class reassembles it here.
 *
 * <p>On API 29+ the file is published with MediaStore, which needs no
 * permission. On older releases the public Downloads directory is used, which
 * requires WRITE_EXTERNAL_STORAGE.
 */
class SaveController {

    private static final String TAG = "CyberChefSave";

    /** Must match BLOB_CHUNK in mobile/mobile.js. */
    private static final String SUBDIR = "CyberChef";

    private final Context context;

    private OutputStream stream;
    private Uri mediaUri;
    private File legacyFile;
    private String name;
    private long written;
    private boolean active;

    SaveController(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized boolean isActive() {
        return active;
    }

    /**
     * Opens the destination. Returns false if the file could not be created,
     * in which case the caller should report the failure and not send chunks.
     *
     * @param fileName the name to publish the file under
     * @param mimeType the MIME type reported by the browser
     * @return true when the destination is ready
     */
    synchronized boolean begin(String fileName, String mimeType) {
        abortInternal();

        if (fileName == null || fileName.trim().isEmpty()) fileName = "download.dat";
        if (mimeType == null || mimeType.isEmpty()) mimeType = "application/octet-stream";
        // Guard against path traversal from a crafted filename.
        fileName = new File(fileName).getName();

        this.name = fileName;
        this.written = 0;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + File.separator + SUBDIR);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                ContentResolver resolver = context.getContentResolver();
                mediaUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (mediaUri == null) {
                    Log.e(TAG, "MediaStore refused to create " + fileName);
                    return false;
                }
                stream = resolver.openOutputStream(mediaUri);
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        SUBDIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    Log.e(TAG, "Could not create " + dir);
                    return false;
                }
                legacyFile = new File(dir, fileName);
                stream = new FileOutputStream(legacyFile);
            }

            if (stream == null) {
                Log.e(TAG, "No output stream for " + fileName);
                abortInternal();
                return false;
            }

            active = true;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to open destination", e);
            abortInternal();
            return false;
        }
    }

    /**
     * Appends one base64 encoded chunk.
     *
     * @param base64 chunk produced by {@code btoa} in the web layer
     */
    synchronized void write(String base64) {
        if (!active || base64 == null || base64.isEmpty()) return;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            stream.write(bytes);
            written += bytes.length;
        } catch (Exception e) {
            Log.e(TAG, "Write failed", e);
            active = false;
        }
    }

    /**
     * Publishes the file.
     *
     * @return the published file name, or null when nothing was written
     */
    synchronized String finish() {
        if (!active) {
            abortInternal();
            return null;
        }

        try {
            stream.flush();
            stream.close();
        } catch (Exception e) {
            Log.e(TAG, "Failed to close output", e);
        }
        stream = null;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && mediaUri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(mediaUri, values, null, null);
            } else if (legacyFile != null) {
                MediaScannerConnection.scanFile(
                        context, new String[]{legacyFile.getAbsolutePath()}, null, null);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to publish output", e);
        }

        active = false;
        String result = name;
        mediaUri = null;
        legacyFile = null;
        name = null;
        return result;
    }

    /** Cancels the transfer and removes the partial file. */
    synchronized void abort() {
        abortInternal();
    }

    private void abortInternal() {
        if (stream != null) {
            try {
                stream.close();
            } catch (Exception ignored) {
                // best effort
            }
            stream = null;
        }
        if (mediaUri != null) {
            try {
                context.getContentResolver().delete(mediaUri, null, null);
            } catch (Exception ignored) {
                // best effort
            }
            mediaUri = null;
        }
        if (legacyFile != null) {
            //noinspection ResultOfMethodCallIgnored
            legacyFile.delete();
            legacyFile = null;
        }
        active = false;
        name = null;
        written = 0;
    }
}
