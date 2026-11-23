import {
  app,
  clipboard,
  ClipboardItem,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AiProvider,
  AppLocale,
  AppearanceConfig,
  CalendarEventInput,
  CaptureInput,
  CaptureMode,
  ChatTurn,
  CreateTaskInput,
  FocusBoardUpdateInput,
  ItemRevision,
  ItemSubKind,
  OrbitUpdateInput,
  SecretCopyField,
  SecretMeta,
  SecretPayload,
  SettingsState,
  StructuredSecretInput,
  SynthesizeNotesInput,
  TaskBoardColumn,
  TaskPriority,
  TextTransformInput,
  TextTransformPreset,
  TriageApplyInput,
  VaultItem,
  VaultQuery,
  VoiceDictationInput,
} from '@shared/types';
import { APP_VERSION } from '@shared/app-version';
import { computeThemeTokens } from '@shared/color-engine';
import { normalizeCardExpiry, recoverBankCardExpiry } from '@shared/russian-event-parser';
import { DEFAULT_MONTHLY_CAP_USD, SECRET_CLIPBOARD_WIPE_MS } from '@shared/constants';
import { normalizeShortcutAccelerator } from '@shared/shortcuts';
import { generateTotp, parseOtpAuthUri } from '@shared/totp';
import {
  fetchCloudAiQuota,
  type CloudAiProxyConfig,
} from './ai/cloud-proxy';
import {
  askVaultWithAi,
  previewSmartTriageWithAi,
  synthesizeNotesWithAi,
  testAiProviderConnection,
} from './ai/enricher';
import { transformNoteText } from './ai/text-studio';
import { buildDiagnosticsReport } from './diagnostics';
import { dictateToNote } from './pipeline/audio-pipeline';
import { importArchiveFromPath, importArchiveJson } from './bridges/archive-importer';
import type { ClipperServer } from './bridges/clipper-server';
import {
  exportEventsToIcal,
  GoogleCalendarBridge,
  parseIcalFeed,
  parseRussianDateExpression,
} from './bridges/google-calendar';
import { ensureDemoSeeded } from './db/demo-seed';
import type { UpdateItemPatch, VaultRepository } from './db/repository';
import { registerV8IntegrationIpc } from './ipc-integrations';
import { CapturePipeline } from './pipeline/capture-pipeline';
import { readClipboardSnapshot } from './pipeline/clipboard-helper';
import { sanitizeVideoCacheLimitMb } from './pipeline/video-cache';
import { analyzeForSecret, detectCardBrand, formatCardDigits, maskLoginHint } from './security/secret-shield';
import type { SyncAuthInput, SyncServerConfigInput } from '@shared/sync-contract';
import { ClipboardWiper, VaultCrypto } from './security/vault-crypto';
import type { SyncEngine } from './sync/sync-engine';
import type { AppUpdaterController } from './updater';
import type { WindowManager } from './windows';

export interface AppRuntimeServices {
  dataDir?: string;
  repo: VaultRepository;
  cryptoVault: VaultCrypto;
  pipeline: CapturePipeline;
  windows: WindowManager;
  gcalBridge?: GoogleCalendarBridge;
  clipper: ClipperServer;
  syncEngine?: SyncEngine;
  updater?: AppUpdaterController;
  getCloudAiProxyConfig?: () => CloudAiProxyConfig | null;
  getSettingsState: () => SettingsState;
  getApiKeyForProvider: (p: AiProvider) => string | null;
  setApiKeyForProvider: (p: 'openrouter' | 'google_ai_studio', key: string) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setScreenProtection?: (enabled: boolean, source?: 'vault' | 'hud') => void;
  syncScreenProtection?: () => void;
  applyWindowBackground?: () => void;
  refreshReminders?: () => void;
  reapplyShortcuts?: () => void;
  onLocaleChanged?: (locale: AppLocale) => void;
  clipperControl?: {
    getPairingInfo: () => { pairingCode: string; pairedCount: number };
    resetPairing: () => { pairingCode: string; pairedCount: number };
  };
}

const PIN_LOCKOUT_TIERS_MS: Array<{ minFails: number; durationMs: number }> = [
  { minFails: 11, durationMs: 30 * 60_000 },
  { minFails: 9, durationMs: 10 * 60_000 },
  { minFails: 7, durationMs: 2 * 60_000 },
  { minFails: 5, durationMs: 30_000 },
];

export function computePinLockoutDurationMs(failedAttempts: number): number {
  for (const tier of PIN_LOCKOUT_TIERS_MS) {
    if (failedAttempts >= tier.minFails) return tier.durationMs;
  }
  return 0;
}

export async function writeConcealedClipboardText(text: string): Promise<void> {
  if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
    try {
      const entries: Record<string, string | Blob> = {
        'text/plain': text,
      };
      if (process.platform === 'win32') {
        entries[
          'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"'
        ] = new Blob([new Uint8Array([1, 0, 0, 0])]);
        entries['electron application/osclipboard;format="CanIncludeInClipboardHistory"'] =
          new Blob([new Uint8Array([0, 0, 0, 0])]);
        entries['electron application/osclipboard;format="CanUploadToCloudClipboard"'] =
          new Blob([new Uint8Array([0, 0, 0, 0])]);
      } else if (process.platform === 'darwin') {
        entries['electron application/osclipboard;format="org.nspasteboard.TransientType"'] =
          new Blob([new Uint8Array(0)]);
        entries['electron application/osclipboard;format="org.nspasteboard.ConcealedType"'] =
          new Blob([new Uint8Array(0)]);
        entries['electron application/osclipboard;format="org.nspasteboard.AutoGeneratedType"'] =
          new Blob([new Uint8Array(0)]);
      }
      await clipboard.write([new ClipboardItem(entries)]);
      return;
    } catch {
      // Fallback cleanly to writeText on mocked or constrained clipboards
    }
  }
  await clipboard.writeText(text);
}

export function redactLockedSecretItem(item: VaultItem, locale: AppLocale = 'ru'): VaultItem {
  if (item.dna !== 'secret') return item;
  const isEn = locale === 'en';
  const cleanedTitle = item.title
    .replace(/\s*·?\s*••••\s*\d{2,6}/g, '')
    .replace(/\d{4,}/g, '••••')
    .trim();
  const safeKindLabel =
    item.secretMeta?.kind === 'bank_card'
      ? isEn
        ? 'Bank card'
        : 'Банковская карта'
      : item.secretMeta?.kind === 'api_key'
        ? isEn
          ? 'Access key'
          : 'Ключ доступа'
        : item.secretMeta?.kind === 'seed'
          ? isEn
            ? 'Recovery phrase'
            : 'Фраза восстановления'
          : item.secretMeta?.kind === 'note'
            ? isEn
              ? 'Secret note'
              : 'Секретная заметка'
            : isEn
              ? 'Secret'
              : 'Секрет';
  return {
    ...item,
    title: cleanedTitle || safeKindLabel,
    body: '',
    summary: isEn ? 'Protected by master PIN' : 'Защищено мастер-кодом',
    ocrText: '',
    extractedActions: [],
    secretMeta: item.secretMeta
      ? {
          ...item.secretMeta,
          loginHint: '',
          last4: undefined,
          expiry: undefined,
        }
      : null,
  };
}

const ALLOWED_SUBKIND = new Set<string>(['contact', 'post', 'checklist', 'video_ref']);

export function sanitizeUpdateItemPatch(raw: unknown): UpdateItemPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: UpdateItemPatch = {};

  if (src.subKind === null) {
    out.subKind = null;
  } else if (typeof src.subKind === 'string' && ALLOWED_SUBKIND.has(src.subKind)) {
    out.subKind = src.subKind as ItemSubKind;
  }
  if (typeof src.orbit === 'string') out.orbit = src.orbit;
  if (typeof src.focusBoardId === 'string' || src.focusBoardId === null) {
    out.focusBoardId = src.focusBoardId;
  }
  if (typeof src.title === 'string') out.title = src.title;
  if (typeof src.body === 'string') out.body = src.body;
  if (typeof src.summary === 'string') out.summary = src.summary;
  if (typeof src.url === 'string' || src.url === null) out.url = src.url;
  if (typeof src.platform === 'string' || src.platform === null) out.platform = src.platform;
  if (src.mediaMeta === null || (typeof src.mediaMeta === 'object' && !Array.isArray(src.mediaMeta))) {
    out.mediaMeta = src.mediaMeta as UpdateItemPatch['mediaMeta'];
  }
  if (Array.isArray(src.extractedActions)) {
    out.extractedActions = src.extractedActions as UpdateItemPatch['extractedActions'];
  }
  if (Array.isArray(src.tags)) {
    out.tags = src.tags.filter((t): t is string => typeof t === 'string');
  }
  if (typeof src.isPinned === 'boolean') out.isPinned = src.isPinned;
  if (typeof src.isArchived === 'boolean') out.isArchived = src.isArchived;
  if (src.remindAt === null || (typeof src.remindAt === 'number' && Number.isFinite(src.remindAt))) {
    out.remindAt = src.remindAt;
  }
  if (
    src.remindedAt === null ||
    (typeof src.remindedAt === 'number' && Number.isFinite(src.remindedAt))
  ) {
    out.remindedAt = src.remindedAt;
  }
  if (src.canvasX === null || (typeof src.canvasX === 'number' && Number.isFinite(src.canvasX))) {
    out.canvasX = src.canvasX;
  }
  if (src.canvasY === null || (typeof src.canvasY === 'number' && Number.isFinite(src.canvasY))) {
    out.canvasY = src.canvasY;
  }
  if (src.canvasW === null || (typeof src.canvasW === 'number' && Number.isFinite(src.canvasW))) {
    out.canvasW = src.canvasW;
  }
  if (src.canvasH === null || (typeof src.canvasH === 'number' && Number.isFinite(src.canvasH))) {
    out.canvasH = src.canvasH;
  }
  if (src.canvasFrame === null || typeof src.canvasFrame === 'string') {
    out.canvasFrame = src.canvasFrame;
  }
  if (Array.isArray(src.annotations)) {
    out.annotations = src.annotations as UpdateItemPatch['annotations'];
  }
  if (Array.isArray(src.linksOut)) {
    out.linksOut = src.linksOut.filter((x): x is string => typeof x === 'string');
  }

  return out;
}

