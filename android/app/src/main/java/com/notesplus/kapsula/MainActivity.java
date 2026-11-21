package com.notesplus.kapsula;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KapsulaNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Single authoritative Android 15/16 (targetSdk 36) edge-to-edge WindowInsets handler.
        // Capacitor SystemBars insetsHandling is disabled in capacitor.config.ts so IME insets
        // are NEVER applied twice (fixing the 40% black void bug on Samsung One UI / WebView 140+).
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        applyPersistedThemeColors(window);

        View decorView = window.getDecorView();
        decorView.setPadding(0, 0, 0, 0);
        // Re-apply after Capacitor's SystemBars plugin posts its startup setStyle() runnable
        decorView.post(() -> applyPersistedThemeColors(getWindow()));

        View contentView = findViewById(android.R.id.content);
        if (contentView != null) {
            ViewCompat.setOnApplyWindowInsetsListener(contentView, (v, windowInsets) -> {
                Insets sysBars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean imeVisibleRaw = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                int imeBottom = imeVisibleRaw ? ime.bottom : 0;

                // Treat IME as docked keyboard only when it actually occupies bottom space beyond nav bar
                // (avoids shrinking layout or hiding nav for Samsung Floating Keyboard where ime.bottom == 0).
                boolean dockedImeVisible = imeVisibleRaw && imeBottom > sysBars.bottom + 24;
                int bottomPad = Math.max(sysBars.bottom, imeBottom);

                v.setPadding(sysBars.left, sysBars.top, sysBars.right, bottomPad);
                KapsulaNativePlugin.updateSystemBarInsets(sysBars.left, sysBars.top);

                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;
                int imeHeightDp = dockedImeVisible
                    ? Math.round(Math.max(0, imeBottom - sysBars.bottom) / density)
                    : 0;
                KapsulaNativePlugin.notifyKeyboardState(dockedImeVisible, imeHeightDp);

                // Explicitly zero out handled systemBars/cutout/IME insets instead of returning CONSUMED:
                // 1) Avoids Chromium issue #461332423 (broken recalculation on fold/keyboard changes).
                // 2) Prevents WebView >= 139 from double-shrinking visualViewport and panning fixed headers off-screen.
                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.NONE
                    )
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .setVisible(WindowInsetsCompat.Type.ime(), false)
                    .build();
            });
            ViewCompat.requestApplyInsets(contentView);
        }

        // Intercept Android system Back gesture/button so sheets/editors close step-by-step instead of exiting
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!KapsulaNativePlugin.notifyBackPressed()) {
                    moveTaskToBack(true);
                }
            }
        });

        handleIncomingIntent(getIntent());
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Post after Capacitor SystemBars.handleOnConfigurationChanged so persisted Kapsula theme wins on every Fold <-> Unfold
        Window window = getWindow();
        if (window != null) {
            applyPersistedThemeColors(window);
            window.getDecorView().post(() -> applyPersistedThemeColors(getWindow()));
        }
        View contentView = findViewById(android.R.id.content);
        if (contentView != null) {
            ViewCompat.requestApplyInsets(contentView);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        Window window = getWindow();
        if (window != null) {
            applyPersistedThemeColors(window);
            window.getDecorView().post(() -> applyPersistedThemeColors(getWindow()));
        }
        View contentView = findViewById(android.R.id.content);
        if (contentView != null) {
            ViewCompat.requestApplyInsets(contentView);
        }
        KapsulaNativePlugin.notifyAppLifecycle("resumed");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        KapsulaNativePlugin.notifyWindowFocusChanged(hasFocus);
    }

    @Override
    public void onPause() {
        KapsulaNativePlugin.notifyAppLifecycle("paused");
        super.onPause();
    }

    private void applyPersistedThemeColors(Window window) {
        if (window == null) return;
        try {
            SharedPreferences prefs = getSharedPreferences("kapsula_native_prefs", Context.MODE_PRIVATE);
            String theme = prefs.getString("ui_theme", "dark");
            String savedBgHex = prefs.getString("ui_bg_hex", null);
            boolean isLight = "light".equals(theme);
            int bgColor = Color.parseColor(isLight ? "#f4f5f7" : "#0e0e11");
            if (savedBgHex != null && savedBgHex.matches("^#[0-9a-fA-F]{6}$")) {
                try {
                    bgColor = Color.parseColor(savedBgHex);
                } catch (Exception ignoredHex) {}
            }
            View content = findViewById(android.R.id.content);
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
        } catch (Exception ignored) {
            // fallback to dark default
        }
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        // Never re-process a historic Share / OAuth intent when user reopens app from Android Recents
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            return;
        }
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            android.net.Uri data = intent.getData();
            if (data != null
                && "com.notesplus.kapsula".equalsIgnoreCase(data.getScheme())
                && "auth-callback".equalsIgnoreCase(data.getHost())) {
                KapsulaNativePlugin.enqueueAuthCallbackUrl(data.toString());
                intent.setData(null);
                intent.setAction(null);
                setIntent(intent);
                return;
            }
        }
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            KapsulaNativePlugin.enqueueShareIntent(this, intent);
            // Clear action so configuration/lifecycle restarts never replay the same Share
            intent.setAction(null);
            setIntent(intent);
        }
    }
}
