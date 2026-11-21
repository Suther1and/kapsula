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
import { CapturePipeline, resolveSafeMediaFilePath } from './pipeline/capture-pipeline';
import { readClipboardSnapshot } from './pipeline/clipboard-helper';
import { ReminderScheduler } from './pipeline/reminder-scheduler';
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
  fs.mkdirSync(isolatedUserData, { recursive: true });
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
    fs.mkdirSync(dataDir, { recursive: true });
    const mediaDir = path.join(dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const baseCsp =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' kapsula-media: data: blob:; media-src 'self' kapsula-media: blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
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
        };
        callback({ responseHeaders: headers });
      });
    }

    // Serve local screenshots, audio recordings (with HTTP 206 Range seeking), and documents safely
    protocol.handle('kapsula-media', async (request) => {
      try {
        const u = new URL(request.url);
        const rawPart =
          u.hostname === 'local'
            ? u.pathname.replace(/^\/+/, '')
            : u.hostname || u.pathname.replace(/^\/+/, '');
        const resolved = resolveSafeMediaFilePath(mediaDir, rawPart);
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

        const ext = path.extname(safeName).toLowerCase();
        const mime =
          ext === '.webm' && safeName.startsWith('vid_')
            ? 'video/webm'
            : MEDIA_MIME_TYPES[ext] ?? 'application/octet-stream';
        const totalSize = stat.size;
        const rangeHeader = request.headers.get('range');
        const cacheHeader = 'private, no-cache';

        if (rangeHeader && totalSize > 0) {
          const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
          if (!match) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${totalSize}` },
            });
          }
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(totalSize - 1, Number(match[2])) : totalSize - 1;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${totalSize}` },
            });
          }
          const stream = fs.createReadStream(target, { start, end });
          return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'Content-Length': String(end - start + 1),
              'Accept-Ranges': 'bytes',
              'Cache-Control': cacheHeader,
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
          },
        });
      } catch {
        return new Response('Bad request', { status: 400 });
      }
    });

    repo = new VaultRepository(path.join(dataDir, 'kapsula-vault.sqlite'));
    let cryptoVault: VaultCrypto;
    try {
      cryptoVault = new VaultCrypto(dataDir, safeStorage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox(
        'Kapsula — доступ к Связке ключей',
        process.platform === 'darwin'
          ? `Не удалось получить ключ локального Сейфа из Связки ключей macOS.\n\nПерезапусти Kapsula и нажми «Всегда разрешать» в запросе Связки ключей.\n\nДетали: ${msg}`
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
      else repo.setSetting('ai_provider', 'google_ai_studio');
    }

    const getApiKeyForProvider = (p: AiProvider): string | null => {
      if (p === 'local') return null;
      const settingKey = p === 'openrouter' ? 'api_key_openrouter_enc' : 'api_key_google_enc';
      const enc = repo!.getSetting(settingKey);
      if (!enc) return null;
      try {
        const res = cryptoVault.decryptConfigJson<{ key: string }>(enc);
        if (res.migratedFromVdk && res.value?.key) {
          try {
            repo!.setSetting(settingKey, cryptoVault.encryptConfigJson({ key: res.value.key }));
          } catch {
            // Non-fatal migration re-wrap
          }
        }
        return res.value?.key || null;
      } catch {
        return null;
      }
    };

    const setApiKeyForProvider = (p: 'openrouter' | 'google_ai_studio', apiKey: string): void => {
      const settingKey = p === 'openrouter' ? 'api_key_openrouter_enc' : 'api_key_google_enc';
      if (!apiKey) repo!.setSetting(settingKey, '');
      else repo!.setSetting(settingKey, cryptoVault.encryptConfigJson({ key: apiKey }));
    };

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
      const autoLockStr = repo!.getSetting('vault_auto_lock_minutes');
      const parsedAutoLock = autoLockStr !== null && autoLockStr !== '' ? Number(autoLockStr) : NaN;
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
        vaultAutoLockMinutes:
          Number.isFinite(parsedAutoLock) && parsedAutoLock >= 0
            ? Math.min(120, Math.round(parsedAutoLock))
            : 5,
        lockVaultOnMinimize: repo!.getSetting('lock_vault_on_minimize') !== 'false',
        lockVaultOnHudClose: repo!.getSetting('lock_vault_on_hud_close') === 'true',
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
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      return permission === 'media' && isAllowedMediaSender(wc, requestingOrigin);
    });
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const allowed = permission === 'media' && isAllowedMediaSender(wc, details?.requestingUrl);
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
        supabaseUrl: syncEngine.getSupabaseBaseUrl(),
        supabasePublishableKey: syncEngine.getSupabasePublishableKey(),
        getAccessToken: () => syncEngine!.getActiveAccessToken(),
      };
    };

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir,
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
        url: syncEngine?.getSupabaseBaseUrl() ?? DEFAULT_SYNC_SUPABASE_URL,
        key: syncEngine?.getSupabasePublishableKey() ?? DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
      }),
    });
    clipper = new ClipperServer(
      pipeline,
      () => clipperToken,
      () => {},
      () =>
        repo!
          .listOrbits()
          .map((o) => ({ id: o.id, name: o.name, color: o.color }))
    );

    if (process.env.KAPSULA_DISABLE_CLIPPER !== '1') {
      try {
        boundClipperPort = await clipper.start();
      } catch {
        boundClipperPort = 0;
      }
    }

    let vaultViewActive = false;
    let hudVaultTabActive = false;

    const syncContentProtection = () => {
      const envDisabled = process.env.KAPSULA_DISABLE_CONTENT_PROTECTION === '1';
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
      try {
        if (windows?.hud && !windows.hud.isDestroyed()) {
          windows.hud.setContentProtection(hudProtect);
        }
      } catch {
        // Optional depending on OS compositor / headless environment
      }
    };

    const applyWindowBackground = () => {
      const cur = getSettingsState();
      const tokens = computeThemeTokens(cur.theme, cur.appearance);
      windows?.setVaultBackgroundColor(tokens.canvasHex);
    };

    windows.createAll();
    applyWindowBackground();
    // Default OFF on startup (Notes/Feed/Tasks/Calendar/Settings remain screenshot-friendly);
    // protection engages dynamically ONLY while viewing Vault / Secrets / Recovery Key.
    syncContentProtection();
    if (vaultUnlocked) {
      recoverLegacyCardExpiries();
    }

    reminderScheduler = new ReminderScheduler(repo, (item) => {
      windows?.broadcast('vault:item-upserted', item);
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: 'Напоминание · Kapsula',
          body: item.title || item.body.slice(0, 80) || 'Открой запись в хранилище',
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
      const fallbackHint = process.platform === 'darwin' ? '⌥+Пробел' : 'Alt+Пробел';
      const hudHint =
        formatShortcutCompact(shortcutStatus.effectiveHudShortcut, process.platform) || fallbackHint;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Открыть Kapsula', click: () => windows?.showVault() },
          { label: `Быстрая панель (${hudHint})`, click: () => windows?.toggleHud() },
          { type: 'separator' },
          {
            label: 'Выход из Kapsula',
            click: () => {
              windows?.setQuitting(true);
              app.quit();
            },
          },
        ])
      );
    };

    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Kapsula',
            submenu: [
              { role: 'about', label: 'О программе Kapsula' },
              { type: 'separator' },
              {
                label: 'Настройки…',
                accelerator: 'Cmd+,',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:open-settings', undefined);
                },
              },
              { type: 'separator' },
              { role: 'services', label: 'Службы' },
              { type: 'separator' },
              { role: 'hide', label: 'Скрыть Kapsula' },
              { role: 'hideOthers', label: 'Скрыть остальные' },
              { role: 'unhide', label: 'Показать все' },
              { type: 'separator' },
              {
                label: 'Выход из Kapsula',
                accelerator: 'Cmd+Q',
                click: () => {
                  windows?.setQuitting(true);
                  app.quit();
                },
              },
            ],
          },
          {
            label: 'Файл',
            submenu: [
              {
                label: 'Новая заметка',
                accelerator: 'Cmd+N',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:new-note', undefined);
                },
              },
              { type: 'separator' },
              {
                label: 'Закрыть окно',
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
            label: 'Правка',
            submenu: [
              { role: 'undo', label: 'Отменить' },
              { role: 'redo', label: 'Повторить' },
              { type: 'separator' },
              { role: 'cut', label: 'Вырезать' },
              { role: 'copy', label: 'Копировать' },
              { role: 'paste', label: 'Вставить' },
              { role: 'pasteAndMatchStyle', label: 'Вставить и согласовать стиль' },
              { role: 'delete', label: 'Удалить' },
              { role: 'selectAll', label: 'Выбрать всё' },
              { type: 'separator' },
              {
                label: 'Найти…',
                accelerator: 'Cmd+F',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:focus-search', undefined);
                },
              },
            ],
          },
          {
            label: 'Вид',
            submenu: [
              {
                label: 'Календарь',
                accelerator: 'Cmd+Shift+C',
                click: () => {
                  windows?.showVault();
                  windows?.broadcast('vault:open-calendar', undefined);
                },
              },
              {
                label: 'Быстрая панель',
                click: () => windows?.toggleHud(),
              },
              { type: 'separator' },
              { role: 'togglefullscreen', label: 'Полноэкранный режим' },
            ],
          },
          {
            label: 'Окно',
            submenu: [
              { role: 'minimize', label: 'Свернуть' },
              { role: 'zoom', label: 'Масштаб' },
              { type: 'separator' },
              {
                label: 'Показать Kapsula',
                click: () => windows?.showVault(),
              },
              { role: 'front', label: 'Все окна — на передний план' },
            ],
          },
        ])
      );
    }

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
          if (msg.includes('Сейф заблокирован')) {
            showSecurityNotice({
              title: 'Сейф заблокирован · Kapsula',
              body: 'Разблокируй Сейф мастер-кодом, чтобы безопасно сохранить конфиденциальные данные из буфера.',
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

      const busyList: string[] = [];
      if (!hudRegistered) busyList.push(formatShortcutCompact(hudShortcut, process.platform));
      if (!snatchRegistered) busyList.push(formatShortcutCompact(snatchShortcut, process.platform));
      shortcutStatus = {
        hudRegistered,
        snatchRegistered,
        effectiveHudShortcut,
        effectiveSnatchShortcut,
        error:
          busyList.length > 0
            ? `Клавиши ${busyList.join(', ')} сейчас заняты другой программой`
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
      isPackaged: app.isPackaged && !process.env.KAPSULA_DATA_DIR,
      appVersion: app.getVersion(),
      openExternal: (url) => shell.openExternal(url),
      callbacks: {
        onStatusChanged: (status) => {
          if (
            status.userId &&
            status.state !== 'signed_out' &&
            repo!.getSetting('ai_provider') === 'local' &&
            repo!.getSetting('ai_provider_explicit') !== '1' &&
            !getApiKeyForProvider('google_ai_studio') &&
            !getApiKeyForProvider('openrouter')
          ) {
            repo!.setSetting('ai_provider', 'google_ai_studio');
            windows?.broadcast('settings:updated', getSettingsState());
          }
          windows?.broadcast('sync:status-updated', status);
        },
        onItemUpserted: (item) => {
          windows?.broadcast('vault:item-upserted', item);
          reminderScheduler?.refresh();
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
        onBatchSynced: () => {
          windows?.broadcast('vault:batch-synced', undefined);
          reminderScheduler?.refresh();
        },
        onWorkspacePrefsChanged: () => {
          applyWindowBackground();
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
      isPackaged: app.isPackaged && !process.env.KAPSULA_DATA_DIR,
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
      if (getSettingsState().lockVaultOnMinimize !== false) {
        ipcHooks.lockVaultIfProtected();
      }
    });
    windows.hud?.on('hide', () => {
      hudVaultTabActive = false;
      syncContentProtection();
      if (getSettingsState().lockVaultOnHudClose === true) {
        ipcHooks.lockVaultIfProtected();
      }
    });
    const idleLockInterval = setInterval(() => {
      try {
        const autoLockMin = getSettingsState().vaultAutoLockMinutes ?? 5;
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