export function registerIpcHandlers(svc: AppRuntimeServices): {
  clearClipboardNow: () => Promise<void>;
  flushPendingDeletes: () => void;
  lockVaultIfProtected: () => void;
} {
  const isTrustedEvent = (e: IpcMainInvokeEvent): boolean => {
    if (!svc.windows.isOwnWebContents(e.sender.id)) return false;
    const frameUrl = e.senderFrame?.url || e.sender.getURL();
    if (!svc.windows.isAllowedSurfaceUrl(frameUrl)) return false;
    if (e.senderFrame && e.senderFrame !== e.sender.mainFrame) return false;
    return true;
  };

  const getLocale = (): AppLocale => svc.getSettingsState().locale ?? svc.repo.getLocale();

  const handleTrusted = <Args extends unknown[], R>(
    channel: string,
    handler: (e: IpcMainInvokeEvent, ...args: Args) => R | Promise<R>
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedEvent(event)) {
        throw new Error(
          getLocale() === 'en' ? 'Untrusted request source' : 'Недоверенный источник запроса'
        );
      }
      return handler(event, ...(args as Args));
    });
  };

  const wiper = new ClipboardWiper();
  const gcalBridge = svc.gcalBridge ?? new GoogleCalendarBridge(svc.repo, svc.cryptoVault);
  let secretClipboardUntil = 0;
  let secretClipboardValue = '';

  const getPersistedPinLockState = () => {
    const attempts = Number(svc.repo.getSetting('pin_failed_attempts') || '0') || 0;
    const lockedUntil = Number(svc.repo.getSetting('pin_locked_until') || '0') || 0;
    return { attempts, lockedUntil };
  };

  const resetPersistedPinLockState = () => {
    svc.repo.setSetting('pin_failed_attempts', '0');
    svc.repo.setSetting('pin_locked_until', '0');
  };

  const emitSettings = () => {
    svc.windows.broadcast('settings:updated', svc.getSettingsState());
  };

  const emitCountsChanged = () => {
    svc.windows.broadcast('vault:orbits-changed', undefined);
    svc.windows.broadcast('vault:boards-changed', undefined);
  };

  const lockVaultIfProtected = (broadcastUpdate = true) => {
    const state = svc.getSettingsState();
    const hasPin = Boolean(state.hasMasterPin || svc.cryptoVault.isPinProtected());
    if (!hasPin) return;
    svc.cryptoVault.lock();
    svc.setVaultUnlocked(false);
    svc.syncScreenProtection?.();
    secretClipboardUntil = 0;
    secretClipboardValue = '';
    void wiper.clearNow(
      (txt) => clipboard.writeText(txt),
      () => clipboard.readText()
    );
    if (broadcastUpdate) emitSettings();
  };

  handleTrusted('vault:query', (_e, q?: VaultQuery) => {
    const s = svc.getSettingsState();
    const locale = s.locale ?? svc.repo.getLocale();
    const vaultLocked = Boolean(s.hasMasterPin && !s.vaultUnlocked);
    const effectiveQuery: VaultQuery =
      vaultLocked && q?.search?.trim() ? { ...q, includeSecrets: false } : (q ?? {});
    const items = svc.repo.queryItems(effectiveQuery);
    if (!vaultLocked) return items;
    return items.map((it) => (it.dna === 'secret' ? redactLockedSecretItem(it, locale) : it));
  });
  handleTrusted('vault:get-item', (_e, id: string, opts?: { includeDeleted?: boolean }) => {
    const cleanId = String(id ?? '').trim();
    if (!cleanId) return null;
    const item = svc.repo.getItemById(cleanId, Boolean(opts?.includeDeleted));
    if (!item) return null;
    const s = svc.getSettingsState();
    const vaultLocked = Boolean(s.hasMasterPin && !s.vaultUnlocked);
    if (vaultLocked && item.dna === 'secret') {
      const locale = s.locale ?? svc.repo.getLocale();
      return redactLockedSecretItem(item, locale);
    }
    return item;
  });
  handleTrusted('vault:stats', () => svc.repo.getStats());

  handleTrusted('vault:capture', async (_e, input: CaptureInput) => {
    const sanitizedInput: CaptureInput = { ...(input ?? {}) };
    delete sanitizedInput.filePath;
    delete sanitizedInput.imageFilePath;
    delete sanitizedInput.videoPath;
    const item = await svc.pipeline.capture(sanitizedInput);
    emitCountsChanged();
    return item;
  });

  handleTrusted(
    'vault:capture-clipboard',
    async (
      _e,
      opts?: CaptureMode | { mode?: CaptureMode; orbitOverride?: string; focusBoardId?: string | null }
    ) => {
      const resolvedOpts =
        typeof opts === 'string' ? { mode: opts as CaptureMode } : opts ?? {};
      const snap = await readClipboardSnapshot(clipboard, nativeImage);
      if (snap.imageBase64) {
        const item = await svc.pipeline.capture({
          imageBase64: snap.imageBase64,
          mode: resolvedOpts.mode,
          orbitOverride: resolvedOpts.orbitOverride,
          focusBoardId: resolvedOpts.focusBoardId,
          source: 'clipboard_snatch',
        });
        emitCountsChanged();
        return item;
      }

      if (!snap.text) return null;
      const item = await svc.pipeline.capture({
        text: snap.text,
        mode: resolvedOpts.mode,
        orbitOverride: resolvedOpts.orbitOverride,
        focusBoardId: resolvedOpts.focusBoardId,
        source: 'clipboard_snatch',
      });
      emitCountsChanged();
      return item;
    }
  );

  handleTrusted('vault:update-item', (_e, id: string, patch: unknown) => {
    const existing = svc.repo.getItemById(id);
    if (!existing) return null;
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (existing.dna === 'secret' && s.hasMasterPin && !s.vaultUnlocked) {
      throw new Error(isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом');
    }
    const cleanPatch = sanitizeUpdateItemPatch(patch);
    const skipAutoRevision = Boolean(
      patch &&
        typeof patch === 'object' &&
        !Array.isArray(patch) &&
        (patch as Record<string, unknown>).skipAutoRevision === true
    );
    const effectivePatch: UpdateItemPatch = { ...cleanPatch };
    if (existing.dna === 'secret' && typeof cleanPatch.title === 'string' && cleanPatch.title.trim()) {
      const nextService = cleanPatch.title.trim();
      effectivePatch.secretMeta = existing.secretMeta
        ? { ...existing.secretMeta, service: nextService }
        : { service: nextService, loginHint: '', kind: 'password' };
      const rawRow = svc.repo.getRawRowById(id);
      if (rawRow?.encrypted_payload) {
        try {
          const decoded = svc.cryptoVault.decryptSecret(rawRow.encrypted_payload);
          effectivePatch.encryptedPayload = svc.cryptoVault.encryptSecret({
            ...decoded,
            service: nextService,
          });
        } catch {
          // Keep existing ciphertext intact
        }
      }
    }
    const updated = svc.repo.updateItem(id, effectivePatch, { skipAutoRevision });
    if (updated) {
      svc.windows.broadcast('vault:item-upserted', updated);
      if (
        cleanPatch.orbit !== undefined ||
        cleanPatch.focusBoardId !== undefined ||
        cleanPatch.isArchived !== undefined ||
        cleanPatch.isPinned !== undefined
      ) {
        emitCountsChanged();
      }
      if (cleanPatch.remindAt !== undefined || cleanPatch.isArchived !== undefined) {
        svc.refreshReminders?.();
      }
    }
    return updated;
  });

  handleTrusted('vault:delete-item', (_e, id: string) => {
    const existing = svc.repo.getItemById(id, { includeDeleted: true });
    if (!existing) return false;
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (existing.dna === 'secret' && s.hasMasterPin && !s.vaultUnlocked) {
      throw new Error(isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом');
    }
    let ok = false;
    if (existing.deletedAt != null) {
      const purged = svc.repo.purgeItemPermanently(id);
      ok = purged.purged;
      if (purged.freedMedia.length > 0) {
        svc.pipeline.cleanupUnreferencedMedia(purged.freedMedia);
      }
    } else {
      ok = svc.repo.deleteItem(id);
    }
    if (ok) {
      svc.windows.broadcast('vault:item-deleted', id);
      emitCountsChanged();
      if (existing.remindAt) svc.refreshReminders?.();
    }
    return ok;
  });

  handleTrusted('vault:purge-item', (_e, id: string) => {
    const existing = svc.repo.getItemById(id, { includeDeleted: true });
    if (!existing) return false;
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (existing.dna === 'secret' && s.hasMasterPin && !s.vaultUnlocked) {
      throw new Error(isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом');
    }
    const res = svc.repo.purgeItemPermanently(id);
    if (res.purged) {
      if (res.freedMedia.length > 0) {
        svc.pipeline.cleanupUnreferencedMedia(res.freedMedia);
      }
      svc.windows.broadcast('vault:item-deleted', id);
      emitCountsChanged();
      if (existing.remindAt) svc.refreshReminders?.();
    }
    return res.purged;
  });

  handleTrusted('vault:empty-trash', () => {
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (s.hasMasterPin && !s.vaultUnlocked) {
      const trashedSecrets = svc.repo.queryItems({ onlyDeleted: true, dna: 'secret', limit: 1 });
      if (trashedSecrets.length > 0) {
        throw new Error(
          isEn
            ? 'Unlock Vault with master PIN to purge secrets in Trash'
            : 'Разблокируй Сейф мастер-кодом, чтобы очистить секреты в корзине'
        );
      }
    }
    const res = svc.repo.emptyTrash();
    if (res.freedMedia.length > 0) {
      svc.pipeline.cleanupUnreferencedMedia(res.freedMedia);
    }
    if (res.purgedIds.length > 6) {
      svc.windows.broadcast('vault:batch-synced', undefined);
    } else {
      for (const id of res.purgedIds) {
        svc.windows.broadcast('vault:item-deleted', id);
      }
    }
    if (res.purgedCount > 0) {
      emitCountsChanged();
      svc.refreshReminders?.();
    }
    return { purgedCount: res.purgedCount };
  });

  handleTrusted('vault:restore-item', (_e, id: string) => {
    const restored = svc.repo.restoreItem(id);
    if (!restored) return null;
    svc.windows.broadcast('vault:item-upserted', restored);
    emitCountsChanged();
    if (restored.remindAt) svc.refreshReminders?.();
    return restored;
  });

  handleTrusted('vault:duplicate-item', (_e, id: string) => {
    const src = svc.repo.getItemById(id);
    if (!src || src.dna === 'secret') return null;
    const isEn = getLocale() === 'en';
    const created = svc.repo.createItem({
      dna: src.dna,
      subKind: src.subKind,
      orbit: src.orbit,
      modeCaptured: src.modeCaptured,
      focusBoardId: src.focusBoardId,
      title: `${src.title} ${isEn ? '(copy)' : '(копия)'}`.slice(0, 96),
      body: src.body,
      summary: src.summary,
      url: src.url,
      domain: src.domain,
      platform: src.platform,
      imagePath: src.imagePath,
      thumbPath: src.thumbPath,
      mediaPath: src.mediaPath,
      mediaType: src.mediaType,
      mediaDurationSec: src.mediaDurationSec,
      mediaMeta: src.mediaMeta,
      ogImageUrl: src.ogImageUrl,
      ocrText: src.ocrText,
      extractedActions: src.extractedActions,
      colorPalette: src.colorPalette,
      tags: src.tags,
      source: 'vault_ui',
      contentHash: crypto.randomUUID(),
      aiStatus: src.aiStatus,
      aiConfidence: src.aiConfidence,
    });
    svc.windows.broadcast('vault:item-upserted', created);
    emitCountsChanged();
    return created;
  });

  handleTrusted('vault:export-markdown', async (_e, id: string) => {
    const item = svc.repo.getItemById(id);
    if (!item || item.dna === 'secret') return { saved: false, path: null };
    const isEn = getLocale() === 'en';
    const safeFileName = (item.title || (isEn ? 'note' : 'zametka'))
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 60) || (isEn ? 'note' : 'zametka');
    const saveOpts: Electron.SaveDialogOptions = {
      title: isEn ? 'Export note as Markdown' : 'Экспорт заметки в Markdown',
      defaultPath: `${safeFileName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const res = svc.windows.vault
      ? await dialog.showSaveDialog(svc.windows.vault, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (res.canceled || !res.filePath) return { saved: false, path: null };
    const md = [
      `# ${item.title}`,
      item.tags.length > 0 ? `*${isEn ? 'Tags' : 'Теги'}: ${item.tags.map((t) => `#${t}`).join(' ')}*` : '',
      item.url ? `${isEn ? 'Source' : 'Источник'}: ${item.url}` : '',
      '',
      item.body || item.summary || '',
    ]
      .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
      .join('\n\n');
    await fs.promises.writeFile(res.filePath, md, 'utf8');
    return { saved: true, path: res.filePath };
  });

  handleTrusted('vault:related-items', (_e, itemId: string) => ({
    related: svc.repo.listRelatedItems(itemId, 6),
    backlinks: svc.repo.listBacklinksToItem(itemId),
  }));

  handleTrusted('vault:inventory-summary', () => {
    const s = svc.getSettingsState();
    const vaultLocked = Boolean(s.hasMasterPin && !s.vaultUnlocked);
    return svc.repo.getVaultInventorySummary(Date.now(), vaultLocked);
  });
  handleTrusted('vault:serendipity', (_e, limit?: number) => svc.repo.pickSerendipityItems(limit));
  handleTrusted('vault:reminders-due', (_e, endMs?: number) =>
    svc.repo.listRemindersWindow(endMs ?? Date.now() + 24 * 60 * 60 * 1000)
  );

  handleTrusted('vault:reprocess-item', async (_e, id: string) => svc.pipeline.reprocessItem(id));
  handleTrusted('vault:reprocess-buffer', async () => svc.pipeline.reprocessBufferAll());

  handleTrusted('vault:seed-examples', async () => {
    const count = await ensureDemoSeeded(svc.repo, svc.cryptoVault, svc.pipeline, true);
    if (count > 0) {
      for (const item of svc.repo.queryItems({ limit: 8 })) {
        svc.windows.broadcast('vault:item-upserted', item);
      }
      emitCountsChanged();
    }
    return count;
  });

  handleTrusted('vault:clear-demo', () => {
    const demoImgs = svc.repo.getDemoImagePaths();
    const removed = svc.repo.clearDemoItems();
    svc.pipeline.cleanupUnreferencedMedia(demoImgs);
    svc.windows.broadcast('vault:item-deleted', '__demo_cleared__');
    emitCountsChanged();
    return removed;
  });

  // Secrets & PIN
  handleTrusted('secret:reveal', (_e, id: string) => {
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (s.hasMasterPin && !s.vaultUnlocked) {
      throw new Error(isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом');
    }
    const item = svc.repo.getItemById(id);
    const rawEnc = svc.repo.getRawEncryptedPayload(id);
    if (!rawEnc) return null;
    const payload = svc.cryptoVault.decryptSecret(rawEnc);
    if (item?.secretMeta?.kind === 'bank_card' && !item.secretMeta.expiry) {
      const recoveredExpiry = recoverBankCardExpiry(payload.expiry, payload.notes);
      if (recoveredExpiry) {
        const synced = svc.repo.updateItem(id, {
          secretMeta: { ...item.secretMeta, expiry: recoveredExpiry },
        });
        if (synced) svc.windows.broadcast('vault:item-upserted', synced);
      }
    }
    return payload;
  });

  const trackAndScheduleSecretWipeMs = (secretVal: string, delayMs: number): number => {
    const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : SECRET_CLIPBOARD_WIPE_MS;
    const guardMs = safeDelayMs > 0 ? safeDelayMs : SECRET_CLIPBOARD_WIPE_MS;
    secretClipboardUntil = Date.now() + guardMs;
    secretClipboardValue = secretVal;
    let initialSkipped = false;
    wiper.scheduleCopy(
      secretVal,
      (txt) => {
        if (!initialSkipped) {
          initialSkipped = true;
          return;
        }
        return clipboard.writeText(txt);
      },
      () => clipboard.readText(),
      safeDelayMs
    );
    return Math.round(safeDelayMs / 1000);
  };

  const trackAndScheduleSecretWipe = (
    secretVal: string,
    wipeSecondsSetting: number
  ): number => {
    const wipeSec = Number.isFinite(wipeSecondsSetting)
      ? Math.max(0, Math.round(wipeSecondsSetting))
      : Math.round(SECRET_CLIPBOARD_WIPE_MS / 1000);
    trackAndScheduleSecretWipeMs(secretVal, wipeSec * 1000);
    return wipeSec;
  };

  handleTrusted('secret:copy', async (_e, id: string) => {
    const s = svc.getSettingsState();
    if (s.hasMasterPin && !s.vaultUnlocked) {
      return { ok: false, locked: true, wipeSeconds: 0 };
    }
    const item = svc.repo.getItemById(id);
    const rawEnc = svc.repo.getRawEncryptedPayload(id);
    if (!rawEnc) return { ok: false, wipeSeconds: 0 };
    const payload = svc.cryptoVault.decryptSecret(rawEnc);
    const valueToCopy =
      item?.secretMeta?.kind === 'bank_card'
        ? payload.secretValue.replace(/\s+/g, '')
        : payload.secretValue;
    await writeConcealedClipboardText(valueToCopy);
    const wipeSeconds = trackAndScheduleSecretWipe(valueToCopy, s.clipboardAutoWipeSeconds);
    return { ok: true, wipeSeconds };
  });

  handleTrusted(
    'secret:copy-field',
    async (_e, id: string, field: SecretCopyField) => {
      const s = svc.getSettingsState();
      if (s.hasMasterPin && !s.vaultUnlocked) {
        return { ok: false, locked: true, wipeSeconds: 0 };
      }
      const item = svc.repo.getItemById(id);
      const rawEnc = svc.repo.getRawEncryptedPayload(id);
      if (!rawEnc) return { ok: false, wipeSeconds: 0 };
      const payload = svc.cryptoVault.decryptSecret(rawEnc);
      if (field === 'login') {
        const loginVal = (payload.login || payload.cardHolder || '').trim();
        if (!loginVal) return { ok: false, wipeSeconds: 0 };
        await writeConcealedClipboardText(loginVal);
        return { ok: true, wipeSeconds: 0 };
      }
      if (field === 'expiry') {
        const expVal = (payload.expiry || item?.secretMeta?.expiry || '').trim();
        if (!expVal) return { ok: false, wipeSeconds: 0 };
        await writeConcealedClipboardText(expVal);
        return { ok: true, wipeSeconds: 0 };
      }
      if (field === 'notes') {
        const notesVal = (payload.notes || '').trim();
        if (!notesVal) return { ok: false, wipeSeconds: 0 };
        await writeConcealedClipboardText(notesVal);
        const wipeSeconds = trackAndScheduleSecretWipe(notesVal, s.clipboardAutoWipeSeconds);
        return { ok: true, wipeSeconds };
      }
      if (field === 'totp') {
        if (!payload.totpSecret) return { ok: false, wipeSeconds: 0 };
        try {
          const snap = generateTotp({
            secret: payload.totpSecret,
            algorithm: payload.totpAlgorithm,
            digits: payload.totpDigits,
            period: payload.totpPeriod,
          });
          await writeConcealedClipboardText(snap.code);
          const wipeSeconds = trackAndScheduleSecretWipe(snap.code, s.clipboardAutoWipeSeconds);
          return { ok: true, wipeSeconds };
        } catch {
          return { ok: false, wipeSeconds: 0 };
        }
      }
      const rawField = field === 'cvv' ? payload.cvv || '' : payload.secretValue || '';
      if (!rawField) return { ok: false, wipeSeconds: 0 };
      const valueToCopy =
        field === 'secretValue' && item?.secretMeta?.kind === 'bank_card'
          ? rawField.replace(/\s+/g, '')
          : rawField;
      await writeConcealedClipboardText(valueToCopy);
      const wipeSeconds = trackAndScheduleSecretWipe(valueToCopy, s.clipboardAutoWipeSeconds);
      return { ok: true, wipeSeconds };
    }
  );

  handleTrusted('secret:get-totp-code', (_e, itemId: string) => {
    const s = svc.getSettingsState();
    if (s.hasMasterPin && !s.vaultUnlocked) {
      return null;
    }
    const rawEnc = svc.repo.getRawEncryptedPayload(itemId);
    if (!rawEnc) return null;
    try {
      const payload = svc.cryptoVault.decryptSecret(rawEnc);
      if (!payload.totpSecret) return null;
      return generateTotp({
        secret: payload.totpSecret,
        algorithm: payload.totpAlgorithm,
        digits: payload.totpDigits,
        period: payload.totpPeriod,
      });
    } catch {
      return null;
    }
  });

  const handleSaveStructuredSecret = (input: StructuredSecretInput) => {
    const s = svc.getSettingsState();
    const locale = s.locale ?? svc.repo.getLocale();
    const isEn = locale === 'en';
    if ((input.id || svc.cryptoVault.isLocked()) && s.hasMasterPin && !s.vaultUnlocked) {
      throw new Error(isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом');
    }
    const cleanService = (input.service || '').trim() || (isEn ? 'Personal Vault' : 'Личный сейф');
    const rawValue = (input.secretValue || '').trim();
    const digits = rawValue.replace(/\D/g, '');
    const isCard = input.kind === 'bank_card';
    const cardBrand = isCard
      ? detectCardBrand(digits, locale) || (isEn ? 'Bank card' : 'Банковская карта')
      : undefined;
    const last4 = isCard && digits.length >= 4 ? digits.slice(-4) : undefined;
    const formattedValue = isCard && digits.length >= 12 ? formatCardDigits(digits) : rawValue;
    const normalizedExpiry = isCard ? normalizeCardExpiry(input.expiry) || input.expiry?.trim() || undefined : undefined;

    const existingItem = input.id ? svc.repo.getItemById(input.id) : null;
    let existingPayload: SecretPayload | null = null;
    if (input.id) {
      const rawExistingEnc = svc.repo.getRawEncryptedPayload(input.id);
      if (rawExistingEnc) {
        try {
          existingPayload = svc.cryptoVault.decryptSecret(rawExistingEnc);
        } catch {
          existingPayload = null;
        }
      }
    }

    // Parse & isolate TOTP 2FA secret strictly inside encrypted SecretPayload (never in SecretMeta or FTS5)
    let totpFields: Pick<
      SecretPayload,
      'totpSecret' | 'totpIssuer' | 'totpAccount' | 'totpAlgorithm' | 'totpDigits' | 'totpPeriod'
    > = {};
    if (input.totpUriOrSecret === undefined) {
      if (existingPayload?.totpSecret) {
        totpFields = {
          totpSecret: existingPayload.totpSecret,
          totpIssuer: existingPayload.totpIssuer,
          totpAccount: existingPayload.totpAccount,
          totpAlgorithm: input.totpAlgorithm ?? existingPayload.totpAlgorithm,
          totpDigits: input.totpDigits ?? existingPayload.totpDigits,
          totpPeriod: input.totpPeriod ?? existingPayload.totpPeriod,
        };
      }
    } else if (input.totpUriOrSecret.trim() !== '') {
      const parsedTotp = parseOtpAuthUri(input.totpUriOrSecret);
      if (!parsedTotp) {
        throw new Error(
          isEn
            ? 'Could not recognize 2FA key — paste the full secret key or authenticator link'
            : 'Не удалось распознать ключ 2FA — вставь секретный ключ целиком или ссылку из приложения-аутентификатора'
        );
      }
      totpFields = {
        totpSecret: parsedTotp.secret,
        ...(parsedTotp.issuer ? { totpIssuer: parsedTotp.issuer } : {}),
        ...(parsedTotp.account ? { totpAccount: parsedTotp.account } : {}),
        totpAlgorithm: input.totpAlgorithm ?? parsedTotp.algorithm,
        totpDigits: input.totpDigits ?? parsedTotp.digits,
        totpPeriod:
          typeof input.totpPeriod === 'number' && Number.isInteger(input.totpPeriod) && input.totpPeriod >= 5
            ? input.totpPeriod
            : parsedTotp.period,
      };
    }

    const hasTotp = Boolean(totpFields.totpSecret);

    const secretMeta: SecretMeta = {
      service: cleanService,
      loginHint: isCard
        ? last4
          ? `•••• ${last4}`
          : isEn
            ? 'Card'
            : 'Карта'
        : maskLoginHint(input.login || input.cardHolder || '') ||
          (input.kind === 'api_key'
            ? rawValue.length > 8
              ? `••••${rawValue.slice(-4)}`
              : '••••'
            : ''),
      kind: input.kind,
      cardBrand,
      last4,
      hasCvv: isCard ? Boolean(input.cvv?.trim()) : undefined,
      expiry: normalizedExpiry,
      hasLogin: !isCard ? Boolean((input.login || input.cardHolder || '').trim()) : undefined,
      ...(hasTotp
        ? {
            hasTotp: true,
            totpDigits: totpFields.totpDigits ?? 6,
            totpPeriod: totpFields.totpPeriod ?? 30,
          }
        : { hasTotp: false }),
    };

    const secretPayload: SecretPayload = {
      service: cleanService,
      login: (input.login || '').trim(),
      secretValue: formattedValue,
      notes: (input.notes || '').trim(),
      cardHolder: input.cardHolder?.trim() || undefined,
      expiry: normalizedExpiry,
      cvv: input.cvv?.trim() || undefined,
      ...(hasTotp ? totpFields : {}),
    };

    const encrypted = svc.cryptoVault.encryptSecret(secretPayload);
    const orbitsBefore = svc.repo.listOrbits();
    let targetOrbit = '';
    if (input.orbit === '') {
      targetOrbit = '';
    } else if (input.orbit && orbitsBefore.some((o) => o.id === input.orbit)) {
      targetOrbit = input.orbit;
    } else if (existingItem) {
      targetOrbit = existingItem.orbit;
    } else {
      // Keep Vault secrets cleanly inside Сейф without spawning sidebar orbits
      targetOrbit = '';
    }
    const finalTitle =
      input.title?.trim() ||
      (isCard
        ? `${cleanService}${last4 ? ` · •••• ${last4}` : ''}`
        : `${cleanService} · ${isEn ? 'Access' : 'Доступ'}`);
    const summaryLabel = isCard
      ? cardBrand && cardBrand !== 'Card'
        ? isEn
          ? `Bank card (${cardBrand}) · hidden in Vault`
          : `Банковская карта (${cardBrand}) · скрыта в Сейфе`
        : isEn
          ? 'Bank card · hidden in Vault'
          : 'Банковская карта · скрыта в Сейфе'
      : input.kind === 'api_key'
        ? isEn
          ? 'Access key · hidden in Vault'
          : 'Ключ доступа · скрыт в Сейфе'
        : input.kind === 'seed'
          ? isEn
            ? 'Recovery phrase · hidden in Vault'
            : 'Фраза восстановления · скрыта в Сейфе'
          : input.kind === 'note'
            ? isEn
              ? 'Secret note · hidden in Vault'
              : 'Секретная заметка · скрыта в Сейфе'
            : isEn
              ? 'Login & password · hidden in Vault'
              : 'Логин и пароль · скрыты в Сейфе';

    if (input.id) {
      const updated = svc.repo.updateItem(input.id, {
        dna: 'secret',
        orbit: targetOrbit,
        focusBoardId: input.focusBoardId !== undefined ? input.focusBoardId : undefined,
        title: finalTitle,
        summary: summaryLabel,
        encryptedPayload: encrypted,
        secretMeta,
        tags: input.tags,
        aiStatus: 'skipped_secret',
      });
      if (updated) {
        svc.windows.broadcast('vault:item-upserted', updated);
        emitCountsChanged();
      }
      return updated;
    }

    // Never store unsalted hash of raw secret values in plaintext SQLite
    const contentHash = crypto.randomUUID();

    const created = svc.repo.createItem({
      dna: 'secret',
      orbit: targetOrbit,
      modeCaptured: 'ghost',
      focusBoardId: input.focusBoardId ?? null,
      title: finalTitle,
      body: '',
      summary: summaryLabel,
      encryptedPayload: encrypted,
      secretMeta,
      tags:
        input.tags && input.tags.length > 0
          ? input.tags
          : isEn
            ? ['vault', isCard ? 'card' : 'access']
            : ['сейф', isCard ? 'карта' : 'доступ'],
      source: 'vault_ui',
      contentHash,
      aiStatus: 'skipped_secret',
    });
    svc.windows.broadcast('vault:item-upserted', created);
    emitCountsChanged();
    return created;
  };

  handleTrusted('secret:save-structured', (_e, input: StructuredSecretInput) =>
    handleSaveStructuredSecret(input)
  );
  handleTrusted('secret:update-structured', (_e, input: StructuredSecretInput) => {
    if (!input?.id) {
      throw new Error(
        getLocale() === 'en' ? 'Vault item ID is missing' : 'Не указан идентификатор записи Сейфа'
      );
    }
    return handleSaveStructuredSecret(input);
  });

  handleTrusted('secret:set-pin', async (_e, pin: string | null, currentPin?: string) => {
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    const hasExistingPin = Boolean(s.hasMasterPin || svc.cryptoVault.isPinProtected());
    if (hasExistingPin && !s.vaultUnlocked) {
      throw new Error(
        isEn
          ? 'Unlock Vault with your current master PIN first'
          : 'Сначала разблокируй Сейф текущим мастер-кодом'
      );
    }
    if (hasExistingPin) {
      const cleanCurrent = typeof currentPin === 'string' ? currentPin.trim() : '';
      if (!cleanCurrent) {
        throw new Error(
          isEn
            ? 'Enter your current master PIN to confirm'
            : 'Введи текущий мастер-код для подтверждения'
        );
      }
      let verified = false;
      if (svc.cryptoVault.isPinProtected()) {
        verified = await svc.cryptoVault.verifyPinProtectionAsync(cleanCurrent);
      } else {
        const storedHash = svc.repo.getSetting('master_pin_hash');
        if (storedHash) {
          verified = await VaultCrypto.verifyPinAsync(cleanCurrent, storedHash);
        }
      }
      if (!verified) {
        throw new Error(
          isEn ? 'Current master PIN is incorrect' : 'Неверный текущий мастер-код'
        );
      }
    }
    if (pin === null || pin === '') {
      svc.cryptoVault.removePinProtection();
      svc.repo.setSetting('master_pin_hash', '');
      svc.repo.setSetting('biometric_unlock_enabled', 'false');
      resetPersistedPinLockState();
      svc.setVaultUnlocked(true);
    } else {
      if (typeof pin !== 'string' || pin.trim().length < 4) {
        throw new Error(
          isEn
            ? 'Master PIN must be at least 4 characters'
            : 'Мастер-код должен содержать минимум 4 символа'
        );
      }
      const cleanPin = pin.trim();
      // Eagerly migrate any legacy VDK-encrypted GCal tokens to configKey before wrapping VDK with PIN
      try {
        gcalBridge.getStatus();
      } catch {
        // Non-fatal
      }
      await svc.cryptoVault.setPinProtectionAsync(cleanPin, {
        enableBiometric: Boolean(s.biometricUnlockEnabled),
      });
      svc.repo.setSetting('master_pin_hash', await VaultCrypto.hashPinAsync(cleanPin));
      resetPersistedPinLockState();
      svc.setVaultUnlocked(true);
    }
    emitSettings();
    return true;
  });

  handleTrusted('secret:unlock-pin', async (_e, pin: string) => {
    const stored = svc.repo.getSetting('master_pin_hash');
    const isCryptoPinProtected = svc.cryptoVault.isPinProtected();
    if (!stored && !isCryptoPinProtected) {
      resetPersistedPinLockState();
      svc.setVaultUnlocked(true);
      emitSettings();
      return true;
    }

    const { attempts, lockedUntil } = getPersistedPinLockState();
    const isEn = getLocale() === 'en';
    if (Date.now() < lockedUntil) {
      const waitSec = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
      throw new Error(
        isEn
          ? `Too many failed attempts. Wait ${waitSec}s`
          : `Слишком много неверных попыток. Подожди ${waitSec} с`
      );
    }

    const cleanPin = String(pin ?? '').trim();
    let ok = false;
    if (isCryptoPinProtected) {
      ok = await svc.cryptoVault.unlockWithPinAsync(cleanPin);
      if (ok && !stored) {
        // Self-heal master_pin_hash if DB row was tampered with while PIN-KEK file remained intact
        svc.repo.setSetting('master_pin_hash', await VaultCrypto.hashPinAsync(cleanPin));
      }
    } else if (stored) {
      ok = await VaultCrypto.verifyPinAsync(cleanPin, stored);
      if (ok) {
        // Seamless v8 migration: upgrade legacy DPAPI + SQLite-hash vault to 2-tier PIN-KEK wrapping!
        try {
          gcalBridge.getStatus();
          await svc.cryptoVault.setPinProtectionAsync(cleanPin);
          svc.repo.setSetting('master_pin_hash', await VaultCrypto.hashPinAsync(cleanPin));
        } catch {
          // Keep unlocked even if migration could not write disk in a read-only dir
        }
      }
    }

    if (ok) {
      resetPersistedPinLockState();
      svc.setVaultUnlocked(true);
      emitSettings();
      return true;
    }

    const nextAttempts = attempts + 1;
    svc.repo.setSetting('pin_failed_attempts', String(nextAttempts));
    const lockoutMs = computePinLockoutDurationMs(nextAttempts);
    if (lockoutMs > 0) {
      svc.repo.setSetting('pin_locked_until', String(Date.now() + lockoutMs));
      emitSettings();
      const waitSec = Math.ceil(lockoutMs / 1000);
      const waitLabel =
        waitSec >= 60
          ? `${Math.ceil(waitSec / 60)} ${isEn ? 'min' : 'мин'}`
          : `${waitSec} ${isEn ? 's' : 'с'}`;
      throw new Error(
        isEn
          ? `Too many failed attempts. Wait ${waitLabel}`
          : `Слишком много неверных попыток. Подожди ${waitLabel}`
      );
    }
    return false;
  });

  handleTrusted('secret:lock', () => {
    lockVaultIfProtected(true);
    emitSettings();
    return true;
  });

  handleTrusted('vault:biometric-unlock', async () => {
    const s = svc.getSettingsState();
    const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
    if (!s.hasMasterPin && !svc.cryptoVault.isPinProtected()) {
      return { ok: true };
    }
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: isEn
          ? 'Biometric unlock is available on macOS (Touch ID)'
          : 'Биометрическая разблокировка доступна на macOS (Touch ID)',
      };
    }
    const canTouchId = Boolean(
      typeof systemPreferences?.canPromptTouchID === 'function' &&
        systemPreferences.canPromptTouchID()
    );
    if (!canTouchId) {
      return {
        ok: false,
        error: isEn
          ? 'Touch ID is unavailable on this device'
          : 'Touch ID недоступен на этом устройстве',
      };
    }
    if (!svc.cryptoVault.hasBiometricSlot()) {
      return {
        ok: false,
        error: isEn
          ? 'Enable Touch ID unlock in Vault settings after entering master PIN'
          : 'Включи вход по Touch ID в настройках Сейфа после ввода мастер-кода',
      };
    }
    try {
      await systemPreferences.promptTouchID(
        isEn ? 'Unlock Kapsula Vault' : 'Открыть Сейф Kapsula'
      );
    } catch {
      return {
        ok: false,
        error: isEn ? 'Touch ID verification canceled' : 'Проверка Touch ID отменена',
      };
    }
    const unwrapped = svc.cryptoVault.unlockWithBiometric();
    if (!unwrapped) {
      return {
        ok: false,
        error: isEn
          ? 'Could not decrypt Vault key — enter master PIN'
          : 'Не удалось расшифровать ключ Сейфа — введи мастер-код',
      };
    }
    resetPersistedPinLockState();
    svc.setVaultUnlocked(true);
    emitSettings();
    return { ok: true };
  });

  handleTrusted('vault:set-screen-protection', (e, active: boolean) => {
    const nextActive = Boolean(active);
    const isHudSender = Boolean(
      svc.windows.hud &&
        !svc.windows.hud.isDestroyed() &&
        e.sender.id === svc.windows.hud.webContents.id
    );
    const source: 'vault' | 'hud' = isHudSender ? 'hud' : 'vault';
    if (svc.setScreenProtection) {
      const prefEnabled = svc.getSettingsState().enableScreenProtection !== false;
      svc.setScreenProtection(nextActive, source);
      return prefEnabled && nextActive;
    }
    svc.repo.setSetting('enable_screen_protection', String(nextActive));
    const effective = nextActive && svc.getSettingsState().vaultUnlocked;
    svc.windows.setContentProtection?.(effective);
    emitSettings();
    return nextActive;
  });

  // Orbits & Focus Boards
  handleTrusted('orbit:list', () => svc.repo.listOrbits());
  handleTrusted(
    'orbit:create',
    (_e, input: { name: string; description: string; color?: string; icon?: string }) => {
      const created = svc.repo.createOrbit(input);
      svc.windows.broadcast('vault:orbits-changed', undefined);
      return created;
    }
  );
  handleTrusted('orbit:update', (_e, id: string, patch: OrbitUpdateInput) => {
    const updated = svc.repo.updateOrbit(id, patch);
    if (updated) svc.windows.broadcast('vault:orbits-changed', undefined);
    return updated;
  });
  handleTrusted('orbit:reorder', (_e, ids: string[]) => {
    const next = svc.repo.reorderOrbits(Array.isArray(ids) ? ids : []);
    svc.windows.broadcast('vault:orbits-changed', undefined);
    return next;
  });
  handleTrusted('orbit:delete', (_e, id: string) => {
    const ok = svc.repo.deleteOrbit(id);
    if (ok) svc.windows.broadcast('vault:orbits-changed', undefined);
    return ok;
  });

  handleTrusted('focus:list', () => svc.repo.listFocusBoards());
  handleTrusted('focus:create', (_e, name: string, color?: string, icon?: string, description?: string) => {
    const b = svc.repo.createFocusBoard(name, color, icon, description);
    emitSettings();
    svc.windows.broadcast('vault:boards-changed', undefined);
    return b;
  });
  handleTrusted('focus:update', (_e, id: string, patch: FocusBoardUpdateInput) => {
    const updated = svc.repo.updateFocusBoard(id, patch);
    if (updated) svc.windows.broadcast('vault:boards-changed', undefined);
    return updated;
  });
  handleTrusted('focus:reorder', (_e, ids: string[]) => {
    const next = svc.repo.reorderFocusBoards(Array.isArray(ids) ? ids : []);
    svc.windows.broadcast('vault:boards-changed', undefined);
    return next;
  });
  handleTrusted('focus:set-active', (_e, id: string | null) => {
    svc.repo.setActiveFocusBoard(id);
    emitSettings();
    svc.windows.broadcast('vault:boards-changed', undefined);
  });
  handleTrusted('focus:delete', (_e, id: string) => {
    const ok = svc.repo.deleteFocusBoard(id);
    emitSettings();
    svc.windows.broadcast('vault:boards-changed', undefined);
    return ok;
  });

  // AI, Synthesis, Triage & Budget
  const getCloudProxy = (): CloudAiProxyConfig | null => svc.getCloudAiProxyConfig?.() ?? null;

  handleTrusted('ai:ask-vault', async (_e, question: string, history?: ChatTurn[]) => {
    const s = svc.getSettingsState();
    const vaultLocked = Boolean(s.hasMasterPin && !s.vaultUnlocked);
    return askVaultWithAi({
      repo: svc.repo,
      question,
      history,
      provider: s.aiProvider,
      apiKey: svc.getApiKeyForProvider(s.aiProvider),
      googleAiKey: svc.getApiKeyForProvider('google_ai_studio'),
      openRouterKey: svc.getApiKeyForProvider('openrouter'),
      cloudProxy: getCloudProxy(),
      capUsd: s.monthlyCapUsd,
      vaultLocked,
    });
  });

  handleTrusted('ai:budget', () => {
    const s = svc.getSettingsState();
    const hasKey = Boolean(svc.getApiKeyForProvider(s.aiProvider));
    return svc.repo.getMonthBudgetSummary(
      s.aiProvider,
      s.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
      hasKey
    );
  });

  handleTrusted('ai:get-cloud-quota', async () => {
    return fetchCloudAiQuota({
      cloudProxy: getCloudProxy(),
      hasGoogleKey: Boolean(svc.getApiKeyForProvider('google_ai_studio')),
      hasOpenRouterKey: Boolean(svc.getApiKeyForProvider('openrouter')),
      locale: getLocale(),
    });
  });

  handleTrusted('ai:transform-text', async (_e, input: TextTransformInput) => {
    const text = typeof input?.text === 'string' ? input.text : '';
    const presets: TextTransformPreset[] =
      Array.isArray(input?.presets) && input.presets.length > 0
        ? input.presets
        : [input?.preset ?? 'structure'];
    const locale = getLocale();
    let existing: VaultItem | null = null;
    if (typeof input?.itemId === 'string' && input.itemId) {
      existing = svc.repo.getItemById(input.itemId);
      if (existing?.dna === 'secret') {
        throw new Error(
          locale === 'en'
            ? 'Vault items are never sent to AI processing'
            : 'Записи Сейфа не отправляются в ИИ-обработку'
        );
      }
    }
    const s = svc.getSettingsState();
    const result = await transformNoteText({
      text,
      preset: presets[0],
      presets,
      provider: s.aiProvider,
      apiKey: svc.getApiKeyForProvider(s.aiProvider),
      googleAiKey: svc.getApiKeyForProvider('google_ai_studio'),
      openRouterKey: svc.getApiKeyForProvider('openrouter'),
      cloudProxy: getCloudProxy(),
      capUsd: s.monthlyCapUsd,
      repo: svc.repo,
      locale,
    });
    const didChange = result.changed ?? result.formattedText.trim() !== text.trim();
    if (existing && text.trim() && didChange) {
      const rev = svc.repo.saveItemRevision({
        itemId: existing.id,
        title: existing.title,
        content: text,
        source: 'beautify',
      });
      return { ...result, changed: didChange, preRevisionId: rev.id };
    }
    return { ...result, changed: didChange, preRevisionId: null };
  });

  handleTrusted(
    'ai:synthesize-notes',
    async (
      _e,
      input: SynthesizeNotesInput & { save?: boolean; overrideTitle?: string; overrideBody?: string }
    ) => {
      const ids = Array.isArray(input?.itemIds) ? input.itemIds : [];
      const sourceItems = ids
        .map((id) => svc.repo.getItemById(id))
        .filter((it): it is NonNullable<typeof it> => Boolean(it) && it!.dna !== 'secret');

      const s = svc.getSettingsState();
      const isEn = (s.locale ?? svc.repo.getLocale()) === 'en';
      const preview =
        typeof input?.overrideBody === 'string' && input.overrideBody.trim()
          ? {
              title:
                input.overrideTitle?.trim() ||
                (isEn ? `Summary (${sourceItems.length})` : `Сводка (${sourceItems.length})`),
              body: input.overrideBody.trim(),
              summary: isEn
                ? `Synthesized from ${sourceItems.length} notes`
                : `Сведено из ${sourceItems.length} записей`,
              tags: Array.from(new Set(sourceItems.flatMap((i) => i.tags))).slice(0, 5),
              orbit: input.orbit ?? sourceItems.find((i) => i.orbit)?.orbit ?? '',
              usedCloud: true,
              preservedDetailsCount: sourceItems.length,
            }
          : await synthesizeNotesWithAi({
              repo: svc.repo,
              items: sourceItems,
              mode: input.mode || 'spec',
              instruction: input.instruction,
              provider: s.aiProvider,
              apiKey: svc.getApiKeyForProvider(s.aiProvider),
              googleAiKey: svc.getApiKeyForProvider('google_ai_studio'),
              openRouterKey: svc.getApiKeyForProvider('openrouter'),
              cloudProxy: getCloudProxy(),
              orbits: svc.repo.listOrbits(),
              capUsd: s.monthlyCapUsd,
            });

      if (input.save === false) {
        return { preview, savedItem: null };
      }

      const finalOrbit = input.orbit !== undefined ? input.orbit : preview.orbit;
      const savedItem = svc.repo.createItem({
        dna: 'note',
        orbit: finalOrbit,
        modeCaptured: s.activeMode,
        focusBoardId: input.focusBoardId ?? null,
        title: input.overrideTitle?.trim() || preview.title,
        body: input.overrideBody?.trim() || preview.body,
        summary: preview.summary,
        tags: preview.tags,
        linksOut: sourceItems.map((i) => i.id),
        source: 'vault_ui',
        contentHash: crypto.randomUUID(),
        aiStatus: preview.usedCloud ? 'enriched' : 'local',
      });

      if (input.archiveSources) {
        for (const srcItem of sourceItems) {
          const archived = svc.repo.updateItem(srcItem.id, { isArchived: true });
          if (archived) svc.windows.broadcast('vault:item-deleted', srcItem.id);
        }
      }

      svc.windows.broadcast('vault:item-upserted', savedItem);
      emitCountsChanged();
      return { preview, savedItem };
    }
  );

  handleTrusted('ai:preview-triage', async (_e, itemIds?: string[]) => {
    const s = svc.getSettingsState();
    const all = svc.repo.queryItems({ includeSecrets: false, limit: 500 });
    const filtered =
      Array.isArray(itemIds) && itemIds.length > 0
        ? all.filter((it) => itemIds.includes(it.id))
        : all;
    return previewSmartTriageWithAi({
      repo: svc.repo,
      items: filtered,
      orbits: svc.repo.listOrbits(),
      boards: svc.repo.listFocusBoards(),
      provider: s.aiProvider,
      apiKey: svc.getApiKeyForProvider(s.aiProvider),
      googleAiKey: svc.getApiKeyForProvider('google_ai_studio'),
      openRouterKey: svc.getApiKeyForProvider('openrouter'),
      cloudProxy: getCloudProxy(),
      capUsd: s.monthlyCapUsd,
    });
  });

  handleTrusted('ai:apply-triage', (_e, input: TriageApplyInput) => {
    const createdOrbitIds = new Map<string, string>();
    const existingOrbits = svc.repo.listOrbits();

    for (const proposal of input?.createOrbits ?? []) {
      const dup = existingOrbits.find(
        (o) => o.name.toLowerCase() === proposal.name.trim().toLowerCase()
      );
      const orb =
        dup ||
        svc.repo.createOrbit({
          name: proposal.name,
          description: proposal.description,
          color: proposal.color,
          icon: proposal.icon,
        });
      for (const itemId of proposal.itemIds) {
        createdOrbitIds.set(itemId, orb.id);
      }
    }

    let movedCount = 0;
    for (const mv of input?.moves ?? []) {
      const targetOrbit = createdOrbitIds.get(mv.itemId) ?? mv.orbit;
      const updated = svc.repo.updateItem(mv.itemId, {
        ...(targetOrbit !== undefined ? { orbit: targetOrbit } : {}),
        ...(mv.focusBoardId !== undefined ? { focusBoardId: mv.focusBoardId } : {}),
        ...(mv.tags && mv.tags.length > 0 ? { tags: mv.tags } : {}),
        ...(mv.archive ? { isArchived: true } : {}),
        aiStatus: 'enriched',
      });
      if (updated) {
        movedCount++;
        if (updated.isArchived) {
          svc.windows.broadcast('vault:item-deleted', updated.id);
        } else {
          svc.windows.broadcast('vault:item-upserted', updated);
        }
      }
    }

    for (const [itemId, orbitId] of createdOrbitIds.entries()) {
      if (input?.moves?.some((m) => m.itemId === itemId)) continue;
      const updated = svc.repo.updateItem(itemId, { orbit: orbitId, aiStatus: 'enriched' });
      if (updated) {
        movedCount++;
        svc.windows.broadcast('vault:item-upserted', updated);
      }
    }

    emitCountsChanged();
    return { applied: movedCount };
  });

  handleTrusted('ai:dictate-to-text', async (_e, input: VoiceDictationInput) => {
    const rawB64 = typeof input?.audioBase64 === 'string' ? input.audioBase64 : '';
    const cleanB64 = rawB64.replace(/^data:[^;]+;base64,/, '');
    const buffer = cleanB64 ? Buffer.from(cleanB64, 'base64') : Buffer.alloc(0);
    const mime = typeof input?.mime === 'string' ? input.mime : 'audio/wav';
    const durationSec = typeof input?.durationSec === 'number' ? input.durationSec : 0;

    // Save standalone audio on disk when attaching to an existing note or dictating inline;
    // when saveAsNewItem is true, capture() stores the audio file once to prevent duplicate files.
    const savedAudio =
      buffer.length > 0 && !input?.saveAsNewItem
        ? svc.pipeline.saveStandaloneAudio(buffer, mime)
        : null;

    const s = svc.getSettingsState();
    const googleAiKey = svc.getApiKeyForProvider('google_ai_studio');
    const openRouterKey = svc.getApiKeyForProvider('openrouter');
    const activeKey = svc.getApiKeyForProvider(s.aiProvider);
    const budget = svc.repo.getMonthBudgetSummary(
      s.aiProvider,
      s.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD,
      Boolean(activeKey || googleAiKey || openRouterKey)
    );

    const res = await dictateToNote({
      buffer,
      mime,
      durationSec,
      mode: input?.mode === 'raw' ? 'raw' : 'smart',
      aiProvider: s.aiProvider,
      googleAiKey,
      openRouterKey,
      cloudProxy: getCloudProxy(),
      budgetReached: budget.limitReached,
      capUsd: s.monthlyCapUsd,
      repo: svc.repo,
      onSpendUsd: (usd, isCloudProxy) => {
        if (usd > 0) {
          svc.repo.logAiUsage(s.aiProvider, 'audio-dictation', 0, 0, usd, Boolean(isCloudProxy));
        }
      },
    });

    if (savedAudio && input?.itemId) {
      const target = svc.repo.getItemById(input.itemId);
      if (target && target.dna !== 'secret') {
        const updated = svc.repo.updateItem(target.id, {
          mediaPath: target.mediaPath || savedAudio.filename,
          mediaType: target.mediaType || savedAudio.mime,
          mediaDurationSec: target.mediaDurationSec ?? durationSec,
          mediaMeta: {
            ...(target.mediaMeta ?? {}),
            waveformPeaks: Array.isArray(input.peaks)
              ? input.peaks
              : target.mediaMeta?.waveformPeaks,
            transcript: res.transcript || target.mediaMeta?.transcript,
          },
        });
        if (updated) svc.windows.broadcast('vault:item-upserted', updated);
      }
    }

    let savedItem = undefined;
    if (input?.saveAsNewItem && buffer.length > 0) {
      const nextMediaMeta: Record<string, unknown> = {};
      if (Array.isArray(input.peaks)) {
        nextMediaMeta.waveformPeaks = input.peaks;
      }
      if (res.transcript?.trim()) {
        nextMediaMeta.transcript = res.transcript.trim();
      }
      if (Array.isArray(res.keyPoints) && res.keyPoints.length > 0) {
        nextMediaMeta.keyPoints = res.keyPoints;
      }
      if (Array.isArray(res.actionItems) && res.actionItems.length > 0) {
        nextMediaMeta.actionItems = res.actionItems;
      }
      savedItem = await svc.pipeline.capture({
        audioBase64: rawB64,
        audioMime: mime,
        audioDurationSec: durationSec,
        skipAudioAi: true,
        title: res.titleSuggestion,
        text: res.formattedText || res.transcript,
        orbitOverride: input.orbitOverride,
        focusBoardId: input.focusBoardId,
        mediaMeta: Object.keys(nextMediaMeta).length > 0 ? nextMediaMeta : undefined,
        source: 'vault_ui',
      });
      emitCountsChanged();
    }

    return {
      ...res,
      audioPath: savedAudio?.filename ?? savedItem?.mediaPath ?? undefined,
      audioMime: savedAudio?.mime ?? savedItem?.mediaType ?? undefined,
      savedItem,
    };
  });

  handleTrusted(
    'vault:save-revision',
    (_e, itemId: string, source: ItemRevision['source'] = 'manual') => {
      const existing = svc.repo.getItemById(itemId);
      if (!existing || existing.dna === 'secret') return null;
      return svc.repo.saveItemRevision({
        itemId: existing.id,
        title: existing.title,
        content: existing.body,
        source,
      });
    }
  );

  handleTrusted('vault:list-revisions', (_e, itemId: string) =>
    svc.repo.listItemRevisions(itemId)
  );

  handleTrusted('vault:revert-revision', (_e, itemId: string, revisionId: string) => {
    const updated = svc.repo.revertItemToRevision(itemId, revisionId);
    if (updated) svc.windows.broadcast('vault:item-upserted', updated);
    return updated;
  });

  handleTrusted('vault:list-tasks', () => svc.repo.listVaultTasks());

  handleTrusted(
    'vault:toggle-task',
    (
      _e,
      payload: {
        itemId: string;
        sourceType: 'markdown' | 'voice_action';
        taskIndex: number;
        done: boolean;
      }
    ) => {
      const res = svc.repo.toggleVaultTask(payload);
      if (res) svc.windows.broadcast('vault:item-upserted', res.item);
      return res;
    }
  );

  handleTrusted(
    'tasks:move-on-board',
    (
      _e,
      input: {
        itemId: string;
        taskKey: string;
        columnId: string;
        boardOrder: number;
      }
    ) => {
      const updated = svc.repo.moveTaskOnBoard(input);
      if (updated) svc.windows.broadcast('vault:item-upserted', updated);
      return updated;
    }
  );

  handleTrusted('tasks:create', (_e, input: CreateTaskInput) => {
    const created = svc.repo.createStandaloneTask(input);
    if (created) {
      svc.windows.broadcast('vault:item-upserted', created);
      emitCountsChanged();
    }
    return created;
  });

  handleTrusted(
    'tasks:update-meta',
    (
      _e,
      input: {
        itemId: string;
        taskKey: string;
        priority?: TaskPriority;
        dueAt?: number | null;
        columnId?: string;
        orbit?: string | null;
        focusBoardId?: string | null;
        notes?: string | null;
      }
    ) => {
      const updated = svc.repo.updateTaskMeta(input);
      if (updated) svc.windows.broadcast('vault:item-upserted', updated);
      return updated;
    }
  );

  handleTrusted(
    'tasks:update-text',
    (
      _e,
      input: {
        itemId: string;
        taskKey: string;
        text: string;
      }
    ) => {
      const updated = svc.repo.updateVaultTaskText(input);
      if (updated) svc.windows.broadcast('vault:item-upserted', updated);
      return updated;
    }
  );

  handleTrusted('tasks:delete', (_e, input: { itemId: string; taskKey: string }) => {
    const res = svc.repo.deleteVaultTask(input);
    if (!res) return null;
    if (res.deletedItemId) {
      svc.windows.broadcast('vault:item-deleted', res.deletedItemId);
      emitCountsChanged();
      return null;
    }
    if (res.item) {
      svc.windows.broadcast('vault:item-upserted', res.item);
    }
    return res.item;
  });

  handleTrusted('tasks:list-columns', () => svc.repo.listTaskBoardColumns());

  handleTrusted('tasks:save-columns', (_e, columns: TaskBoardColumn[]) => {
    const saved = svc.repo.saveTaskBoardColumns(Array.isArray(columns) ? columns : []);
    emitSettings();
    return saved;
  });

  // Settings
  handleTrusted('settings:get', () => svc.getSettingsState());
  handleTrusted('settings:update', (_e, patch: Partial<SettingsState>) => {
    let appearanceOrThemeChanged = false;
    if (patch.theme === 'dark' || patch.theme === 'light') {
      svc.repo.setSetting('theme', patch.theme);
      appearanceOrThemeChanged = true;
    }
    if (patch.locale === 'ru' || patch.locale === 'en') {
      svc.repo.setLocale(patch.locale);
      svc.onLocaleChanged?.(patch.locale);
    }
    if (patch.appearance && typeof patch.appearance === 'object') {
      svc.repo.saveAppearanceConfig(patch.appearance as Partial<AppearanceConfig>);
      appearanceOrThemeChanged = true;
    }
    if (appearanceOrThemeChanged) {
      if (svc.applyWindowBackground) {
        svc.applyWindowBackground();
      } else {
        const nextTheme = svc.repo.getSetting('theme') === 'light' ? 'light' : 'dark';
        const tokens = computeThemeTokens(nextTheme, svc.repo.getAppearanceConfig());
        svc.windows.setVaultBackgroundColor?.(tokens.canvasHex);
      }
    }
    if (Array.isArray(patch.taskBoardColumns)) {
      svc.repo.saveTaskBoardColumns(patch.taskBoardColumns);
    }
    if (typeof patch.showBoardColumnIcons === 'boolean') {
      svc.repo.setSetting('show_board_column_icons', String(patch.showBoardColumnIcons));
    }
    if (typeof patch.onboarded === 'boolean') {
      svc.repo.setSetting('onboarded', String(patch.onboarded));
    }
    if (patch.activeMode) svc.repo.setSetting('active_mode', patch.activeMode);
    if (patch.activeFocusBoardId !== undefined) {
      svc.repo.setActiveFocusBoard(patch.activeFocusBoardId);
    }
    if (patch.aiProvider) {
      svc.repo.setSetting('ai_provider', patch.aiProvider);
      svc.repo.setSetting('ai_provider_explicit', '1');
    }
    if (typeof patch.monthlyCapUsd === 'number' && Number.isFinite(patch.monthlyCapUsd)) {
      svc.repo.setSetting('monthly_cap_usd', String(Math.max(0.25, Math.min(10, patch.monthlyCapUsd))));
    }
    if (typeof patch.enableAutoOcr === 'boolean') {
      svc.repo.setSetting('enable_auto_ocr', String(patch.enableAutoOcr));
    }
    if (typeof patch.enableUrlUnfurl === 'boolean') {
      svc.repo.setSetting('enable_url_unfurl', String(patch.enableUrlUnfurl));
    }
    if (
      typeof patch.clipboardAutoWipeSeconds === 'number' &&
      Number.isFinite(patch.clipboardAutoWipeSeconds)
    ) {
      const roundedWipe = Math.round(patch.clipboardAutoWipeSeconds);
      const clampedWipe = roundedWipe <= 0 ? 0 : Math.max(5, Math.min(300, roundedWipe));
      svc.repo.setSetting('clipboard_wipe_sec', String(clampedWipe));
    }
    if (
      typeof patch.vaultAutoLockMinutes === 'number' &&
      Number.isFinite(patch.vaultAutoLockMinutes)
    ) {
      const clampedAutoLock = Math.max(0, Math.min(120, Math.round(patch.vaultAutoLockMinutes)));
      svc.repo.setSetting('vault_auto_lock_minutes', String(clampedAutoLock));
    }
    if (typeof patch.lockVaultOnMinimize === 'boolean') {
      svc.repo.setSetting('lock_vault_on_minimize', String(patch.lockVaultOnMinimize));
    }
    if (typeof patch.lockVaultOnHudClose === 'boolean') {
      svc.repo.setSetting('lock_vault_on_hud_close', String(patch.lockVaultOnHudClose));
    }
    if (typeof patch.enableScreenProtection === 'boolean') {
      svc.repo.setSetting('enable_screen_protection', String(patch.enableScreenProtection));
      if (svc.syncScreenProtection) {
        svc.syncScreenProtection();
      } else if (!patch.enableScreenProtection) {
        svc.windows.setContentProtection?.(false);
      }
    }
    if (typeof patch.biometricUnlockEnabled === 'boolean') {
      const curState = svc.getSettingsState();
      const isEn = (curState.locale ?? svc.repo.getLocale()) === 'en';
      if (patch.biometricUnlockEnabled) {
        const touchIdAvailable =
          process.platform === 'darwin' &&
          typeof systemPreferences.canPromptTouchID === 'function' &&
          Boolean(systemPreferences.canPromptTouchID());
        if (!touchIdAvailable) {
          throw new Error(
            isEn
              ? 'Touch ID unlock is only available on a Mac with Touch ID'
              : 'Вход по Touch ID доступен только на Mac с поддержкой Touch ID'
          );
        }
        if (curState.hasMasterPin && !curState.vaultUnlocked) {
          throw new Error(
            isEn ? 'Unlock Vault with master PIN first' : 'Сначала разблокируй Сейф мастер-кодом'
          );
        }
        const enabledOk = svc.cryptoVault.setBiometricSlotEnabled(true);
        svc.repo.setSetting('biometric_unlock_enabled', enabledOk ? 'true' : 'false');
      } else {
        svc.cryptoVault.setBiometricSlotEnabled(false);
        svc.repo.setSetting('biometric_unlock_enabled', 'false');
      }
    }
    if (typeof patch.emailInboundWebhookUrl === 'string') {
      const trimmedHook = patch.emailInboundWebhookUrl.trim();
      if (trimmedHook && !/^https:\/\//i.test(trimmedHook)) {
        throw new Error(
          getLocale() === 'en'
            ? 'Webhook URL must start with https://'
            : 'Адрес обработчика должен начинаться с https://'
        );
      }
      svc.repo.setSetting('email_inbound_webhook_url', trimmedHook);
    }
    if (patch.viewLayout === 'grid' || patch.viewLayout === 'list' || patch.viewLayout === 'board') {
      svc.repo.setSetting('view_layout', patch.viewLayout);
    }
    if (typeof patch.launchAtLogin === 'boolean') {
      svc.repo.setSetting('launch_at_login', String(patch.launchAtLogin));
      if (app.isPackaged && !process.env.KAPSULA_DATA_DIR) {
        try {
          app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
        } catch {
          // Non-fatal
        }
      }
    }
    if (typeof patch.soundTickEnabled === 'boolean') {
      svc.repo.setSetting('sound_tick_enabled', String(patch.soundTickEnabled));
    }
    let shortcutsChanged = false;
    const currentSettings = svc.getSettingsState();
    const isEnShortcut = (currentSettings.locale ?? svc.repo.getLocale()) === 'en';
    const nextHudShortcut =
      typeof patch.hudShortcut === 'string'
        ? normalizeShortcutAccelerator(patch.hudShortcut, process.platform)
        : currentSettings.hudShortcut;
    const nextSnatchShortcut =
      typeof patch.snatchShortcut === 'string'
        ? normalizeShortcutAccelerator(patch.snatchShortcut, process.platform)
        : currentSettings.snatchShortcut;

    const modHint =
      process.platform === 'darwin'
        ? isEnShortcut
          ? 'Cmd, Option, or Shift'
          : 'Cmd, Option или Shift'
        : isEnShortcut
          ? 'Ctrl, Alt, or Shift'
          : 'Ctrl, Alt или Shift';
    if (typeof patch.hudShortcut === 'string') {
      if (!nextHudShortcut) {
        throw new Error(
          isEnShortcut
            ? `Specify a shortcut with a modifier key (${modHint})`
            : `Укажи сочетание с клавишей-модификатором (${modHint})`
        );
      }
      if (nextHudShortcut === nextSnatchShortcut) {
        throw new Error(
          isEnShortcut
            ? 'Quick launch and clipboard capture shortcuts cannot be the same'
            : 'Сочетания для быстрого запуска и захвата буфера не могут совпадать'
        );
      }
      svc.repo.setSetting('hud_shortcut', nextHudShortcut);
      shortcutsChanged = true;
    }
    if (typeof patch.snatchShortcut === 'string') {
      if (!nextSnatchShortcut) {
        throw new Error(
          isEnShortcut
            ? `Specify a shortcut with a modifier key (${modHint})`
            : `Укажи сочетание с клавишей-модификатором (${modHint})`
        );
      }
      if (nextHudShortcut === nextSnatchShortcut) {
        throw new Error(
          isEnShortcut
            ? 'Quick launch and clipboard capture shortcuts cannot be the same'
            : 'Сочетания для быстрого запуска и захвата буфера не могут совпадать'
        );
      }
      svc.repo.setSetting('snatch_shortcut', nextSnatchShortcut);
      shortcutsChanged = true;
    }
    if (shortcutsChanged) {
      svc.reapplyShortcuts?.();
    }
    if (
      typeof patch.videoCacheLimitMb === 'number' &&
      Number.isFinite(patch.videoCacheLimitMb)
    ) {
      const sanitizedLimit = sanitizeVideoCacheLimitMb(patch.videoCacheLimitMb);
      svc.repo.setSetting('video_cache_limit_mb', String(sanitizedLimit));
      svc.pipeline.getVideoCache().setLimitMb(sanitizedLimit);
    }
    if (patch.vaultUnlocked === false) {
      lockVaultIfProtected(false);
    }
    emitSettings();
    return svc.getSettingsState();
  });

  handleTrusted(
    'settings:set-api-key',
    (_e, provider: 'openrouter' | 'google_ai_studio', apiKey: string) => {
      svc.setApiKeyForProvider(provider, apiKey.trim());
      if (apiKey.trim()) {
        svc.repo.setSetting('ai_provider', provider);
      } else if (svc.getSettingsState().aiProvider === provider) {
        const other = provider === 'google_ai_studio' ? 'openrouter' : 'google_ai_studio';
        const isSignedIn = Boolean(svc.syncEngine?.getStatus().userId);
        svc.repo.setSetting(
          'ai_provider',
          svc.getApiKeyForProvider(other) ? other : isSignedIn ? 'google_ai_studio' : 'local'
        );
      }
      emitSettings();
      return svc.getSettingsState();
    }
  );

  handleTrusted(
    'settings:test-ai-key',
    async (_e, provider: AiProvider, apiKeyInput?: string) => {
      const effectiveKey =
        typeof apiKeyInput === 'string' && apiKeyInput.trim()
          ? apiKeyInput.trim()
          : svc.getApiKeyForProvider(provider);
      return testAiProviderConnection({
        provider,
        apiKey: effectiveKey,
        cloudProxy: effectiveKey ? null : getCloudProxy(),
        locale: getLocale(),
      });
    }
  );

  // Calendar & Google Calendar sync
  handleTrusted('calendar:list', (_e, range?: { startAt?: number; endAt?: number }) =>
    svc.repo.listCalendarEvents(range)
  );
  handleTrusted('calendar:upsert', (_e, input: CalendarEventInput) => {
    const ev = svc.repo.upsertCalendarEvent(input);
    svc.windows.broadcast('vault:calendar-changed', undefined);
    return ev;
  });
  handleTrusted('calendar:delete', (_e, id: string) => {
    const ok = svc.repo.deleteCalendarEvent(id);
    if (ok) svc.windows.broadcast('vault:calendar-changed', undefined);
    return ok;
  });
  handleTrusted('calendar:status', async () => gcalBridge.getStatusWithRemoteCheck());
  handleTrusted('calendar:save-config', (_e, input: { clientId?: string; icalUrl?: string }) => {
    const status = gcalBridge.saveConfig(input);
    emitSettings();
    return status;
  });
  handleTrusted('calendar:connect-oauth', async (_e, clientId?: string) => {
    const status = await gcalBridge.connectOAuth(clientId);
    emitSettings();
    svc.windows.broadcast('vault:calendar-changed', undefined);
    return status;
  });
  handleTrusted('calendar:disconnect', () => {
    const status = gcalBridge.disconnect();
    emitSettings();
    svc.windows.broadcast('vault:calendar-changed', undefined);
    return status;
  });
  handleTrusted('calendar:sync-now', async () => {
    const res = await gcalBridge.syncNow();
    emitSettings();
    svc.windows.broadcast('vault:calendar-changed', undefined);
    return res;
  });
  handleTrusted('calendar:import-ics', async (_e, icsText?: string) => {
    let raw = typeof icsText === 'string' ? icsText : '';
    const locale = getLocale();
    const isEn = locale === 'en';
    if (!raw) {
      const openOpts: Electron.OpenDialogOptions = {
        title: isEn ? 'Import calendar (.ics)' : 'Импорт календаря (.ics)',
        properties: ['openFile'],
        filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      };
      const pick = svc.windows.vault
        ? await dialog.showOpenDialog(svc.windows.vault, openOpts)
        : await dialog.showOpenDialog(openOpts);
      if (pick.canceled || !pick.filePaths[0]) return { imported: 0 };
      raw = await fs.promises.readFile(pick.filePaths[0], 'utf8');
    }
    const parsed = parseIcalFeed(raw, locale);
    for (const ev of parsed) {
      svc.repo.upsertCalendarEvent({
        ...ev,
        externalSource: 'ics_import',
        externalId: ev.externalId,
      });
    }
    if (parsed.length > 0) svc.windows.broadcast('vault:calendar-changed', undefined);
    return { imported: parsed.length };
  });
  handleTrusted('calendar:export-ics', async () => {
    const events = svc.repo.listCalendarEvents();
    const isEn = getLocale() === 'en';
    const saveOpts: Electron.SaveDialogOptions = {
      title: isEn ? 'Export calendar (.ics)' : 'Экспорт календаря (.ics)',
      defaultPath: 'kapsula-calendar.ics',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    };
    const pick = svc.windows.vault
      ? await dialog.showSaveDialog(svc.windows.vault, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (pick.canceled || !pick.filePath) return { exported: 0, path: null };
    const ics = exportEventsToIcal(events);
    await fs.promises.writeFile(pick.filePath, ics, 'utf8');
    return { exported: events.length, path: pick.filePath };
  });
  handleTrusted('calendar:parse-date', (_e, rawText: string) =>
    parseRussianDateExpression(rawText, undefined, getLocale())
  );

  // Universal Archive Import & Browser Extension
  handleTrusted('bridges:import-archive', async (_e, rawJson: string) => {
    const res = await importArchiveJson(rawJson, svc.pipeline, svc.repo);
    emitCountsChanged();
    return res;
  });
  handleTrusted('bridges:pick-archive-file', async () => {
    const isEn = getLocale() === 'en';
    const openOpts: Electron.OpenDialogOptions = {
      title: isEn ? 'Choose notes archive (JSON / HTML)' : 'Выбери архив заметок (JSON / HTML)',
      properties: ['openFile'],
      filters: [{ name: isEn ? 'Note archives' : 'Архивы заметок', extensions: ['json', 'html', 'htm'] }],
    };
    const pick = svc.windows.vault
      ? await dialog.showOpenDialog(svc.windows.vault, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (pick.canceled || !pick.filePaths[0]) {
      return { canceled: true, imported: 0, skippedDuplicates: 0, errors: 0, format: 'unknown' };
    }
    const res = await importArchiveFromPath(pick.filePaths[0], svc.pipeline, svc.repo);
    emitCountsChanged();
    return { canceled: false, ...res };
  });
  handleTrusted('bridges:open-extension-dir', async () => {
    const unpackedExt = path.join(process.resourcesPath, 'extension');
    const extPath = fs.existsSync(unpackedExt)
      ? unpackedExt
      : path.resolve(app.getAppPath(), 'extension');
    await shell.openPath(extPath);
  });

  const resolveDataDir = () =>
    svc.dataDir || process.env.KAPSULA_DATA_DIR || path.join(app.getPath('userData'), 'kapsula-data');

  handleTrusted('vault:storage-summary', async () => {
    const dir = resolveDataDir();
    let totalBytes = 0;
    let mediaFilesCount = 0;

    const walk = async (cur: string, inMedia: boolean): Promise<void> => {
      try {
        const entries = await fs.promises.readdir(cur, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '_electron-profile') continue;
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) {
            await walk(full, inMedia || entry.name === 'media');
          } else if (entry.isFile()) {
            try {
              const st = await fs.promises.stat(full);
              totalBytes += st.size;
              if (inMedia) mediaFilesCount += 1;
            } catch {
              // ignore transient locks
            }
          }
        }
      } catch {
        // ignore missing dir
      }
    };

    await walk(dir, false);
    const stats = svc.repo.getStats();
    return {
      itemCount: stats.total,
      mediaFilesCount,
      totalBytes,
    };
  });

  handleTrusted('vault:open-data-dir', async () => {
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  handleTrusted('media:video-cache-stats', () => svc.pipeline.getVideoCache().getStats());

  handleTrusted('media:clear-video-cache', () => svc.pipeline.getVideoCache().clear());

  handleTrusted('media:ensure-link-video', async (_e, itemId: string) => {
    if (typeof itemId !== 'string' || !itemId.trim()) return null;
    return svc.pipeline.ensureLinkVideo(itemId.trim());
  });

  handleTrusted('vault:export-backup', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const isEn = getLocale() === 'en';
    const saveOpts: Electron.SaveDialogOptions = {
      title: isEn ? 'Save Kapsula backup' : 'Сохранить резервную копию Kapsula',
      defaultPath: path.join(app.getPath('documents'), `kapsula-backup-${stamp}.json`),
      filters: [{ name: isEn ? 'Kapsula backup' : 'Резервная копия Kapsula', extensions: ['json'] }],
    };
    const pick = svc.windows.vault
      ? await dialog.showSaveDialog(svc.windows.vault, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (pick.canceled || !pick.filePath) {
      return { canceled: true, itemCount: 0, filePath: null };
    }

    const items = svc.repo
      .queryItems({ includeArchived: true, includeSecrets: false, limit: 10000 })
      .map((it) => ({
        id: it.id,
        dna: it.dna,
        orbit: it.orbit,
        focusBoardId: it.focusBoardId,
        title: it.title,
        body: it.body,
        summary: it.summary,
        url: it.url,
        tags: it.tags,
        isPinned: it.isPinned,
        isArchived: it.isArchived,
        remindAt: it.remindAt,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      }));
    const payload = {
      format: 'kapsula-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      orbits: svc.repo.listOrbits(),
      boards: svc.repo.listFocusBoards(),
      calendarEvents: svc.repo.listCalendarEvents(),
      items,
    };
    await fs.promises.writeFile(pick.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { canceled: false, itemCount: items.length, filePath: pick.filePath };
  });

  // System Screen Capture
  handleTrusted('system:capture-screen', async (_e, opts?: { reopenHud?: boolean }) => {
    const isEn = getLocale() === 'en';
    const wasHudVisible = Boolean(svc.windows.hud?.isVisible());
    if (wasHudVisible) {
      svc.windows.hideHud();
      await new Promise((r) => setTimeout(r, 140));
    }
    try {
      // Call desktopCapturer first so macOS registers Kapsula in System Settings → Screen Recording
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (process.platform === 'darwin') {
        try {
          const status = systemPreferences.getMediaAccessStatus('screen');
          if (status !== 'granted') {
            throw new Error(
              isEn
                ? 'Screen Recording permission is required. Allow Kapsula in System Settings → Privacy & Security → Screen Recording and restart the app.'
                : 'Нет доступа к записи экрана. Разреши Kapsula в «Системные настройки → Конфиденциальность и безопасность → Запись экрана» и перезапусти приложение.'
            );
          }
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes('Системные настройки') || err.message.includes('System Settings'))
          ) {
            throw err;
          }
        }
      }
      const first = sources[0];
      if (!first || first.thumbnail.isEmpty()) {
        throw new Error(
          isEn ? 'Could not capture screenshot.' : 'Не удалось получить снимок экрана.'
        );
      }
      const pngBuf = first.thumbnail.toPNG();
      const s = svc.getSettingsState();
      const item = await svc.pipeline.capture({
        imageBytes: new Uint8Array(pngBuf.buffer, pngBuf.byteOffset, pngBuf.byteLength),
        mode: s.activeMode,
        focusBoardId: s.activeFocusBoardId,
        source: wasHudVisible ? 'hud' : 'vault_ui',
      });
      emitCountsChanged();
      return item;
    } finally {
      if (wasHudVisible && opts?.reopenHud !== false) {
        svc.windows.showHud();
      }
    }
  });

  // Window & HUD actions
  handleTrusted(
    'window:action',
    (
      _e,
      action:
        | 'minimize'
        | 'maximize'
        | 'close'
        | 'open-vault'
        | 'open-vault-new-note'
        | 'open-vault-calendar'
        | 'open-hud'
    ) => {
      const win = svc.windows.vault;
      if (action === 'open-hud') {
        svc.windows.showHud();
        return;
      }
      if (!win) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      } else if (action === 'close') {
        win.close();
      } else if (action === 'open-vault') {
        svc.windows.showVault();
      } else if (action === 'open-vault-new-note') {
        svc.windows.showVault();
        svc.windows.broadcast('vault:new-note', undefined);
      } else if (action === 'open-vault-calendar') {
        svc.windows.showVault();
        svc.windows.broadcast('vault:open-calendar', undefined);
      }
    }
  );

  handleTrusted('window:open-external', async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
      await shell.openExternal(url.trim());
    }
  });

  handleTrusted('window:copy-text', async (_e, text: string) => {
    await clipboard.writeText(text);
  });

  handleTrusted('window:copy-image', async (_e, imagePath: string) => {
    if (!imagePath) return false;
    const safeName = path.basename(imagePath);
    if (!safeName || safeName === '.') return false;
    const abs = path.join(svc.pipeline.getMediaDir(), safeName);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    const img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) return false;
    const pngBuf = img.toPNG();
    const blob = new Blob([new Uint8Array(pngBuf)], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  });

  handleTrusted('window:focus-item', (_e, id: string) => {
    svc.windows.showVault();
    svc.windows.broadcast('vault:focus-item', id);
  });

  handleTrusted('hud:close', () => {
    svc.windows.hideHud();
  });

  handleTrusted('hud:set-prevent-close', (_e, prevent: boolean) => {
    svc.windows.setHudPreventBlurClose(Boolean(prevent));
    return Boolean(prevent);
  });

  handleTrusted('window:is-fullscreen', () => {
    const win = svc.windows.vault;
    return Boolean(win && !win.isDestroyed() && win.isFullScreen());
  });

  handleTrusted('hud:paste-back', async (_e, text: string, isSecret: boolean = false) => {
    if (!text) return false;
    if (isSecret) {
      await writeConcealedClipboardText(text);
      // Clear secret clipboard promptly (1.5s) after paste-back instead of waiting full 30s
      trackAndScheduleSecretWipeMs(text, 1500);
    } else {
      await clipboard.writeText(text);
    }
    return svc.windows.pasteBackFromHud();
  });

  const SAFE_OPEN_EXTENSIONS = new Set([
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.mp3',
    '.wav',
    '.m4a',
    '.ogg',
    '.webm',
    '.mp4',
    '.mov',
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.docx',
    '.xlsx',
    '.pptx',
    '.eml',
    '.rtf',
    '.odt',
    '.ods',
    '.odp',
  ]);

  handleTrusted('media:open', async (_e, filename: string) => {
    if (!filename) return false;
    const mediaRoot = path.resolve(svc.pipeline.getMediaDir());
    const safe = path.basename(filename);
    const target = path.resolve(mediaRoot, safe);
    if (!target.startsWith(mediaRoot + path.sep) || !fs.existsSync(target)) return false;
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = fs.realpathSync(mediaRoot);
      realTarget = fs.realpathSync(target);
    } catch {
      return false;
    }
    if (!realTarget.startsWith(realRoot + path.sep)) return false;
    const ext = path.extname(realTarget).toLowerCase();
    if (!SAFE_OPEN_EXTENSIONS.has(ext)) {
      shell.showItemInFolder(realTarget);
      return true;
    }
    const err = await shell.openPath(realTarget);
    return !err;
  });

  handleTrusted('media:reveal', (_e, filename: string) => {
    if (!filename) return false;
    const mediaRoot = path.resolve(svc.pipeline.getMediaDir());
    const safe = path.basename(filename);
    const target = path.resolve(mediaRoot, safe);
    if (!target.startsWith(mediaRoot + path.sep) || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  handleTrusted('hud:clipboard-preview', async () => {
    const snap = await readClipboardSnapshot(clipboard, nativeImage);
    if (Date.now() < secretClipboardUntil && snap.text === secretClipboardValue) {
      return { hasImage: false, text: '' };
    }
    if (snap.text && analyzeForSecret(snap.text).isSecret) {
      return { hasImage: Boolean(snap.imageBase64), text: '' };
    }
    return {
      hasImage: Boolean(snap.imageBase64),
      text: snap.text.slice(0, 600),
    };
  });

  // Cloud E2EE Sync (Supabase)
  const syncNotReadyErr = () =>
    getLocale() === 'en'
      ? 'Sync module is not initialized'
      : 'Модуль синхронизации не инициализирован';

  handleTrusted('sync:status', () => {
    if (!svc.syncEngine) {
      throw new Error(syncNotReadyErr());
    }
    return svc.syncEngine.getStatus();
  });

  handleTrusted('sync:sign-up', async (_e, input: SyncAuthInput) => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.signUp(String(input?.email ?? ''), String(input?.password ?? ''));
  });

  handleTrusted('sync:sign-in', async (_e, input: SyncAuthInput) => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.signIn(String(input?.email ?? ''), String(input?.password ?? ''));
  });

  handleTrusted('sync:sign-in-google', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    const res = await svc.syncEngine.signInWithGoogle({
      openExternal: (url) => shell.openExternal(url),
    });
    if (res.ok) {
      svc.windows.showVault();
      emitSettings();
    }
    return res;
  });

  handleTrusted('sync:sign-out', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    const status = await svc.syncEngine.signOut();
    svc.setVaultUnlocked(true);
    emitSettings();
    svc.windows.broadcast('vault:batch-synced', undefined);
    return status;
  });

  handleTrusted('sync:delete-account', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    const res = await svc.syncEngine.deleteAccount();
    if (res.ok) {
      svc.setVaultUnlocked(true);
      emitSettings();
      svc.windows.broadcast('vault:batch-synced', undefined);
    }
    return res;
  });

  handleTrusted('sync:setup-passphrase', async (_e, passphrase: string) => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.setupPassphrase(String(passphrase ?? ''));
  });

  handleTrusted('sync:unlock-passphrase', async (_e, passphrase: string) => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.unlockWithPassphrase(String(passphrase ?? ''));
  });

  handleTrusted(
    'sync:unlock-recovery',
    async (_e, payload: { recoveryKey: string; newPassphrase?: string }) => {
      if (!svc.syncEngine) throw new Error(syncNotReadyErr());
      return svc.syncEngine.unlockWithRecoveryKey(
        String(payload?.recoveryKey ?? ''),
        typeof payload?.newPassphrase === 'string' ? payload.newPassphrase : undefined
      );
    }
  );

  handleTrusted(
    'sync:change-passphrase',
    async (_e, payload: { currentPassphrase: string; newPassphrase: string }) => {
      if (!svc.syncEngine) throw new Error(syncNotReadyErr());
      return svc.syncEngine.changePassphrase(
        String(payload?.currentPassphrase ?? ''),
        String(payload?.newPassphrase ?? '')
      );
    }
  );

  handleTrusted('sync:now', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.syncNow();
  });

  handleTrusted('sync:reconcile-full', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.reconcileFull();
  });

  handleTrusted('sync:set-server-config', async (_e, input: SyncServerConfigInput | null) => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.setServerConfig(input);
  });

  handleTrusted('sync:regenerate-recovery', async () => {
    if (!svc.syncEngine) throw new Error(syncNotReadyErr());
    return svc.syncEngine.regenerateRecoveryKey();
  });

  handleTrusted('sync:copy-recovery-key', async (_e, recoveryKey: string) => {
    const clean = String(recoveryKey ?? '').trim();
    if (!clean) return { ok: false, wipeSeconds: 0 };
    const cfgWipe = svc.getSettingsState().clipboardAutoWipeSeconds;
    const effectiveWipeSec = cfgWipe > 0 ? Math.max(cfgWipe, 60) : 60;
    await writeConcealedClipboardText(clean);
    trackAndScheduleSecretWipe(clean, effectiveWipeSec);
    return { ok: true, wipeSeconds: effectiveWipeSec };
  });

  handleTrusted('clipper:get-pairing-info', () => {
    if (svc.clipperControl) return svc.clipperControl.getPairingInfo();
    return { pairingCode: '', pairedCount: 0 };
  });

  handleTrusted('clipper:reset-pairing', () => {
    if (svc.clipperControl) return svc.clipperControl.resetPairing();
    return { pairingCode: '', pairedCount: 0 };
  });

  // In-App Cloud Updates (Windows NSIS auto-update + macOS .dmg release checker)
  handleTrusted('updater:get-state', () => {
    if (svc.updater) return svc.updater.getState();
    return {
      status: 'idle' as const,
      currentVersion: (() => {
        try {
          return app.getVersion();
        } catch {
          return APP_VERSION;
        }
      })(),
      mode: 'manual-download' as const,
      latestVersion: null,
      releaseNotes: null,
      downloadUrl: null,
      percent: null,
      error: null,
      checkedAt: null,
      dismissedVersion: null,
    };
  });

  handleTrusted('updater:check', async (_e, rawOpts?: { silent?: boolean; maxAgeMs?: number }) => {
    if (!svc.updater) {
      return {
        status: 'up-to-date' as const,
        currentVersion: app.getVersion(),
        mode: 'manual-download' as const,
      };
    }
    if (rawOpts && rawOpts.silent === true) {
      const maxAgeMs =
        typeof rawOpts.maxAgeMs === 'number' &&
        Number.isFinite(rawOpts.maxAgeMs) &&
        rawOpts.maxAgeMs > 0
          ? rawOpts.maxAgeMs
          : undefined;
      return svc.updater.refreshIfStale(maxAgeMs);
    }
    return svc.updater.checkForUpdates({ silent: false });
  });

  handleTrusted('updater:download', async () => {
    if (!svc.updater) {
      return {
        status: 'error' as const,
        currentVersion: app.getVersion(),
        mode: 'manual-download' as const,
        error:
          getLocale() === 'en'
            ? 'Updater module is not initialized'
            : 'Модуль обновлений не инициализирован',
      };
    }
    return svc.updater.downloadUpdate();
  });

  handleTrusted('updater:install', async () => {
    if (!svc.updater) return { ok: false };
    return svc.updater.installUpdate();
  });

  handleTrusted('updater:dismiss', (_e, version?: string) => {
    if (!svc.updater) return null;
    return svc.updater.dismissUpdate(typeof version === 'string' ? version : undefined);
  });

  // Safe, 100%-redacted diagnostics report
  handleTrusted('diagnostics:get-report', async () => {
    const s = svc.getSettingsState();
    const locale = s.locale ?? svc.repo.getLocale();
    const stats = svc.repo.getStats();
    const orbitsCount = svc.repo.listOrbits().length;
    const boardsCount = svc.repo.listFocusBoards().length;
    const calendarEventsCount = svc.repo.listCalendarEvents().length;
    const syncStatus = svc.syncEngine?.getStatus() ?? null;
    const updaterState = svc.updater?.getState() ?? null;
    const calStatus = gcalBridge.getStatus();
    const cloudQuota = await fetchCloudAiQuota({
      cloudProxy: getCloudProxy(),
      hasGoogleKey: s.hasGoogleAiKey,
      hasOpenRouterKey: s.hasOpenRouterKey,
      locale,
    }).catch(() => null);

    const appVersion = (() => {
      try {
        return app.getVersion();
      } catch {
        return APP_VERSION;
      }
    })();

    return buildDiagnosticsReport({
      appVersion,
      stats,
      orbitsCount,
      boardsCount,
      calendarEventsCount,
      settings: s,
      syncStatus,
      cloudQuota,
      updaterState,
      extraErrors: [calStatus.error],
      locale,
    });
  });

  // v8 Integration IPCs (inline note images, voice AI transcription, .eml / Obsidian / Notion / JSON IO, Markdown ZIP export, inbound email token)
  registerV8IntegrationIpc({
    ipcMain,
    dialog,
    getMainWindow: () => svc.windows.vault,
    repo: svc.repo,
    pipeline: svc.pipeline,
    syncEngine: svc.syncEngine,
    broadcastUpsert: (item) => svc.windows.broadcast('vault:item-upserted', item),
    onOrbitsChanged: emitCountsChanged,
    onSettingsChanged: emitSettings,
    documentsDir: (() => {
      try {
        return app.getPath('documents');
      } catch {
        return undefined;
      }
    })(),
    handleTrusted,
  });

  return {
    clearClipboardNow: () =>
      wiper.clearNow(
        (txt) => clipboard.writeText(txt),
        () => clipboard.readText()
      ),
    flushPendingDeletes: () => {},
    lockVaultIfProtected: () => lockVaultIfProtected(true),
  };
}
