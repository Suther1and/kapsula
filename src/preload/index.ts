import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  SyncActionResult,
  SyncAuthInput,
  SyncAuthResult,
  SyncServerConfigInput,
  SyncSetupPassphraseResult,
  SyncStatus,
} from '@shared/sync-contract';
import type {
  AiProvider,
  AppUpdaterState,
  ArchiveImportResult,
  AskVaultResult,
  BudgetSummary,
  BulkDeleteItemsResult,
  BulkDeleteTasksResult,
  BulkTasksMutationResult,
  BulkToggleTaskInput,
  BulkUpdateItemsResult,
  BulkUpdateTasksMetaInput,
  CalendarEvent,
  CalendarEventInput,
  CalendarSyncStatus,
  CaptureInput,
  ChatTurn,
  CloudAiQuotaStatus,
  CreateTaskInput,
  ExportResult,
  FocusBoard,
  FocusBoardUpdateInput,
  ImportResult,
  ItemRevision,
  ItemRevisionSource,
  OrbitDef,
  OrbitUpdateInput,
  SaveNoteImageResult,
  SecretCopyField,
  SecretCopyResult,
  SecretPayload,
  SettingsState,
  StructuredSecretInput,
  SynthesizeNotesInput,
  SynthesizeNotesResult,
  TaskBoardColumn,
  TaskPriority,
  TextTransformInput,
  TextTransformResult,
  TotpCodeSnapshot,
  TranscribeItemResult,
  TriageApplyInput,
  TriagePreviewResult,
  VaultInventorySummary,
  VaultItem,
  VaultQuery,
  VaultTaskEntry,
  VideoCacheStats,
  VoiceDictationInput,
  VoiceDictationResult,
} from '@shared/types';

export interface KapsulaBridgeApi {
  readonly platform: NodeJS.Platform;
  queryVault(q?: VaultQuery): Promise<VaultItem[]>;
  getVaultItem(id: string, opts?: { includeDeleted?: boolean }): Promise<VaultItem | null>;
  getStats(): Promise<{
    total: number;
    inboxCount: number;
    demoCount: number;
    pinnedCount: number;
    archivedCount: number;
    trashedCount?: number;
    dueRemindersCount: number;
    byOrbit: Record<string, number>;
    byDna: Record<string, number>;
  }>;
  getInventorySummary(): Promise<VaultInventorySummary>;
  pickSerendipity(limit?: number): Promise<VaultItem[]>;
  listDueReminders(endMs?: number): Promise<VaultItem[]>;
  capture(input: CaptureInput): Promise<VaultItem>;
  captureClipboard(
    opts?: string | { mode?: string; orbitOverride?: string; focusBoardId?: string | null }
  ): Promise<VaultItem | null>;
  captureScreen(opts?: { reopenHud?: boolean }): Promise<VaultItem>;
  updateItem(id: string, patch: Record<string, unknown>): Promise<VaultItem | null>;
  bulkUpdateItems(
    ids: string[],
    patch: Record<string, unknown>,
    opts?: { projection?: 'card' | 'full' }
  ): Promise<BulkUpdateItemsResult>;
  deleteItem(id: string): Promise<boolean>;
  bulkDeleteItems(ids: string[]): Promise<BulkDeleteItemsResult>;
  restoreItem(id: string): Promise<VaultItem | null>;
  bulkRestoreItems(ids: string[]): Promise<BulkUpdateItemsResult>;
  purgeItem(id: string): Promise<boolean>;
  emptyTrash(): Promise<{ purgedCount: number }>;
  duplicateItem(id: string): Promise<VaultItem | null>;
  saveNoteImage(input: {
    base64?: string;
    bytes?: Uint8Array;
    mimeType?: string;
    fileName?: string;
  }): Promise<SaveNoteImageResult>;
  exportMarkdown(id: string): Promise<{ saved: boolean; path: string | null }>;
  getRelatedItems(
    itemId: string
  ): Promise<{ related: Array<{ item: VaultItem; reason: string; score: number }>; backlinks: VaultItem[] }>;
  reprocessItem(id: string): Promise<VaultItem | null>;
  reprocessBufferAll(): Promise<number>;
  seedExamples(): Promise<number>;
  clearDemoItems(): Promise<number>;

