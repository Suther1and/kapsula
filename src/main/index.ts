import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import type {
  AiProvider,
  AppLocale,
  CaptureMode,
  SettingsState,
  ShortcutRegistrationStatus,
} from '@shared/types';
import { computeThemeTokens } from '@shared/color-engine';
import { CLIPPER_PORT_BASE, DEFAULT_MONTHLY_CAP_USD } from '@shared/constants';
import { recoverBankCardExpiry } from '@shared/russian-event-parser';
import {
  DEFAULT_HUD_SHORTCUT,
  formatShortcutCompact,
  getDefaultSnatchShortcut,
  normalizeShortcutAccelerator,
} from '@shared/shortcuts';
import {
  DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SYNC_SUPABASE_URL,
} from '@shared/sync-contract';
import type { CloudAiProxyConfig } from './ai/cloud-proxy';
import { ClipperServer } from './bridges/clipper-server';
import { GoogleCalendarBridge } from './bridges/google-calendar';
import { VaultRepository } from './db/repository';
import { registerIpcHandlers } from './ipc';
import { samplePaletteFromBgra } from './ocr/ocr-service';
import { CapturePipeline, resolveSafeMediaFilePathAsync } from './pipeline/capture-pipeline';
import { readClipboardSnapshot } from './pipeline/clipboard-helper';
import { ReminderScheduler } from './pipeline/reminder-scheduler';
import {
  parseHttpByteRange,
  sanitizeVideoCacheLimitMb,
  VideoCacheManager,
} from './pipeline/video-cache';
import { VaultCrypto } from './security/vault-crypto';
import { SyncEngine } from './sync/sync-engine';
import { AppUpdaterController } from './updater';
import { resolveIconPath, resolveTrayIconPath, WindowManager } from './windows';

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Isolate Chromium/Electron userData when running automated tests or secondary data dirs
if (process.env.KAPSULA_DATA_DIR) {
  const isolatedUserData = path.join(path.resolve(process.env.KAPSULA_DATA_DIR), '_electron-profile');
  fs.mkdirSync(isolatedUserData, { recursive: true, mode: 0o700 });
  app.setPath('userData', isolatedUserData);
}

// Must run before app.whenReady
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kapsula-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

