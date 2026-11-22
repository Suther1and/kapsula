import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import type { SyncStatus } from '@shared/sync-contract';
import {
  extractTasksFromMobileItem,
  fetchMobileCloudAiQuota,
  formatUsdRu,
  MOBILE_CLOUD_AI_QUOTA_EXCEEDED_MSG,
  polishMobileNoteText,
  resolveMobileAiTarget,
  transcribeMobileVoiceItem,
  type MobileAiCloudAuth,
} from '@mobile/lib/mobile-ai';
import {
  buildMobileDiagnosticsReport,
  sanitizeDiagnosticsError,
} from '@mobile/lib/mobile-diagnostics';
import {
  checkForMobileUpdate,
  compareSemver,
  isAllowedAndroidApkUrl,
  isNewerAndroidRelease,
} from '@mobile/lib/mobile-updater';
import { mobileBridge } from '@mobile/native/bridge';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';

describe('Mobile Cloud AI Proxy, OAuth, Updater & Redacted Diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers personal API key (Priority 1) over built-in Cloud AI proxy (Priority 2)', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const signedInCloudAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => 'jwt-session-token-abc',
      getSupabaseBaseUrl: () => 'https://gxkvuwipzbqocbxgyqty.supabase.co',
      getSupabasePublishableKey: async () => 'sb_publishable_test_key',
    };

    // Without personal key -> resolves to Priority 2 cloud_proxy
    const proxyTarget = await resolveMobileAiTarget(store, signedInCloudAuth);
    expect(proxyTarget?.mode).toBe('cloud_proxy');
    if (proxyTarget?.mode === 'cloud_proxy') {
      expect(proxyTarget.proxyUrl).toBe(
        'https://gxkvuwipzbqocbxgyqty.supabase.co/functions/v1/ai-proxy'
      );
      expect(proxyTarget.accessToken).toBe('jwt-session-token-abc');
      expect(proxyTarget.publishableKey).toBe('sb_publishable_test_key');
    }

    // With personal Gemini key -> switches to Priority 1 personal direct call
    const personalKey = ['AIza', 'SyPersonalDirectKey1234567890123456'].join('');
    await store.setMobileAiConfig({
      provider: 'google_ai_studio',
      googleKey: personalKey,
    });
    const personalTarget = await resolveMobileAiTarget(store, signedInCloudAuth);
    expect(personalTarget?.mode).toBe('personal');
    if (personalTarget?.mode === 'personal') {
      expect(personalTarget.provider).toBe('google_ai_studio');
      expect(personalTarget.apiKey).toBe(personalKey);
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"tasks":["Выкатить релиз"]}' }] } }],
      }),
    } as unknown as Response);

    const note = await store.createItem({
      dna: 'note',
      title: 'Релиз',
      body: 'Нужно выкатить релиз сегодня вечером',
    });
    const res = await extractTasksFromMobileItem(store, note, signedInCloudAuth);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('generativelanguage.googleapis.com');
  });

  it('routes through ai-proxy when no personal key is set, enforces secret redaction, and maps HTTP 429 cleanly', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const cloudAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => 'jwt-live-user-token',
      getSupabaseBaseUrl: () => 'https://gxkvuwipzbqocbxgyqty.supabase.co',
      getSupabasePublishableKey: async () => 'sb_publishable_demo',
    };

    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const bodyStr = String(init?.body ?? '');
      calls.push({ url: String(url), headers, body: bodyStr });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'Обновлённый текст с ключом [REDACTED_SECRET_0] и паролем: [REDACTED_SECRET_1]',
                    },
                  ],
                },
              },
            ],
          },
          quota: { spentUsd: 0.04, limitUsd: 1, remainingUsd: 0.96 },
        }),
      } as unknown as Response;
    });

    // Secret vault items must still be strictly blocked before proxy calls!
    const secretItem = await store.upsertSecret({
      kind: 'password',
      title: 'Bank',
      service: 'bank.example',
      login: 'user@example.com',
      secretValue: 'SuperSecret999!',
    });
    const blocked = await polishMobileNoteText(store, secretItem, cloudAuth);
    expect(blocked.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Regular note with inline secret -> routed to ai-proxy with redacted payload & restored locally
    const fakeInlineKey = ['sk-proj-', 'AbCdEfGhIjKlMnOpQrStUvWxYz9999'].join('');
    const note = await store.createItem({
      dna: 'note',
      title: 'Сервер',
      body: `Подключить ключ ${fakeInlineKey} и пароль: TopSecretPassword7!`,
    });
    const polished = await polishMobileNoteText(store, note, cloudAuth);
    expect(polished.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gxkvuwipzbqocbxgyqty.supabase.co/functions/v1/ai-proxy');
    expect(calls[0]!.headers.Authorization).toBe('Bearer jwt-live-user-token');
    expect(calls[0]!.headers.apikey).toBe('sb_publishable_demo');
    expect(calls[0]!.body).toContain('"action":"gemini"');
    expect(calls[0]!.body).not.toContain(fakeInlineKey);
    expect(calls[0]!.body).not.toContain('TopSecretPassword7!');
    expect(polished.item?.body).toContain(fakeInlineKey);
    expect(polished.item?.body).toContain('TopSecretPassword7!');

    // HTTP 429 quota exceeded -> friendly Russian message
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error: 'Месячный лимит общего ИИ ($1,00) исчерпан. Можно добавить свой API-ключ в Настройках или дождаться 1-го числа.',
      }),
    } as unknown as Response);

    const quotaHit = await extractTasksFromMobileItem(store, note, cloudAuth);
    expect(quotaHit.ok).toBe(false);
    expect(quotaHit.error).toBe(MOBILE_CLOUD_AI_QUOTA_EXCEEDED_MSG);

    // Voice transcription also blocks secrets & routes via ai-proxy
    const voiceBlocked = await transcribeMobileVoiceItem(store, secretItem, undefined, cloudAuth);
    expect(voiceBlocked.ok).toBe(false);
  });

  it('fetches Cloud AI quota only when access token exists and formats USD cleanly in Russian', async () => {
    expect(formatUsdRu(0)).toBe('$0,00');
    expect(formatUsdRu(0.37)).toBe('$0,37');
    expect(formatUsdRu(1)).toBe('$1,00');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Signed out -> returns null without firing any network request
    const signedOutAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => null,
      getSupabaseBaseUrl: () => 'https://gxkvuwipzbqocbxgyqty.supabase.co',
    };
    expect(await fetchMobileCloudAiQuota(signedOutAuth)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Signed in -> calls GET /functions/v1/ai-proxy
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        spentUsd: 0.42,
        limitUsd: 1,
        remainingUsd: 0.58,
        requestCount: 19,
        blocked: false,
        globalExhausted: false,
        providers: { google: true, openrouter: true },
        month: '2026-11',
      }),
    } as unknown as Response);

    const signedInAuth: MobileAiCloudAuth = {
      getActiveAccessToken: async () => 'jwt-quota-check',
      getSupabaseBaseUrl: () => 'https://gxkvuwipzbqocbxgyqty.supabase.co',
      getSupabasePublishableKey: async () => 'sb_pub_key',
    };
    const quota = await fetchMobileCloudAiQuota(signedInAuth);
    expect(quota?.ok).toBe(true);
    expect(quota?.spentUsd).toBe(0.42);
    expect(quota?.limitUsd).toBe(1);
    expect(quota?.remainingUsd).toBe(0.58);
    expect(quota?.requestCount).toBe(19);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://gxkvuwipzbqocbxgyqty.supabase.co/functions/v1/ai-proxy'
    );
  });

  it('completes Google OAuth PKCE flow and exposes access token on MobileSyncEngine', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    let exchangedCode: string | null = null;
    let oauthOpts: unknown = null;
    let currentSession: {
      access_token: string;
      expires_at: number;
      user: { id: string; email: string };
    } | null = null;

    const mockClient = {
      auth: {
        getSession: async () => ({ data: { session: currentSession }, error: null }),
        signInWithOAuth: async (args: unknown) => {
          oauthOpts = args;
          return {
            data: { url: 'https://gxkvuwipzbqocbxgyqty.supabase.co/auth/v1/authorize?provider=google' },
            error: null,
          };
        },
        exchangeCodeForSession: async (code: string) => {
          exchangedCode = code;
          currentSession = {
            access_token: 'pkce-access-token-123',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'u-google-1', email: 'friend@example.com' },
          };
          return { data: { session: currentSession }, error: null };
        },
        signOut: async () => {
          currentSession = null;
          return { error: null };
        },
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const openSpy = vi.spyOn(mobileBridge, 'openExternalUrl').mockResolvedValue();

    const engine = new MobileSyncEngine({
      store,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) => mockClient,
    });
    await engine.init();

    // Before sign-in, token is null
    expect(await engine.getActiveAccessToken()).toBeNull();

    // Start Google sign-in
    const startRes = await engine.signInWithGoogle();
    expect(startRes.ok).toBe(true);
    expect(oauthOpts).toEqual({
      provider: 'google',
      options: {
        redirectTo: 'com.notesplus.kapsula://auth-callback',
        skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' },
      },
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://gxkvuwipzbqocbxgyqty.supabase.co/auth/v1/authorize?provider=google'
    );

    // Cancelled callback returns friendly Russian error
    const cancelRes = await engine.completeOAuthCallback(
      'com.notesplus.kapsula://auth-callback?error=access_denied'
    );
    expect(cancelRes.ok).toBe(false);
    expect(cancelRes.error).toBe('Вход через Google отменён');

    // Successful callback exchanges PKCE code and transitions to needs_passphrase_setup
    const cbRes = await engine.completeOAuthCallback(
      'com.notesplus.kapsula://auth-callback?code=pkce_code_xyz'
    );
    expect(cbRes.ok).toBe(true);
    expect(exchangedCode).toBe('pkce_code_xyz');
    expect(cbRes.needsPassphraseSetup).toBe(true);
    expect(engine.getStatus().email).toBe('friend@example.com');
    expect(await engine.getActiveAccessToken()).toBe('pkce-access-token-123');
    expect(engine.getSupabaseBaseUrl()).toBe('https://gxkvuwipzbqocbxgyqty.supabase.co');

    engine.dispose();
  });

  it('compares semver/versionCode, validates APK URL allowlist, and checks GitHub Releases cleanly', async () => {
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('v1.2.0', '1.1.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);

    expect(
      isNewerAndroidRelease(
        { versionName: '1.0.0', versionCode: 100000000 },
        { versionName: '1.0.0', versionCode: 100000005 }
      )
    ).toBe(true);
    expect(
      isNewerAndroidRelease(
        { versionName: '1.1.0', versionCode: 101000000 },
        { versionName: '1.0.9', versionCode: 100090999 }
      )
    ).toBe(false);

    // Strict allowlist
    expect(
      isAllowedAndroidApkUrl(
        'https://github.com/Suther1and/kapsula/releases/download/v1.1.0/Kapsula-1.1.0-android.apk'
      )
    ).toBe(true);
    expect(
      isAllowedAndroidApkUrl('https://objects.githubusercontent.com/github-production-release/foo.apk')
    ).toBe(true);
    expect(
      isAllowedAndroidApkUrl('https://release-assets.githubusercontent.com/foo/bar.apk')
    ).toBe(true);
    expect(isAllowedAndroidApkUrl('http://github.com/Suther1and/kapsula/foo.apk')).toBe(false);
    expect(isAllowedAndroidApkUrl('https://evil.example.com/Kapsula-release.apk')).toBe(false);
    expect(isAllowedAndroidApkUrl('https://github.com/otheruser/kapsula/foo.apk')).toBe(false);

    // Mock GitHub Releases response with android-latest.json + release APK
    const sha = 'a'.repeat(64);
    const apkDownloadUrl =
      'https://github.com/Suther1and/kapsula/releases/download/v1.1.0/Kapsula-1.1.0-android.apk';
    const manifestUrl =
      'https://github.com/Suther1and/kapsula/releases/download/v1.1.0/android-latest.json';

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v1.1.0',
            body: 'Улучшения синхронизации и входа через Google',
            assets: [
              { name: 'android-latest.json', browser_download_url: manifestUrl },
              { name: 'Kapsula-1.1.0-android.apk', browser_download_url: apkDownloadUrl },
            ],
          }),
        } as unknown as Response;
      }
      if (u === manifestUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            versionName: '1.1.0',
            versionCode: 101000012,
            fileName: 'Kapsula-1.1.0-android.apk',
            sha256: sha,
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;

    const avail = await checkForMobileUpdate({
      currentVersion: '1.0.0',
      currentVersionCode: 100000000,
      fetchImpl: mockFetch,
    });
    expect(avail.status).toBe('update_available');
    expect(avail.latestVersion).toBe('1.1.0');
    expect(avail.latestVersionCode).toBe(101000012);
    expect(avail.apkUrl).toBe(apkDownloadUrl);
    expect(avail.sha256).toBe(sha);

    // Already on latest version -> up_to_date
    const same = await checkForMobileUpdate({
      currentVersion: '1.1.0',
      currentVersionCode: 101000012,
      fetchImpl: mockFetch,
    });
    expect(same.status).toBe('up_to_date');

    // No releases yet (404) -> graceful up_to_date without error
    const noRelease = await checkForMobileUpdate({
      currentVersion: '1.0.0',
      currentVersionCode: 100000000,
      fetchImpl: (async () => ({ ok: false, status: 404 }) as unknown as Response) as typeof fetch,
    });
    expect(noRelease.status).toBe('up_to_date');
  });

  it('produces 100% redacted diagnostics with zero emails, keys, UUIDs, URLs, or note contents', () => {
    const fakeDiagKey = ['sk-proj-', 'AbCdEfGhIjKlMnOpQrStUvWxYz9999'].join('');
    const syncStatus: SyncStatus = {
      state: 'error',
      email: 'private-user@example.com',
      userId: '123e4567-e89b-12d3-a456-426614174000',
      deviceId: '987e6543-e21b-12d3-a456-426614174999',
      deviceName: 'Samsung Galaxy Z Fold6',
      lastSyncAt: 1_760_000_000_000,
      lastReconcileAt: 1_760_000_000_000,
      pendingCount: 3,
      failedDirtyCount: 1,
      syncedRecordsCount: 42,
      realtimeConnected: false,
      hasCustomServer: true,
      supabaseUrl: 'https://secret-custom-host.example.com',
      error:
        `Ошибка для private-user@example.com при запросе https://secret-custom-host.example.com?token=abc с ключом ${fakeDiagKey} и user 123e4567-e89b-12d3-a456-426614174000`,
      devices: [
        {
          deviceId: '987e6543-e21b-12d3-a456-426614174999',
          deviceName: 'Samsung Galaxy Z Fold6',
          platform: 'android',
          appVersion: '1.0.0',
          lastSeenAt: '2026-11-21T10:00:00Z',
          isCurrent: true,
        },
      ],
      hasRecoveryKeyBackupHint: true,
    };

    const report = buildMobileDiagnosticsReport({
      appVersionName: '1.0.0',
      appVersionCode: 100000000,
      platform: 'android',
      viewportWidth: 360,
      viewportHeight: 800,
      foldMode: 'compact',
      foldPosture: 'flat',
      itemCounts: {
        activeTotal: 15,
        notes: 8,
        secrets: 3,
        tasksTotal: 5,
        eventsTotal: 2,
        orbits: 4,
        boards: 1,
        trashed: 2,
        archived: 1,
      },
      syncStatus,
      aiConfig: {
        provider: 'local',
        hasGoogleKey: false,
        hasOpenRouterKey: false,
      },
      nowMs: 1_760_000_500_000,
    });

    expect(report).toContain('appVersion: 1.0.0 (100000000)');
    expect(report).toContain('viewport: 360x800');
    expect(report).toContain('fold: mode=compact, posture=flat');
    expect(report).toContain('pending=3, failed=1');
    expect(report).toContain('aiMode: cloud_proxy');
    // Strictly ZERO PII/secrets/URLs
    expect(report).not.toContain('private-user@example.com');
    expect(report).not.toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(report).not.toContain('987e6543-e21b-12d3-a456-426614174999');
    expect(report).not.toContain('secret-custom-host.example.com');
    expect(report).not.toContain(fakeDiagKey);

    const fakeJwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjMifQ', 'abcdef123456'].join('.');
    expect(sanitizeDiagnosticsError(`Bearer ${fakeJwt}`)).not.toContain('eyJhbGci');
  });

  it('wires AndroidManifest, FileProvider, build.gradle, MainActivity, and KapsulaNativePlugin for OAuth & APK updates', () => {
    const manifest = fs.readFileSync(
      path.resolve('android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    const filePaths = fs.readFileSync(
      path.resolve('android/app/src/main/res/xml/file_paths.xml'),
      'utf8'
    );
    const mainActivity = fs.readFileSync(
      path.resolve('android/app/src/main/java/com/notesplus/kapsula/MainActivity.java'),
      'utf8'
    );
    const plugin = fs.readFileSync(
      path.resolve('android/app/src/main/java/com/notesplus/kapsula/KapsulaNativePlugin.java'),
      'utf8'
    );

    expect(manifest).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    expect(manifest).toContain('android:scheme="com.notesplus.kapsula"');
    expect(manifest).toContain('android:host="auth-callback"');
    expect(filePaths).toContain('name="apk_updates"');
    expect(filePaths).toContain('path="updates/"');
    expect(mainActivity).toContain('enqueueAuthCallbackUrl');
    expect(plugin).toContain('consumePendingAuthCallback');
    expect(plugin).toContain('getAppVersion');
    expect(plugin).toContain('downloadAndInstallApk');
    expect(plugin).toContain('apkDownloadProgress');
    expect(plugin).toContain('ACTION_MANAGE_UNKNOWN_APP_SOURCES');
    expect(plugin).toContain('https://github.com/Suther1and/kapsula/');
    expect(plugin).toContain('https://objects.githubusercontent.com/');
    expect(plugin).toContain('https://release-assets.githubusercontent.com/');
  });
});