  revealSecret(id: string): Promise<SecretPayload | null>;
  copySecret(id: string): Promise<SecretCopyResult>;
  copySecretField(
    id: string,
    field: SecretCopyField
  ): Promise<SecretCopyResult>;
  getTotpCode(itemId: string): Promise<TotpCodeSnapshot | null>;
  saveStructuredSecret(input: StructuredSecretInput): Promise<VaultItem | null>;
  setMasterPin(pin: string | null, currentPin?: string): Promise<boolean>;
  unlockVaultPin(pin: string): Promise<boolean>;
  lockVaultPin(): Promise<boolean>;
  promptBiometricUnlock(): Promise<{ ok: boolean; error?: string }>;
  setScreenProtection(enabled: boolean): Promise<boolean>;

  listOrbits(): Promise<OrbitDef[]>;
  createOrbit(input: { name: string; description: string; color?: string; icon?: string }): Promise<OrbitDef>;
  updateOrbit(id: string, patch: OrbitUpdateInput): Promise<OrbitDef | null>;
  reorderOrbits(ids: string[]): Promise<OrbitDef[]>;
  deleteOrbit(id: string): Promise<boolean>;

  listFocusBoards(): Promise<FocusBoard[]>;
  createFocusBoard(name: string, color?: string, icon?: string, description?: string): Promise<FocusBoard>;
  updateFocusBoard(id: string, patch: FocusBoardUpdateInput): Promise<FocusBoard | null>;
  reorderFocusBoards(ids: string[]): Promise<FocusBoard[]>;
  setActiveFocusBoard(id: string | null): Promise<void>;
  deleteFocusBoard(id: string): Promise<boolean>;

  askVault(question: string, history?: ChatTurn[]): Promise<AskVaultResult>;
  getBudget(): Promise<BudgetSummary>;
  getCloudAiQuota(): Promise<CloudAiQuotaStatus>;
  transformText(input: TextTransformInput): Promise<TextTransformResult>;
  synthesizeNotes(
    input: SynthesizeNotesInput & { save?: boolean; overrideTitle?: string; overrideBody?: string }
  ): Promise<{ preview: SynthesizeNotesResult; savedItem: VaultItem | null }>;
  previewSmartTriage(itemIds?: string[]): Promise<TriagePreviewResult>;
  applySmartTriage(input: TriageApplyInput): Promise<{ applied: number }>;
  dictateAudio(input: VoiceDictationInput): Promise<VoiceDictationResult>;
  transcribeItem(input: {
    itemId: string;
    wavBase64Fallback?: string;
    extractTasks?: boolean;
  }): Promise<TranscribeItemResult>;
  saveRevision(itemId: string, source?: ItemRevisionSource): Promise<ItemRevision | null>;
  listRevisions(itemId: string): Promise<ItemRevision[]>;
  revertRevision(itemId: string, revisionId: string): Promise<VaultItem | null>;
  saveItemRevision(itemId: string, source?: ItemRevisionSource): Promise<ItemRevision | null>;
  listItemRevisions(itemId: string): Promise<ItemRevision[]>;
  revertItemToRevision(itemId: string, revisionId: string): Promise<VaultItem | null>;
  listTasks(): Promise<VaultTaskEntry[]>;
  toggleTask(payload: {
    itemId: string;
    sourceType: 'markdown' | 'voice_action';
    taskIndex: number;
    done: boolean;
  }): Promise<{ item: VaultItem; tasks: VaultTaskEntry[] } | null>;
  bulkToggleTasks(inputs: BulkToggleTaskInput[]): Promise<BulkTasksMutationResult>;
  moveTaskOnBoard(input: {
    itemId: string;
    taskKey: string;
    columnId: string;
    boardOrder: number;
  }): Promise<VaultItem | null>;
  createTask(input: CreateTaskInput): Promise<VaultItem | null>;
  updateTaskMeta(input: {
    itemId: string;
    taskKey: string;
    priority?: TaskPriority;
    dueAt?: number | null;
    columnId?: string;
    orbit?: string | null;
    focusBoardId?: string | null;
    notes?: string | null;
  }): Promise<VaultItem | null>;
  bulkUpdateTasksMeta(input: BulkUpdateTasksMetaInput): Promise<BulkTasksMutationResult>;
  updateVaultTaskText(input: {
    itemId: string;
    taskKey: string;
    text: string;
  }): Promise<VaultItem | null>;
  deleteVaultTask(input: { itemId: string; taskKey: string }): Promise<VaultItem | null>;
  bulkDeleteTasks(inputs: Array<{ itemId: string; taskKey: string }>): Promise<BulkDeleteTasksResult>;
  listTaskBoardColumns(): Promise<TaskBoardColumn[]>;
  saveTaskBoardColumns(columns: TaskBoardColumn[]): Promise<TaskBoardColumn[]>;

