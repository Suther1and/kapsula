import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';
import type { KapsulaBridgeApi } from '../../src/preload/index';
import type { SyncStatus } from '@shared/sync-contract';
import { I18nProvider } from '@shared/i18n/react';
import type {
  AppLocale,
  CalendarEvent,
  FocusBoard,
  OrbitDef,
  SettingsState,
  TaskBoardColumn,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';

export type KapsulaEventName =
  | 'onVaultItemUpserted'
  | 'onVaultItemsBatchUpserted'
  | 'onVaultItemDeleted'
  | 'onVaultItemsBatchDeleted'
  | 'onVaultNewNote'
  | 'onOpenCalendar'
  | 'onOrbitsChanged'
  | 'onBoardsChanged'
  | 'onCalendarChanged'
  | 'onFocusItem'
  | 'onSettingsUpdated'
  | 'onSyncStatusUpdated'
  | 'onVaultBatchSynced'
  | 'onHudOpened'
  | 'onWindowFullScreenChanged'
  | 'onOpenSettings'
  | 'onFocusSearch'
  | 'onUpdaterStateChanged';

let polyfillsInstalled = false;

export function installJsdomPolyfills(): void {
  if (typeof window === 'undefined' || polyfillsInstalled) return;
  polyfillsInstalled = true;

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  if (typeof globalThis.IntersectionObserver === 'undefined') {
    globalThis.IntersectionObserver = class IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  }
  if (!Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => [];
  }

  // TipTap / ProseMirror jsdom guards
  if (typeof Range !== 'undefined') {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* () {},
        }) as unknown as DOMRectList;
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    }
  }

  if (!document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
}

export function makeSettingsState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    theme: 'dark',
    locale: 'ru',
    activeMode: 'autopilot',
    activeFocusBoardId: null,
    aiProvider: 'local',
    monthlyCapUsd: 5,
    enableAutoOcr: true,
    enableUrlUnfurl: true,
    clipboardAutoWipeSeconds: 30,
    hasOpenRouterKey: false,
    hasGoogleAiKey: false,
    hasMasterPin: false,
    vaultUnlocked: true,
    clipperPort: 47831,
    clipperToken: 'test-clipper-token',
    viewLayout: 'grid',
    launchAtLogin: false,
    soundTickEnabled: false,
    hudShortcut: 'CommandOrControl+Space',
    snatchShortcut: 'CommandOrControl+Shift+V',
    googleCalendarConnected: false,
    googleCalendarEmail: null,
    googleCalendarClientId: '',
    googleCalendarIcalUrl: '',
    googleCalendarLastSyncAt: null,
    vaultAutoLockMinutes: 5,
    lockVaultOnMinimize: false,
    lockVaultOnHudClose: false,
    enableScreenProtection: true,
    biometricUnlockAvailable: false,
    biometricUnlockEnabled: false,
    pinLockoutRemainingSec: 0,
    onboarded: true,
    planTier: 'free',
    ...overrides,
  };
}

export function makeOrbit(overrides: Partial<OrbitDef> = {}): OrbitDef {
  return {
    id: 'work',
    name: 'Работа',
    description: 'Рабочие заметки и проекты',
    icon: 'Briefcase',
    color: '#3B82F6',
    sortOrder: 0,
    isBuiltin: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    itemCount: 0,
    ...overrides,
  };
}

export function makeFocusBoard(overrides: Partial<FocusBoard> = {}): FocusBoard {
  return {
    id: 'board-1',
    name: 'Проект',
    description: '',
    icon: 'BookmarkSimple',
    color: '#E86A33',
    sortOrder: 0,
    isActive: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

export function makeVaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  const now = 1_700_000_000_000;
  return {
    id: 'item-1',
    dna: 'note',
    subKind: null,
    orbit: '',
    modeCaptured: 'autopilot',
    focusBoardId: null,
    title: 'Тестовая заметка',
    body: 'Текст тестовой заметки',
    summary: 'Текст тестовой заметки',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: null,
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    hasEncryptedPayload: false,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: 'hash-item-1',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    isDemo: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    purgedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
    syncVersion: 1,
    ...overrides,
  };
}

export function makeSecretItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return makeVaultItem({
    id: 'secret-1',
    dna: 'secret',
    title: 'GitHub Пароль',
    body: '🔒 Зашифровано в Сейфе',
    summary: 'GitHub',
    hasEncryptedPayload: true,
    secretMeta: {
      kind: 'password',
      service: 'GitHub',
      loginHint: 'd***@kapsula.app',
      hasLogin: true,
      hasTotp: false,
    },
    ...overrides,
  });
}

