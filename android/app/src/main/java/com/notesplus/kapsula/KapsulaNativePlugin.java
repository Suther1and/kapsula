package com.notesplus.kapsula;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Rect;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Parcelable;
import android.os.PersistableBundle;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Toast;

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.util.Consumer;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.fragment.app.FragmentActivity;
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter;
import androidx.window.layout.DisplayFeature;
import androidx.window.layout.FoldingFeature;
import androidx.window.layout.WindowInfoTracker;
import androidx.window.layout.WindowLayoutInfo;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(
    name = "KapsulaNative",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class KapsulaNativePlugin extends Plugin {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEYSTORE_ALIAS = "kapsula_master_v1";
    private static final String KEYSTORE_AUTH_ALIAS = "kapsula_vault_auth_v1";
    private static final String PREFS_NAME = "kapsula_native_prefs";
    private static final String PREF_PENDING_CAMERA_PATH = "pending_camera_path";
    private static final String PREF_UI_THEME = "ui_theme";
    private static final String PREF_UI_BG_HEX = "ui_bg_hex";
    private static final int MAX_SHARED_FILE_BYTES = 12 * 1024 * 1024;
    private static final int STAGED_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024;
    private static final String STAGED_DIR_NAME = "kapsula-staged";
    private static final int IMAGE_OPTIMIZE_THRESHOLD_BYTES = 3 * 1024 * 1024;
    private static final int IMAGE_MAX_DIMENSION_PX = 2400;
    private static final int IMAGE_JPEG_QUALITY = 84;
    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s<>\"')]+", Pattern.CASE_INSENSITIVE);

    private static final ExecutorService IO_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ExecutorService UPDATE_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ExecutorService LINK_FETCH_EXECUTOR = Executors.newFixedThreadPool(2);
    private static final int MAX_EXTERNAL_TEXT_BYTES = 260 * 1024;
    private static final int MAX_EXTERNAL_REDIRECTS = 4;
    private static final AtomicBoolean APK_DOWNLOAD_IN_PROGRESS = new AtomicBoolean(false);
    private static final long MAX_APK_DOWNLOAD_BYTES = 250L * 1024L * 1024L;
    private static final ConcurrentLinkedQueue<JSObject> PENDING_SHARES = new ConcurrentLinkedQueue<>();
    private static final AtomicReference<String> PENDING_AUTH_CALLBACK_URL = new AtomicReference<>(null);
    private static volatile KapsulaNativePlugin activeInstance = null;
    private static volatile boolean latestKeyboardVisible = false;
    private static volatile int latestKeyboardHeightDp = 0;
    private static volatile int latestSysBarLeftPx = 0;
    private static volatile int latestSysBarTopPx = 0;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object voiceLock = new Object();

    // Clipboard wipe state (Android 10+ background-safe via OnPrimaryClipChangedListener + focus check)
    private Runnable clipboardWipeRunnable = null;
    private ClipboardManager.OnPrimaryClipChangedListener clipChangedListener = null;
    private volatile boolean clipboardOwnedByUs = false;
    private volatile long ignoreClipChangeUntilMs = 0L;
    private volatile long clipboardWipeDueAtMs = 0L;

    // Voice recorder state (guarded by voiceLock)
    private MediaRecorder mediaRecorder = null;
    private File voiceOutputFile = null;
    private long voiceStartedAtMs = 0L;
    private final List<Double> voicePeaks = new ArrayList<>();
    private Runnable amplitudePoller = null;

    // Fold posture state (Jetpack WindowManager)
    private WindowInfoTrackerCallbackAdapter windowInfoTrackerAdapter = null;
    private Consumer<WindowLayoutInfo> layoutInfoConsumer = null;
    private volatile JSObject latestFoldState = defaultFoldState();

    private static JSObject defaultFoldState() {
        JSObject obj = new JSObject();
        obj.put("posture", "flat");
        obj.put("isSeparating", false);
        obj.put("hingeOrientation", "none");
        obj.put("hingeBounds", JSObject.NULL);
        return obj;
    }

    @Override
    public void load() {
        super.load();
        activeInstance = this;
        startFoldPostureTracking();
        final Context appCtx = getContext().getApplicationContext();
        IO_EXECUTOR.execute(() -> cleanStagedDir(appCtx));
    }

    @Override
    protected void handleOnDestroy() {
        stopFoldPostureTracking();
        cancelRecorderInternal();
        unregisterClipboardListener();
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    public static void notifyAppLifecycle(String state) {
        KapsulaNativePlugin inst = activeInstance;
        if (inst != null) {
            if ("resumed".equals(state)) {
                inst.checkOverdueClipboardWipe();
            }
            JSObject payload = new JSObject();
            payload.put("state", state);
            inst.notifyListeners("appLifecycle", payload, true);
        }
    }

    public static void notifyWindowFocusChanged(boolean hasFocus) {
        KapsulaNativePlugin inst = activeInstance;
        if (inst != null && hasFocus) {
            inst.checkOverdueClipboardWipe();
        }
    }

    public static void updateSystemBarInsets(int leftPx, int topPx) {
        latestSysBarLeftPx = Math.max(0, leftPx);
        latestSysBarTopPx = Math.max(0, topPx);
    }

    public static boolean notifyBackPressed() {
        KapsulaNativePlugin inst = activeInstance;
        if (inst != null && inst.hasListeners("backPressed")) {
            inst.notifyListeners("backPressed", new JSObject());
            return true;
        }
        return false;
    }

    public static void notifyKeyboardState(boolean visible, int heightDp) {
        if (latestKeyboardVisible == visible && latestKeyboardHeightDp == heightDp) {
            return;
        }
        latestKeyboardVisible = visible;
        latestKeyboardHeightDp = heightDp;
        KapsulaNativePlugin inst = activeInstance;
        if (inst != null) {
            JSObject payload = new JSObject();
            payload.put("visible", visible);
            payload.put("heightDp", heightDp);
            inst.mainHandler.post(() -> inst.notifyListeners("keyboardStateChanged", payload, true));
        }
    }

    @PluginMethod
    public void getKeyboardState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("visible", latestKeyboardVisible);
        ret.put("heightDp", latestKeyboardHeightDp);
        call.resolve(ret);
    }

    @PluginMethod
    public void hideKeyboard(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            mainHandler.post(() -> {
                try {
                    Window window = activity.getWindow();
                    View decor = window.getDecorView();
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
                    controller.hide(WindowInsetsCompat.Type.ime());
                    InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                    View focus = activity.getCurrentFocus();
                    if (imm != null) {
                        imm.hideSoftInputFromWindow((focus != null ? focus : decor).getWindowToken(), 0);
                    }
                } catch (Exception ignored) {}
            });
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void hapticImpact(PluginCall call) {
        String style = call.getString("style", "light");
        Activity activity = getActivity();
        if (activity != null) {
            mainHandler.post(() -> {
                try {
                    View root = activity.getWindow().getDecorView();
                    int feedback;
                    if ("heavy".equals(style) || "long".equals(style)) {
                        feedback = HapticFeedbackConstants.LONG_PRESS;
                    } else if ("error".equals(style)) {
                        feedback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? HapticFeedbackConstants.REJECT
                            : HapticFeedbackConstants.LONG_PRESS;
                    } else if ("success".equals(style)) {
                        feedback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? HapticFeedbackConstants.CONFIRM
                            : HapticFeedbackConstants.VIRTUAL_KEY;
                    } else if ("medium".equals(style)) {
                        feedback = HapticFeedbackConstants.VIRTUAL_KEY;
                    } else {
                        feedback = HapticFeedbackConstants.CLOCK_TICK;
                    }
                    root.performHapticFeedback(feedback);
                } catch (Exception ignored) {}
            });
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // ==================== ANDROID SHARE TARGET (OFF-MAIN-THREAD, ZERO DUPLICATES) ====================

    public static void enqueueShareIntent(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return;
        }

        // Snapshot intent extras on main thread before clearing the activity intent, then read streams off-thread
        final Context appCtx = context.getApplicationContext();
        final Intent intentCopy = new Intent(intent);
        final String actionCopy = action;

        IO_EXECUTOR.execute(() -> {
            JSObject payload = buildSharePayload(appCtx, intentCopy, actionCopy);
            if (payload == null) return;

            KapsulaNativePlugin inst = activeInstance;
            if (inst != null && inst.hasListeners("shareReceived")) {
                inst.mainHandler.post(() -> inst.notifyListeners("shareReceived", payload));
            } else {
                PENDING_SHARES.add(payload);
                if (inst != null) {
                    inst.mainHandler.post(() -> inst.notifyListeners("shareReceived", payload, true));
                }
            }
        });
    }

    private static JSObject buildSharePayload(Context context, Intent intent, String action) {
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null) {
            CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (cs != null) text = cs.toString();
        }
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);

        JSArray filesArr = new JSArray();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri single = getParcelableExtraCompat(intent, Intent.EXTRA_STREAM, Uri.class);
            if (single != null) uris.add(single);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> multi = getParcelableArrayListExtraCompat(intent, Intent.EXTRA_STREAM, Uri.class);
            if (multi != null) uris.addAll(multi);
        }

        if (intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            final boolean collectClipUris = uris.isEmpty();
            for (int i = 0; i < clip.getItemCount(); i++) {
                if (collectClipUris) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
                if ((text == null || text.trim().isEmpty()) && clip.getItemAt(i).getText() != null) {
                    text = clip.getItemAt(i).getText().toString();
                }
            }
        }

        // Extract URL AFTER ClipData fallback (fixes H3)
        String extractedUrl = null;
        if (text != null) {
            Matcher m = URL_PATTERN.matcher(text);
            if (m.find()) {
                extractedUrl = m.group().replaceAll("[.,!?;:]+$", "");
            }
        }

        final int maxTotalBytes = MAX_SHARED_FILE_BYTES * 2;
        int totalBytesRead = 0;
        int truncatedCount = 0;
        for (int i = 0; i < uris.size(); i++) {
            Uri uri = uris.get(i);
            if (totalBytesRead >= maxTotalBytes) {
                truncatedCount++;
                continue;
            }
            JSObject fileObj = readUriToJsObject(context, uri, intent.getType());
            if (fileObj == null) {
                truncatedCount++;
                continue;
            }
            int size = fileObj.optInt("size", 0);
            if (size <= 0 || totalBytesRead + size > maxTotalBytes) {
                truncatedCount++;
                continue;
            }
            totalBytesRead += size;
            filesArr.put(fileObj);
        }

        if ((text == null || text.trim().isEmpty()) && filesArr.length() == 0 && truncatedCount == 0) {
            return null;
        }

        JSObject payload = new JSObject();
        payload.put("id", UUID.randomUUID().toString());
        payload.put("action", Intent.ACTION_SEND_MULTIPLE.equals(action) ? "send_multiple" : "send");
        if (text != null) payload.put("text", text);
        if (subject != null) payload.put("subject", subject);
        if (extractedUrl != null) payload.put("url", extractedUrl);
        if (filesArr.length() > 0) payload.put("files", filesArr);
        if (truncatedCount > 0) payload.put("truncatedCount", truncatedCount);
        payload.put("receivedAt", System.currentTimeMillis());
        return payload;
    }

    private static boolean isPrivateAppFileUri(Context context, Uri uri) {
        if (uri == null || !"file".equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        String rawPath = uri.getPath();
        if (rawPath == null || rawPath.trim().isEmpty()) {
            return true;
        }
        try {
            String canonicalTarget = new File(rawPath).getCanonicalPath();
            List<File> protectedDirs = new ArrayList<>();
            if (context.getApplicationInfo() != null && context.getApplicationInfo().dataDir != null) {
                protectedDirs.add(new File(context.getApplicationInfo().dataDir));
            }
            if (context.getFilesDir() != null) protectedDirs.add(context.getFilesDir());
            if (context.getCacheDir() != null) protectedDirs.add(context.getCacheDir());
            if (context.getNoBackupFilesDir() != null) protectedDirs.add(context.getNoBackupFilesDir());
            if (context.getCodeCacheDir() != null) protectedDirs.add(context.getCodeCacheDir());

            for (File dir : protectedDirs) {
                if (dir == null) continue;
                String canonicalDir = dir.getCanonicalPath();
                if (canonicalTarget.equals(canonicalDir) || canonicalTarget.startsWith(canonicalDir + File.separator)) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            return true;
        }
    }

    @SuppressWarnings("deprecation")
    private static <T extends Parcelable> T getParcelableExtraCompat(Intent intent, String key, Class<T> clazz) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(key, clazz);
        }
        Parcelable obj = intent.getParcelableExtra(key);
        return clazz.isInstance(obj) ? clazz.cast(obj) : null;
    }

    @SuppressWarnings("deprecation")
    private static <T extends Parcelable> ArrayList<T> getParcelableArrayListExtraCompat(Intent intent, String key, Class<T> clazz) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableArrayListExtra(key, clazz);
        }
        return intent.getParcelableArrayListExtra(key);
    }

    private static File getStagedDir(Context context) {
        File dir = new File(context.getCacheDir(), STAGED_DIR_NAME);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    private static void cleanStagedDir(Context context) {
        try {
            File dir = new File(context.getCacheDir(), STAGED_DIR_NAME);
            if (!dir.exists() || !dir.isDirectory()) return;
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File f : files) {
                if (f != null && f.isFile()) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        } catch (Exception ignored) {
            // Ignore cleanup errors on boot
        }
    }

    private static long queryFileSize(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !cursor.isNull(idx)) {
                    return cursor.getLong(idx);
                }
            }
        } catch (Exception ignored) {
            // Ignore provider query error; stream limit still enforces MAX_SHARED_FILE_BYTES
        }
        return -1L;
    }

    private static String writeStagedBytes(Context context, byte[] bytes) throws Exception {
        File staged = new File(getStagedDir(context), UUID.randomUUID().toString());
        try (FileOutputStream fos = new FileOutputStream(staged)) {
            fos.write(bytes);
        } catch (Exception err) {
            //noinspection ResultOfMethodCallIgnored
            staged.delete();
            throw err;
        }
        return staged.getAbsolutePath();
    }

    private static JSObject readUriToJsObject(Context context, Uri uri, String fallbackMime) {
        if (isPrivateAppFileUri(context, uri)) {
            return null;
        }
        ContentResolver resolver = context.getContentResolver();
        String mime = resolver.getType(uri);
        if (mime == null || mime.isEmpty() || "*/*".equals(mime)) {
            mime = (fallbackMime != null && !"*/*".equals(fallbackMime))
                ? fallbackMime
                : "application/octet-stream";
        }
        String displayName = queryDisplayName(resolver, uri);
        if (displayName == null || displayName.isEmpty()) {
            displayName = "shared-" + System.currentTimeMillis();
        }

        boolean isRasterImage = mime.startsWith("image/")
            && !"image/gif".equalsIgnoreCase(mime)
            && !"image/svg+xml".equalsIgnoreCase(mime);

        long knownSize = queryFileSize(resolver, uri);
        if (!isRasterImage && knownSize > MAX_SHARED_FILE_BYTES) {
            return null;
        }

        try {
            if (isRasterImage) {
                byte[] bytes = null;
                if (knownSize <= 0 || knownSize <= IMAGE_OPTIMIZE_THRESHOLD_BYTES) {
                    try (InputStream in = resolver.openInputStream(uri)) {
                        if (in == null) return null;
                        bytes = readLimitedBytes(in, IMAGE_OPTIMIZE_THRESHOLD_BYTES);
                    }
                }
                // If a high-res photo (e.g. Samsung 50MP/200MP) exceeds threshold, downscale natively instead of dropping
                if (bytes == null) {
                    bytes = encodeOptimizedImageFromUri(resolver, uri);
                    if (bytes != null && bytes.length > 0) {
                        mime = "image/jpeg";
                        if (!displayName.toLowerCase().endsWith(".jpg") && !displayName.toLowerCase().endsWith(".jpeg")) {
                            int dot = displayName.lastIndexOf('.');
                            String stem = dot > 0 ? displayName.substring(0, dot) : displayName;
                            displayName = stem + ".jpg";
                        }
                    }
                }
                if (bytes == null || bytes.length == 0 || bytes.length > MAX_SHARED_FILE_BYTES) return null;
                JSObject obj = new JSObject();
                obj.put("name", displayName);
                obj.put("mime", mime);
                if (bytes.length > STAGED_FILE_THRESHOLD_BYTES) {
                    obj.put("stagedPath", writeStagedBytes(context, bytes));
                } else {
                    obj.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                }
                obj.put("size", bytes.length);
                return obj;
            }

            // Non-raster files: stream small payloads in RAM and spill > 2 MiB directly to disk
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) return null;
                ByteArrayOutputStream memBuf = new ByteArrayOutputStream();
                File stagedFile = null;
                FileOutputStream stagedOut = null;
                byte[] chunk = new byte[16384];
                long total = 0;
                try {
                    int n;
                    while ((n = in.read(chunk)) != -1) {
                        total += n;
                        if (total > MAX_SHARED_FILE_BYTES) {
                            return null;
                        }
                        if (stagedOut == null && total > STAGED_FILE_THRESHOLD_BYTES) {
                            stagedFile = new File(getStagedDir(context), UUID.randomUUID().toString());
                            stagedOut = new FileOutputStream(stagedFile);
                            stagedOut.write(memBuf.toByteArray());
                            memBuf = null;
                        }
                        if (stagedOut != null) {
                            stagedOut.write(chunk, 0, n);
                        } else {
                            memBuf.write(chunk, 0, n);
                        }
                    }
                    if (total <= 0) {
                        return null;
                    }
                    JSObject obj = new JSObject();
                    obj.put("name", displayName);
                    obj.put("mime", mime);
                    obj.put("size", total);
                    if (stagedFile != null) {
                        stagedOut.close();
                        stagedOut = null;
                        obj.put("stagedPath", stagedFile.getAbsolutePath());
                        stagedFile = null;
                    } else if (memBuf != null) {
                        byte[] bytes = memBuf.toByteArray();
                        obj.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    }
                    return obj;
                } finally {
                    if (stagedOut != null) {
                        try {
                            stagedOut.close();
                        } catch (Exception ignored) {}
                    }
                    if (stagedFile != null && stagedFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        stagedFile.delete();
                    }
                }
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    @PluginMethod
    public void deleteStagedFile(PluginCall call) {
        String rawPath = call.getString("stagedPath", "");
        JSObject ret = new JSObject();
        if (rawPath == null || rawPath.trim().isEmpty()) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        try {
            File stagedDir = getStagedDir(getContext().getApplicationContext()).getCanonicalFile();
            File target = new File(rawPath).getCanonicalFile();
            String prefix = stagedDir.getPath() + File.separator;
            if (!target.getPath().startsWith(prefix)) {
                ret.put("ok", false);
                call.resolve(ret);
                return;
            }
            ret.put("ok", !target.exists() || target.delete());
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("ok", false);
            call.resolve(ret);
        }
    }

    private static byte[] compressBitmapJpeg(Bitmap bitmap) {
        if (bitmap == null) return null;
        try {
            int w = bitmap.getWidth();
            int h = bitmap.getHeight();
            Bitmap scaled = bitmap;
            int maxDim = Math.max(w, h);
            if (maxDim > IMAGE_MAX_DIMENSION_PX && w > 0 && h > 0) {
                float ratio = (float) IMAGE_MAX_DIMENSION_PX / (float) maxDim;
                int targetW = Math.max(1, Math.round(w * ratio));
                int targetH = Math.max(1, Math.round(h * ratio));
                scaled = Bitmap.createScaledBitmap(bitmap, targetW, targetH, true);
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, IMAGE_JPEG_QUALITY, baos);
            if (scaled != bitmap) {
                scaled.recycle();
            }
            bitmap.recycle();
            return baos.toByteArray();
        } catch (Exception ignored) {
            try {
                bitmap.recycle();
            } catch (Exception ignored2) {}
            return null;
        }
    }

    private static int computeInSampleSize(int width, int height, int maxDim) {
        int sample = 1;
        int maxSide = Math.max(width, height);
        while (maxSide / (sample * 2) >= maxDim) {
            sample *= 2;
        }
        return sample;
    }

    private static byte[] encodeOptimizedImageFromFile(File file) {
        if (file == null || !file.exists()) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ImageDecoder.Source source = ImageDecoder.createSource(file);
                Bitmap bmp = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                    int w = info.getSize().getWidth();
                    int h = info.getSize().getHeight();
                    int maxDim = Math.max(w, h);
                    if (maxDim > IMAGE_MAX_DIMENSION_PX && w > 0 && h > 0) {
                        float ratio = (float) IMAGE_MAX_DIMENSION_PX / (float) maxDim;
                        decoder.setTargetSize(
                            Math.max(1, Math.round(w * ratio)),
                            Math.max(1, Math.round(h * ratio))
                        );
                    }
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                });
                return compressBitmapJpeg(bmp);
            } else {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, IMAGE_MAX_DIMENSION_PX);
                Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
                return compressBitmapJpeg(bmp);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static byte[] encodeOptimizedImageFromUri(ContentResolver resolver, Uri uri) {
        if (resolver == null || uri == null) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ImageDecoder.Source source = ImageDecoder.createSource(resolver, uri);
                Bitmap bmp = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                    int w = info.getSize().getWidth();
                    int h = info.getSize().getHeight();
                    int maxDim = Math.max(w, h);
                    if (maxDim > IMAGE_MAX_DIMENSION_PX && w > 0 && h > 0) {
                        float ratio = (float) IMAGE_MAX_DIMENSION_PX / (float) maxDim;
                        decoder.setTargetSize(
                            Math.max(1, Math.round(w * ratio)),
                            Math.max(1, Math.round(h * ratio))
                        );
                    }
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                });
                return compressBitmapJpeg(bmp);
            } else {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                try (InputStream in = resolver.openInputStream(uri)) {
                    if (in == null) return null;
                    BitmapFactory.decodeStream(in, null, bounds);
                }
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inSampleSize = computeInSampleSize(bounds.outWidth, bounds.outHeight, IMAGE_MAX_DIMENSION_PX);
                try (InputStream in2 = resolver.openInputStream(uri)) {
                    if (in2 == null) return null;
                    Bitmap bmp = BitmapFactory.decodeStream(in2, null, opts);
                    return compressBitmapJpeg(bmp);
                }
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String queryDisplayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
            // fallback
        }
        return uri.getLastPathSegment();
    }

    private static byte[] readLimitedBytes(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > maxBytes) {
                return null;
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    @PluginMethod
    public void consumePendingShares(PluginCall call) {
        JSArray arr = new JSArray();
        JSObject item;
        while ((item = PENDING_SHARES.poll()) != null) {
            arr.put(item);
        }
        JSObject ret = new JSObject();
        ret.put("shares", arr);
        call.resolve(ret);
    }

    // ==================== DEVICE INFO & WINDOW SECURITY ====================

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("model", Build.MODEL != null ? Build.MODEL : "Android");
        ret.put("manufacturer", Build.MANUFACTURER != null ? Build.MANUFACTURER : "Android");
        ret.put("osVersion", Build.VERSION.RELEASE != null ? Build.VERSION.RELEASE : "");
        ret.put("platform", "android");
        call.resolve(ret);
    }

    @PluginMethod
    public void setScreenSecure(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Activity activity = getActivity();
        if (activity != null) {
            mainHandler.post(() -> {
                try {
                    Window window = activity.getWindow();
                    if (enabled) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    }
                } catch (Exception ignored) {}
            });
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void minimizeApp(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            mainHandler.post(() -> activity.moveTaskToBack(true));
        }
        call.resolve();
    }

    // ==================== ANDROID KEYSTORE AES-256-GCM ====================

    private synchronized SecretKey getOrCreateKeystoreKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        if (ks.containsAlias(KEYSTORE_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEYSTORE_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build();
        generator.init(spec);
        return generator.generateKey();
    }

    private SecretKey getOrCreateAuthKeystoreKey() throws Exception {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) {
            throw new IllegalStateException("Device lock screen is not configured");
        }
        KeyStore ks = KeyStore.getInstance(KEYSTORE_PROVIDER);
        ks.load(null);
        if (ks.containsAlias(KEYSTORE_AUTH_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEYSTORE_AUTH_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec.Builder specBuilder = new KeyGenParameterSpec.Builder(
            KEYSTORE_AUTH_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            specBuilder.setUserAuthenticationParameters(
                30,
                KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL
            );
        } else {
            //noinspection deprecation
            specBuilder.setUserAuthenticationValidityDurationSeconds(30);
        }
        generator.init(specBuilder.build());
        return generator.generateKey();
    }

    private String encryptWithKeystoreKey(SecretKey key, String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
        return Base64.encodeToString(combined, Base64.NO_WRAP);
    }

    private String decryptWithKeystoreKey(SecretKey key, String cipherText) throws Exception {
        byte[] combined = Base64.decode(cipherText, Base64.NO_WRAP);
        if (combined.length < 28) {
            throw new IllegalArgumentException("Corrupt ciphertext");
        }
        byte[] iv = new byte[12];
        byte[] data = new byte[combined.length - 12];
        System.arraycopy(combined, 0, iv, 0, 12);
        System.arraycopy(combined, 12, data, 0, data.length);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        byte[] plainBytes = cipher.doFinal(data);
        return new String(plainBytes, StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void isKeystoreAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            getOrCreateKeystoreKey();
            ret.put("available", true);
        } catch (Exception e) {
            ret.put("available", false);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void isAuthKeystoreAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            getOrCreateAuthKeystoreKey();
            ret.put("available", true);
        } catch (Exception e) {
            ret.put("available", false);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void keystoreEncrypt(PluginCall call) {
        String plain = call.getString("plainText");
        if (plain == null) {
            call.reject("Пустые данные для шифрования");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("cipherText", encryptWithKeystoreKey(getOrCreateKeystoreKey(), plain));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось защитить данные системным хранилищем ключей");
        }
    }

    @PluginMethod
    public void keystoreDecrypt(PluginCall call) {
        String cipherText = call.getString("cipherText");
        if (cipherText == null || cipherText.isEmpty()) {
            call.reject("Отсутствуют зашифрованные данные");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("plainText", decryptWithKeystoreKey(getOrCreateKeystoreKey(), cipherText));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось расшифровать данные системным хранилищем ключей");
        }
    }

    @PluginMethod
    public void keystoreAuthEncrypt(PluginCall call) {
        String plain = call.getString("plainText");
        if (plain == null) {
            call.reject("Пустые данные для шифрования");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("cipherText", encryptWithKeystoreKey(getOrCreateAuthKeystoreKey(), plain));
            call.resolve(ret);
        } catch (UserNotAuthenticatedException e) {
            call.reject("Требуется подтверждение биометрии или блокировки экрана", "AUTH_REQUIRED");
        } catch (Exception e) {
            call.reject("Не удалось защитить ключ биометрическим хранилищем");
        }
    }

    @PluginMethod
    public void keystoreAuthDecrypt(PluginCall call) {
        String cipherText = call.getString("cipherText");
        if (cipherText == null || cipherText.isEmpty()) {
            call.reject("Отсутствуют зашифрованные данные");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("plainText", decryptWithKeystoreKey(getOrCreateAuthKeystoreKey(), cipherText));
            call.resolve(ret);
        } catch (UserNotAuthenticatedException e) {
            call.reject("Требуется подтверждение биометрии или блокировки экрана", "AUTH_REQUIRED");
        } catch (Exception e) {
            call.reject("Не удалось расшифровать ключ после проверки биометрии");
        }
    }

    // ==================== BIOMETRIC PROMPT (FAIL-CLOSED, API 24..36 SAFE) ====================

    @PluginMethod
    public void checkBiometric(PluginCall call) {
        BiometricManager bm = BiometricManager.from(getContext());
        int authenticators = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.BIOMETRIC_WEAK
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        int canAuth = bm.canAuthenticate(authenticators);
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        boolean deviceSecure = km != null && km.isDeviceSecure();
        boolean available = (canAuth == BiometricManager.BIOMETRIC_SUCCESS) || deviceSecure;

        JSObject ret = new JSObject();
        ret.put("available", available);
        ret.put("biometryType", available ? "biometric" : "none");
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticateBiometric(PluginCall call) {
        FragmentActivity activity = getActivity();
        if (activity == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Экран приложения недоступен");
            call.resolve(ret);
            return;
        }

        String title = call.getString("title", "Доступ к Сейфу Kapsula");
        String subtitle = call.getString("subtitle", "Подтверди личность отпечатком или лицом");

        mainHandler.post(() -> {
            BiometricManager bm = BiometricManager.from(activity);
            KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
            boolean deviceHasLockScreen = km != null && km.isDeviceSecure();

            int authenticators = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? BiometricManager.Authenticators.BIOMETRIC_STRONG
                    | BiometricManager.Authenticators.BIOMETRIC_WEAK
                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                : BiometricManager.Authenticators.BIOMETRIC_WEAK
                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

            int status = bm.canAuthenticate(authenticators);

            if (status != BiometricManager.BIOMETRIC_SUCCESS) {
                // Fail-CLOSED when the device has neither biometric nor lock screen PIN configured:
                // return explicit reason so JS can fall back to the app-level Master PIN.
                if (!deviceHasLockScreen && (status == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
                    || status == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE)) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("reason", "no_device_credential");
                    ret.put("error", "На устройстве не настроена биометрия или блокировка экрана — используй мастер-PIN");
                    call.resolve(ret);
                    return;
                }
                // Fail-closed for hardware errors, security update required, or unknown errors!
                if (status != BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED && !deviceHasLockScreen) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("reason", "hardware_unavailable");
                    ret.put("error", "Биометрический датчик сейчас недоступен — проверь настройки защиты телефона");
                    call.resolve(ret);
                    return;
                }
                if (status == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE
                    || status == BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("reason", "hardware_unavailable");
                    ret.put("error", "Датчик отпечатка временно недоступен — попробуй ещё раз");
                    call.resolve(ret);
                    return;
                }
            }

            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        call.resolve(ret);
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                        JSObject ret = new JSObject();
                        ret.put("ok", false);
                        if (errorCode != BiometricPrompt.ERROR_USER_CANCELED
                            && errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                            ret.put("error", errString.toString());
                        }
                        call.resolve(ret);
                    }

                    @Override
                    public void onAuthenticationFailed() {
                        // System prompt remains visible for retry
                    }
                }
            );

            BiometricPrompt.PromptInfo.Builder builder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(authenticators);
            } else {
                // On API 24-29 allows biometric OR device PIN/pattern/password
                //noinspection deprecation
                builder.setDeviceCredentialAllowed(true);
            }

            try {
                prompt.authenticate(builder.build());
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("error", "Не удалось запустить проверку биометрии");
                call.resolve(ret);
            }
        });
    }

    // ==================== SENSITIVE CLIPBOARD + BACKGROUND-SAFE AUTO-WIPE ====================

    private void unregisterClipboardListener() {
        mainHandler.post(() -> {
            if (clipboardWipeRunnable != null) {
                mainHandler.removeCallbacks(clipboardWipeRunnable);
                clipboardWipeRunnable = null;
            }
            if (clipChangedListener != null) {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    try {
                        cm.removePrimaryClipChangedListener(clipChangedListener);
                    } catch (Exception ignored) {}
                }
                clipChangedListener = null;
            }
        });
    }

    private void ensureClipboardListener(ClipboardManager cm) {
        if (clipChangedListener != null) return;
        clipChangedListener = () -> {
            long now = System.currentTimeMillis();
            if (now <= ignoreClipChangeUntilMs) {
                ignoreClipChangeUntilMs = 0L;
                return;
            }
            // User copied something else in another app -> stop owning clipboard so we don't wipe their new clip
            clipboardOwnedByUs = false;
            clipboardWipeDueAtMs = 0L;
        };
        try {
            cm.addPrimaryClipChangedListener(clipChangedListener);
        } catch (Exception ignored) {}
    }

    private void performSafeClipboardClear(ClipboardManager cm) {
        if (!clipboardOwnedByUs || cm == null) return;
        // On Android 10-16, clipboard mutations while unfocused silently fail or throw.
        // Keep clipboardOwnedByUs & clipboardWipeDueAtMs intact so onResume/onWindowFocusChanged wipes immediately on return.
        Activity activity = getActivity();
        if (activity == null || !activity.hasWindowFocus()) {
            return;
        }
        try {
            ignoreClipChangeUntilMs = System.currentTimeMillis() + 900L;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                cm.clearPrimaryClip();
            } else {
                cm.setPrimaryClip(ClipData.newPlainText("", ""));
            }
            clipboardOwnedByUs = false;
            clipboardWipeDueAtMs = 0L;
        } catch (Exception ignored) {
            ignoreClipChangeUntilMs = 0L;
            // Leave ownership intact so next foreground resume retries clearing the secret
        }
    }

    private void checkOverdueClipboardWipe() {
        long due = clipboardWipeDueAtMs;
        if (clipboardOwnedByUs && due > 0L && System.currentTimeMillis() >= due) {
            mainHandler.post(() -> {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                performSafeClipboardClear(cm);
            });
        }
    }

    @PluginMethod
    public void copySensitive(PluginCall call) {
        String text = call.getString("text", "");
        int wipeSeconds = call.getInt("wipeSeconds", 30);
        boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", wipeSeconds > 0));

        mainHandler.post(() -> {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                ensureClipboardListener(cm);
                ClipData clip = ClipData.newPlainText("Kapsula", text);
                if (sensitive) {
                    PersistableBundle extras = new PersistableBundle();
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                    } else {
                        extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                    }
                    clip.getDescription().setExtras(extras);
                }

                ignoreClipChangeUntilMs = System.currentTimeMillis() + 900L;
                cm.setPrimaryClip(clip);

                if (clipboardWipeRunnable != null) {
                    mainHandler.removeCallbacks(clipboardWipeRunnable);
                    clipboardWipeRunnable = null;
                }

                if (wipeSeconds > 0) {
                    clipboardOwnedByUs = true;
                    clipboardWipeDueAtMs = System.currentTimeMillis() + wipeSeconds * 1000L;
                    clipboardWipeRunnable = () -> performSafeClipboardClear(cm);
                    mainHandler.postDelayed(clipboardWipeRunnable, wipeSeconds * 1000L);
                } else {
                    clipboardOwnedByUs = false;
                    clipboardWipeDueAtMs = 0L;
                }
            }

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("wipeSeconds", wipeSeconds);
            call.resolve(ret);
        });
    }

    // ==================== NATIVE VOICE RECORDING (THREAD-SAFE) ====================

    @PluginMethod
    public void startVoiceRecording(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermsCallback");
            return;
        }
        startRecorderInternal(call);
    }

    @PermissionCallback
    private void microphonePermsCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startRecorderInternal(call);
        } else {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Разреши доступ к микрофону для записи голосовых заметок");
            call.resolve(ret);
        }
    }

    private void startRecorderInternal(PluginCall call) {
        cancelRecorderInternal();
        synchronized (voiceLock) {
            try {
                File outFile = File.createTempFile("kapsula-voice-", ".m4a", getContext().getCacheDir());
                MediaRecorder recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? new MediaRecorder(getContext())
                    : new MediaRecorder();
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                recorder.setAudioEncodingBitRate(128000);
                recorder.setAudioSamplingRate(44100);
                recorder.setOutputFile(outFile.getAbsolutePath());
                recorder.prepare();
                recorder.start();

                this.mediaRecorder = recorder;
                this.voiceOutputFile = outFile;
                this.voiceStartedAtMs = System.currentTimeMillis();
                this.voicePeaks.clear();

                this.amplitudePoller = new Runnable() {
                    @Override
                    public void run() {
                        double norm = -1.0;
                        synchronized (voiceLock) {
                            if (mediaRecorder == null) return;
                            try {
                                int maxAmp = mediaRecorder.getMaxAmplitude();
                                norm = Math.min(1.0, Math.max(0.08, maxAmp / 22000.0));
                                voicePeaks.add(Math.round(norm * 1000.0) / 1000.0);
                                if (voicePeaks.size() > 120) voicePeaks.remove(0);
                            } catch (Exception ignored) {
                                // transient read error
                            }
                            if (mediaRecorder != null) {
                                mainHandler.postDelayed(this, 120);
                            }
                        }
                        if (norm >= 0.0) {
                            JSObject ev = new JSObject();
                            ev.put("level", norm);
                            notifyListeners("voiceAmplitude", ev);
                        }
                    }
                };
                mainHandler.postDelayed(amplitudePoller, 120);

                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                cancelRecorderInternal();
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("error", "Не удалось запустить запись голоса");
                call.resolve(ret);
            }
        }
    }

    @PluginMethod
    public void stopVoiceRecording(PluginCall call) {
        final MediaRecorder rec;
        final File file;
        final List<Double> peaksCopy;
        final int durationSec;

        synchronized (voiceLock) {
            if (amplitudePoller != null) {
                mainHandler.removeCallbacks(amplitudePoller);
                amplitudePoller = null;
            }
            rec = mediaRecorder;
            file = voiceOutputFile;
            mediaRecorder = null;
            voiceOutputFile = null;
            peaksCopy = new ArrayList<>(voicePeaks);
            voicePeaks.clear();
            durationSec = (int) Math.max(1L, Math.round((System.currentTimeMillis() - voiceStartedAtMs) / 1000.0));
        }

        if (rec == null || file == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Запись не активна");
            call.resolve(ret);
            return;
        }

        IO_EXECUTOR.execute(() -> {
            try {
                rec.stop();
            } catch (Exception ignored) {}
            try {
                rec.release();
            } catch (Exception ignored) {}

            long fileLen = file.length();
            if (fileLen <= 0 || fileLen > MAX_SHARED_FILE_BYTES) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("error", fileLen > MAX_SHARED_FILE_BYTES ? "Запись слишком большая для сохранения" : "Запись получилась пустой");
                call.resolve(ret);
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return;
            }
            if (fileLen > STAGED_FILE_THRESHOLD_BYTES) {
                File staged = new File(getStagedDir(getContext().getApplicationContext()), UUID.randomUUID().toString() + ".m4a");
                try (FileInputStream fis = new FileInputStream(file); FileOutputStream fos = new FileOutputStream(staged)) {
                    byte[] chunk = new byte[16384];
                    int n;
                    while ((n = fis.read(chunk)) != -1) {
                        fos.write(chunk, 0, n);
                    }
                    JSArray peaksArr = new JSArray();
                    for (Double p : peaksCopy) peaksArr.put(p);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("stagedPath", staged.getAbsolutePath());
                    ret.put("mime", "audio/mp4");
                    ret.put("durationSec", durationSec);
                    ret.put("peaks", peaksArr);
                    call.resolve(ret);
                    return;
                } catch (Exception e) {
                    //noinspection ResultOfMethodCallIgnored
                    staged.delete();
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("error", "Не удалось прочитать сохранённую запись");
                    call.resolve(ret);
                    return;
                } finally {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }

            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] bytes = readLimitedBytes(fis, MAX_SHARED_FILE_BYTES);
                if (bytes == null || bytes.length == 0) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("error", "Запись получилась пустой");
                    call.resolve(ret);
                    return;
                }
                JSArray peaksArr = new JSArray();
                for (Double p : peaksCopy) peaksArr.put(p);

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                ret.put("mime", "audio/mp4");
                ret.put("durationSec", durationSec);
                ret.put("peaks", peaksArr);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("error", "Не удалось прочитать сохранённую запись");
                call.resolve(ret);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    @PluginMethod
    public void cancelVoiceRecording(PluginCall call) {
        cancelRecorderInternal();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    private void cancelRecorderInternal() {
        synchronized (voiceLock) {
            if (amplitudePoller != null) {
                mainHandler.removeCallbacks(amplitudePoller);
                amplitudePoller = null;
            }
            if (mediaRecorder != null) {
                try {
                    mediaRecorder.stop();
                } catch (Exception ignored) {}
                try {
                    mediaRecorder.release();
                } catch (Exception ignored) {}
                mediaRecorder = null;
            }
            if (voiceOutputFile != null) {
                //noinspection ResultOfMethodCallIgnored
                voiceOutputFile.delete();
                voiceOutputFile = null;
            }
            voicePeaks.clear();
        }
    }

    // ==================== CAMERA & FILE PICKER (OFF-MAIN-THREAD + PROCESS-DEATH SAFE) ====================

    private SharedPreferences getNativePrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void capturePhoto(PluginCall call) {
        launchCameraInternal(call);
    }

    private void launchCameraInternal(PluginCall call) {
        try {
            File cameraDir = new File(getContext().getCacheDir(), "camera");
            if (!cameraDir.exists() && !cameraDir.mkdirs()) {
                throw new Exception("Не удалось подготовить папку камеры");
            }
            File photoFile = File.createTempFile("kapsula-cam-", ".jpg", cameraDir);
            getNativePrefs().edit().putString(PREF_PENDING_CAMERA_PATH, photoFile.getAbsolutePath()).apply();
            Uri photoUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                photoFile
            );
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(call, intent, "cameraResultCallback");
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Не удалось открыть камеру");
            call.resolve(ret);
        }
    }

    @ActivityCallback
    private void cameraResultCallback(PluginCall call, ActivityResult result) {
        SharedPreferences prefs = getNativePrefs();
        String path = prefs.getString(PREF_PENDING_CAMERA_PATH, null);
        prefs.edit().remove(PREF_PENDING_CAMERA_PATH).apply();
        final File file = path != null ? new File(path) : null;

        if (result.getResultCode() != Activity.RESULT_OK || file == null || !file.exists() || file.length() == 0) {
            if (file != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            JSObject ret = new JSObject();
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }

        IO_EXECUTOR.execute(() -> {
            JSObject ret = new JSObject();
            try {
                // Always normalize & downscale high-res Samsung 50MP/200MP camera JPEGs with EXIF orientation
                byte[] bytes = encodeOptimizedImageFromFile(file);
                if (bytes == null || bytes.length == 0) {
                    try (FileInputStream fis = new FileInputStream(file)) {
                        bytes = readLimitedBytes(fis, MAX_SHARED_FILE_BYTES);
                    }
                }
                if (bytes == null || bytes.length == 0 || bytes.length > MAX_SHARED_FILE_BYTES) {
                    ret.put("ok", false);
                    ret.put("error", "Снимок слишком большой для сохранения");
                    call.resolve(ret);
                    return;
                }
                JSObject fileObj = new JSObject();
                fileObj.put("name", "photo-" + System.currentTimeMillis() + ".jpg");
                fileObj.put("mime", "image/jpeg");
                if (bytes.length > STAGED_FILE_THRESHOLD_BYTES) {
                    fileObj.put("stagedPath", writeStagedBytes(getContext().getApplicationContext(), bytes));
                } else {
                    fileObj.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                }
                fileObj.put("size", bytes.length);
                ret.put("ok", true);
                ret.put("file", fileObj);
                call.resolve(ret);
            } catch (Exception e) {
                ret.put("ok", false);
                ret.put("error", "Не удалось обработать снимок");
                call.resolve(ret);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        String mime = call.getString("mime", "*/*");
        boolean multiple = Boolean.TRUE.equals(call.getBoolean("multiple", false));
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        if (multiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
            startActivityForResult(call, intent, "pickFileResultCallback");
        } catch (ActivityNotFoundException | SecurityException e) {
            call.reject("На устройстве не найдено приложение для выбора файлов");
        }
    }

    @ActivityCallback
    private void pickFileResultCallback(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("files", new JSArray());
            call.resolve(ret);
            return;
        }

        final Intent data = result.getData();
        final Context appCtx = getContext().getApplicationContext();
        final List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        IO_EXECUTOR.execute(() -> {
            JSArray filesArr = new JSArray();
            long totalBytesRead = 0;
            final long maxTotalBytes = MAX_SHARED_FILE_BYTES * 2L;
            boolean truncated = false;
            for (Uri uri : uris) {
                if (totalBytesRead >= maxTotalBytes) {
                    truncated = true;
                    break;
                }
                JSObject obj = readUriToJsObject(appCtx, uri, null);
                if (obj == null) {
                    truncated = true;
                    continue;
                }
                long size = obj.optLong("size", 0);
                if (size <= 0 || totalBytesRead + size > maxTotalBytes) {
                    truncated = true;
                    if (filesArr.length() > 0) break;
                    continue;
                }
                totalBytesRead += size;
                filesArr.put(obj);
            }
            JSObject ret = new JSObject();
            ret.put("ok", filesArr.length() > 0);
            ret.put("files", filesArr);
            ret.put("truncated", truncated);
            call.resolve(ret);
        });
    }

    // ==================== FOLD POSTURE (JETPACK WINDOWMANAGER) ====================

    private void startFoldPostureTracking() {
        Activity activity = getActivity();
        if (activity == null) return;
        try {
            windowInfoTrackerAdapter = new WindowInfoTrackerCallbackAdapter(
                WindowInfoTracker.getOrCreate(activity)
            );
            layoutInfoConsumer = this::handleWindowLayoutInfo;
            windowInfoTrackerAdapter.addWindowLayoutInfoListener(
                activity,
                ContextCompat.getMainExecutor(activity),
                layoutInfoConsumer
            );
        } catch (Exception ignored) {
            // Non-foldable or restricted environment
        }
    }

    private void stopFoldPostureTracking() {
        if (windowInfoTrackerAdapter != null && layoutInfoConsumer != null) {
            try {
                windowInfoTrackerAdapter.removeWindowLayoutInfoListener(layoutInfoConsumer);
            } catch (Exception ignored) {}
        }
        windowInfoTrackerAdapter = null;
        layoutInfoConsumer = null;
    }

    private void handleWindowLayoutInfo(WindowLayoutInfo info) {
        JSObject next = defaultFoldState();
        float density = getContext().getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;

        for (DisplayFeature feature : info.getDisplayFeatures()) {
            if (feature instanceof FoldingFeature) {
                FoldingFeature fold = (FoldingFeature) feature;
                next.put(
                    "posture",
                    fold.getState() == FoldingFeature.State.HALF_OPENED ? "half-opened" : "flat"
                );
                next.put("isSeparating", fold.isSeparating());
                next.put(
                    "hingeOrientation",
                    fold.getOrientation() == FoldingFeature.Orientation.VERTICAL ? "vertical" : "horizontal"
                );
                Rect b = fold.getBounds();
                int adjLeft = Math.max(0, b.left - latestSysBarLeftPx);
                int adjRight = Math.max(adjLeft, b.right - latestSysBarLeftPx);
                int adjTop = Math.max(0, b.top - latestSysBarTopPx);
                int adjBottom = Math.max(adjTop, b.bottom - latestSysBarTopPx);
                JSObject boundsObj = new JSObject();
                boundsObj.put("left", Math.round(adjLeft / density));
                boundsObj.put("top", Math.round(adjTop / density));
                boundsObj.put("right", Math.round(adjRight / density));
                boundsObj.put("bottom", Math.round(adjBottom / density));
                next.put("hingeBounds", boundsObj);
                break;
            }
        }
        latestFoldState = next;
        notifyListeners("foldStateChanged", next);
    }

    @PluginMethod
    public void getFoldState(PluginCall call) {
        call.resolve(latestFoldState);
    }

    // ==================== SYSTEM BARS (ANDROID 15/16 EDGE-TO-EDGE SAFE) & EXTERNAL LINKS ====================

    @PluginMethod
    public void setSystemBarsTheme(PluginCall call) {
        String theme = call.getString("theme", "dark");
        String backgroundHex = call.getString("backgroundHex", null);
        boolean isLight = "light".equals(theme);
        String validBgHex = (backgroundHex != null && backgroundHex.matches("^#[0-9a-fA-F]{6}$"))
            ? backgroundHex
            : null;
        try {
            SharedPreferences.Editor editor = getNativePrefs().edit()
                .putString(PREF_UI_THEME, isLight ? "light" : "dark");
            if (validBgHex != null) {
                editor.putString(PREF_UI_BG_HEX, validBgHex);
            } else {
                editor.remove(PREF_UI_BG_HEX);
            }
            editor.apply();
        } catch (Exception ignored) {}
        Activity activity = getActivity();
        if (activity != null) {
            mainHandler.post(() -> {
                try {
                    Window window = activity.getWindow();
                    int bgColor = Color.parseColor(isLight ? "#f4f5f7" : "#0e0e11");
                    if (validBgHex != null) {
                        try {
                            bgColor = Color.parseColor(validBgHex);
                        } catch (Exception ignoredHex) {}
                    }
                    View content = activity.findViewById(android.R.id.content);
                    if (content != null) {
                        content.setBackgroundColor(bgColor);
                    }
                    window.getDecorView().setBackgroundColor(bgColor);
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        getBridge().getWebView().setBackgroundColor(bgColor);
                    }
                    if (Build.VERSION.SDK_INT < 35) {
                        //noinspection deprecation
                        window.setStatusBarColor(bgColor);
                        //noinspection deprecation
                        window.setNavigationBarColor(bgColor);
                    }
                    WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(window, window.getDecorView());
                    controller.setAppearanceLightStatusBars(isLight);
                    controller.setAppearanceLightNavigationBars(isLight);
                } catch (Exception ignored) {}
            });
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://")
            || url.startsWith("mailto:") || url.startsWith("tel:"))) {
            call.reject("Недопустимая ссылка");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось открыть ссылку");
        }
    }

    // ==================== OAUTH DEEP LINK CALLBACK ====================

    public static void enqueueAuthCallbackUrl(String url) {
        if (url == null || url.trim().isEmpty()) return;
        KapsulaNativePlugin inst = activeInstance;
        if (inst != null && inst.hasListeners("authCallbackUrl")) {
            JSObject payload = new JSObject();
            payload.put("url", url);
            inst.mainHandler.post(() -> inst.notifyListeners("authCallbackUrl", payload));
        } else {
            PENDING_AUTH_CALLBACK_URL.set(url);
            if (inst != null) {
                JSObject payload = new JSObject();
                payload.put("url", url);
                inst.mainHandler.post(() -> inst.notifyListeners("authCallbackUrl", payload, true));
            }
        }
    }

    @PluginMethod
    public void consumePendingAuthCallback(PluginCall call) {
        String url = PENDING_AUTH_CALLBACK_URL.getAndSet(null);
        JSObject ret = new JSObject();
        ret.put("url", url != null ? url : JSObject.NULL);
        call.resolve(ret);
    }

    // ==================== APP VERSION & IN-APP APK UPDATER ====================

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            PackageInfo info = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? pm.getPackageInfo(ctx.getPackageName(), PackageManager.PackageInfoFlags.of(0))
                : getPackageInfoLegacy(pm, ctx.getPackageName());
            String versionName = info.versionName != null && !info.versionName.trim().isEmpty()
                ? info.versionName.trim()
                : "1.0.0";
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : getVersionCodeLegacy(info);
            ret.put("versionName", versionName);
            ret.put("versionCode", versionCode);
        } catch (Exception e) {
            ret.put("versionName", "1.0.0");
            ret.put("versionCode", 1);
        }
        ret.put("distChannel", BuildConfig.DIST_CHANNEL);
        ret.put("allowSelfUpdate", BuildConfig.ALLOW_SELF_UPDATE);
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getPackageInfoLegacy(PackageManager pm, String pkg) throws PackageManager.NameNotFoundException {
        return pm.getPackageInfo(pkg, 0);
    }

    @SuppressWarnings("deprecation")
    private static long getVersionCodeLegacy(PackageInfo info) {
        return info.versionCode;
    }

    private static boolean isAllowedApkUrl(String url) {
        if (url == null) return false;
        String clean = url.trim();
        return clean.startsWith("https://github.com/Suther1and/kapsula/")
            || clean.startsWith("https://objects.githubusercontent.com/")
            || clean.startsWith("https://release-assets.githubusercontent.com/");
    }

    private static String bytesToHexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static String computeFileSha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[32768];
        try (InputStream in = new FileInputStream(file)) {
            int n;
            while ((n = in.read(buf)) != -1) {
                digest.update(buf, 0, n);
            }
        }
        return bytesToHexLower(digest.digest());
    }

    private void emitApkProgress(int percent) {
        int clamped = Math.max(0, Math.min(100, percent));
        JSObject payload = new JSObject();
        payload.put("percent", clamped);
        mainHandler.post(() -> notifyListeners("apkDownloadProgress", payload));
    }

    @SuppressWarnings("deprecation")
    private static Signature[] getSignaturesLegacy(PackageInfo info) {
        return info != null ? info.signatures : null;
    }

    private static Set<String> extractSigningCertSha256Set(PackageInfo info) throws Exception {
        Set<String> out = new HashSet<>();
        if (info == null) return out;
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo != null) {
                sigs = signingInfo.hasMultipleSigners()
                    ? signingInfo.getApkContentsSigners()
                    : signingInfo.getSigningCertificateHistory();
            }
        }
        if (sigs == null || sigs.length == 0) {
            sigs = getSignaturesLegacy(info);
        }
        if (sigs != null) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (Signature sig : sigs) {
                if (sig == null) continue;
                byte[] digest = md.digest(sig.toByteArray());
                out.add(bytesToHexLower(digest));
                md.reset();
            }
        }
        return out;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getPackageArchiveInfoLegacy(PackageManager pm, String archivePath, int flags) {
        return pm.getPackageArchiveInfo(archivePath, flags);
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getInstalledSignaturesInfoLegacy(PackageManager pm, String pkg)
        throws PackageManager.NameNotFoundException {
        return pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
    }

    private static boolean verifyApkSignatureMatchesCurrentApp(Context ctx, File apkFile) {
        try {
            PackageManager pm = ctx.getPackageManager();
            String pkgName = ctx.getPackageName();
            PackageInfo installedInfo;
            PackageInfo archiveInfo;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                PackageManager.PackageInfoFlags flags =
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES);
                installedInfo = pm.getPackageInfo(pkgName, flags);
                archiveInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                installedInfo = pm.getPackageInfo(pkgName, PackageManager.GET_SIGNING_CERTIFICATES);
                archiveInfo = getPackageArchiveInfoLegacy(
                    pm,
                    apkFile.getAbsolutePath(),
                    PackageManager.GET_SIGNING_CERTIFICATES
                );
            } else {
                installedInfo = getInstalledSignaturesInfoLegacy(pm, pkgName);
                archiveInfo = getPackageArchiveInfoLegacy(
                    pm,
                    apkFile.getAbsolutePath(),
                    PackageManager.GET_SIGNATURES
                );
            }

            if (installedInfo == null || archiveInfo == null) {
                return false;
            }
            if (!pkgName.equals(archiveInfo.packageName)) {
                return false;
            }

            long installedCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? installedInfo.getLongVersionCode()
                : getVersionCodeLegacy(installedInfo);
            long archiveCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archiveInfo.getLongVersionCode()
                : getVersionCodeLegacy(archiveInfo);
            if (archiveCode < installedCode) {
                return false;
            }

            Set<String> installedCerts = extractSigningCertSha256Set(installedInfo);
            Set<String> archiveCerts = extractSigningCertSha256Set(archiveInfo);
            if (installedCerts.isEmpty() || archiveCerts.isEmpty()) {
                return false;
            }
            return !Collections.disjoint(installedCerts, archiveCerts);
        } catch (Exception ignored) {
            return false;
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        if (!BuildConfig.ALLOW_SELF_UPDATE) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Обновления приложения доступны через Google Play");
            call.resolve(ret);
            return;
        }

        final String url = call.getString("url", "");
        final String expectedShaRaw = call.getString("sha256", null);
        final String expectedSha256 = expectedShaRaw != null ? expectedShaRaw.trim().toLowerCase(Locale.US) : "";

        if (!isAllowedApkUrl(url)) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Недоверенный адрес файла обновления");
            call.resolve(ret);
            return;
        }
        if (expectedSha256.isEmpty() || !expectedSha256.matches("^[0-9a-f]{64}$")) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Отсутствует контрольная сумма обновления — установка отменена");
            call.resolve(ret);
            return;
        }
        if (!APK_DOWNLOAD_IN_PROGRESS.compareAndSet(false, true)) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("error", "Загрузка обновления уже выполняется");
            call.resolve(ret);
            return;
        }

        final Context appCtx = getContext().getApplicationContext();

        UPDATE_EXECUTOR.execute(() -> {
            File updatesDir = new File(appCtx.getCacheDir(), "updates");
            File targetApk = new File(updatesDir, "kapsula-update.apk");
            File tempApk = new File(updatesDir, "kapsula-update.apk.part");
            try {
                if (!updatesDir.exists() && !updatesDir.mkdirs()) {
                    throw new Exception("Не удалось создать папку для загрузки обновления");
                }

                // Reuse already downloaded APK only if both SHA-256 and signing certificate match
                boolean needDownload = true;
                if (targetApk.exists() && targetApk.length() > 0) {
                    try {
                        if (expectedSha256.equalsIgnoreCase(computeFileSha256(targetApk))
                            && verifyApkSignatureMatchesCurrentApp(appCtx, targetApk)) {
                            needDownload = false;
                            emitApkProgress(100);
                        } else {
                            //noinspection ResultOfMethodCallIgnored
                            targetApk.delete();
                        }
                    } catch (Exception ignoredCache) {
                        needDownload = true;
                    }
                }

                if (needDownload) {
                    emitApkProgress(1);
                    String currentUrl = url.trim();
                    HttpURLConnection conn = null;
                    int redirects = 0;
                    try {
                        while (true) {
                            if (!isAllowedApkUrl(currentUrl)) {
                                throw new Exception("Обновление перенаправлено на недоверенный адрес");
                            }
                            conn = (HttpURLConnection) new URL(currentUrl).openConnection();
                            conn.setInstanceFollowRedirects(false);
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(30000);
                            conn.setRequestProperty("User-Agent", "Kapsula-Android-Updater");
                            int code = conn.getResponseCode();
                            if (code == HttpURLConnection.HTTP_MOVED_PERM
                                || code == HttpURLConnection.HTTP_MOVED_TEMP
                                || code == HttpURLConnection.HTTP_SEE_OTHER
                                || code == 307
                                || code == 308) {
                                String nextLoc = conn.getHeaderField("Location");
                                conn.disconnect();
                                conn = null;
                                if (nextLoc == null || nextLoc.trim().isEmpty() || ++redirects > 5) {
                                    throw new Exception("Слишком много перенаправлений при загрузке обновления");
                                }
                                currentUrl = nextLoc.trim();
                                continue;
                            }
                            if (code < 200 || code >= 300) {
                                throw new Exception("Не удалось скачать обновление (код ответа " + code + ")");
                            }
                            break;
                        }

                        long totalBytes = conn.getContentLengthLong();
                        MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        if (tempApk.exists()) {
                            //noinspection ResultOfMethodCallIgnored
                            tempApk.delete();
                        }

                        long downloaded = 0L;
                        int lastPercent = 1;
                        byte[] buf = new byte[32768];
                        try (InputStream in = conn.getInputStream();
                             FileOutputStream fos = new FileOutputStream(tempApk)) {
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                downloaded += n;
                                if (downloaded > MAX_APK_DOWNLOAD_BYTES) {
                                    throw new Exception("Файл обновления превышает допустимый размер");
                                }
                                fos.write(buf, 0, n);
                                digest.update(buf, 0, n);
                                if (totalBytes > 0) {
                                    int pct = (int) Math.min(99L, Math.max(1L, (downloaded * 100L) / totalBytes));
                                    if (pct >= lastPercent + 2) {
                                        lastPercent = pct;
                                        emitApkProgress(pct);
                                    }
                                }
                            }
                            fos.flush();
                        }

                        if (downloaded == 0L) {
                            throw new Exception("Файл обновления оказался пустым");
                        }

                        String actualSha256 = bytesToHexLower(digest.digest());
                        if (!expectedSha256.equalsIgnoreCase(actualSha256)) {
                            //noinspection ResultOfMethodCallIgnored
                            tempApk.delete();
                            throw new Exception("Проверка целостности файла обновления не пройдена — установка отменена");
                        }

                        if (!verifyApkSignatureMatchesCurrentApp(appCtx, tempApk)) {
                            //noinspection ResultOfMethodCallIgnored
                            tempApk.delete();
                            throw new Exception("Подпись файла обновления не совпадает с установленным приложением — установка отменена");
                        }

                        if (targetApk.exists()) {
                            //noinspection ResultOfMethodCallIgnored
                            targetApk.delete();
                        }
                        if (!tempApk.renameTo(targetApk)) {
                            throw new Exception("Не удалось сохранить загруженный файл обновления");
                        }
                        emitApkProgress(100);
                    } finally {
                        if (conn != null) {
                            conn.disconnect();
                        }
                        if (tempApk.exists()) {
                            //noinspection ResultOfMethodCallIgnored
                            tempApk.delete();
                        }
                    }
                }

                if (!verifyApkSignatureMatchesCurrentApp(appCtx, targetApk)) {
                    //noinspection ResultOfMethodCallIgnored
                    targetApk.delete();
                    throw new Exception("Подпись файла обновления не совпадает с установленным приложением — установка отменена");
                }

                // Android 8+ requires explicit "Install unknown apps" permission for in-app updates
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !appCtx.getPackageManager().canRequestPackageInstalls()) {
                    mainHandler.post(() -> {
                        try {
                            Toast.makeText(
                                appCtx,
                                "Разреши установку обновлений для Kapsula, затем вернись и нажми «Обновить»",
                                Toast.LENGTH_LONG
                            ).show();
                            Intent settingsIntent = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + appCtx.getPackageName())
                            );
                            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            appCtx.startActivity(settingsIntent);
                        } catch (Exception ignoredPerm) {}
                    });
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("needsPermission", true);
                    ret.put("error", "Разреши установку приложений для Kapsula в настройках Android и нажми «Обновить» ещё раз");
                    call.resolve(ret);
                    return;
                }

                Uri apkUri = FileProvider.getUriForFile(
                    appCtx,
                    appCtx.getPackageName() + ".fileprovider",
                    targetApk
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                appCtx.startActivity(installIntent);

                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("error", e.getMessage() != null && !e.getMessage().isEmpty()
                    ? e.getMessage()
                    : "Не удалось загрузить и установить обновление");
                call.resolve(ret);
            } finally {
                APK_DOWNLOAD_IN_PROGRESS.set(false);
            }
        });
    }

    // ==================== SSRF-SAFE EXTERNAL TEXT FETCH FOR LINK UNFURLING ====================

    private static boolean isLiteralIpHostname(String host) {
        if (host == null || host.isEmpty()) return false;
        String bare = host;
        if (bare.startsWith("[") && bare.endsWith("]")) {
            bare = bare.substring(1, bare.length() - 1);
        }
        if (bare.contains(":")) return true;
        if (bare.matches("^([0-9]+|0[xX][0-9a-fA-F]+)(\\.([0-9]+|0[xX][0-9a-fA-F]+))*$")) return true;
        return false;
    }

    private static boolean isBlockedIpv4Bytes(int a, int b, int c, int d, boolean allowTunFakeIp) {
        if (a == 0) return true; // 0.0.0.0/8
        if (a == 10) return true; // 10.0.0.0/8
        if (a == 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
        if (a == 127) return true; // 127.0.0.0/8 loopback
        if (a == 169 && b == 254) return true; // 169.254.0.0/16 link-local & cloud metadata
        if (a == 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a == 192 && b == 0 && c == 0) return true; // 192.0.0.0/24
        if (a == 192 && b == 0 && c == 2) return true; // 192.0.2.0/24
        if (a == 192 && b == 168) return true; // 192.168.0.0/16
        if (a == 198 && (b == 18 || b == 19)) return !allowTunFakeIp; // 198.18.0.0/15 TUN Fake-IP
        if (a == 198 && b == 51 && c == 100) return true; // 198.51.100.0/24
        if (a == 203 && b == 0 && c == 113) return true; // 203.0.113.0/24
        if (a >= 224) return true; // multicast & reserved
        return false;
    }

    private static boolean isUnsafeInetAddress(InetAddress addr, boolean allowTunFakeIp) {
        if (addr == null) return true;
        if (addr.isAnyLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress()
            || addr.isSiteLocalAddress() || addr.isMulticastAddress()) {
            return true;
        }
        byte[] raw = addr.getAddress();
        if (addr instanceof Inet4Address && raw.length == 4) {
            return isBlockedIpv4Bytes(raw[0] & 0xFF, raw[1] & 0xFF, raw[2] & 0xFF, raw[3] & 0xFF, allowTunFakeIp);
        }
        if (addr instanceof Inet6Address && raw.length == 16) {
            int b0 = raw[0] & 0xFF;
            int b1 = raw[1] & 0xFF;
            if ((b0 & 0xFE) == 0xFC) return true; // fc00::/7 ULA
            if (b0 == 0xFE && (b1 & 0xC0) == 0x80) return true; // fe80::/10 link-local
            if (b0 == 0xFF) return true; // ff00::/8 multicast
            // Local-use NAT64 prefix 64:ff9b:1::/48 (RFC 8215)
            if (b0 == 0x00 && b1 == 0x64 && (raw[2] & 0xFF) == 0xFF && (raw[3] & 0xFF) == 0x9B
                && (raw[4] & 0xFF) == 0x00 && (raw[5] & 0xFF) == 0x01) {
                return true;
            }
            // Well-known NAT64 prefix 64:ff9b::/96 (RFC 6052)
            boolean isNat64WellKnown = b0 == 0x00 && b1 == 0x64
                && (raw[2] & 0xFF) == 0xFF && (raw[3] & 0xFF) == 0x9B;
            if (isNat64WellKnown) {
                for (int i = 4; i < 12; i++) {
                    if (raw[i] != 0) {
                        isNat64WellKnown = false;
                        break;
                    }
                }
            }
            if (isNat64WellKnown) {
                return isBlockedIpv4Bytes(
                    raw[12] & 0xFF,
                    raw[13] & 0xFF,
                    raw[14] & 0xFF,
                    raw[15] & 0xFF,
                    allowTunFakeIp
                );
            }
            // Check IPv4-mapped IPv6 (::ffff:a.b.c.d) and IPv4-compatible IPv6 (::a.b.c.d)
            boolean firstTenZero = true;
            for (int i = 0; i < 10; i++) {
                if (raw[i] != 0) {
                    firstTenZero = false;
                    break;
                }
            }
            if (firstTenZero) {
                int b10 = raw[10] & 0xFF;
                int b11 = raw[11] & 0xFF;
                if ((b10 == 0xFF && b11 == 0xFF) || (b10 == 0x00 && b11 == 0x00)) {
                    return isBlockedIpv4Bytes(
                        raw[12] & 0xFF,
                        raw[13] & 0xFF,
                        raw[14] & 0xFF,
                        raw[15] & 0xFF,
                        allowTunFakeIp
                    );
                }
            }
            return false;
        }
        return true;
    }

    private static boolean isSafeExternalTargetUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = new URI(rawUrl.trim());
            String scheme = uri.getScheme();
            if (scheme == null || (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))) {
                return false;
            }
            String host = uri.getHost();
            if (host == null || host.trim().isEmpty()) return false;
            String lower = host.trim().toLowerCase(Locale.ROOT);
            while (lower.endsWith(".")) {
                lower = lower.substring(0, lower.length() - 1);
            }
            if (lower.isEmpty()
                || "localhost".equals(lower)
                || lower.endsWith(".localhost")
                || lower.endsWith(".local")
                || lower.endsWith(".internal")
                || lower.endsWith(".home.arpa")
                || lower.endsWith(".lan")) {
                return false;
            }
            boolean isLiteral = isLiteralIpHostname(lower);
            if (!isLiteral && !lower.contains(".")) {
                return false;
            }
            String bareHost = lower.startsWith("[") && lower.endsWith("]")
                ? lower.substring(1, lower.length() - 1)
                : lower;
            InetAddress[] resolved = InetAddress.getAllByName(bareHost);
            if (resolved == null || resolved.length == 0) {
                return false;
            }
            // Allow RFC 2544 198.18.0.0/15 ONLY for DNS resolution of validated public non-IP domains (TUN Fake-IP)
            boolean allowTunFakeIp = !isLiteral;
            for (InetAddress addr : resolved) {
                if (isUnsafeInetAddress(addr, allowTunFakeIp)) {
                    return false;
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] readTruncatedBytes(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int remaining = maxBytes;
        int n;
        while (remaining > 0 && (n = in.read(buf, 0, Math.min(buf.length, remaining))) != -1) {
            out.write(buf, 0, n);
            remaining -= n;
        }
        return out.toByteArray();
    }

    @PluginMethod
    public void fetchExternalText(PluginCall call) {
        String rawUrl = call.getString("url", "");
        String accept = call.getString("accept", "text/html,application/json;q=0.9,*/*;q=0.8");
        String userAgent = call.getString(
            "userAgent",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
        );
        int requestedTimeout = call.getInt("timeoutMs", 4500);
        final int timeoutMs = Math.max(1000, Math.min(8000, requestedTimeout));

        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("status", 0);
            ret.put("finalUrl", "");
            ret.put("contentType", "");
            ret.put("body", "");
            call.resolve(ret);
            return;
        }

        final String startUrl = rawUrl.trim();
        final String reqAccept = accept != null && !accept.trim().isEmpty()
            ? accept.trim()
            : "text/html,application/json;q=0.9,*/*;q=0.8";
        final String reqUa = userAgent != null && !userAgent.trim().isEmpty()
            ? userAgent.trim()
            : "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

        LINK_FETCH_EXECUTOR.execute(() -> {
            String currentUrl = startUrl;
            HttpURLConnection conn = null;
            try {
                for (int hop = 0; hop <= MAX_EXTERNAL_REDIRECTS; hop++) {
                    if (!isSafeExternalTargetUrl(currentUrl)) {
                        JSObject blocked = new JSObject();
                        blocked.put("ok", false);
                        blocked.put("status", 0);
                        blocked.put("finalUrl", currentUrl);
                        blocked.put("contentType", "");
                        blocked.put("body", "");
                        blocked.put("error", "blocked_url");
                        call.resolve(blocked);
                        return;
                    }

                    conn = (HttpURLConnection) new URL(currentUrl).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(timeoutMs);
                    conn.setReadTimeout(timeoutMs);
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("User-Agent", reqUa);
                    conn.setRequestProperty("Accept", reqAccept);
                    conn.setRequestProperty("Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7");

                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.trim().isEmpty() || hop >= MAX_EXTERNAL_REDIRECTS) {
                            JSObject fail = new JSObject();
                            fail.put("ok", false);
                            fail.put("status", status);
                            fail.put("finalUrl", currentUrl);
                            fail.put("contentType", "");
                            fail.put("body", "");
                            call.resolve(fail);
                            return;
                        }
                        currentUrl = new URI(currentUrl).resolve(loc.trim()).toString();
                        continue;
                    }

                    String contentType = conn.getContentType() != null ? conn.getContentType() : "";
                    String body = "";
                    InputStream stream = status >= 200 && status < 400
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                    if (stream != null) {
                        try (InputStream in = stream) {
                            byte[] bytes = readTruncatedBytes(in, MAX_EXTERNAL_TEXT_BYTES);
                            body = new String(bytes, StandardCharsets.UTF_8);
                        }
                    }

                    JSObject ret = new JSObject();
                    ret.put("ok", status >= 200 && status < 300);
                    ret.put("status", status);
                    ret.put("finalUrl", currentUrl);
                    ret.put("contentType", contentType);
                    ret.put("body", body);
                    call.resolve(ret);
                    return;
                }
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("status", 0);
                ret.put("finalUrl", currentUrl);
                ret.put("contentType", "");
                ret.put("body", "");
                call.resolve(ret);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }
}