  listCalendarEvents(range?: { startAt?: number; endAt?: number }): Promise<CalendarEvent[]>;
  upsertCalendarEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  deleteCalendarEvent(id: string): Promise<boolean>;
  getCalendarStatus(): Promise<CalendarSyncStatus>;
  saveCalendarConfig(input: { clientId?: string; icalUrl?: string }): Promise<CalendarSyncStatus>;
  connectGoogleCalendar(clientId?: string): Promise<CalendarSyncStatus>;
  disconnectGoogleCalendar(): Promise<CalendarSyncStatus>;
  syncCalendarNow(): Promise<{ imported: number; pushed: number; status: CalendarSyncStatus }>;
  importCalendarIcs(icsText?: string): Promise<{ imported: number }>;
  exportCalendarIcs(): Promise<{ exported: number; path: string | null }>;
  parseNaturalDate(text: string): Promise<{ startAt: number; endAt: number; label: string } | null>;

  getSettings(): Promise<SettingsState>;
  updateSettings(patch: Record<string, unknown>): Promise<SettingsState>;
  setApiKey(provider: 'openrouter' | 'google_ai_studio', apiKey: string): Promise<SettingsState>;
  testAiKey(provider: AiProvider, apiKey?: string): Promise<{ ok: boolean; message: string }>;

  importArchiveJson(rawJson: string): Promise<ArchiveImportResult>;
  pickAndImportArchive(): Promise<ArchiveImportResult & { canceled?: boolean }>;
  openExtensionFolder(): Promise<void>;
  getClipperPairingInfo(): Promise<{ pairingCode: string; pairedCount: number }>;
  resetClipperPairing(): Promise<{ pairingCode: string; pairedCount: number }>;
  getStorageSummary(): Promise<{ itemCount: number; mediaFilesCount: number; totalBytes: number }>;
  getVideoCacheStats(): Promise<VideoCacheStats>;
  clearVideoCache(): Promise<VideoCacheStats>;
  ensureLinkVideo(itemId: string): Promise<VaultItem | null>;
  openDataFolder(): Promise<void>;
  exportBackup(): Promise<{ canceled: boolean; itemCount: number; filePath: string | null }>;
  importEmlFiles(filePaths?: string[]): Promise<ImportResult>;
  importMarkdownFolder(folderPath?: string): Promise<ImportResult>;
  importNotionZip(zipPath?: string): Promise<ImportResult>;
  importJsonBackup(filePath?: string): Promise<ImportResult>;
  exportMarkdownZip(): Promise<ExportResult>;
  rotateEmailInboundToken(): Promise<{ address: string; token: string }>;

  getSyncStatus(): Promise<SyncStatus>;
  syncSignUp(input: SyncAuthInput): Promise<SyncAuthResult>;
  syncSignIn(input: SyncAuthInput): Promise<SyncAuthResult>;
  syncSignInGoogle(): Promise<SyncAuthResult>;
  syncSignOut(): Promise<SyncStatus>;
  syncDeleteAccount(): Promise<{ ok: boolean; error?: string; status?: SyncStatus }>;
  syncSetupPassphrase(passphrase: string): Promise<SyncSetupPassphraseResult>;
  syncUnlockPassphrase(passphrase: string): Promise<SyncActionResult>;
  syncUnlockRecovery(payload: {
    recoveryKey: string;
    newPassphrase?: string;
  }): Promise<SyncActionResult>;
  syncChangePassphrase(payload: {
    currentPassphrase: string;
    newPassphrase: string;
  }): Promise<SyncActionResult>;
  syncNow(): Promise<SyncActionResult>;
  reconcileFullSync(): Promise<SyncStatus>;
  syncSetServerConfig(input: SyncServerConfigInput | null): Promise<SyncStatus>;
  syncRegenerateRecoveryKey(): Promise<SyncSetupPassphraseResult>;
  syncCopyRecoveryKey(recoveryKey: string): Promise<{ ok: boolean; wipeSeconds: number }>;