export function makeTaskEntry(overrides: Partial<VaultTaskEntry> = {}): VaultTaskEntry {
  return {
    id: 'item-1:markdown:0',
    itemId: 'item-1',
    itemTitle: 'Тестовая заметка',
    sourceType: 'markdown',
    taskIndex: 0,
    text: 'Первая задача',
    done: false,
    orbit: '',
    remindAt: null,
    updatedAt: 1_700_000_000_000,
    taskKey: 'md:0',
    columnId: 'col_inbox',
    boardOrder: 0,
    priority: 'none',
    dueAt: null,
    ...overrides,
  };
}

export function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = new Date(2026, 1, 10, 10, 0, 0, 0).getTime();
  return {
    id: 'ev-1',
    title: 'Встреча команды',
    notes: '',
    location: '',
    startAt: start,
    endAt: start + 3_600_000,
    allDay: false,
    hasEndTime: true,
    color: '#E86A33',
    kind: 'event',
    recurrence: 'none',
    isDone: false,
    linkedItemId: null,
    checklist: [],
    attachments: [],
    externalSource: null,
    externalId: null,
    etag: null,
    createdAt: start,
    updatedAt: start,
    deletedAt: null,
    ...overrides,
  };
}

export function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'signed_out',
    email: null,
    userId: null,
    deviceId: 'test-device-1',
    deviceName: 'Test PC',
    lastSyncAt: null,
    pendingCount: 0,
    syncedRecordsCount: 0,
    realtimeConnected: false,
    hasCustomServer: false,
    supabaseUrl: 'https://gxkvuwipzbqocbxgyqty.supabase.co',
    error: null,
    devices: [],
    hasRecoveryKeyBackupHint: false,
    ...overrides,
  };
}

export function makeDefaultColumns(): TaskBoardColumn[] {
  return [
    { id: 'col_inbox', title: 'Входящие', color: '#64748B', order: 0 },
    { id: 'col_doing', title: 'В работе', color: '#E86A33', order: 1 },
    { id: 'col_done', title: 'Готово', color: '#10B981', order: 2, isDone: true },
  ];
}