const singleInstanceLock =
  process.env.KAPSULA_ALLOW_MULTI === '1' ? true : app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  let tray: Tray | null = null;
  let windows: WindowManager | null = null;
  let clipper: ClipperServer | null = null;
  let gcalBridge: GoogleCalendarBridge | null = null;
  let repo: VaultRepository | null = null;
  let reminderScheduler: ReminderScheduler | null = null;
  let syncEngine: SyncEngine | null = null;
  let updater: AppUpdaterController | null = null;

  app.on('second-instance', () => {
    windows?.showVault();
  });

  app.on('activate', () => {
    windows?.showVault();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = process.env.KAPSULA_DATA_DIR || path.join(app.getPath('userData'), 'kapsula-data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const mediaDir = path.join(dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    const cachedRealMediaDir = (fs.realpathSync.native ?? fs.realpathSync)(mediaDir);
    const videoCache = new VideoCacheManager(path.join(dataDir, 'video-cache'));

    const baseCsp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' kapsula-media: data: blob:; media-src 'self' kapsula-media: blob: data:; frame-src https://www.youtube-nocookie.com; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    if (!process.env.VITE_DEV_SERVER_URL) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const isLocalResource =
          details.url.startsWith('file://') || details.url.startsWith('kapsula-media:');
        if (!isLocalResource) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        const headers: Record<string, string | string[]> = {
          ...(details.responseHeaders ?? {}),
          'Content-Security-Policy': [`${baseCsp}; frame-ancestors 'none'`],
          'X-Content-Type-Options': ['nosniff'],
        };
        callback({ responseHeaders: headers });
      });
    }

    // Serve local screenshots, audio/video attachments, and cached social clips (with HTTP 206 Range seeking)
    protocol.handle('kapsula-media', async (request) => {
      try {
        const u = new URL(request.url);
        const isCacheHost = u.hostname === 'cache';
        const rawPart =
          isCacheHost || u.hostname === 'local'
            ? u.pathname.replace(/^\/+/, '')
            : u.hostname || u.pathname.replace(/^\/+/, '');
        const resolved = isCacheHost
          ? await videoCache.resolveSafePathAsync(rawPart)
          : await resolveSafeMediaFilePathAsync(mediaDir, rawPart, cachedRealMediaDir);
        if (!resolved.ok) {
          return new Response(
            resolved.status === 400
              ? 'Bad request'
              : resolved.status === 403
                ? 'Forbidden'
                : 'Not found',
            { status: resolved.status }
          );
        }
        const { safeName, filePath: target, stat } = resolved;
        if (isCacheHost) {
          await videoCache.touchAsync(safeName);
        }

        const ext = path.extname(safeName).toLowerCase();
        const mime =
          ext === '.webm' && (safeName.startsWith('vid_') || safeName.startsWith('vc_'))
            ? 'video/webm'
            : MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream';
        const totalSize = stat.size;
        const rangeHeader = request.headers.get('range');
        const isImmutableMediaName = /^(?:[a-f0-9]{16,}|(?:shot|thumb|img|vid|vc|aud|doc|voice|noteimg|media|clip|tg|og|file|att|cam)_)/i.test(
          safeName
        );
        const cacheHeader = isImmutableMediaName
          ? 'private, max-age=31536000, immutable'
          : 'private, max-age=3600';

        const range = parseHttpByteRange(rangeHeader, totalSize);
        if (range.status === 416) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }
        if (range.status === 206) {
          const { start, end } = range;
          const stream = fs.createReadStream(target, { start, end });
          return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'Content-Length': String(end - start + 1),
              'Accept-Ranges': 'bytes',
              'Cache-Control': cacheHeader,
              'X-Content-Type-Options': 'nosniff',
            },
          });
        }

        const stream = fs.createReadStream(target);
        return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(totalSize),
            'Accept-Ranges': 'bytes',
            'Cache-Control': cacheHeader,
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('Bad request', { status: 400 });
      }
    });

    repo = new VaultRepository(path.join(dataDir, 'kapsula-vault.sqlite'));
    repo.setDefaultOsLocale(app.getLocale());
    await videoCache.setLimitMbAsync(sanitizeVideoCacheLimitMb(repo.getSetting('video_cache_limit_mb')));
    const getLocale = (): AppLocale => repo?.getLocale() ?? 'ru';
    let cryptoVault: VaultCrypto;
    try {
      cryptoVault = new VaultCrypto(dataDir, safeStorage, getLocale(), { isPackaged: app.isPackaged });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isEnStartup = getLocale() === 'en';
      dialog.showErrorBox(
        isEnStartup ? 'Kapsula — Keychain access' : 'Kapsula — доступ к Связке ключей',
        process.platform === 'darwin'
          ? isEnStartup
            ? `Could not retrieve local Vault key from macOS Keychain.\n\nRestart Kapsula and click "Always Allow" in the Keychain prompt.\n\nDetails: ${msg}`
            : `Не удалось получить ключ локального Сейфа из Связки ключей macOS.\n\nПерезапусти Kapsula и нажми «Всегда разрешать» в запросе Связки ключей.\n\nДетали: ${msg}`
          : isEnStartup
            ? `Could not open system Vault key storage.\n\nDetails: ${msg}`
            : `Не удалось открыть системное хранилище ключей Сейфа.\n\nДетали: ${msg}`
      );
      try {
        repo.close();
      } catch {
        // ignore
      }
      app.exit(1);
      return;
    }

    const hasInitialPin = Boolean(repo.getSetting('master_pin_hash')) || cryptoVault.isPinProtected();
    let vaultUnlocked = !hasInitialPin && !cryptoVault.isLocked();
    let cardExpiryBackfilled = false;
    const recoverLegacyCardExpiries = () => {
      if (cardExpiryBackfilled || !repo || cryptoVault.isLocked()) return;
      cardExpiryBackfilled = true;
      try {
        const secrets = repo.queryItems({ dna: 'secret', limit: 200 });
        for (const item of secrets) {
          if (item.secretMeta?.kind !== 'bank_card' || item.secretMeta.expiry) continue;
          const rawEnc = repo.getRawEncryptedPayload(item.id);
          if (!rawEnc) continue;
          try {
            const payload = cryptoVault.decryptSecret(rawEnc);
            const recovered = recoverBankCardExpiry(payload.expiry, payload.notes);
            if (!recovered) continue;
            const synced = repo.updateItem(item.id, {
              secretMeta: { ...item.secretMeta, expiry: recovered },
            });
            if (synced) windows?.broadcast('vault:item-upserted', synced);
          } catch {
            // Skip unreadable legacy payload without blocking startup
          }
        }
      } catch {
        // Non-fatal startup backfill
      }
    };

    let clipperToken = repo.getSetting('clipper_token') || '';
    if (!clipperToken) {
      clipperToken = crypto.randomBytes(16).toString('hex');
      repo.setSetting('clipper_token', clipperToken);
    }
    let clipperPairingCode = repo.getSetting('clipper_pairing_code') || '';
    if (!clipperPairingCode) {
      clipperPairingCode = String(crypto.randomInt(100000, 1000000));
      repo.setSetting('clipper_pairing_code', clipperPairingCode);
    }
    const readPairedOrigins = (): Set<string> => {
      try {
        const raw = repo?.getSetting('clipper_paired_origins');
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0));
      } catch {
        return new Set();
      }
    };
    const writePairedOrigins = (origins: Set<string>): void => {
      repo?.setSetting('clipper_paired_origins', JSON.stringify(Array.from(origins)));
    };

    // Bootstrap API key from environment if present on first start
    const envOpenRouter = process.env.OPENROUTER_API_KEY?.trim();
    const envGemini = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
    if (envOpenRouter && !repo.getSetting('api_key_openrouter_enc')) {
      repo.setSetting('api_key_openrouter_enc', cryptoVault.encryptConfigJson({ key: envOpenRouter }));
    }
    if (envGemini && !repo.getSetting('api_key_google_enc')) {
      repo.setSetting('api_key_google_enc', cryptoVault.encryptConfigJson({ key: envGemini }));
    }
    if (!repo.getSetting('ai_provider')) {
      if (envGemini) repo.setSetting('ai_provider', 'google_ai_studio');
      else if (envOpenRouter) repo.setSetting('ai_provider', 'openrouter');
      else repo.setSetting('ai_provider', 'local');
    }

    const apiKeyMemo = new Map<AiProvider, { enc: string; key: string | null }>();

    const getApiKeyForProvider = (p: AiProvider): string | null => {
      if (p === 'local') return null;
      const settingKey = p === 'openrouter' ? 'api_key_openrouter_enc' : 'api_key_google_enc';
      const enc = repo!.getSetting(settingKey);
      if (!enc) {
        apiKeyMemo.delete(p);
        return null;
      }
      const memo = apiKeyMemo.get(p);
      if (memo && memo.enc === enc) {
        return memo.key;
      }
      try {
        const res = cryptoVault.decryptConfigJson<{ key: string }>(enc);
        let storedEnc = enc;
        if (res.migratedFromVdk && res.value?.key) {
          try {
            storedEnc = cryptoVault.encryptConfigJson({ key: res.value.key });
            repo!.setSetting(settingKey, storedEnc);
          } catch {
            // Non-fatal migration re-wrap
          }
        }
        const key = res.value?.key || null;
        apiKeyMemo.set(p, { enc: storedEnc, key });
        return key;
      } catch {
        return null;
      }
    };

    const setApiKeyForProvider = (p: 'openrouter' | 'google_ai_studio', apiKey: string): void => {
      const settingKey = p === 'openrouter' ? 'api_key_openrouter_enc' : 'api_key_google_enc';
      apiKeyMemo.delete(p);
      if (!apiKey) {
        repo!.setSetting(settingKey, '');
      } else {
        const enc = cryptoVault.encryptConfigJson({ key: apiKey });
        repo!.setSetting(settingKey, enc);
        apiKeyMemo.set(p, { enc, key: apiKey });
      }
    };

    const getVaultAutoLockMinutes = (): number => {
      const autoLockStr = repo!.getSetting('vault_auto_lock_minutes');
      const parsedAutoLock = autoLockStr !== null && autoLockStr !== '' ? Number(autoLockStr) : NaN;
      return Number.isFinite(parsedAutoLock) && parsedAutoLock >= 0
        ? Math.min(120, Math.round(parsedAutoLock))
        : 5;
    };

    const getLockVaultOnMinimize = (): boolean =>
      repo!.getSetting('lock_vault_on_minimize') !== 'false';

    const getLockVaultOnHudClose = (): boolean =>
      repo!.getSetting('lock_vault_on_hud_close') === 'true';

    const defaultSnatchShortcut = getDefaultSnatchShortcut(process.platform);
    let boundClipperPort = CLIPPER_PORT_BASE;
    let shortcutStatus: ShortcutRegistrationStatus = {
      hudRegistered: false,
      snatchRegistered: false,
      effectiveHudShortcut: DEFAULT_HUD_SHORTCUT,
      effectiveSnatchShortcut: defaultSnatchShortcut,
      error: null,
    };

    const getConfiguredShortcuts = () => {
      const hudRaw = repo!.getSetting('hud_shortcut');
      const snatchRaw = repo!.getSetting('snatch_shortcut');
      return {
        hudShortcut: normalizeShortcutAccelerator(hudRaw, process.platform) || DEFAULT_HUD_SHORTCUT,
        snatchShortcut:
          normalizeShortcutAccelerator(snatchRaw, process.platform) || defaultSnatchShortcut,
      };
    };

    const getSettingsState = (): SettingsState => {
      const theme = repo!.getSetting('theme') === 'light' ? 'light' : 'dark';
      const activeMode = (repo!.getSetting('active_mode') as CaptureMode) || 'autopilot';
      const aiProvider = (repo!.getSetting('ai_provider') as AiProvider) || 'local';
      const capStr = repo!.getSetting('monthly_cap_usd');
      const parsedCap = capStr ? Number(capStr) : NaN;
      const wipeStr = repo!.getSetting('clipboard_wipe_sec');
      const parsedWipe = wipeStr !== null && wipeStr !== '' ? Number(wipeStr) : NaN;
      const autoLockMinutes = getVaultAutoLockMinutes();
      const pinLockedUntil = Number(repo!.getSetting('pin_locked_until') || '0') || 0;
      const pinLockoutRemainingSec = Math.max(0, Math.ceil((pinLockedUntil - Date.now()) / 1000));
      const layoutRaw = repo!.getSetting('view_layout');
      const viewLayout = layoutRaw === 'list' || layoutRaw === 'board' ? layoutRaw : 'grid';
      const gcalStatus = gcalBridge?.getStatus();
      const { hudShortcut, snatchShortcut } = getConfiguredShortcuts();
      const biometricUnlockAvailable =
        process.platform === 'darwin' &&
        typeof systemPreferences.canPromptTouchID === 'function' &&
        Boolean(systemPreferences.canPromptTouchID());
      return {
        locale: getLocale(),
        theme,
        activeMode,
        activeFocusBoardId: repo!.getSetting('active_focus_board_id') || null,
        aiProvider,
        monthlyCapUsd: Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : DEFAULT_MONTHLY_CAP_USD,
        enableAutoOcr: repo!.getSetting('enable_auto_ocr') !== 'false',
        enableUrlUnfurl: repo!.getSetting('enable_url_unfurl') !== 'false',
        clipboardAutoWipeSeconds:
          Number.isFinite(parsedWipe) && (parsedWipe === 0 || parsedWipe >= 5)
            ? Math.min(300, Math.round(parsedWipe))
            : 30,
        hasOpenRouterKey: Boolean(getApiKeyForProvider('openrouter')),
        hasGoogleAiKey: Boolean(getApiKeyForProvider('google_ai_studio')),
        hasMasterPin: Boolean(repo!.getSetting('master_pin_hash')) || cryptoVault.isPinProtected(),
        vaultUnlocked,
        clipperPort: boundClipperPort,
        clipperToken,
        viewLayout,
        launchAtLogin: repo!.getSetting('launch_at_login') === 'true',
        soundTickEnabled: repo!.getSetting('sound_tick_enabled') === 'true',
        hudShortcut,
        snatchShortcut,
        shortcutStatus,
        googleCalendarConnected: gcalStatus?.connected ?? false,
        googleCalendarEmail: gcalStatus?.email ?? null,
        googleCalendarClientId: gcalStatus?.clientId ?? '',
        googleCalendarIcalUrl: gcalStatus?.icalUrl ?? '',
        googleCalendarLastSyncAt: gcalStatus?.lastSyncAt ?? null,
        vaultAutoLockMinutes: autoLockMinutes,
        lockVaultOnMinimize: getLockVaultOnMinimize(),
        lockVaultOnHudClose: getLockVaultOnHudClose(),
        enableScreenProtection:
          repo!.getSetting('enable_screen_protection') !== 'false' &&
          repo!.getSetting('enable_screen_protection') !== '0',
        biometricUnlockAvailable,
        biometricUnlockEnabled:
          repo!.getSetting('biometric_unlock_enabled') === 'true' && cryptoVault.hasBiometricSlot(),
        pinLockoutRemainingSec,
        appearance: repo!.getAppearanceConfig(),
        taskBoardColumns: repo!.listTaskBoardColumns(),
        showBoardColumnIcons: repo!.getSetting('show_board_column_icons') !== 'false',
        onboarded: repo!.getSetting('onboarded') === 'true',
        emailInboundAddress: repo!.getSetting('email_inbound_address') || undefined,
        emailInboundToken: repo!.getSetting('email_inbound_token') || undefined,
        emailInboundWebhookUrl: repo!.getSetting('email_inbound_webhook_url') || undefined,
        planTier: repo!.getSetting('plan_tier') === 'pro' ? 'pro' : 'free',
        videoCacheLimitMb: videoCache.getLimitMb(),
      };
    };

    const preloadPath = path.resolve(__dirname, '../preload/index.js');
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const rendererHtml = path.resolve(__dirname, '../renderer/index.html');
    const iconPath = resolveIconPath();

    windows = new WindowManager(
      preloadPath,
      devServerUrl ? { url: devServerUrl } : { htmlPath: rendererHtml },
      iconPath,
      {
        getPosition: (displayId) => {
          const raw = repo?.getSetting(`hud_pos_${displayId}`);
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
              return { x: parsed.x, y: parsed.y };
            }
          } catch {
            // Ignore malformed saved bounds
          }
          return null;
        },
        savePosition: (displayId, x, y) => {
          repo?.setSetting(`hud_pos_${displayId}`, JSON.stringify({ x, y }));
        },
      }
    );

    const isAllowedMediaSender = (
      wc: Electron.WebContents | null | undefined,
      candidateUrl?: string
    ): boolean => {
      if (!wc || !windows?.isOwnWebContents(wc.id)) return false;
      if (!windows.isAllowedSurfaceUrl(wc.getURL())) return false;
      if (!candidateUrl || candidateUrl === 'file://' || candidateUrl === 'file:///') return true;
      return windows.isAllowedSurfaceUrl(candidateUrl);
    };
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      if (permission !== 'media' || !isAllowedMediaSender(wc, requestingOrigin)) return false;
      return details?.mediaType !== 'video';
    });
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
      const requestsVideo = Array.isArray(mediaTypes) && mediaTypes.includes('video');
      const allowed =
        permission === 'media' && !requestsVideo && isAllowedMediaSender(wc, details?.requestingUrl);
      if (!allowed) {
        callback(false);
        return;
      }
      if (process.platform === 'darwin') {
        void systemPreferences
          .askForMediaAccess('microphone')
          .then((granted) => callback(granted))
          .catch(() => callback(false));
        return;
      }
      callback(true);
    });

    const showSecurityNotice = (notice: { title: string; body: string }) => {
      if (!Notification.isSupported()) return;
      try {
        const notif = new Notification({
          title: notice.title,
          body: notice.body,
        });
        notif.on('click', () => {
          windows?.showVault();
        });
        notif.show();
      } catch {
        // Ignore OS notification failures in headless/restricted sessions
      }
    };

    const getCloudAiProxyConfig = (): CloudAiProxyConfig | null => {
      if (!syncEngine) return null;
      return {
        supabaseUrl: DEFAULT_SYNC_SUPABASE_URL,
        supabasePublishableKey: DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
        getAccessToken: () => syncEngine!.getActiveAccessToken(),
        getLocale,
      };
    };

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir,
      videoCache,
      getConfig: () => {
        const s = getSettingsState();
        return {
          activeMode: s.activeMode,
          activeFocusBoardId: s.activeFocusBoardId,
          aiProvider: s.aiProvider,
          apiKey: getApiKeyForProvider(s.aiProvider),
          googleAiKey: getApiKeyForProvider('google_ai_studio'),
          openRouterKey: getApiKeyForProvider('openrouter'),
          cloudProxy: getCloudAiProxyConfig(),
          monthlyCapUsd: s.monthlyCapUsd,
          enableAutoOcr: s.enableAutoOcr,
          enableUrlUnfurl: s.enableUrlUnfurl,
        };
      },
      samplePalette: (absImgPath) => {
        const img = nativeImage.createFromPath(absImgPath);
        if (img.isEmpty()) return [];
        const resized = img.resize({ width: 48 });
        const size = resized.getSize();
        return samplePaletteFromBgra(resized.toBitmap(), size.width, size.height);
      },
      prepareVisionImage: async (absImgPath) => {
        const img = nativeImage.createFromPath(absImgPath);
        if (img.isEmpty()) return null;
        const size = img.getSize();
        const scaled =
          size.width > 1280 || size.height > 1280
            ? img.resize(
                size.width >= size.height
                  ? { width: 1280, quality: 'good' }
                  : { height: 1280, quality: 'good' }
              )
            : img;
        const jpg = scaled.toJPEG(84);
        if (!jpg || jpg.length === 0) return null;
        return { base64: jpg.toString('base64'), mimeType: 'image/jpeg' };
      },
      onItemUpserted: (item) => {
        windows?.broadcast('vault:item-upserted', item);
      },
      onItemDeleted: (itemId) => {
        windows?.broadcast('vault:item-deleted', itemId);
      },
      onSecurityNotice: showSecurityNotice,
      onOrbitsChanged: () => {
        windows?.broadcast('vault:orbits-changed', undefined);
      },
      onReminderChanged: () => {
        reminderScheduler?.refresh();
      },
      onCalendarChanged: () => {
        windows?.broadcast('vault:calendar-changed', undefined);
      },
    });

    // v2 clean startup: purge legacy demo cards once without touching real user data
    if (!repo.getSetting('v2_demo_purged')) {
      const demoImgs = repo.getDemoImagePaths();
      const removedDemo = repo.clearDemoItems();
      if (removedDemo > 0) {
        pipeline.cleanupUnreferencedMedia(demoImgs);
      }
      repo.setSetting('v2_demo_purged', '1');
    }

    gcalBridge = new GoogleCalendarBridge(repo, cryptoVault, {
      getSupabaseConfig: () => ({
        url: DEFAULT_SYNC_SUPABASE_URL,
        key: DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
      }),
      getAccessToken: () => syncEngine?.getActiveAccessToken() ?? Promise.resolve(null),
    });
    clipper = new ClipperServer(
      pipeline,
      () => clipperToken,
      () => {},
      () =>
        repo!
          .listOrbits()
          .map((o) => ({ id: o.id, name: o.name, color: o.color })),
      getLocale,
      {
        getPairingCode: () => clipperPairingCode,
        isOriginPaired: (origin) => readPairedOrigins().has(origin),
        onPairOrigin: (origin) => {
          const next = readPairedOrigins();
          next.add(origin);
          writePairedOrigins(next);
        },
      }
    );

    if (process.env.KAPSULA_DISABLE_CLIPPER === '1') {
      boundClipperPort = 0;
    } else {
      void clipper
        .start()
        .then((port) => {
          boundClipperPort = port;
          if (port !== CLIPPER_PORT_BASE) {
            windows?.broadcast('settings:updated', getSettingsState());
          }
        })
        .catch(() => {
          boundClipperPort = 0;
          windows?.broadcast('settings:updated', getSettingsState());
        });
    }

    let vaultViewActive = false;
    let hudVaultTabActive = false;

    const syncContentProtection = () => {
      const envDisabled = !app.isPackaged && process.env.KAPSULA_DISABLE_CONTENT_PROTECTION === '1';
      const prefEnabled = !envDisabled && getSettingsState().enableScreenProtection !== false;
      const vaultProtect = prefEnabled && vaultViewActive;
      const hudProtect = prefEnabled && hudVaultTabActive;
      try {
        if (windows?.vault && !windows.vault.isDestroyed()) {
          windows.vault.setContentProtection(vaultProtect);
        }
      } catch {
        // Optional depending on OS compositor / headless environment
      }
      windows?.setHudContentProtection(hudProtect);
    };

    const applyWindowBackground = () => {
      const cur = getSettingsState();
      nativeTheme.themeSource = cur.theme === 'light' ? 'light' : 'dark';
      const tokens = computeThemeTokens(cur.theme, cur.appearance);
      const glassOn = Boolean(cur.appearance?.glassPreset && cur.appearance.glassPreset !== 'off');
      const material = cur.appearance?.glassNativeMaterial ?? 'none';
      windows?.setVaultGlassMaterial(material, glassOn, tokens.canvasHex);
    };

    windows.createAll();
    applyWindowBackground();
    windows.vault?.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          repo?.warmupSearchIndex();
        } catch {
          // Non-fatal background search warmup
        }
      }, 1200).unref?.();
      if (process.env.KAPSULA_DISABLE_STARTUP_UNFURL !== '1') {
        setTimeout(() => {
          try {
            pipeline.scanAndEnrichStubLinks(12);
          } catch {
            // Non-fatal background stub-link enrichment
          }
        }, 3500).unref?.();
      }
    });
    // Default OFF on startup (Notes/Feed/Tasks/Calendar/Settings remain screenshot-friendly);
    // protection engages dynamically ONLY while viewing Vault / Secrets / Recovery Key.
    syncContentProtection();
    if (vaultUnlocked) {
      recoverLegacyCardExpiries();
    }

    reminderScheduler = new ReminderScheduler(repo, (item) => {
      windows?.broadcast('vault:item-upserted', item);
      if (Notification.isSupported()) {
        const isEn = getLocale() === 'en';
        const notif = new Notification({
          title: isEn ? 'Reminder · Kapsula' : 'Напоминание · Kapsula',
          body:
            item.title ||
            item.body.slice(0, 80) ||
            (isEn ? 'Open note in vault' : 'Открой запись в хранилище'),
        });
        notif.on('click', () => {
          windows?.showVault();
          windows?.broadcast('vault:focus-item', item.id);
        });
        notif.show();
      }
    });
    reminderScheduler.start();

    const rebuildTrayMenu = () => {
      if (!tray) return;
      const loc = getLocale();
      const isEn = loc === 'en';
      const fallbackHint =
        process.platform === 'darwin'
          ? isEn
            ? '⌥+Space'
            : '⌥+Пробел'
          : isEn
            ? 'Alt+Space'
            : 'Alt+Пробел';
      const hudHint =
        formatShortcutCompact(shortcutStatus.effectiveHudShortcut, process.platform, loc) || fallbackHint;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: isEn ? 'Open Kapsula' : 'Открыть Kapsula', click: () => windows?.showVault() },
          {
            label: isEn ? `Quick HUD (${hudHint})` : `Быстрая панель (${hudHint})`,
            click: () => windows?.toggleHud(),
          },
          { type: 'separator' },
          {
            label: isEn ? 'Quit Kapsula' : 'Выход из Kapsula',
            click: () => {
              windows?.setQuitting(true);
              app.quit();
            },
          },
        ])
      );
    };

    const rebuildAppMenu = () => {
      if (process.platform !== 'darwin') return;
      const isEn = getLocale() === 'en';
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Kapsula',
            submenu: [
              { role: 'about', label: isEn ? 'About Kapsula' : 'О программе Kapsula' },
              { type: 'separator' },
              {
                label: isEn ? 'Settings…' : 'Настройки…',
                accelerator: 'Cmd+,',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:open-settings', undefined);
                },
              },
              { type: 'separator' },
              { role: 'services', label: isEn ? 'Services' : 'Службы' },
              { type: 'separator' },
              { role: 'hide', label: isEn ? 'Hide Kapsula' : 'Скрыть Kapsula' },
              { role: 'hideOthers', label: isEn ? 'Hide Others' : 'Скрыть остальные' },
              { role: 'unhide', label: isEn ? 'Show All' : 'Показать все' },
              { type: 'separator' },
              {
                label: isEn ? 'Quit Kapsula' : 'Выход из Kapsula',
                accelerator: 'Cmd+Q',
                click: () => {
                  windows?.setQuitting(true);
                  app.quit();
                },
              },
            ],
          },
          {
            label: isEn ? 'File' : 'Файл',
            submenu: [
              {
                label: isEn ? 'New Note' : 'Новая заметка',
                accelerator: 'Cmd+N',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:new-note', undefined);
                },
              },
              { type: 'separator' },
              {
                label: isEn ? 'Close Window' : 'Закрыть окно',
                accelerator: 'Cmd+W',
                click: () => {
                  const focused = BrowserWindow.getFocusedWindow();
                  if (focused && !focused.isDestroyed()) {
                    focused.close();
                  } else {
                    windows?.hideVaultSafely();
                  }
                },
              },
            ],
          },
          {
            label: isEn ? 'Edit' : 'Правка',
            submenu: [
              { role: 'undo', label: isEn ? 'Undo' : 'Отменить' },
              { role: 'redo', label: isEn ? 'Redo' : 'Повторить' },
              { type: 'separator' },
              { role: 'cut', label: isEn ? 'Cut' : 'Вырезать' },
              { role: 'copy', label: isEn ? 'Copy' : 'Копировать' },
              { role: 'paste', label: isEn ? 'Paste' : 'Вставить' },
              {
                role: 'pasteAndMatchStyle',
                label: isEn ? 'Paste and Match Style' : 'Вставить и согласовать стиль',
              },
              { role: 'delete', label: isEn ? 'Delete' : 'Удалить' },
              { role: 'selectAll', label: isEn ? 'Select All' : 'Выбрать всё' },
              { type: 'separator' },
              {
                label: isEn ? 'Find…' : 'Найти…',
                accelerator: 'Cmd+F',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:focus-search', undefined);
                },
              },
            ],
          },
          {
            label: isEn ? 'View' : 'Вид',
            submenu: [
              {
                label: isEn ? 'Calendar' : 'Календарь',
                accelerator: 'Cmd+Shift+C',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:open-calendar', undefined);
                },
              },
              {
                label: isEn ? 'Quick HUD' : 'Быстрая панель',
                click: () => windows?.toggleHud(),
              },
              { type: 'separator' },
              { role: 'togglefullscreen', label: isEn ? 'Toggle Full Screen' : 'Полноэкранный режим' },
            ],
          },
          {
            label: isEn ? 'Window' : 'Окно',
            submenu: [
              { role: 'minimize', label: isEn ? 'Minimize' : 'Свернуть' },
              { role: 'zoom', label: isEn ? 'Zoom' : 'Масштаб' },
              { type: 'separator' },
              {
                label: isEn ? 'Show Kapsula' : 'Показать Kapsula',
                click: () => windows?.showVault(),
              },
              { role: 'front', label: isEn ? 'Bring All to Front' : 'Все окна — на передний план' },
            ],
          },
        ])
      );
    };

    rebuildAppMenu();

    const runClipboardSnatch = () => {
      void (async () => {
        try {
          const snap = await readClipboardSnapshot(clipboard, nativeImage);
          if (snap.imageBase64) {
            await pipeline.capture({
              imageBase64: snap.imageBase64,
              source: 'clipboard_snatch',
            });
            return;
          }
          if (snap.text) {
            await pipeline.capture({
              text: snap.text,
              source: 'clipboard_snatch',
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '');
          if (msg.includes('Сейф заблокирован') || msg.includes('Vault is locked')) {
            const isEn = getLocale() === 'en';
            showSecurityNotice({
              title: isEn ? 'Vault is locked · Kapsula' : 'Сейф заблокирован · Kapsula',
              body: isEn
                ? 'Unlock Vault with your master PIN to securely save sensitive clipboard data.'
                : 'Разблокируй Сейф мастер-кодом, чтобы безопасно сохранить конфиденциальные данные из буфера.',
            });
          }
        }
      })();
    };

    const reapplyShortcuts = () => {
      globalShortcut.unregisterAll();
      const { hudShortcut, snatchShortcut } = getConfiguredShortcuts();
      const hasCustomHud = Boolean(repo!.getSetting('hud_shortcut'));

      let hudRegistered = false;
      let effectiveHudShortcut = hudShortcut;
      try {
        hudRegistered = globalShortcut.register(hudShortcut, () => {
          windows?.toggleHud();
        });
      } catch {
        hudRegistered = false;
      }

      if (!hudRegistered && !hasCustomHud) {
        try {
          const fallbackOk = globalShortcut.register('CommandOrControl+Shift+Space', () => {
            windows?.toggleHud();
          });
          if (fallbackOk) {
            hudRegistered = true;
            effectiveHudShortcut = 'CommandOrControl+Shift+Space';
          }
        } catch {
          // ignore
        }
      }

      let snatchRegistered = false;
      const effectiveSnatchShortcut = snatchShortcut;
      if (snatchShortcut !== effectiveHudShortcut) {
        try {
          snatchRegistered = globalShortcut.register(snatchShortcut, runClipboardSnatch);
        } catch {
          snatchRegistered = false;
        }
      }

      const loc = getLocale();
      const isEn = loc === 'en';
      const busyList: string[] = [];
      if (!hudRegistered) busyList.push(formatShortcutCompact(hudShortcut, process.platform, loc));
      if (!snatchRegistered) busyList.push(formatShortcutCompact(snatchShortcut, process.platform, loc));
      shortcutStatus = {
        hudRegistered,
        snatchRegistered,
        effectiveHudShortcut,
        effectiveSnatchShortcut,
        error:
          busyList.length > 0
            ? isEn
              ? `Shortcuts ${busyList.join(', ')} are currently used by another app`
              : `Клавиши ${busyList.join(', ')} сейчас заняты другой программой`
            : null,
      };
      rebuildTrayMenu();
    };

    syncEngine = new SyncEngine({
      dataDir,
      mediaDir,
      repo,
      vaultCrypto: cryptoVault,
      safeStorage,
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      openExternal: (url) => shell.openExternal(url),
      callbacks: {
        onStatusChanged: (status) => {
          windows?.broadcast('sync:status-updated', status);
        },
        onItemUpserted: (item) => {
          windows?.broadcast('vault:item-upserted', item);
          reminderScheduler?.refresh();
          pipeline.enqueueSyncedLinkEnrichment(item);
        },
        onItemDeleted: (id) => {
          windows?.broadcast('vault:item-deleted', id);
          reminderScheduler?.refresh();
        },
        onOrbitsChanged: () => {
          windows?.broadcast('vault:orbits-changed', undefined);
        },
        onBoardsChanged: () => {
          windows?.broadcast('vault:boards-changed', undefined);
        },
        onCalendarChanged: () => {
          windows?.broadcast('vault:calendar-changed', undefined);
        },
        onBatchSynced: (upsertedItems) => {
          windows?.broadcast('vault:batch-synced', undefined);
          reminderScheduler?.refresh();
          if (Array.isArray(upsertedItems) && upsertedItems.length > 0) {
            for (const pulled of upsertedItems) {
              pipeline.enqueueSyncedLinkEnrichment(pulled);
            }
          } else {
            pipeline.scanAndEnrichStubLinks(12);
          }
        },
        onWorkspacePrefsChanged: () => {
          const nextLocale = getLocale();
          cryptoVault.setLocale(nextLocale);
          syncEngine?.setLocale(nextLocale);
          updater?.setLocale(nextLocale);
          applyWindowBackground();
          reapplyShortcuts();
          rebuildAppMenu();
          windows?.broadcast('settings:updated', getSettingsState());
        },
        onMediaCleanup: (filenames) => {
          pipeline.cleanupUnreferencedMedia(filenames);
        },
      },
    });
    void syncEngine.initialize().catch(() => {});

    updater = new AppUpdaterController({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      locale: getLocale(),
      onStateChanged: (nextState) => {
        windows?.broadcast('updater:state-changed', nextState);
      },
      openExternal: (url) => shell.openExternal(url),
      getDismissedVersion: () => repo?.getSetting('updater_dismissed_version') || null,
      setDismissedVersion: (version) => {
        repo?.setSetting('updater_dismissed_version', version);
      },
    });
    updater.start();

    const ipcHooks = registerIpcHandlers({
      dataDir,
      repo,
      cryptoVault,
      pipeline,
      windows,
      gcalBridge,
      clipper,
      syncEngine,
      updater,
      getCloudAiProxyConfig,
      getSettingsState,
      getApiKeyForProvider,
      setApiKeyForProvider,
      setVaultUnlocked: (v) => {
        vaultUnlocked = v;
        if (v) {
          recoverLegacyCardExpiries();
          // Eagerly migrate legacy v7 VDK-encrypted Google Calendar tokens to configKey
          gcalBridge?.getStatus();
          syncEngine?.handleVaultUnlocked();
        } else {
          cryptoVault.lock();
        }
        syncContentProtection();
      },
      setScreenProtection: (enabled, source = 'vault') => {
        if (source === 'hud') {
          hudVaultTabActive = Boolean(enabled);
        } else {
          vaultViewActive = Boolean(enabled);
        }
        syncContentProtection();
      },
      syncScreenProtection: syncContentProtection,
      applyWindowBackground,
      refreshReminders: () => {
        reminderScheduler?.refresh();
      },
      reapplyShortcuts,
      clipperControl: {
        getPairingInfo: () => ({
          pairingCode: clipperPairingCode,
          pairedCount: readPairedOrigins().size,
        }),
        resetPairing: () => {
          writePairedOrigins(new Set());
          clipperToken = crypto.randomBytes(16).toString('hex');
          repo!.setSetting('clipper_token', clipperToken);
          clipperPairingCode = String(crypto.randomInt(100000, 1000000));
          repo!.setSetting('clipper_pairing_code', clipperPairingCode);
          return {
            pairingCode: clipperPairingCode,
            pairedCount: 0,
          };
        },
      },
      onLocaleChanged: (nextLocale) => {
        cryptoVault.setLocale(nextLocale);
        syncEngine?.setLocale(nextLocale);
        updater?.setLocale(nextLocale);
        reapplyShortcuts();
        rebuildAppMenu();
      },
    });

    windows.vault?.on('focus', () => {
      const st = syncEngine?.getStatus();
      if (st && (st.state === 'synced' || st.state === 'offline')) {
        const elapsed = st.lastSyncAt ? Date.now() - st.lastSyncAt : Infinity;
        if (elapsed > 15_000) {
          void syncEngine?.syncNow().catch(() => {});
        }
      }
    });

    // Global shortcuts: HUD + Silent Clipboard Snatch
    reapplyShortcuts();

    // Auto-lock Vault secrets on OS lock, sleep, Vault hide/minimize, optional HUD close, or configurable system idle
    powerMonitor.on('lock-screen', () => ipcHooks.lockVaultIfProtected());
    powerMonitor.on('suspend', () => ipcHooks.lockVaultIfProtected());
    powerMonitor.on('resume', () => syncEngine?.handleSystemResume());
    windows.vault?.on('hide', () => ipcHooks.lockVaultIfProtected());
    windows.vault?.on('minimize', () => {
      if (getLockVaultOnMinimize()) {
        ipcHooks.lockVaultIfProtected();
      }
    });
    windows.setOnHudHide(() => {
      hudVaultTabActive = false;
      syncContentProtection();
      if (getLockVaultOnHudClose()) {
        ipcHooks.lockVaultIfProtected();
      }
    });
    const idleLockInterval = setInterval(() => {
      try {
        const autoLockMin = getVaultAutoLockMinutes();
        if (autoLockMin > 0 && powerMonitor.getSystemIdleTime() >= autoLockMin * 60) {
          ipcHooks.lockVaultIfProtected();
        }
      } catch {
        // ignore idle query failure on unsupported environments
      }
    }, 15_000);
    idleLockInterval.unref?.();

    // System Tray / macOS Menu Bar
    const resolvedTray = resolveTrayIconPath();
    let trayIcon: Electron.NativeImage;
    if (process.platform === 'darwin' && resolvedTray?.isTemplate) {
      // Load 1x and @2x explicitly via buffers so Retina crispness works even inside app.asar
      trayIcon = nativeImage.createEmpty();
      trayIcon.addRepresentation({
        scaleFactor: 1,
        width: 18,
        height: 18,
        buffer: fs.readFileSync(resolvedTray.path),
      });
      if (resolvedTray.path2x) {
        trayIcon.addRepresentation({
          scaleFactor: 2,
          width: 36,
          height: 36,
          buffer: fs.readFileSync(resolvedTray.path2x),
        });
      }
      trayIcon.setTemplateImage(true);
    } else if (resolvedTray) {
      trayIcon = nativeImage.createFromPath(resolvedTray.path);
      if (process.platform === 'darwin' && !trayIcon.isEmpty()) {
        trayIcon = trayIcon.resize({ width: 18, height: 18 });
      }
    } else if (iconPath) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    } else {
      trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Kapsula');
    rebuildTrayMenu();
    if (process.platform !== 'darwin') {
      tray.on('double-click', () => windows?.showVault());
    }

    let quitCleanupDone = false;
    app.on('before-quit', (e) => {
      clearInterval(idleLockInterval);
      windows?.setQuitting(true);
      updater?.dispose();
      reminderScheduler?.stop();
      globalShortcut.unregisterAll();
      if (tray) {
        tray.destroy();
        tray = null;
      }
      if (quitCleanupDone) return;
      e.preventDefault();
      quitCleanupDone = true;
      void Promise.race([
        Promise.allSettled([
          ipcHooks.clearClipboardNow(),
          syncEngine?.flushNow(2500),
          pipeline.waitForIdle(),
          clipper?.stop(),
        ]),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).finally(() => {
        try {
          syncEngine?.dispose();
        } catch {
          // ignore
        }
        try {
          cryptoVault.dispose();
        } catch {
          // ignore
        }
        try {
          ipcHooks.flushPendingDeletes();
        } catch {
          // ignore
        }
        try {
          repo?.close();
        } catch {
          // ignore if already closed
        }
        app.exit(0);
      });
    });
  });
}