  getUpdaterState(): Promise<AppUpdaterState>;
  checkForUpdates(opts?: { silent?: boolean; maxAgeMs?: number }): Promise<AppUpdaterState>;
  downloadUpdate(): Promise<AppUpdaterState>;
  installUpdate(): Promise<{ ok: boolean }>;
  dismissUpdate(version?: string): Promise<AppUpdaterState | null>;
  getDiagnosticsReport(): Promise<string>;

  windowAction(
    action:
      | 'minimize'
      | 'maximize'
      | 'close'
      | 'open-vault'
      | 'open-vault-new-note'
      | 'open-vault-calendar'
      | 'open-hud'
  ): Promise<void>;
  focusVaultItem(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openMediaFile(filename: string): Promise<boolean>;
  revealMediaFile(filename: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  copyImage(imagePath: string): Promise<boolean>;
  closeHud(): Promise<void>;
  setHudPreventClose(prevent: boolean): Promise<boolean>;
  pasteBackFromHud(text: string, isSecret?: boolean): Promise<boolean>;
  isWindowFullScreen(): Promise<boolean>;
  getHudClipboardPreview(): Promise<{ hasImage: boolean; text: string }>;
  getPathForFile(file: File): string;

  onVaultItemUpserted(cb: (item: VaultItem) => void): () => void;
  onVaultItemsBatchUpserted(cb: (items: VaultItem[]) => void): () => void;
  onVaultItemDeleted(cb: (id: string) => void): () => void;
  onVaultItemsBatchDeleted(cb: (ids: string[]) => void): () => void;
  onVaultNewNote(cb: () => void): () => void;
  onOpenCalendar(cb: () => void): () => void;
  onOrbitsChanged(cb: () => void): () => void;
  onBoardsChanged(cb: () => void): () => void;
  onCalendarChanged(cb: () => void): () => void;
  onFocusItem(cb: (id: string) => void): () => void;
  onSettingsUpdated(cb: (settings: SettingsState) => void): () => void;
  onSyncStatusUpdated(cb: (status: SyncStatus) => void): () => void;
  onVaultBatchSynced(cb: () => void): () => void;
  onHudOpened(cb: () => void): () => void;
  onWindowFullScreenChanged(cb: (isFullScreen: boolean) => void): () => void;
  onOpenSettings(cb: () => void): () => void;
  onFocusSearch(cb: () => void): () => void;
  onUpdaterStateChanged(cb: (state: AppUpdaterState) => void): () => void;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KapsulaBridgeApi = {
  platform: process.platform,
  queryVault: (q) => ipcRenderer.invoke('vault:query', q),
  getVaultItem: (id, opts) => ipcRenderer.invoke('vault:get-item', id, opts),
  getStats: () => ipcRenderer.invoke('vault:stats'),
  getInventorySummary: () => ipcRenderer.invoke('vault:inventory-summary'),
  pickSerendipity: (limit) => ipcRenderer.invoke('vault:serendipity', limit),
  listDueReminders: (endMs) => ipcRenderer.invoke('vault:reminders-due', endMs),
  capture: (input) => ipcRenderer.invoke('vault:capture', input),
  captureClipboard: (opts) => ipcRenderer.invoke('vault:capture-clipboard', opts),
  captureScreen: (opts) => ipcRenderer.invoke('system:capture-screen', opts),
  updateItem: (id, patch) => ipcRenderer.invoke('vault:update-item', id, patch),
  bulkUpdateItems: (ids, patch, opts) =>
    ipcRenderer.invoke('vault:bulk-update-items', ids, patch, opts),
  deleteItem: (id) => ipcRenderer.invoke('vault:delete-item', id),
  bulkDeleteItems: (ids) => ipcRenderer.invoke('vault:bulk-delete-items', ids),
  restoreItem: (id) => ipcRenderer.invoke('vault:restore-item', id),
  bulkRestoreItems: (ids) => ipcRenderer.invoke('vault:bulk-restore-items', ids),
  purgeItem: (id) => ipcRenderer.invoke('vault:purge-item', id),
  emptyTrash: () => ipcRenderer.invoke('vault:empty-trash'),
  duplicateItem: (id) => ipcRenderer.invoke('vault:duplicate-item', id),
  saveNoteImage: (input) => ipcRenderer.invoke('media:save-note-image', input),
  exportMarkdown: (id) => ipcRenderer.invoke('vault:export-markdown', id),
  getRelatedItems: (itemId) => ipcRenderer.invoke('vault:related-items', itemId),
  reprocessItem: (id) => ipcRenderer.invoke('vault:reprocess-item', id),
  reprocessBufferAll: () => ipcRenderer.invoke('vault:reprocess-buffer'),
  seedExamples: () => ipcRenderer.invoke('vault:seed-examples'),
  clearDemoItems: () => ipcRenderer.invoke('vault:clear-demo'),

  revealSecret: (id) => ipcRenderer.invoke('secret:reveal', id),
  copySecret: (id) => ipcRenderer.invoke('secret:copy', id),
  copySecretField: (id, field) => ipcRenderer.invoke('secret:copy-field', id, field),
  getTotpCode: (itemId) => ipcRenderer.invoke('secret:get-totp-code', itemId),
  saveStructuredSecret: (input) => ipcRenderer.invoke('secret:save-structured', input),
  setMasterPin: (pin, currentPin) => ipcRenderer.invoke('secret:set-pin', pin, currentPin),
  unlockVaultPin: (pin) => ipcRenderer.invoke('secret:unlock-pin', pin),
  lockVaultPin: () => ipcRenderer.invoke('secret:lock'),
  promptBiometricUnlock: () => ipcRenderer.invoke('vault:biometric-unlock'),
  setScreenProtection: (enabled) => ipcRenderer.invoke('vault:set-screen-protection', enabled),

  listOrbits: () => ipcRenderer.invoke('orbit:list'),
  createOrbit: (input) => ipcRenderer.invoke('orbit:create', input),
  updateOrbit: (id, patch) => ipcRenderer.invoke('orbit:update', id, patch),
  reorderOrbits: (ids) => ipcRenderer.invoke('orbit:reorder', ids),
  deleteOrbit: (id) => ipcRenderer.invoke('orbit:delete', id),

  listFocusBoards: () => ipcRenderer.invoke('focus:list'),
  createFocusBoard: (name, color, icon, description) =>
    ipcRenderer.invoke('focus:create', name, color, icon, description),
  updateFocusBoard: (id, patch) => ipcRenderer.invoke('focus:update', id, patch),
  reorderFocusBoards: (ids) => ipcRenderer.invoke('focus:reorder', ids),
  setActiveFocusBoard: (id) => ipcRenderer.invoke('focus:set-active', id),
  deleteFocusBoard: (id) => ipcRenderer.invoke('focus:delete', id),

  askVault: (question, history) => ipcRenderer.invoke('ai:ask-vault', question, history),
  getBudget: () => ipcRenderer.invoke('ai:budget'),
  getCloudAiQuota: () => ipcRenderer.invoke('ai:get-cloud-quota'),
  transformText: (input) => ipcRenderer.invoke('ai:transform-text', input),
  synthesizeNotes: (input) => ipcRenderer.invoke('ai:synthesize-notes', input),
  previewSmartTriage: (itemIds) => ipcRenderer.invoke('ai:preview-triage', itemIds),
  applySmartTriage: (input) => ipcRenderer.invoke('ai:apply-triage', input),
  dictateAudio: (input) => ipcRenderer.invoke('ai:dictate-to-text', input),
  transcribeItem: (input) => ipcRenderer.invoke('ai:transcribe-item', input),
  saveRevision: (itemId, source) => ipcRenderer.invoke('vault:save-revision', itemId, source),
  listRevisions: (itemId) => ipcRenderer.invoke('vault:list-revisions', itemId),
  revertRevision: (itemId, revisionId) =>
    ipcRenderer.invoke('vault:revert-revision', itemId, revisionId),
  saveItemRevision: (itemId, source) => ipcRenderer.invoke('vault:save-revision', itemId, source),
  listItemRevisions: (itemId) => ipcRenderer.invoke('vault:list-revisions', itemId),
  revertItemToRevision: (itemId, revisionId) =>
    ipcRenderer.invoke('vault:revert-revision', itemId, revisionId),
  listTasks: () => ipcRenderer.invoke('vault:list-tasks'),
  toggleTask: (payload) => ipcRenderer.invoke('vault:toggle-task', payload),
  bulkToggleTasks: (inputs) => ipcRenderer.invoke('tasks:bulk-toggle', inputs),
  moveTaskOnBoard: (input) => ipcRenderer.invoke('tasks:move-on-board', input),
  createTask: (input) => ipcRenderer.invoke('tasks:create', input),
  updateTaskMeta: (input) => ipcRenderer.invoke('tasks:update-meta', input),
  bulkUpdateTasksMeta: (input) => ipcRenderer.invoke('tasks:bulk-update-meta', input),
  updateVaultTaskText: (input) => ipcRenderer.invoke('tasks:update-text', input),
  deleteVaultTask: (input) => ipcRenderer.invoke('tasks:delete', input),
  bulkDeleteTasks: (inputs) => ipcRenderer.invoke('tasks:bulk-delete', inputs),
  listTaskBoardColumns: () => ipcRenderer.invoke('tasks:list-columns'),
  saveTaskBoardColumns: (columns) => ipcRenderer.invoke('tasks:save-columns', columns),

  listCalendarEvents: (range) => ipcRenderer.invoke('calendar:list', range),
  upsertCalendarEvent: (input) => ipcRenderer.invoke('calendar:upsert', input),
  deleteCalendarEvent: (id) => ipcRenderer.invoke('calendar:delete', id),
  getCalendarStatus: () => ipcRenderer.invoke('calendar:status'),
  saveCalendarConfig: (input) => ipcRenderer.invoke('calendar:save-config', input),
  connectGoogleCalendar: (clientId) => ipcRenderer.invoke('calendar:connect-oauth', clientId),
  disconnectGoogleCalendar: () => ipcRenderer.invoke('calendar:disconnect'),
  syncCalendarNow: () => ipcRenderer.invoke('calendar:sync-now'),
  importCalendarIcs: (icsText) => ipcRenderer.invoke('calendar:import-ics', icsText),
  exportCalendarIcs: () => ipcRenderer.invoke('calendar:export-ics'),
  parseNaturalDate: (text) => ipcRenderer.invoke('calendar:parse-date', text),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setApiKey: (provider, apiKey) => ipcRenderer.invoke('settings:set-api-key', provider, apiKey),
  testAiKey: (provider, apiKey) => ipcRenderer.invoke('settings:test-ai-key', provider, apiKey),

  importArchiveJson: (rawJson) => ipcRenderer.invoke('bridges:import-archive', rawJson),
  pickAndImportArchive: () => ipcRenderer.invoke('bridges:pick-archive-file'),
  openExtensionFolder: () => ipcRenderer.invoke('bridges:open-extension-dir'),
  getClipperPairingInfo: () => ipcRenderer.invoke('clipper:get-pairing-info'),
  resetClipperPairing: () => ipcRenderer.invoke('clipper:reset-pairing'),
  getStorageSummary: () => ipcRenderer.invoke('vault:storage-summary'),
  getVideoCacheStats: () => ipcRenderer.invoke('media:video-cache-stats'),
  clearVideoCache: () => ipcRenderer.invoke('media:clear-video-cache'),
  ensureLinkVideo: (itemId) => ipcRenderer.invoke('media:ensure-link-video', itemId),
  openDataFolder: () => ipcRenderer.invoke('vault:open-data-dir'),
  exportBackup: () => ipcRenderer.invoke('vault:export-backup'),
  importEmlFiles: (filePaths) => ipcRenderer.invoke('integrations:import-eml', filePaths),
  importMarkdownFolder: (folderPath) =>
    ipcRenderer.invoke('integrations:import-markdown-folder', folderPath),
  importNotionZip: (zipPath) => ipcRenderer.invoke('integrations:import-notion-zip', zipPath),
  importJsonBackup: (filePath) => ipcRenderer.invoke('integrations:import-json-backup', filePath),
  exportMarkdownZip: () => ipcRenderer.invoke('integrations:export-markdown-zip'),
  rotateEmailInboundToken: () => ipcRenderer.invoke('integrations:rotate-email-token'),

  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncSignUp: (input) => ipcRenderer.invoke('sync:sign-up', input),
  syncSignIn: (input) => ipcRenderer.invoke('sync:sign-in', input),
  syncSignInGoogle: () => ipcRenderer.invoke('sync:sign-in-google'),
  syncSignOut: () => ipcRenderer.invoke('sync:sign-out'),
  syncDeleteAccount: () => ipcRenderer.invoke('sync:delete-account'),
  syncSetupPassphrase: (passphrase) => ipcRenderer.invoke('sync:setup-passphrase', passphrase),
  syncUnlockPassphrase: (passphrase) => ipcRenderer.invoke('sync:unlock-passphrase', passphrase),
  syncUnlockRecovery: (payload) => ipcRenderer.invoke('sync:unlock-recovery', payload),
  syncChangePassphrase: (payload) => ipcRenderer.invoke('sync:change-passphrase', payload),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  reconcileFullSync: () => ipcRenderer.invoke('sync:reconcile-full'),
  syncSetServerConfig: (input) => ipcRenderer.invoke('sync:set-server-config', input),
  syncRegenerateRecoveryKey: () => ipcRenderer.invoke('sync:regenerate-recovery'),
  syncCopyRecoveryKey: (recoveryKey) => ipcRenderer.invoke('sync:copy-recovery-key', recoveryKey),

  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: (opts) => ipcRenderer.invoke('updater:check', opts),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  dismissUpdate: (version) => ipcRenderer.invoke('updater:dismiss', version),
  getDiagnosticsReport: () => ipcRenderer.invoke('diagnostics:get-report'),

  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  focusVaultItem: (id) => ipcRenderer.invoke('window:focus-item', id),
  openExternal: (url) => ipcRenderer.invoke('window:open-external', url),
  openMediaFile: (filename) => ipcRenderer.invoke('media:open', filename),
  revealMediaFile: (filename) => ipcRenderer.invoke('media:reveal', filename),
  copyText: (text) => ipcRenderer.invoke('window:copy-text', text),
  copyImage: (imagePath) => ipcRenderer.invoke('window:copy-image', imagePath),
  closeHud: () => ipcRenderer.invoke('hud:close'),
  setHudPreventClose: (prevent) => ipcRenderer.invoke('hud:set-prevent-close', prevent),
  pasteBackFromHud: (text, isSecret) => ipcRenderer.invoke('hud:paste-back', text, isSecret),
  isWindowFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  getHudClipboardPreview: () => ipcRenderer.invoke('hud:clipboard-preview'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  onVaultItemUpserted: (cb) => subscribe('vault:item-upserted', cb),
  onVaultItemsBatchUpserted: (cb) => subscribe('vault:items-batch-upserted', cb),
  onVaultItemDeleted: (cb) => subscribe('vault:item-deleted', cb),
  onVaultItemsBatchDeleted: (cb) => subscribe('vault:items-batch-deleted', cb),
  onVaultNewNote: (cb) => subscribe('vault:new-note', cb),
  onOpenCalendar: (cb) => subscribe('vault:open-calendar', cb),
  onOrbitsChanged: (cb) => subscribe('vault:orbits-changed', cb),
  onBoardsChanged: (cb) => subscribe('vault:boards-changed', cb),
  onCalendarChanged: (cb) => subscribe('vault:calendar-changed', cb),
  onFocusItem: (cb) => subscribe('vault:focus-item', cb),
  onSettingsUpdated: (cb) => subscribe('settings:updated', cb),
  onSyncStatusUpdated: (cb) => subscribe('sync:status-updated', cb),
  onVaultBatchSynced: (cb) => subscribe('vault:batch-synced', cb),
  onHudOpened: (cb) => subscribe('hud:opened', cb),
  onWindowFullScreenChanged: (cb) => subscribe('window:fullscreen-changed', cb),
  onOpenSettings: (cb) => subscribe('vault:open-settings', cb),
  onFocusSearch: (cb) => subscribe('vault:focus-search', cb),
  onUpdaterStateChanged: (cb) => subscribe('updater:state-changed', cb),
};

contextBridge.exposeInMainWorld('kapsula', api);