export function createMockKapsulaApi(overrides: Partial<KapsulaBridgeApi> = {}) {
  const listeners = new Map<KapsulaEventName, Set<(...args: any[]) => void>>();

  const subscribe = (event: KapsulaEventName) => (cb: (...args: any[]) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  };

  const emit = (event: KapsulaEventName, ...args: any[]) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      cb(...args);
    }
  };

  const api: KapsulaBridgeApi = {
    platform: 'win32',
    queryVault: vi.fn(async () => []),
    getVaultItem: vi.fn(async () => null),
    getStats: vi.fn(async () => ({
      total: 0,
      inboxCount: 0,
      demoCount: 0,
      pinnedCount: 0,
      archivedCount: 0,
      trashedCount: 0,
      dueRemindersCount: 0,
      byOrbit: {},
      byDna: {},
    })),
    getInventorySummary: vi.fn(async () => ({
      totalItems: 0,
      unassignedCount: 0,
      byDna: { link: 0, secret: 0, shot: 0, snippet: 0, note: 0, voice: 0, doc: 0 },
      byOrbit: [],
      vaultLocked: false,
      bankCardCount: 0,
      bankCards: [],
      passwordCount: 0,
      apiKeyCount: 0,
      secretServices: [],
      dueReminderCount: 0,
      dueReminders: [],
    })),
    pickSerendipity: vi.fn(async () => []),
    listDueReminders: vi.fn(async () => []),
    capture: vi.fn(async (input) =>
      makeVaultItem({
        id: 'captured-1',
        title: input.title || 'Новая заметка',
        body: input.text || '',
      })
    ),
    captureClipboard: vi.fn(async () => null),
    captureScreen: vi.fn(async () => makeVaultItem()),
    updateItem: vi.fn(async (id, patch) =>
      makeVaultItem({
        id,
        ...(patch as Partial<VaultItem>),
      })
    ),
    bulkUpdateItems: vi.fn(async (ids: string[], patch: Record<string, unknown>) => ({
      items: ids.map((id) => makeVaultItem({ id, ...(patch as Partial<VaultItem>) })),
      count: ids.length,
      failedIds: [],
    })),
    deleteItem: vi.fn(async () => true),
    bulkDeleteItems: vi.fn(async (ids: string[]) => ({
      deletedIds: ids,
      purgedIds: [],
      failedIds: [],
    })),
    restoreItem: vi.fn(async () => makeVaultItem()),
    bulkRestoreItems: vi.fn(async (ids: string[]) => ({
      items: ids.map((id) => makeVaultItem({ id, deletedAt: null })),
      count: ids.length,
      failedIds: [],
    })),
    purgeItem: vi.fn(async () => true),
    emptyTrash: vi.fn(async () => ({ purgedCount: 0 })),
    duplicateItem: vi.fn(async () => makeVaultItem({ id: 'dup-1' })),
    saveNoteImage: vi.fn(async () => ({ filename: 'img.png', mediaUrl: 'kapsula-media://local/img.png' })),
    exportMarkdown: vi.fn(async () => ({ saved: true, path: 'note.md' })),
    getRelatedItems: vi.fn(async () => ({ related: [], backlinks: [] })),
    reprocessItem: vi.fn(async () => null),
    reprocessBufferAll: vi.fn(async () => 0),
    seedExamples: vi.fn(async () => 0),
    clearDemoItems: vi.fn(async () => 0),

    revealSecret: vi.fn(async () => ({
      service: 'GitHub',
      login: 'dev@kapsula.app',
      secretValue: 'super-secret-password',
      notes: '',
    })),
    copySecret: vi.fn(async () => ({ ok: true, wipeSeconds: 30 })),
    copySecretField: vi.fn(async () => ({ ok: true, wipeSeconds: 30 })),
    getTotpCode: vi.fn(async () => null),
    saveStructuredSecret: vi.fn(async (input) =>
      makeSecretItem({
        id: input.id || 'secret-created-1',
        title: input.title || input.service,
      })
    ),
    setMasterPin: vi.fn(async () => true),
    unlockVaultPin: vi.fn(async () => true),
    lockVaultPin: vi.fn(async () => true),
    promptBiometricUnlock: vi.fn(async () => ({ ok: true })),
    setScreenProtection: vi.fn(async () => true),

    listOrbits: vi.fn(async () => [makeOrbit()]),
    createOrbit: vi.fn(async (input) => makeOrbit({ id: 'orbit-new', ...input })),
    updateOrbit: vi.fn(async (id, patch) => makeOrbit({ id, ...patch })),
    reorderOrbits: vi.fn(async () => [makeOrbit()]),
    deleteOrbit: vi.fn(async () => true),

    listFocusBoards: vi.fn(async () => [makeFocusBoard()]),
    createFocusBoard: vi.fn(async (name) => makeFocusBoard({ name })),
    updateFocusBoard: vi.fn(async (id, patch) => makeFocusBoard({ id, ...patch })),
    reorderFocusBoards: vi.fn(async () => [makeFocusBoard()]),
    setActiveFocusBoard: vi.fn(async () => {}),
    deleteFocusBoard: vi.fn(async () => true),

    askVault: vi.fn(async () => ({
      answer: '',
      citations: [],
      usedProvider: 'local' as const,
      costUsd: 0,
    })),
    getBudget: vi.fn(async () => ({
      monthKey: '2026-11',
      spentUsd: 0,
      capUsd: 5,
      callsCount: 0,
      cacheHitsCount: 0,
      provider: 'local' as const,
      hasCloudKey: false,
      limitReached: false,
    })),
    getCloudAiQuota: vi.fn(async () => ({
      available: false,
      signedIn: false,
      spentUsd: 0,
      limitUsd: 1,
      remainingUsd: 1,
      requestCount: 0,
      blocked: false,
      globalExhausted: false,
      usingPersonalKey: false,
    })),
    transformText: vi.fn(async (input) => ({
      formattedText: input.text,
      extractedTasks: [],
      usedCloud: false,
    })),
    synthesizeNotes: vi.fn(async () => ({
      preview: {
        title: 'Сводка',
        body: 'Текст',
        summary: 'Текст',
        tags: [],
        orbit: '',
        usedCloud: false,
        preservedDetailsCount: 1,
      },
      savedItem: null,
    })),
    previewSmartTriage: vi.fn(async () => ({
      configured: true,
      usedCloud: false,
      suggestions: [],
      newOrbits: [],
      mergeGroups: [],
    })),
    applySmartTriage: vi.fn(async () => ({ applied: 0 })),
    dictateAudio: vi.fn(async () => ({
      transcript: '',
      formattedText: '',
      keyPoints: [],
      actionItems: [],
      durationSec: 1,
      usedCloud: false,
    })),
    transcribeItem: vi.fn(async () => ({ ok: true })),
    saveRevision: vi.fn(async () => null),
    listRevisions: vi.fn(async () => []),
    revertRevision: vi.fn(async () => null),
    saveItemRevision: vi.fn(async () => null),
    listItemRevisions: vi.fn(async () => []),
    revertItemToRevision: vi.fn(async () => null),
    listTasks: vi.fn(async () => []),
    toggleTask: vi.fn(async () => null),
    bulkToggleTasks: vi.fn(async () => ({ updatedItems: [], tasks: [] })),
    moveTaskOnBoard: vi.fn(async () => makeVaultItem()),
    createTask: vi.fn(async () => makeVaultItem()),
    updateTaskMeta: vi.fn(async () => makeVaultItem()),
    bulkUpdateTasksMeta: vi.fn(async () => ({ updatedItems: [], tasks: [] })),
    updateVaultTaskText: vi.fn(async () => makeVaultItem()),
    deleteVaultTask: vi.fn(async () => makeVaultItem()),
    bulkDeleteTasks: vi.fn(async () => ({ updatedItems: [], deletedItemIds: [], tasks: [] })),
    listTaskBoardColumns: vi.fn(async () => makeDefaultColumns()),
    saveTaskBoardColumns: vi.fn(async (cols) => cols),

    listCalendarEvents: vi.fn(async () => []),
    upsertCalendarEvent: vi.fn(async (input) =>
      makeCalendarEvent({
        id: input.id || 'ev-new-1',
        title: input.title,
        startAt: input.startAt,
        endAt: input.endAt,
        allDay: Boolean(input.allDay),
        hasEndTime: input.hasEndTime !== false,
        color: input.color || '#E86A33',
        kind: input.kind || 'event',
        recurrence: input.recurrence || 'none',
        location: input.location || '',
        notes: input.notes || '',
      })
    ),
    deleteCalendarEvent: vi.fn(async () => true),
    getCalendarStatus: vi.fn(async () => ({
      connected: false,
      email: null,
      clientId: '',
      icalUrl: '',
      lastSyncAt: null,
      error: null,
      hasCredentials: false,
    })),
    saveCalendarConfig: vi.fn(async () => ({
      connected: false,
      email: null,
      clientId: '',
      icalUrl: '',
      lastSyncAt: null,
      error: null,
      hasCredentials: false,
    })),
    connectGoogleCalendar: vi.fn(async () => ({
      connected: false,
      email: null,
      clientId: '',
      icalUrl: '',
      lastSyncAt: null,
      error: null,
      hasCredentials: false,
    })),
    disconnectGoogleCalendar: vi.fn(async () => ({
      connected: false,
      email: null,
      clientId: '',
      icalUrl: '',
      lastSyncAt: null,
      error: null,
      hasCredentials: false,
    })),
    syncCalendarNow: vi.fn(async () => ({
      imported: 0,
      pushed: 0,
      status: {
        connected: false,
        email: null,
        clientId: '',
        icalUrl: '',
        lastSyncAt: null,
        error: null,
        hasCredentials: false,
      },
    })),
    importCalendarIcs: vi.fn(async () => ({ imported: 0 })),
    exportCalendarIcs: vi.fn(async () => ({ exported: 0, path: null })),
    parseNaturalDate: vi.fn(async () => null),

    getSettings: vi.fn(async () => makeSettingsState()),
    updateSettings: vi.fn(async (patch) => makeSettingsState(patch as Partial<SettingsState>)),
    setApiKey: vi.fn(async () => makeSettingsState()),
    testAiKey: vi.fn(async () => ({ ok: true, message: 'OK' })),

    importArchiveJson: vi.fn(async () => ({
      format: 'unknown' as const,
      imported: 0,
      skippedDuplicates: 0,
      errors: 0,
    })),
    pickAndImportArchive: vi.fn(async () => ({
      format: 'unknown' as const,
      imported: 0,
      skippedDuplicates: 0,
      errors: 0,
      canceled: true,
    })),
    openExtensionFolder: vi.fn(async () => {}),
    getClipperPairingInfo: vi.fn(async () => ({ pairingCode: '123456', pairedCount: 0 })),
    resetClipperPairing: vi.fn(async () => ({ pairingCode: '654321', pairedCount: 0 })),
    getStorageSummary: vi.fn(async () => ({ itemCount: 0, mediaFilesCount: 0, totalBytes: 0 })),
    getVideoCacheStats: vi.fn(async () => ({ bytesUsed: 0, fileCount: 0, limitMb: 500 })),
    clearVideoCache: vi.fn(async () => ({ bytesUsed: 0, fileCount: 0, limitMb: 500 })),
    ensureLinkVideo: vi.fn(async () => null),
    openDataFolder: vi.fn(async () => {}),
    exportBackup: vi.fn(async () => ({ canceled: false, itemCount: 0, filePath: 'backup.json' })),
    importEmlFiles: vi.fn(async () => ({ importedCount: 0, skippedCount: 0, orbitsCreated: 0 })),
    importMarkdownFolder: vi.fn(async () => ({ importedCount: 0, skippedCount: 0, orbitsCreated: 0 })),
    importNotionZip: vi.fn(async () => ({ importedCount: 0, skippedCount: 0, orbitsCreated: 0 })),
    importJsonBackup: vi.fn(async () => ({ importedCount: 0, skippedCount: 0, orbitsCreated: 0 })),
    exportMarkdownZip: vi.fn(async () => ({ ok: true })),
    rotateEmailInboundToken: vi.fn(async () => ({ address: 'a@b', token: 'tok' })),

    getSyncStatus: vi.fn(async () => makeSyncStatus()),
    syncSignUp: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncSignIn: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncSignInGoogle: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncSignOut: vi.fn(async () => makeSyncStatus()),
    syncDeleteAccount: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncSetupPassphrase: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncUnlockPassphrase: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncUnlockRecovery: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncChangePassphrase: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncNow: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    reconcileFullSync: vi.fn(async () => makeSyncStatus()),
    syncSetServerConfig: vi.fn(async () => makeSyncStatus()),
    syncRegenerateRecoveryKey: vi.fn(async () => ({ ok: true, status: makeSyncStatus() })),
    syncCopyRecoveryKey: vi.fn(async () => ({ ok: true, wipeSeconds: 30 })),

    getUpdaterState: vi.fn(async () => ({
      status: 'idle' as const,
      currentVersion: '1.0.4',
      mode: 'manual-download' as const,
    })),
    checkForUpdates: vi.fn(async () => ({
      status: 'up-to-date' as const,
      currentVersion: '1.0.4',
      mode: 'manual-download' as const,
    })),
    downloadUpdate: vi.fn(async () => ({
      status: 'idle' as const,
      currentVersion: '1.0.4',
      mode: 'manual-download' as const,
    })),
    installUpdate: vi.fn(async () => ({ ok: true })),
    dismissUpdate: vi.fn(async () => null),
    getDiagnosticsReport: vi.fn(async () => '{}'),

    windowAction: vi.fn(async () => {}),
    focusVaultItem: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    openMediaFile: vi.fn(async () => true),
    revealMediaFile: vi.fn(async () => true),
    copyText: vi.fn(async () => {}),
    copyImage: vi.fn(async () => true),
    closeHud: vi.fn(async () => {}),
    setHudPreventClose: vi.fn(async () => true),
    pasteBackFromHud: vi.fn(async () => true),
    isWindowFullScreen: vi.fn(async () => false),
    getHudClipboardPreview: vi.fn(async () => ({ hasImage: false, text: '' })),
    getPathForFile: vi.fn(() => ''),

    onVaultItemUpserted: subscribe('onVaultItemUpserted'),
    onVaultItemsBatchUpserted: subscribe('onVaultItemsBatchUpserted'),
    onVaultItemDeleted: subscribe('onVaultItemDeleted'),
    onVaultItemsBatchDeleted: subscribe('onVaultItemsBatchDeleted'),
    onVaultNewNote: subscribe('onVaultNewNote'),
    onOpenCalendar: subscribe('onOpenCalendar'),
    onOrbitsChanged: subscribe('onOrbitsChanged'),
    onBoardsChanged: subscribe('onBoardsChanged'),
    onCalendarChanged: subscribe('onCalendarChanged'),
    onFocusItem: subscribe('onFocusItem'),
    onSettingsUpdated: subscribe('onSettingsUpdated'),
    onSyncStatusUpdated: subscribe('onSyncStatusUpdated'),
    onVaultBatchSynced: subscribe('onVaultBatchSynced'),
    onHudOpened: subscribe('onHudOpened'),
    onWindowFullScreenChanged: subscribe('onWindowFullScreenChanged'),
    onOpenSettings: subscribe('onOpenSettings'),
    onFocusSearch: subscribe('onFocusSearch'),
    onUpdaterStateChanged: subscribe('onUpdaterStateChanged'),

    ...overrides,
  };

  return { api, emit };
}

export function installMockKapsulaApi(overrides: Partial<KapsulaBridgeApi> = {}) {
  const created = createMockKapsulaApi(overrides);
  (window as unknown as { kapsula: KapsulaBridgeApi }).kapsula = created.api;
  return created;
}

export function renderWithI18n(
  ui: React.ReactElement,
  locale: AppLocale = 'ru',
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(I18nProvider, { locale, children });
  return render(ui, { wrapper: Wrapper, ...options });
}
