import type { AppLocale } from '@shared/i18n/core';
import { normalizeLocale } from '@shared/i18n/core';
import { isUntitledPlaceholderTitle } from '@shared/item-helpers';
import {
  DEFAULT_APPEARANCE_CONFIG,
} from '@shared/color-engine';
import {
  getMobileIntlLocale,
  resolveMobileLocale,
  setRuntimeMobileLocale,
  tm,
  writeStoredMobileLocale,
} from '../lib/mobile-i18n';
import {
  extractInlineMediaFilenames,
  type SyncEntityType,
  type SyncedCalendarEventPayload,
  type SyncedFocusBoardPayload,
  type SyncedItemPayload,
  type SyncedItemRevisionPayload,
  type SyncedOrbitPayload,
  type SyncedWorkspacePrefsPayload,
} from '@shared/sync-contract';
import {
  DEFAULT_TASK_BOARD_COLUMNS,
  extractWikiLinkTitles,
  isDoneColumn,
  normalizeTaskTextHash,
  parseMarkdownTasks as sharedParseMarkdownTasks,
  reconcileTaskMeta,
  toggleMarkdownTaskInBody,
} from '@shared/task-helpers';
import { generateTotp, parseOtpAuthUri } from '@shared/totp';
import type {
  AiProvider,
  AppearanceConfig,
  CalendarEvent,
  CalendarEventInput,
  ContentDna,
  FocusBoard,
  FocusBoardUpdateInput,
  ItemRevision,
  ItemRevisionSource,
  ItemSource,
  MediaMeta,
  OrbitDef,
  OrbitUpdateInput,
  SecretCopyField,
  SecretPayload,
  StructuredSecretInput,
  TaskBoardColumn,
  TaskBoardItemMeta,
  TaskPriority,
  TotpCodeSnapshot,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { mobileBridge } from '../native/bridge';
import { base64ToBytes, bytesToBase64 } from '../sync/mobile-crypto';
import { sanitizeMobileMediaFilename } from '../sync/mobile-media';
import {
  buildSecretMetaFromInput,
  hashMasterPin,
  MobileLocalCrypto,
  verifyMasterPin,
} from './mobile-vault-crypto';

export interface StoredMobileItem extends VaultItem {
  encryptedSecretPayload: string | null;
  lastDeviceId?: string | null;
  purgedAt?: number | null;
}

export interface StoredMobileOrbit extends OrbitDef {
  syncVersion: number;
  lastDeviceId?: string | null;
}

export interface StoredMobileBoard extends FocusBoard {
  syncVersion: number;
  lastDeviceId?: string | null;
}

export interface StoredMobileCalendarEvent extends CalendarEvent {
  lastDeviceId?: string | null;
}

export interface StoredMobileRevision extends ItemRevision {
  lastDeviceId?: string | null;
}

export interface DirtySyncEntry {
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  dirtyAt: number;
  dirtySeq: number;
  failCount?: number;
  lastError?: string | null;
  nextRetryAt?: number;
}

export interface BlobCacheEntry {
  localName: string;
  blobId: string;
  sha256: string;
  byteSize: number;
  updatedAt: number;
  uploadedForUser: string | null;
}

export interface StoredMediaFile {
  localName: string;
  mime: string;
  bytes: Uint8Array;
  updatedAt: number;
}

export interface MobileAiConfig {
  provider: AiProvider;
  hasGoogleKey: boolean;
  hasOpenRouterKey: boolean;
}

export interface MobileStoreOptions {
  dbName?: string;
  memoryOnly?: boolean;
}

export const MOBILE_IDB_VERSION = 3;
const DB_VERSION = MOBILE_IDB_VERSION;
const MAX_REVISIONS_PER_ITEM = 30;
const AUTO_REVISION_MIN_INTERVAL_MS = 5 * 60_000;
const AUTO_REVISION_MIN_DELTA_CHARS = 120;

const STORE_NAMES = [
  'items',
  'orbits',
  'focus_boards',
  'calendar_events',
  'item_revisions',
  'sync_dirty',
  'sync_state',
  'sync_blob_cache',
  'media_files',
  'secure_kv',
] as const;

type StoreName = (typeof STORE_NAMES)[number];

const MARKDOWN_TASK_RE = /^(\s*[-*•]\s+)(?:\\\[|\[)([ xX])(?:\\\]|\])(\s+)(.+)$/;

export interface MobileParsedMarkdownTask {
  index: number;
  taskIndex: number;
  lineIndex: number;
  text: string;
  done: boolean;
  taskKey: string;
  textHash: string;
}

export function parseMarkdownTasks(body: string): MobileParsedMarkdownTask[] {
  return sharedParseMarkdownTasks(body).map((t) => ({
    ...t,
    taskIndex: t.index,
  }));
}

export function compareLww(
  local: {
    updatedAt: number;
    syncVersion: number;
    deletedAt: number | null;
    deviceId: string;
  } | null,
  remote: {
    updatedAt: number;
    syncVersion: number;
    deletedAt: number | null;
    deviceId: string;
  }
): 'remote' | 'local' | 'equal' {
  if (!local) return 'remote';
  if (remote.updatedAt > local.updatedAt) return 'remote';
  if (remote.updatedAt < local.updatedAt) return 'local';
  if (remote.syncVersion > local.syncVersion) return 'remote';
  if (remote.syncVersion < local.syncVersion) return 'local';
  if (Boolean(remote.deletedAt) !== Boolean(local.deletedAt)) {
    return remote.deletedAt ? 'remote' : 'local';
  }
  if (remote.deviceId > local.deviceId) return 'remote';
  if (remote.deviceId < local.deviceId) return 'local';
  return 'equal';
}

function generateUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function computeLightContentHash(parts: Array<string | null | undefined>): string {
  const joined = parts.filter(Boolean).join('|');
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function extractUrlDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

function detectLinkPlatform(url: string | null | undefined): string | null {
  const domain = extractUrlDomain(url)?.toLowerCase();
  if (!domain) return null;
  if (domain === 't.me' || domain.endsWith('.t.me') || domain.includes('telegram')) return 'telegram';
  if (domain.includes('instagram.com')) return 'instagram';
  if (domain.includes('youtube.com') || domain === 'youtu.be') return 'youtube';
  if (domain.includes('github.com')) return 'github';
  if (domain === 'x.com' || domain.includes('twitter.com')) return 'x';
  if (domain.includes('figma.com')) return 'figma';
  return null;
}

function entityTypeOrder(t: SyncEntityType): number {
  if (t === 'orbit') return 0;
  if (t === 'focus_board') return 1;
  if (t === 'item') return 2;
  if (t === 'calendar_event') return 3;
  if (t === 'item_revision') return 4;
  return 5;
}

function parseTaskKey(taskKey: string): { sourceType: 'markdown' | 'voice_action'; index: number } | null {
  if (taskKey.startsWith('md:')) {
    const idx = Number(taskKey.slice(3));
    return Number.isInteger(idx) && idx >= 0 ? { sourceType: 'markdown', index: idx } : null;
  }
  if (taskKey.startsWith('va:')) {
    const idx = Number(taskKey.slice(3));
    return Number.isInteger(idx) && idx >= 0 ? { sourceType: 'voice_action', index: idx } : null;
  }
  if (taskKey.startsWith('voice:')) {
    const idx = Number(taskKey.slice(6));
    return Number.isInteger(idx) && idx >= 0 ? { sourceType: 'voice_action', index: idx } : null;
  }
  return null;
}

function pinLockoutDurationSec(failedAttempts: number): number {
  if (failedAttempts >= 11) return 30 * 60;
  if (failedAttempts >= 9) return 10 * 60;
  if (failedAttempts >= 7) return 2 * 60;
  if (failedAttempts >= 5) return 30;
  return 0;
}

class MemoryIdbAdapter {
  private readonly tables = new Map<StoreName, Map<string, unknown>>();

  constructor() {
    for (const name of STORE_NAMES) {
      this.tables.set(name, new Map());
    }
  }

  public async get<T>(store: StoreName, key: string): Promise<T | null> {
    return (this.tables.get(store)!.get(key) as T | undefined) ?? null;
  }

  public async getAll<T>(store: StoreName): Promise<T[]> {
    return Array.from(this.tables.get(store)!.values()) as T[];
  }

  public async put(store: StoreName, key: string, value: unknown): Promise<void> {
    this.tables.get(store)!.set(key, value);
  }

  public async delete(store: StoreName, key: string): Promise<void> {
    this.tables.get(store)!.delete(key);
  }

  public async clear(store: StoreName): Promise<void> {
    this.tables.get(store)!.clear();
  }
}

class RealIdbAdapter {
  private db: IDBDatabase | null = null;

  constructor(private readonly dbName: string) {}

  public async open(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) {
          db.createObjectStore('items', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('orbits')) {
          db.createObjectStore('orbits', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('focus_boards')) {
          db.createObjectStore('focus_boards', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('calendar_events')) {
          db.createObjectStore('calendar_events', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('item_revisions')) {
          const revStore = db.createObjectStore('item_revisions', { keyPath: 'id' });
          revStore.createIndex('by_item_id', 'itemId', { unique: false });
        }
        if (!db.objectStoreNames.contains('sync_dirty')) {
          db.createObjectStore('sync_dirty', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('sync_state')) {
          db.createObjectStore('sync_state', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('sync_blob_cache')) {
          db.createObjectStore('sync_blob_cache', { keyPath: 'localName' });
        }
        if (!db.objectStoreNames.contains('media_files')) {
          db.createObjectStore('media_files', { keyPath: 'localName' });
        }
        if (!db.objectStoreNames.contains('secure_kv')) {
          db.createObjectStore('secure_kv', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error(tm('store.idbOpenErr')));
    });
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error(tm('store.idbNotInitErr'));
    return this.db;
  }

  public async get<T>(store: StoreName, key: string): Promise<T | null> {
    const db = this.getDb();
    return new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error(tm('store.idbReadErr')));
    });
  }

  public async getAll<T>(store: StoreName): Promise<T[]> {
    const db = this.getDb();
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as T[]);
      req.onerror = () => reject(req.error ?? new Error(tm('store.idbReadErr')));
    });
  }

  public async put(store: StoreName, _key: string, value: unknown): Promise<void> {
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(tm('store.idbWriteErr')));
    });
  }

  public async delete(store: StoreName, key: string): Promise<void> {
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(tm('store.idbDeleteErr')));
    });
  }

  public async clear(store: StoreName): Promise<void> {
    const db = this.getDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error(tm('store.idbClearErr')));
    });
  }
}

export class MobileVaultStore {
  private readonly backend: MemoryIdbAdapter | RealIdbAdapter;
  private readonly itemsMap = new Map<string, StoredMobileItem>();
  private readonly orbitsMap = new Map<string, StoredMobileOrbit>();
  private readonly boardsMap = new Map<string, StoredMobileBoard>();
  private readonly calendarMap = new Map<string, StoredMobileCalendarEvent>();
  private readonly revisionsMap = new Map<string, StoredMobileRevision>();
  private readonly dirtyMap = new Map<string, DirtySyncEntry>();
  private readonly syncStateMap = new Map<string, string>();
  private readonly blobCacheMap = new Map<string, BlobCacheEntry>();
  private readonly mediaFilesMap = new Map<string, StoredMediaFile>();
  private readonly secureKvMap = new Map<string, string>();
  private readonly mediaObjectUrlCache = new Map<string, string>();
  private readonly mediaRefCounts = new Map<string, number>();
  private dataVersion = 0;
  private readonly snapshotCache = new Map<string, unknown>();

  private dirtySeqCounter = 1;
  private initialized = false;
  private readonly isMemoryOnly: boolean;
  private deviceNameLabel = 'Android';
  private cachedPinFailedAttempts = 0;
  private cachedPinLockedUntil = 0;
  private mutationListener: ((entityType: SyncEntityType, entityId: string) => void) | null = null;
  private changeListeners = new Set<() => void>();
  public readonly localCrypto: MobileLocalCrypto;

  constructor(options: MobileStoreOptions = {}) {
    const useMemory = Boolean(options.memoryOnly) || typeof indexedDB === 'undefined';
    this.isMemoryOnly = Boolean(options.memoryOnly);
    this.backend = useMemory
      ? new MemoryIdbAdapter()
      : new RealIdbAdapter(options.dbName ?? 'kapsula_mobile_v1');

    this.localCrypto = new MobileLocalCrypto(async () => {
      const existing = this.syncStateMap.get('local_fallback_seed');
      if (existing) return existing;
      const buf = new Uint8Array(new ArrayBuffer(32));
      globalThis.crypto.getRandomValues(buf);
      const seed = bytesToBase64(buf);
      await this.setSyncState('local_fallback_seed', seed);
      return seed;
    });
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.backend instanceof RealIdbAdapter) {
      await this.backend.open();
    }
    const [items, orbits, boards, events, revisions, dirty, states, blobs, secure] = await Promise.all([
      this.backend.getAll<StoredMobileItem>('items'),
      this.backend.getAll<StoredMobileOrbit>('orbits'),
      this.backend.getAll<StoredMobileBoard>('focus_boards'),
      this.backend.getAll<StoredMobileCalendarEvent>('calendar_events'),
      this.backend.getAll<StoredMobileRevision>('item_revisions'),
      this.backend.getAll<DirtySyncEntry>('sync_dirty'),
      this.backend.getAll<{ key: string; value: string }>('sync_state'),
      this.backend.getAll<BlobCacheEntry>('sync_blob_cache'),
      this.backend.getAll<{ key: string; value: string }>('secure_kv'),
    ]);

    items.forEach((it) => this.itemsMap.set(it.id, it));
    orbits.forEach((o) => this.orbitsMap.set(o.id, o));
    boards.forEach((b) => this.boardsMap.set(b.id, b));
    events.forEach((e) => this.calendarMap.set(e.id, e));
    revisions.forEach((r) => this.revisionsMap.set(r.id, r));
    dirty.forEach((d) => {
      this.dirtyMap.set(d.key, d);
      if (d.dirtySeq >= this.dirtySeqCounter) {
        this.dirtySeqCounter = d.dirtySeq + 1;
      }
    });
    states.forEach((s) => this.syncStateMap.set(s.key, s.value));
    blobs.forEach((b) => this.blobCacheMap.set(b.localName, b));
    secure.forEach((s) => this.secureKvMap.set(s.key, s.value));

    await this.loadPinLockoutState();
    this.localCrypto.setPinProtectedMode(this.hasMasterPin());
    this.bumpDataVersion();
    this.initialized = true;
  }

  private async loadPinLockoutState(): Promise<void> {
    const legacyAttempts = this.syncStateMap.get('pin_failed_attempts');
    const legacyUntil = this.syncStateMap.get('pin_locked_until');
    const requireOs = mobileBridge.isNativeAndroid();

    if (legacyAttempts !== undefined) {
      const n = Number(legacyAttempts) || 0;
      if (n > 0) {
        try {
          await this.setSecureValue('pin_failed_attempts', String(n), {
            requireOsProtection: requireOs,
          });
        } catch {
          // ignore if Keystore unavailable during migration
        }
      }
      await this.deleteSyncState('pin_failed_attempts');
    }
    if (legacyUntil !== undefined) {
      const n = Number(legacyUntil) || 0;
      if (n > 0) {
        try {
          await this.setSecureValue('pin_locked_until', String(n), {
            requireOsProtection: requireOs,
          });
        } catch {
          // ignore if Keystore unavailable during migration
        }
      }
      await this.deleteSyncState('pin_locked_until');
    }

    const secAttempts = await this.getSecureValue('pin_failed_attempts');
    const secUntil = await this.getSecureValue('pin_locked_until');
    this.cachedPinFailedAttempts = Math.max(0, Number(secAttempts || '0') || 0);
    this.cachedPinLockedUntil = Math.max(0, Number(secUntil || '0') || 0);
  }

  private async persistPinLockoutState(attempts: number, lockedUntil: number): Promise<void> {
    this.cachedPinFailedAttempts = attempts;
    this.cachedPinLockedUntil = lockedUntil;
    const requireOs = mobileBridge.isNativeAndroid();
    try {
      if (attempts > 0) {
        await this.setSecureValue('pin_failed_attempts', String(attempts), {
          requireOsProtection: requireOs,
        });
      } else {
        await this.removeSecureValue('pin_failed_attempts');
      }
      if (lockedUntil > 0) {
        await this.setSecureValue('pin_locked_until', String(lockedUntil), {
          requireOsProtection: requireOs,
        });
      } else {
        await this.removeSecureValue('pin_locked_until');
      }
    } catch {
      // In-memory lockout values remain enforced if Keystore is temporarily unavailable
    }
    await this.deleteSyncState('pin_failed_attempts');
    await this.deleteSyncState('pin_locked_until');
  }

  public setDeviceNameLabel(name: string): void {
    if (name?.trim()) this.deviceNameLabel = name.trim();
  }

  public setMutationListener(
    listener: ((entityType: SyncEntityType, entityId: string) => void) | null
  ): void {
    this.mutationListener = listener;
  }

  public subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private bumpDataVersion(): void {
    this.dataVersion += 1;
    this.snapshotCache.clear();
  }

  private emitChange(): void {
    this.bumpDataVersion();
    this.changeListeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // isolate UI subscriber errors
      }
    });
  }

  private nextMonotonicTs(prev?: number | null): number {
    const now = Date.now();
    return typeof prev === 'number' && prev >= now ? prev + 1 : now;
  }

  // ==================== Sync State & Secure KV ====================

  public getSyncState(key: string): string | null {
    return this.syncStateMap.get(key) ?? null;
  }

  public async setSyncState(key: string, value: string): Promise<void> {
    this.syncStateMap.set(key, value);
    await this.backend.put('sync_state', key, { key, value });
  }

  public async deleteSyncState(key: string): Promise<void> {
    this.syncStateMap.delete(key);
    await this.backend.delete('sync_state', key);
  }

  public async getSecureValue(key: string): Promise<string | null> {
    const encoded = this.secureKvMap.get(key);
    if (!encoded) return null;
    return this.localCrypto.decryptString(encoded);
  }

  public hasSecureKey(key: string): boolean {
    return this.secureKvMap.has(key);
  }

  public hasOsProtectedSecureKey(key: string): boolean {
    const raw = this.secureKvMap.get(key);
    return Boolean(raw && raw.startsWith('aks:'));
  }

  public async setSecureValue(
    key: string,
    plainValue: string,
    opts?: { requireOsProtection?: boolean }
  ): Promise<void> {
    const encoded = await this.localCrypto.encryptString(
      plainValue,
      Boolean(opts?.requireOsProtection)
    );
    this.secureKvMap.set(key, encoded);
    await this.backend.put('secure_kv', key, { key, value: encoded });
  }

  public async removeSecureValue(key: string): Promise<void> {
    this.secureKvMap.delete(key);
    await this.backend.delete('secure_kv', key);
  }

  public async removeSecureByPrefix(prefix: string): Promise<void> {
    const keys = Array.from(this.secureKvMap.keys()).filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      this.secureKvMap.delete(key);
      await this.backend.delete('secure_kv', key);
    }
  }

  // ==================== Master PIN, 2-Tier VDK & Exponential Backoff ====================

  public hasMasterPin(): boolean {
    return this.secureKvMap.has('vault_master_pin_hash');
  }

  public isVaultLocked(): boolean {
    return this.localCrypto.isLocked();
  }

  public lockVault(): void {
    this.localCrypto.lock();
  }

  private async storeBiometricVdk(vdk: Uint8Array): Promise<void> {
    const b64 = bytesToBase64(vdk);
    if (mobileBridge.isNativeAndroid()) {
      const authAvailable = await mobileBridge.isAuthKeystoreAvailable();
      if (!authAvailable) {
        await this.removeSecureValue('vault_vdk_bio_wrapped');
        return;
      }
      try {
        const cipher = await mobileBridge.keystoreAuthEncrypt(b64);
        const value = `aks_auth:${cipher}`;
        this.secureKvMap.set('vault_vdk_bio_wrapped', value);
        await this.backend.put('secure_kv', 'vault_vdk_bio_wrapped', {
          key: 'vault_vdk_bio_wrapped',
          value,
        });
      } catch {
        // User-auth window wasn't active yet; clear stale bio wrap cleanly so PIN remains fallback
        await this.removeSecureValue('vault_vdk_bio_wrapped');
      }
      return;
    }
    await this.setSecureValue('vault_vdk_bio_wrapped', b64);
  }

  public async enableBiometricVdkWrap(): Promise<void> {
    if (!this.hasMasterPin()) return;
    const vdk = this.localCrypto.getVdkCopy();
    if (!vdk) {
      throw new Error(tm('vaultCrypto.locked', undefined, this.getLocale()));
    }
    try {
      await this.storeBiometricVdk(vdk);
    } finally {
      vdk.fill(0);
    }
  }

  public async disableBiometricVdkWrap(): Promise<void> {
    await this.removeSecureValue('vault_vdk_bio_wrapped');
  }

  private async migrateSecretsToCurrentVdk(): Promise<void> {
    for (const item of this.itemsMap.values()) {
      if (
        item.dna !== 'secret' ||
        item.purgedAt != null ||
        !item.encryptedSecretPayload ||
        item.encryptedSecretPayload.startsWith('vdk:')
      ) {
        continue;
      }
      const plain = await this.localCrypto.decryptSecretPayload(item.encryptedSecretPayload);
      const reencrypted = await this.localCrypto.encryptSecretPayload(plain);
      const updated: StoredMobileItem = {
        ...item,
        encryptedSecretPayload: reencrypted,
      };
      this.itemsMap.set(item.id, updated);
      await this.backend.put('items', item.id, updated);
    }
  }

  public async setMasterPin(pin: string): Promise<void> {
    if (this.hasMasterPin() && this.isVaultLocked()) {
      throw new Error(tm('vaultCrypto.locked', undefined, this.getLocale()));
    }
    const requireOs = mobileBridge.isNativeAndroid();
    const hashed = await hashMasterPin(pin);
    await this.setSecureValue('vault_master_pin_hash', hashed, {
      requireOsProtection: requireOs,
    });

    const vdk = this.localCrypto.getVdkCopy() ?? this.localCrypto.generateVdk();
    try {
      const wrappedPin = await this.localCrypto.wrapVdkWithPin(vdk, pin);
      await this.setSecureValue('vault_vdk_pin_wrapped', wrappedPin, {
        requireOsProtection: requireOs,
      });
      this.localCrypto.setPinProtectedMode(true);
      this.localCrypto.setUnlockedVdk(vdk);
      await this.migrateSecretsToCurrentVdk();

      if (this.getSyncState('pref_biometric_vault') !== '0') {
        await this.storeBiometricVdk(vdk);
      } else {
        await this.removeSecureValue('vault_vdk_bio_wrapped');
      }
    } finally {
      vdk.fill(0);
    }

    await this.persistPinLockoutState(0, 0);
    this.emitChange();
  }

  public async removeMasterPin(): Promise<void> {
    if (this.isVaultLocked()) {
      throw new Error(tm('vaultCrypto.locked', undefined, this.getLocale()));
    }
    const requireOs = mobileBridge.isNativeAndroid();
    for (const item of this.itemsMap.values()) {
      if (item.dna !== 'secret' || item.purgedAt != null || !item.encryptedSecretPayload) {
        continue;
      }
      if (item.encryptedSecretPayload.startsWith('vdk:')) {
        const plain = await this.localCrypto.decryptSecretPayload(item.encryptedSecretPayload);
        const migrated = await this.localCrypto.encryptString(JSON.stringify(plain), requireOs);
        const updated: StoredMobileItem = {
          ...item,
          encryptedSecretPayload: migrated,
        };
        this.itemsMap.set(item.id, updated);
        await this.backend.put('items', item.id, updated);
      }
    }

    this.localCrypto.setPinProtectedMode(false);
    await this.removeSecureValue('vault_master_pin_hash');
    await this.removeSecureValue('vault_vdk_pin_wrapped');
    await this.removeSecureValue('vault_vdk_bio_wrapped');
    await this.persistPinLockoutState(0, 0);
    this.emitChange();
  }

  public getPinLockoutRemainingSec(nowMs = Date.now()): number {
    if (this.cachedPinLockedUntil <= nowMs) return 0;
    return Math.ceil((this.cachedPinLockedUntil - nowMs) / 1000);
  }

  public async verifyMasterPinWithBackoff(
    pin: string,
    nowMs = Date.now()
  ): Promise<{ ok: boolean; lockoutRemainingSec: number; error?: string }> {
    const remaining = this.getPinLockoutRemainingSec(nowMs);
    const locale = this.getLocale();
    if (remaining > 0) {
      return {
        ok: false,
        lockoutRemainingSec: remaining,
        error: tm('store.pinLockout', { sec: remaining }, locale),
      };
    }

    const storedHash = await this.getSecureValue('vault_master_pin_hash');
    if (!storedHash) {
      return { ok: false, lockoutRemainingSec: 0, error: tm('store.pinNotSet', undefined, locale) };
    }

    const matched = await verifyMasterPin(pin, storedHash);
    if (matched) {
      await this.persistPinLockoutState(0, 0);
      return { ok: true, lockoutRemainingSec: 0 };
    }

    const attempts = this.cachedPinFailedAttempts + 1;
    const lockSec = pinLockoutDurationSec(attempts);
    if (lockSec > 0) {
      await this.persistPinLockoutState(attempts, nowMs + lockSec * 1000);
      return {
        ok: false,
        lockoutRemainingSec: lockSec,
        error: tm('store.pinWrongWithDelay', { sec: lockSec }, locale),
      };
    }
    await this.persistPinLockoutState(attempts, 0);
    return {
      ok: false,
      lockoutRemainingSec: 0,
      error: tm('vault.pinWrong', undefined, locale),
    };
  }

  public async unlockVaultWithPin(
    pin: string,
    nowMs = Date.now()
  ): Promise<{ ok: boolean; lockoutRemainingSec: number; error?: string }> {
    const verified = await this.verifyMasterPinWithBackoff(pin, nowMs);
    if (!verified.ok) return verified;

    const requireOs = mobileBridge.isNativeAndroid();
    const wrapped = await this.getSecureValue('vault_vdk_pin_wrapped');
    if (wrapped) {
      const vdk = await this.localCrypto.unwrapVdkWithPin(wrapped, pin);
      if (!vdk) {
        return {
          ok: false,
          lockoutRemainingSec: 0,
          error: tm('vaultCrypto.decryptFailed', undefined, this.getLocale()),
        };
      }
      try {
        this.localCrypto.setPinProtectedMode(true);
        this.localCrypto.setUnlockedVdk(vdk);
        await this.migrateSecretsToCurrentVdk();
      } finally {
        vdk.fill(0);
      }
      return { ok: true, lockoutRemainingSec: 0 };
    }

    // Migrate legacy PIN vault without VDK wrapper yet
    const freshVdk = this.localCrypto.generateVdk();
    try {
      const newWrapped = await this.localCrypto.wrapVdkWithPin(freshVdk, pin);
      await this.setSecureValue('vault_vdk_pin_wrapped', newWrapped, {
        requireOsProtection: requireOs,
      });
      this.localCrypto.setPinProtectedMode(true);
      this.localCrypto.setUnlockedVdk(freshVdk);
      await this.migrateSecretsToCurrentVdk();
      if (this.getSyncState('pref_biometric_vault') !== '0') {
        await this.storeBiometricVdk(freshVdk);
      }
    } finally {
      freshVdk.fill(0);
    }
    return { ok: true, lockoutRemainingSec: 0 };
  }

  public async unlockVaultWithBiometric(): Promise<{ ok: boolean; needsPinFallback?: boolean }> {
    if (!this.hasMasterPin()) {
      this.localCrypto.setPinProtectedMode(false);
      return { ok: true };
    }
    const rawEntry = this.secureKvMap.get('vault_vdk_bio_wrapped');
    if (!rawEntry) {
      return { ok: false, needsPinFallback: true };
    }
    try {
      let b64: string | null = null;
      if (rawEntry.startsWith('aks_auth:')) {
        if (!mobileBridge.isNativeAndroid()) return { ok: false, needsPinFallback: true };
        b64 = await mobileBridge.keystoreAuthDecrypt(rawEntry.slice('aks_auth:'.length));
      } else {
        b64 = await this.getSecureValue('vault_vdk_bio_wrapped');
      }
      if (!b64) return { ok: false, needsPinFallback: true };
      const vdk = base64ToBytes(b64);
      if (vdk.length !== 32) return { ok: false, needsPinFallback: true };
      try {
        this.localCrypto.setPinProtectedMode(true);
        this.localCrypto.setUnlockedVdk(vdk);
      } finally {
        vdk.fill(0);
      }
      await this.persistPinLockoutState(0, 0);
      return { ok: true };
    } catch {
      return { ok: false, needsPinFallback: true };
    }
  }

  // ==================== Mobile AI Config (Encrypted in secure_kv) ====================

  public getMobileAiConfig(): MobileAiConfig {
    const raw = this.getSyncState('pref_ai_provider');
    const provider: AiProvider =
      raw === 'google_ai_studio' || raw === 'openrouter' ? raw : 'local';
    return {
      provider,
      hasGoogleKey: this.hasSecureKey('ai_key_google'),
      hasOpenRouterKey: this.hasSecureKey('ai_key_openrouter'),
    };
  }

  public async setMobileAiConfig(patch: {
    provider?: AiProvider;
    googleKey?: string | null;
    openrouterKey?: string | null;
  }): Promise<MobileAiConfig> {
    if (patch.provider !== undefined) {
      await this.setSyncState('pref_ai_provider', patch.provider);
    }
    const requireOs = mobileBridge.isNativeAndroid();
    if (patch.googleKey !== undefined) {
      const clean = (patch.googleKey ?? '').trim();
      if (clean) {
        await this.setSecureValue('ai_key_google', clean, { requireOsProtection: requireOs });
      } else {
        await this.removeSecureValue('ai_key_google');
      }
    }
    if (patch.openrouterKey !== undefined) {
      const clean = (patch.openrouterKey ?? '').trim();
      if (clean) {
        await this.setSecureValue('ai_key_openrouter', clean, { requireOsProtection: requireOs });
      } else {
        await this.removeSecureValue('ai_key_openrouter');
      }
    }
    this.emitChange();
    return this.getMobileAiConfig();
  }

  public async getMobileAiApiKey(provider?: AiProvider): Promise<{
    provider: AiProvider;
    apiKey: string | null;
  }> {
    const effProvider = provider ?? this.getMobileAiConfig().provider;
    if (effProvider === 'google_ai_studio') {
      return { provider: effProvider, apiKey: await this.getSecureValue('ai_key_google') };
    }
    if (effProvider === 'openrouter') {
      return { provider: effProvider, apiKey: await this.getSecureValue('ai_key_openrouter') };
    }
    return { provider: 'local', apiKey: null };
  }

  // ==================== Dirty Queue (with Dead-Letter Retry) ====================

  public async markDirty(
    entityType: SyncEntityType,
    entityId: string,
    silent = false
  ): Promise<void> {
    const key = `${entityType}:${entityId}`;
    const entry: DirtySyncEntry = {
      key,
      entityType,
      entityId,
      dirtyAt: Date.now(),
      dirtySeq: this.dirtySeqCounter++,
      failCount: 0,
      lastError: null,
      nextRetryAt: 0,
    };
    this.dirtyMap.set(key, entry);
    await this.backend.put('sync_dirty', key, entry);
    if (!silent) {
      this.mutationListener?.(entityType, entityId);
    }
  }

  public async recordDirtyFailure(
    entityType: SyncEntityType,
    entityId: string,
    errorMessage: string,
    nowMs = Date.now()
  ): Promise<void> {
    const key = `${entityType}:${entityId}`;
    const existing = this.dirtyMap.get(key);
    if (!existing) return;
    const failCount = (existing.failCount ?? 0) + 1;
    const backoffMs = Math.min(300_000, 5_000 * Math.pow(2, Math.min(failCount - 1, 6)));
    const updated: DirtySyncEntry = {
      ...existing,
      failCount,
      lastError: errorMessage.slice(0, 300),
      nextRetryAt: nowMs + backoffMs,
    };
    this.dirtyMap.set(key, updated);
    await this.backend.put('sync_dirty', key, updated);
  }

  private async clearDirtyKeyForce(entityType: SyncEntityType, entityId: string): Promise<void> {
    const key = `${entityType}:${entityId}`;
    if (!this.dirtyMap.has(key)) return;
    this.dirtyMap.delete(key);
    await this.backend.delete('sync_dirty', key);
  }

  public async clearDirtyByEntityType(entityType: SyncEntityType): Promise<void> {
    const keysToDelete: string[] = [];
    this.dirtyMap.forEach((d, k) => {
      if (d.entityType === entityType) keysToDelete.push(k);
    });
    for (const k of keysToDelete) {
      this.dirtyMap.delete(k);
      await this.backend.delete('sync_dirty', k);
    }
  }

  public async resetDirtyRetryBackoff(): Promise<void> {
    for (const [k, d] of this.dirtyMap.entries()) {
      if ((d.nextRetryAt ?? 0) > 0) {
        const updated: DirtySyncEntry = { ...d, nextRetryAt: 0 };
        this.dirtyMap.set(k, updated);
        await this.backend.put('sync_dirty', k, updated);
      }
    }
  }

  public listDirtyEntities(limit = 100, nowMs = Date.now()): DirtySyncEntry[] {
    return Array.from(this.dirtyMap.values())
      .filter((d) => (d.nextRetryAt ?? 0) <= nowMs)
      .sort((a, b) => {
        const orderDiff = entityTypeOrder(a.entityType) - entityTypeOrder(b.entityType);
        if (orderDiff !== 0) return orderDiff;
        if (a.dirtySeq !== b.dirtySeq) return a.dirtySeq - b.dirtySeq;
        return a.dirtyAt - b.dirtyAt;
      })
      .slice(0, limit);
  }

  public listAllDirtyEntities(): DirtySyncEntry[] {
    return Array.from(this.dirtyMap.values());
  }

  public countDirtyEntities(): number {
    return this.dirtyMap.size;
  }

  public countFailedDirtyEntities(): number {
    let count = 0;
    this.dirtyMap.forEach((d) => {
      if ((d.failCount ?? 0) > 0) count += 1;
    });
    return count;
  }

  public countSyncableRecords(): number {
    let count = 0;
    this.itemsMap.forEach((it) => {
      if (!it.isDemo && !it.deletedAt && !it.purgedAt) count++;
    });
    this.orbitsMap.forEach((o) => {
      if (!o.deletedAt) count++;
    });
    this.boardsMap.forEach((b) => {
      if (!b.deletedAt) count++;
    });
    this.calendarMap.forEach((e) => {
      if (!e.deletedAt) count++;
    });
    return count;
  }

  public async clearDirtyEntity(
    entityType: SyncEntityType,
    entityId: string,
    expectedDirtySeq: number
  ): Promise<void> {
    const key = `${entityType}:${entityId}`;
    const current = this.dirtyMap.get(key);
    if (!current || current.dirtySeq !== expectedDirtySeq) return;
    this.dirtyMap.delete(key);
    await this.backend.delete('sync_dirty', key);
  }

  public async clearAllDirtyEntities(): Promise<void> {
    this.dirtyMap.clear();
    await this.backend.clear('sync_dirty');
  }

  public async enqueueAllSyncableEntities(): Promise<void> {
    let lastType: SyncEntityType | null = null;
    let lastId = '';
    for (const o of this.orbitsMap.values()) {
      await this.markDirty('orbit', o.id, true);
      lastType = 'orbit';
      lastId = o.id;
    }
    for (const b of this.boardsMap.values()) {
      await this.markDirty('focus_board', b.id, true);
      lastType = 'focus_board';
      lastId = b.id;
    }
    for (const it of this.itemsMap.values()) {
      if (!it.isDemo) {
        await this.markDirty('item', it.id, true);
        lastType = 'item';
        lastId = it.id;
      }
    }
    for (const ev of this.calendarMap.values()) {
      await this.markDirty('calendar_event', ev.id, true);
      lastType = 'calendar_event';
      lastId = ev.id;
    }
    for (const rev of this.listSyncableRevisions()) {
      await this.markDirty('item_revision', rev.id, true);
      lastType = 'item_revision';
      lastId = rev.id;
    }
    if (
      this.getSyncState('task_board_columns_json') ||
      this.getSyncState('appearance_config_json') ||
      this.getSyncState('mobile_locale')
    ) {
      await this.markDirty('workspace_prefs', 'default', true);
      lastType = 'workspace_prefs';
      lastId = 'default';
    }
    if (lastType) {
      this.mutationListener?.(lastType, lastId);
    }
  }

  public async bumpEntityTimestampForRetry(
    entityType: SyncEntityType,
    entityId: string,
    minUpdatedAt: number,
    minSyncVersion: number
  ): Promise<void> {
    const targetTs = Math.max(minUpdatedAt, Date.now());
    const localDevice = this.getSyncState('device_id');

    if (entityType === 'item') {
      const existing = this.itemsMap.get(entityId);
      if (!existing) return;
      const updated: StoredMobileItem = {
        ...existing,
        updatedAt: targetTs,
        syncVersion: Math.max((existing.syncVersion ?? 1) + 1, minSyncVersion),
        lastDeviceId: localDevice,
      };
      this.itemsMap.set(entityId, updated);
      await this.backend.put('items', entityId, updated);
      return;
    }
    if (entityType === 'orbit') {
      const existing = this.orbitsMap.get(entityId);
      if (!existing) return;
      const updated: StoredMobileOrbit = {
        ...existing,
        updatedAt: targetTs,
        syncVersion: Math.max((existing.syncVersion ?? 1) + 1, minSyncVersion),
        lastDeviceId: localDevice,
      };
      this.orbitsMap.set(entityId, updated);
      await this.backend.put('orbits', entityId, updated);
      return;
    }
    if (entityType === 'focus_board') {
      const existing = this.boardsMap.get(entityId);
      if (!existing) return;
      const updated: StoredMobileBoard = {
        ...existing,
        updatedAt: targetTs,
        syncVersion: Math.max((existing.syncVersion ?? 1) + 1, minSyncVersion),
        lastDeviceId: localDevice,
      };
      this.boardsMap.set(entityId, updated);
      await this.backend.put('focus_boards', entityId, updated);
      return;
    }
    if (entityType === 'calendar_event') {
      const existing = this.calendarMap.get(entityId);
      if (!existing) return;
      const updated: StoredMobileCalendarEvent = {
        ...existing,
        updatedAt: targetTs,
        syncVersion: Math.max((existing.syncVersion ?? 1) + 1, minSyncVersion),
        lastDeviceId: localDevice,
      };
      this.calendarMap.set(entityId, updated);
      await this.backend.put('calendar_events', entityId, updated);
    }
  }

  public listLocalTombstoneIds(): Array<{
    entityType: SyncEntityType;
    entityId: string;
    syncVersion: number;
    deletedAt: number;
    purgedAt: number | null;
    dna?: ContentDna;
  }> {
    const out: Array<{
      entityType: SyncEntityType;
      entityId: string;
      syncVersion: number;
      deletedAt: number;
      purgedAt: number | null;
      dna?: ContentDna;
    }> = [];
    this.itemsMap.forEach((it) => {
      if (!it.isDemo && (it.deletedAt != null || it.purgedAt != null)) {
        out.push({
          entityType: 'item',
          entityId: it.id,
          syncVersion: it.syncVersion ?? 1,
          deletedAt: it.deletedAt ?? it.purgedAt!,
          purgedAt: it.purgedAt ?? null,
          dna: it.dna,
        });
      }
    });
    this.orbitsMap.forEach((o) => {
      if (o.deletedAt != null) {
        out.push({
          entityType: 'orbit',
          entityId: o.id,
          syncVersion: o.syncVersion ?? 1,
          deletedAt: o.deletedAt,
          purgedAt: null,
        });
      }
    });
    this.boardsMap.forEach((b) => {
      if (b.deletedAt != null) {
        out.push({
          entityType: 'focus_board',
          entityId: b.id,
          syncVersion: b.syncVersion ?? 1,
          deletedAt: b.deletedAt,
          purgedAt: null,
        });
      }
    });
    this.calendarMap.forEach((e) => {
      if (e.deletedAt != null) {
        out.push({
          entityType: 'calendar_event',
          entityId: e.id,
          syncVersion: e.syncVersion ?? 1,
          deletedAt: e.deletedAt,
          purgedAt: null,
        });
      }
    });
    return out;
  }

  // ==================== Blob Cache & Lazy LRU Local Media ====================

  public getBlobCache(localName: string): BlobCacheEntry | null {
    return this.blobCacheMap.get(localName) ?? null;
  }

  public async upsertBlobCache(entry: BlobCacheEntry): Promise<void> {
    this.blobCacheMap.set(entry.localName, entry);
    await this.backend.put('sync_blob_cache', entry.localName, entry);
  }

  public async clearSyncBlobCache(): Promise<void> {
    this.blobCacheMap.clear();
    await this.backend.clear('sync_blob_cache');
  }

  public getPendingBlobDeletes(): string[] {
    const raw = this.getSyncState('pending_blob_deletes');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v)
      );
    } catch {
      return [];
    }
  }

  public async removePendingBlobDeletes(blobIds: string[]): Promise<void> {
    if (blobIds.length === 0) return;
    const drop = new Set(blobIds);
    const remaining = this.getPendingBlobDeletes().filter((id) => !drop.has(id));
    if (remaining.length === 0) {
      await this.deleteSyncState('pending_blob_deletes');
    } else {
      await this.setSyncState('pending_blob_deletes', JSON.stringify(remaining));
    }
  }

  public async enqueuePendingBlobDeletes(
    localNames: string[],
    excludeItemId?: string
  ): Promise<void> {
    if (!localNames || localNames.length === 0) return;
    const queue = new Set(this.getPendingBlobDeletes());
    let changed = false;

    for (const rawName of localNames) {
      const safe = sanitizeMobileMediaFilename(rawName);
      if (!safe) continue;
      if (this.isMediaReferencedByAnyItem(safe, excludeItemId)) continue;

      const cached = this.getBlobCache(safe);
      if (!cached) continue;
      this.blobCacheMap.delete(safe);
      await this.backend.delete('sync_blob_cache', safe);

      if (!/^[a-f0-9]{64}$/i.test(cached.blobId)) continue;
      let sharedStillUsed = false;
      for (const sibling of this.blobCacheMap.values()) {
        if (
          sibling.blobId === cached.blobId &&
          sibling.localName !== safe &&
          this.isMediaReferencedByAnyItem(sibling.localName, excludeItemId)
        ) {
          sharedStillUsed = true;
          break;
        }
      }
      if (sharedStillUsed) continue;

      if (!queue.has(cached.blobId)) {
        queue.add(cached.blobId);
        changed = true;
      }
    }

    if (changed) {
      await this.setSyncState('pending_blob_deletes', JSON.stringify(Array.from(queue)));
    }
  }

  public async wipeAllUserData(): Promise<void> {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      for (const url of this.mediaObjectUrlCache.values()) {
        URL.revokeObjectURL(url);
      }
    }
    this.mediaObjectUrlCache.clear();
    this.mediaRefCounts.clear();
    this.bumpDataVersion();
    this.itemsMap.clear();
    this.orbitsMap.clear();
    this.boardsMap.clear();
    this.calendarMap.clear();
    this.revisionsMap.clear();
    this.dirtyMap.clear();
    this.blobCacheMap.clear();
    this.mediaFilesMap.clear();

    const clearedStores: StoreName[] = [
      'items',
      'orbits',
      'focus_boards',
      'calendar_events',
      'item_revisions',
      'sync_dirty',
      'sync_blob_cache',
      'media_files',
    ];
    for (const storeName of clearedStores) {
      await this.backend.clear(storeName);
    }

    const preservedSyncKeys = new Set([
      'device_id',
      'custom_supabase_url',
      'mobile_locale',
      'appearance_config_json',
      'pref_biometric_vault',
    ]);
    for (const key of Array.from(this.syncStateMap.keys())) {
      if (!preservedSyncKeys.has(key)) {
        await this.deleteSyncState(key);
      }
    }

    const preservedSecureKeys = new Set(['custom_supabase_key']);
    for (const key of Array.from(this.secureKvMap.keys())) {
      if (!preservedSecureKeys.has(key)) {
        await this.removeSecureValue(key);
      }
    }

    this.localCrypto.resetForAccountWipe();
    this.emitChange();
  }

  public retainMediaUrl(localName: string | null | undefined): void {
    if (!localName || /^(?:https?:|data:|blob:)/i.test(localName)) return;
    const safe = sanitizeMobileMediaFilename(localName);
    if (!safe) return;
    this.mediaRefCounts.set(safe, (this.mediaRefCounts.get(safe) ?? 0) + 1);
  }

  public releaseMediaUrl(localName: string | null | undefined): void {
    if (!localName || /^(?:https?:|data:|blob:)/i.test(localName)) return;
    const safe = sanitizeMobileMediaFilename(localName);
    if (!safe) return;
    const prev = this.mediaRefCounts.get(safe) ?? 0;
    if (prev <= 1) {
      this.mediaRefCounts.delete(safe);
      if (this.mediaObjectUrlCache.size > 40) {
        this.evictMediaLru();
      }
    } else {
      this.mediaRefCounts.set(safe, prev - 1);
    }
  }

  public getActiveMediaUrlRefCount(localName: string): number {
    const safe = sanitizeMobileMediaFilename(localName);
    return safe ? (this.mediaRefCounts.get(safe) ?? 0) : 0;
  }

  public getMediaObjectUrlCacheSize(): number {
    return this.mediaObjectUrlCache.size;
  }

  private evictMediaLru(): void {
    const MAX_CACHED_FILES = 24;
    while (this.mediaFilesMap.size > MAX_CACHED_FILES) {
      const oldestKey = this.mediaFilesMap.keys().next().value;
      if (!oldestKey) break;
      this.mediaFilesMap.delete(oldestKey);
    }
    const MAX_CACHED_URLS = 40;
    if (this.mediaObjectUrlCache.size <= MAX_CACHED_URLS) return;
    for (const [key, url] of Array.from(this.mediaObjectUrlCache.entries())) {
      if (this.mediaObjectUrlCache.size <= MAX_CACHED_URLS) break;
      if ((this.mediaRefCounts.get(key) ?? 0) > 0) continue;
      if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
      this.mediaObjectUrlCache.delete(key);
    }
  }

  public getMediaFile(localName: string): StoredMediaFile | null {
    const safe = sanitizeMobileMediaFilename(localName) ?? localName;
    const hit = this.mediaFilesMap.get(safe);
    if (!hit) return null;
    this.mediaFilesMap.delete(safe);
    this.mediaFilesMap.set(safe, hit);
    return hit;
  }

  public async loadMediaFile(localName: string): Promise<StoredMediaFile | null> {
    const safe = sanitizeMobileMediaFilename(localName);
    if (!safe) return null;
    const cached = this.getMediaFile(safe);
    if (cached) return cached;
    const fromDb = await this.backend.get<StoredMediaFile>('media_files', safe);
    if (!fromDb) return null;
    this.mediaFilesMap.set(safe, fromDb);
    this.evictMediaLru();
    return fromDb;
  }

  public async saveMediaFile(localName: string, mime: string, bytes: Uint8Array): Promise<void> {
    const safe = sanitizeMobileMediaFilename(localName) ?? localName;
    const prevUrl = this.mediaObjectUrlCache.get(safe);
    if (prevUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(prevUrl);
      this.mediaObjectUrlCache.delete(safe);
    }
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    copy.set(bytes);
    const record: StoredMediaFile = {
      localName: safe,
      mime: mime || 'application/octet-stream',
      bytes: copy,
      updatedAt: Date.now(),
    };
    await this.backend.put('media_files', safe, record);
    this.mediaFilesMap.delete(safe);
    this.mediaFilesMap.set(safe, record);
    this.evictMediaLru();
  }

  public async putMedia(localName: string, mime: string, bytes: Uint8Array): Promise<string> {
    const safe = sanitizeMobileMediaFilename(localName) ?? localName;
    await this.saveMediaFile(safe, mime, bytes);
    return safe;
  }

  private collectItemMediaNames(item: StoredMobileItem): string[] {
    const names = new Set<string>();
    const add = (val: string | null | undefined) => {
      const safe = sanitizeMobileMediaFilename(val);
      if (safe) names.add(safe);
    };
    add(item.imagePath);
    add(item.thumbPath);
    add(item.mediaPath);
    for (const g of item.mediaMeta?.galleryPaths ?? []) add(g);
    for (const inlineName of extractInlineMediaFilenames(item.body)) add(inlineName);
    return Array.from(names);
  }

  private isMediaReferencedByAnyItem(filename: string, excludeItemId?: string): boolean {
    for (const it of this.itemsMap.values()) {
      if (it.id === excludeItemId || it.purgedAt != null) continue;
      if (it.imagePath === filename || it.thumbPath === filename || it.mediaPath === filename) {
        return true;
      }
      if (it.mediaMeta?.galleryPaths?.includes(filename)) return true;
      if (it.body && it.body.includes(filename)) {
        if (extractInlineMediaFilenames(it.body).includes(filename)) return true;
      }
    }
    for (const ev of this.calendarMap.values()) {
      if (ev.deletedAt) continue;
      if (ev.attachments?.includes(filename)) return true;
    }
    return false;
  }

  public async deleteMediaFilesIfUnreferenced(
    filenames: string[],
    excludeItemId?: string
  ): Promise<void> {
    for (const raw of filenames) {
      const safe = sanitizeMobileMediaFilename(raw);
      if (!safe) continue;
      if (this.isMediaReferencedByAnyItem(safe, excludeItemId)) continue;
      const prevUrl = this.mediaObjectUrlCache.get(safe);
      if (prevUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(prevUrl);
      }
      this.mediaObjectUrlCache.delete(safe);
      this.mediaFilesMap.delete(safe);
      await this.backend.delete('media_files', safe);
    }
  }

  private createOrGetObjectUrlForFile(file: StoredMediaFile): string | null {
    const safe = sanitizeMobileMediaFilename(file.localName) ?? file.localName;
    const cached = this.mediaObjectUrlCache.get(safe);
    if (cached) {
      this.mediaObjectUrlCache.delete(safe);
      this.mediaObjectUrlCache.set(safe, cached);
      return cached;
    }
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return null;
    }
    const blobPart: BlobPart =
      file.bytes.byteOffset === 0 &&
      file.bytes.byteLength === file.bytes.buffer.byteLength &&
      file.bytes.buffer instanceof ArrayBuffer
        ? file.bytes.buffer
        : file.bytes.slice().buffer;
    const url = URL.createObjectURL(new Blob([blobPart], { type: file.mime }));
    this.mediaObjectUrlCache.set(safe, url);
    this.evictMediaLru();
    return url;
  }

  public getMediaObjectUrl(localName: string | null | undefined): string | null {
    if (!localName) return null;
    if (/^(?:https?:|data:|blob:)/i.test(localName)) return localName;
    const safe = sanitizeMobileMediaFilename(localName);
    if (!safe) return null;
    const cached = this.mediaObjectUrlCache.get(safe);
    if (cached) {
      this.mediaObjectUrlCache.delete(safe);
      this.mediaObjectUrlCache.set(safe, cached);
      return cached;
    }
    const file = this.getMediaFile(safe);
    if (!file) return null;
    return this.createOrGetObjectUrlForFile(file);
  }

  public async ensureMediaObjectUrl(localName: string | null | undefined): Promise<string | null> {
    if (!localName) return null;
    if (/^(?:https?:|data:|blob:)/i.test(localName)) return localName;
    const syncHit = this.getMediaObjectUrl(localName);
    if (syncHit) return syncHit;
    const loaded = await this.loadMediaFile(localName);
    if (!loaded) return null;
    return this.createOrGetObjectUrlForFile(loaded);
  }

  public ensureMediaUrl(localName: string | null | undefined): Promise<string | null> {
    return this.ensureMediaObjectUrl(localName);
  }

  // ==================== Read Queries ====================

  private toPublicItem(raw: StoredMobileItem): VaultItem {
    const { encryptedSecretPayload: _enc, lastDeviceId: _dev, ...publicItem } = raw;
    return publicItem;
  }

  public listItems(opts?: {
    includeDeleted?: boolean;
    onlyDeleted?: boolean;
    includePurged?: boolean;
    includeArchived?: boolean;
    includeSecrets?: boolean;
  }): VaultItem[] {
    const cacheKey = `listItems:${this.dataVersion}:${Boolean(opts?.includeDeleted)}:${Boolean(
      opts?.onlyDeleted
    )}:${Boolean(opts?.includePurged)}:${Boolean(opts?.includeArchived)}:${
      opts?.includeSecrets !== false
    }`;
    const cached = this.snapshotCache.get(cacheKey);
    if (cached) return cached as VaultItem[];

    const out: VaultItem[] = [];
    this.itemsMap.forEach((raw) => {
      if (!opts?.includePurged && raw.purgedAt != null) return;
      if (opts?.onlyDeleted) {
        if (raw.deletedAt == null) return;
      } else {
        if (!opts?.includeDeleted && raw.deletedAt != null) return;
        if (!opts?.includeArchived && raw.isArchived) return;
      }
      if (opts?.includeSecrets === false && raw.dna === 'secret') return;
      out.push(this.toPublicItem(raw));
    });
    const sorted = opts?.onlyDeleted
      ? out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      : out.sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return b.createdAt - a.createdAt;
        });
    this.snapshotCache.set(cacheKey, sorted);
    return sorted;
  }

  public listTrashedItems(): VaultItem[] {
    return this.listItems({ onlyDeleted: true, includePurged: false, includeSecrets: true });
  }

  public listArchivedItems(): VaultItem[] {
    const cacheKey = `listArchivedItems:${this.dataVersion}`;
    const cached = this.snapshotCache.get(cacheKey);
    if (cached) return cached as VaultItem[];

    const out: VaultItem[] = [];
    this.itemsMap.forEach((raw) => {
      if (raw.purgedAt != null || raw.deletedAt != null) return;
      if (!raw.isArchived) return;
      out.push(this.toPublicItem(raw));
    });
    const sorted = out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.snapshotCache.set(cacheKey, sorted);
    return sorted;
  }

  public getRawItem(id: string): StoredMobileItem | null {
    return this.itemsMap.get(id) ?? null;
  }

  public getItemById(id: string, includeDeleted = false, includePurged = false): VaultItem | null {
    const raw = this.itemsMap.get(id);
    if (!raw) return null;
    if (!includePurged && raw.purgedAt != null) return null;
    if (!includeDeleted && raw.deletedAt != null) return null;
    return this.toPublicItem(raw);
  }

  public listOrbits(includeDeleted = false): OrbitDef[] {
    const locale = this.getLocale();
    const cacheKey = `listOrbits:${this.dataVersion}:${locale}:${includeDeleted}`;
    const cached = this.snapshotCache.get(cacheKey);
    if (cached) return cached as OrbitDef[];

    const counts = new Map<string, number>();
    this.itemsMap.forEach((it) => {
      if (it.deletedAt || it.purgedAt || it.isArchived) return;
      if (it.orbit) counts.set(it.orbit, (counts.get(it.orbit) ?? 0) + 1);
    });

    const out: OrbitDef[] = [];
    this.orbitsMap.forEach((o) => {
      if (!includeDeleted && o.deletedAt) return;
      const { syncVersion: _sv, lastDeviceId: _ld, ...pub } = o;
      out.push({ ...pub, itemCount: counts.get(o.id) ?? 0 });
    });
    const intl = getMobileIntlLocale(locale);
    const sorted = out.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, intl)
    );
    this.snapshotCache.set(cacheKey, sorted);
    return sorted;
  }

  public getRawOrbit(id: string): StoredMobileOrbit | null {
    return this.orbitsMap.get(id) ?? null;
  }

  public listBoards(includeDeleted = false): FocusBoard[] {
    const counts = new Map<string, number>();
    this.itemsMap.forEach((it) => {
      if (it.deletedAt || it.purgedAt || it.isArchived) return;
      if (it.focusBoardId) counts.set(it.focusBoardId, (counts.get(it.focusBoardId) ?? 0) + 1);
    });

    const out: FocusBoard[] = [];
    this.boardsMap.forEach((b) => {
      if (!includeDeleted && b.deletedAt) return;
      const { syncVersion: _sv, lastDeviceId: _ld, ...pub } = b;
      out.push({ ...pub, itemCount: counts.get(b.id) ?? 0 });
    });
    const intl = getMobileIntlLocale(this.getLocale());
    return out.sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, intl)
    );
  }

  public getRawBoard(id: string): StoredMobileBoard | null {
    return this.boardsMap.get(id) ?? null;
  }

  public listCalendarEvents(includeDeleted = false): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    this.calendarMap.forEach((e) => {
      if (!includeDeleted && e.deletedAt) return;
      const { lastDeviceId: _ld, ...pub } = e;
      out.push(pub);
    });
    return out.sort((a, b) => a.startAt - b.startAt);
  }

  public getRawCalendarEvent(id: string): StoredMobileCalendarEvent | null {
    return this.calendarMap.get(id) ?? null;
  }

  // ==================== Wiki-Links Resolution ====================

  private reconcileLinksOutFromBody(
    body: string | null | undefined,
    selfId: string,
    explicitLinksOut?: string[]
  ): string[] {
    const titles = extractWikiLinkTitles(body);
    const out = new Set<string>(explicitLinksOut ?? []);
    if (titles.length > 0) {
      const titleLookup = new Map<string, string>();
      this.itemsMap.forEach((it) => {
        if (it.id === selfId || it.deletedAt || it.purgedAt || it.dna === 'secret') return;
        const norm = (it.title || '').trim().toLowerCase();
        if (norm && !titleLookup.has(norm)) {
          titleLookup.set(norm, it.id);
        }
      });
      for (const title of titles) {
        const hit = titleLookup.get(title.toLowerCase());
        if (hit) out.add(hit);
      }
    }
    return Array.from(out);
  }

  // ==================== Item Revisions (DB v3) ====================

  public getRawRevision(id: string): StoredMobileRevision | null {
    return this.revisionsMap.get(id) ?? null;
  }

  public listItemRevisions(itemId: string): ItemRevision[] {
    const out: ItemRevision[] = [];
    this.revisionsMap.forEach((rev) => {
      if (rev.itemId === itemId && !rev.deletedAt) {
        const { lastDeviceId: _ld, ...pub } = rev;
        out.push(pub);
      }
    });
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  public listSyncableRevisions(limitPerItem = 15): StoredMobileRevision[] {
    const byItem = new Map<string, StoredMobileRevision[]>();
    this.revisionsMap.forEach((rev) => {
      if (rev.deletedAt) return;
      const list = byItem.get(rev.itemId) ?? [];
      list.push(rev);
      byItem.set(rev.itemId, list);
    });
    const out: StoredMobileRevision[] = [];
    byItem.forEach((list) => {
      list.sort((a, b) => b.createdAt - a.createdAt);
      out.push(...list.slice(0, limitPerItem));
    });
    return out;
  }

  private async pruneRevisionsForItem(itemId: string): Promise<void> {
    const all = Array.from(this.revisionsMap.values())
      .filter((r) => r.itemId === itemId && !r.deletedAt)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (all.length <= MAX_REVISIONS_PER_ITEM) return;

    const toEvictCount = all.length - MAX_REVISIONS_PER_ITEM;
    const regularOldestFirst = all
      .filter((r) => r.source !== 'sync_conflict')
      .reverse();
    const conflictOldestFirst = all
      .filter((r) => r.source === 'sync_conflict')
      .reverse();
    const candidates = [...regularOldestFirst, ...conflictOldestFirst].slice(0, toEvictCount);

    for (const victim of candidates) {
      this.revisionsMap.delete(victim.id);
      await this.backend.delete('item_revisions', victim.id);
      await this.clearDirtyKeyForce('item_revision', victim.id);
    }
  }

  public async saveItemRevision(
    itemId: string,
    source: ItemRevisionSource = 'manual',
    opts?: {
      title?: string | null;
      content?: string;
      deviceName?: string | null;
      skipSyncDirty?: boolean;
    }
  ): Promise<ItemRevision | null> {
    const item = this.itemsMap.get(itemId);
    if (!item || item.dna === 'secret' || item.purgedAt != null) return null;

    const revTitle = opts?.title !== undefined ? opts.title : item.title;
    const revContent = opts?.content !== undefined ? opts.content : item.body;
    const contentHash = computeLightContentHash([revTitle ?? '', revContent]);

    // Deduplicate against latest revision of same item (except explicit sync_conflict)
    const existingList = this.listItemRevisions(itemId);
    const latest = existingList[0];
    if (source !== 'sync_conflict' && latest && latest.contentHash === contentHash) {
      return latest;
    }

    const now = this.nextMonotonicTs(latest?.createdAt);
    const id = generateUuid();
    const stored: StoredMobileRevision = {
      id,
      itemId,
      title: revTitle ?? null,
      content: revContent,
      source,
      contentHash,
      deviceName: opts?.deviceName ?? this.deviceNameLabel,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.revisionsMap.set(id, stored);
    await this.backend.put('item_revisions', id, stored);
    await this.pruneRevisionsForItem(itemId);
    if (!opts?.skipSyncDirty) {
      await this.markDirty('item_revision', id, true);
    }
    this.emitChange();
    const { lastDeviceId: _ld, ...pub } = stored;
    return pub;
  }

  public async revertItemToRevision(itemId: string, revisionId: string): Promise<VaultItem | null> {
    const item = this.itemsMap.get(itemId);
    const rev = this.revisionsMap.get(revisionId);
    if (!item || item.deletedAt || item.purgedAt || !rev || rev.itemId !== itemId) {
      return null;
    }
    // Snapshot current state before restoring
    await this.saveItemRevision(itemId, 'restore', {
      title: item.title,
      content: item.body,
    });
    return this.updateItem(itemId, {
      title: rev.title ?? item.title,
      body: rev.content,
    });
  }

  public async applySyncedRevision(
    payload: SyncedItemRevisionPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    const parent = this.itemsMap.get(payload.itemId);
    if (parent?.purgedAt != null && !payload.deletedAt) {
      // Never resurrect revisions belonging to a permanently purged item
      return { applied: false, localStrictlyNewer: false };
    }

    const existing = this.revisionsMap.get(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt ?? existing.createdAt,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt ?? null,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;
    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }
    const stored: StoredMobileRevision = {
      id: payload.id,
      itemId: payload.itemId,
      title: payload.title,
      content: payload.content,
      source: payload.source,
      contentHash: payload.contentHash,
      deviceName: payload.deviceName,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      deletedAt: payload.deletedAt,
      syncVersion: payload.syncVersion,
      lastDeviceId: remoteDeviceId,
    };
    this.revisionsMap.set(stored.id, stored);
    await this.backend.put('item_revisions', stored.id, stored);
    await this.clearDirtyKeyForce('item_revision', stored.id);
    await this.pruneRevisionsForItem(stored.itemId);
    return { applied: true, localStrictlyNewer: false };
  }

  // ==================== Workspace Prefs (Kanban Columns + Appearance) ====================

  public listTaskBoardColumns(): TaskBoardColumn[] {
    const raw = this.getSyncState('task_board_columns_json');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as TaskBoardColumn[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return [...parsed].sort((a, b) => a.order - b.order);
        }
      } catch {
        // fallback to default
      }
    }
    return DEFAULT_TASK_BOARD_COLUMNS.map((c) => ({ ...c }));
  }

  public async saveTaskBoardColumns(columns: TaskBoardColumn[]): Promise<TaskBoardColumn[]> {
    const locale = this.getLocale();
    const normalized: TaskBoardColumn[] = (columns.length > 0 ? columns : DEFAULT_TASK_BOARD_COLUMNS).map(
      (col, idx) => {
        const rawIcon = typeof col.icon === 'string' ? col.icon.trim().slice(0, 32) : '';
        const icon = rawIcon && /^[a-z0-9_-]+$/i.test(rawIcon) ? rawIcon : undefined;
        return {
          id: col.id.trim() || `col_${idx}`,
          title: col.title.trim() || tm('store.defaultColumn', undefined, locale),
          color: col.color || '#94A3B8',
          order: idx,
          ...(col.isDone ? { isDone: true } : {}),
          ...(icon ? { icon } : {}),
        };
      }
    );
    // Ensure at least one done column exists
    if (!normalized.some((c) => c.isDone || c.id === 'done')) {
      normalized.push({
        id: 'done',
        title: tm('store.defaultDoneColumn', undefined, locale),
        color: '#2EA06B',
        order: normalized.length,
        isDone: true,
        icon: 'check',
      });
    }

    const validColIds = new Set(normalized.map((c) => c.id));
    const fallbackColId =
      normalized.find((c) => !c.isDone && c.id !== 'done')?.id ?? normalized[0]!.id;

    // Reassign any task cards pointing to deleted columns back to inbox/first column
    for (const item of this.itemsMap.values()) {
      if (item.deletedAt || item.purgedAt || !item.mediaMeta?.taskMeta) continue;
      let changed = false;
      const nextTaskMeta: Record<string, TaskBoardItemMeta> = { ...item.mediaMeta.taskMeta };
      for (const [k, meta] of Object.entries(nextTaskMeta)) {
        if (!validColIds.has(meta.columnId)) {
          nextTaskMeta[k] = { ...meta, columnId: fallbackColId };
          changed = true;
        }
      }
      if (changed) {
        const ts = this.nextMonotonicTs(item.updatedAt);
        const updated: StoredMobileItem = {
          ...item,
          mediaMeta: { ...item.mediaMeta, taskMeta: nextTaskMeta },
          updatedAt: ts,
          syncVersion: (item.syncVersion ?? 1) + 1,
          lastDeviceId: this.getSyncState('device_id'),
        };
        this.itemsMap.set(item.id, updated);
        await this.backend.put('items', item.id, updated);
        await this.markDirty('item', item.id, true);
      }
    }

    await this.setSyncState('task_board_columns_json', JSON.stringify(normalized));
    await this.bumpWorkspacePrefsVersion();
    this.emitChange();
    return normalized;
  }

  public getAppearanceConfig(): AppearanceConfig {
    const raw = this.getSyncState('appearance_config_json');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<AppearanceConfig>;
        return { ...DEFAULT_APPEARANCE_CONFIG, ...parsed };
      } catch {
        // fallback
      }
    }
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }

  public async saveAppearanceConfig(config: AppearanceConfig): Promise<AppearanceConfig> {
    const merged: AppearanceConfig = { ...DEFAULT_APPEARANCE_CONFIG, ...config };
    await this.setSyncState('appearance_config_json', JSON.stringify(merged));
    await this.bumpWorkspacePrefsVersion();
    this.emitChange();
    return merged;
  }

  public getPersistedLocale(): AppLocale | null {
    const raw = this.getSyncState('mobile_locale');
    if (raw === 'ru' || raw === 'en') return raw;
    return null;
  }

  public getLocale(): AppLocale {
    return resolveMobileLocale({
      persistedLocale: this.getPersistedLocale(),
    });
  }

  public async setLocale(locale: AppLocale): Promise<AppLocale> {
    const normalized = normalizeLocale(locale);
    await this.setSyncState('mobile_locale', normalized);
    if (!this.isMemoryOnly) {
      writeStoredMobileLocale(normalized);
      setRuntimeMobileLocale(normalized);
    }
    await this.bumpWorkspacePrefsVersion();
    this.emitChange();
    return normalized;
  }

  private async bumpWorkspacePrefsVersion(): Promise<void> {
    const prevUpdated = Number(this.getSyncState('workspace_prefs_updated_at') || '0') || 0;
    const prevVer = Number(this.getSyncState('workspace_prefs_sync_version') || '0') || 0;
    const now = this.nextMonotonicTs(prevUpdated);
    await this.setSyncState('workspace_prefs_updated_at', String(now));
    await this.setSyncState('workspace_prefs_sync_version', String(prevVer + 1));
    const devId = this.getSyncState('device_id');
    if (devId) await this.setSyncState('workspace_prefs_device_id', devId);
    await this.markDirty('workspace_prefs', 'default');
  }

  public getWorkspacePrefsPayload(): SyncedWorkspacePrefsPayload {
    const updatedAt = Number(this.getSyncState('workspace_prefs_updated_at') || '0') || Date.now();
    const syncVersion = Number(this.getSyncState('workspace_prefs_sync_version') || '1') || 1;
    return {
      v: 1,
      id: 'default',
      locale: this.getPersistedLocale() ?? this.getLocale(),
      taskBoardColumns: this.listTaskBoardColumns(),
      appearance: this.getAppearanceConfig(),
      updatedAt,
      deletedAt: null,
      syncVersion,
    };
  }

  public getWorkspacePrefsForSync(): SyncedWorkspacePrefsPayload {
    return this.getWorkspacePrefsPayload();
  }

  public async applySyncedWorkspacePrefs(
    payload: SyncedWorkspacePrefsPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    const localUpdated = Number(this.getSyncState('workspace_prefs_updated_at') || '0') || 0;
    const localMeta =
      localUpdated > 0
        ? {
            updatedAt: localUpdated,
            syncVersion: Number(this.getSyncState('workspace_prefs_sync_version') || '1') || 1,
            deletedAt: null,
            deviceId: this.getSyncState('workspace_prefs_device_id') || localDeviceId,
          }
        : null;
    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }
    if (Array.isArray(payload.taskBoardColumns) && payload.taskBoardColumns.length > 0) {
      await this.setSyncState('task_board_columns_json', JSON.stringify(payload.taskBoardColumns));
    }
    if (payload.appearance) {
      await this.setSyncState(
        'appearance_config_json',
        JSON.stringify({ ...DEFAULT_APPEARANCE_CONFIG, ...payload.appearance })
      );
    }
    if (payload.locale === 'ru' || payload.locale === 'en') {
      await this.setSyncState('mobile_locale', payload.locale);
      if (!this.isMemoryOnly) {
        writeStoredMobileLocale(payload.locale);
        setRuntimeMobileLocale(payload.locale);
      }
    }
    await this.setSyncState('workspace_prefs_updated_at', String(payload.updatedAt));
    await this.setSyncState('workspace_prefs_sync_version', String(payload.syncVersion));
    await this.setSyncState('workspace_prefs_device_id', remoteDeviceId);
    await this.clearDirtyKeyForce('workspace_prefs', 'default');
    this.emitChange();
    return { applied: true, localStrictlyNewer: false };
  }

  public async applyRemoteWorkspacePrefs(
    payload: SyncedWorkspacePrefsPayload,
    remoteDeviceId = 'remote',
    localDeviceId = this.getSyncState('device_id') || 'local'
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    return this.applySyncedWorkspacePrefs(payload, remoteDeviceId, localDeviceId);
  }

  // ==================== Local Mutations ====================

  public async createItem(input: {
    dna?: ContentDna;
    title?: string;
    body?: string;
    summary?: string;
    url?: string | null;
    orbit?: string;
    focusBoardId?: string | null;
    tags?: string[];
    source?: ItemSource;
    remindAt?: number | null;
    imagePath?: string | null;
    thumbPath?: string | null;
    mediaPath?: string | null;
    mediaType?: string | null;
    mediaDurationSec?: number | null;
    mediaMeta?: MediaMeta | null;
    ogImageUrl?: string | null;
    extractedActions?: VaultItem['extractedActions'];
    isPinned?: boolean;
    isMuted?: boolean;
    preserveEmptyTitle?: boolean;
    linksOut?: string[];
  }): Promise<VaultItem> {
    const now = Date.now();
    const id = generateUuid();
    const url = input.url?.trim() || null;
    const domain = extractUrlDomain(url);
    const platform = detectLinkPlatform(url);
    const dna: ContentDna = input.dna ?? (url ? 'link' : 'note');
    const body = input.body ?? '';
    const locale = this.getLocale();
    const cleanTitle = input.preserveEmptyTitle
      ? (input.title?.trim() ?? '')
      : input.title?.trim() ||
        (url
          ? domain || tm('store.linkTitle', undefined, locale)
          : body.trim().split('\n')[0]?.slice(0, 80) || tm('store.newItemTitle', undefined, locale));

    const linksOut = this.reconcileLinksOutFromBody(body, id, input.linksOut);

    const stored: StoredMobileItem = {
      id,
      dna,
      subKind: null,
      orbit: input.orbit ?? '',
      modeCaptured: 'autopilot',
      focusBoardId: input.focusBoardId ?? null,
      title: cleanTitle,
      body,
      summary: input.summary ?? '',
      url,
      domain,
      platform,
      imagePath: input.imagePath ?? null,
      thumbPath: input.thumbPath ?? null,
      mediaPath: input.mediaPath ?? null,
      mediaType: input.mediaType ?? null,
      mediaDurationSec: input.mediaDurationSec ?? null,
      mediaMeta: input.mediaMeta ?? null,
      ogImageUrl: input.ogImageUrl ?? null,
      ocrText: '',
      extractedActions: input.extractedActions ?? [],
      colorPalette: [],
      hasEncryptedPayload: false,
      encryptedSecretPayload: null,
      secretMeta: null,
      tags: input.tags ?? [],
      source: input.source ?? 'vault_ui',
      externalId: null,
      contentHash: computeLightContentHash([dna, cleanTitle, body, url]),
      aiStatus: 'local',
      aiConfidence: null,
      isPinned: Boolean(input.isPinned),
      isMuted: Boolean(input.isMuted),
      isArchived: false,
      isDemo: false,
      remindAt: input.remindAt ?? null,
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
      linksOut,
      syncVersion: 1,
      lastDeviceId: this.getSyncState('device_id'),
    };

    this.itemsMap.set(id, stored);
    await this.backend.put('items', id, stored);
    await this.markDirty('item', id);
    this.emitChange();
    return this.getItemById(id)!;
  }

  public async updateItem(
    id: string,
    patch: Partial<
      Pick<
        VaultItem,
        | 'title'
        | 'body'
        | 'summary'
        | 'url'
        | 'domain'
        | 'platform'
        | 'ogImageUrl'
        | 'extractedActions'
        | 'orbit'
        | 'focusBoardId'
        | 'tags'
        | 'isPinned'
        | 'isMuted'
        | 'isArchived'
        | 'remindAt'
        | 'mediaMeta'
        | 'imagePath'
        | 'thumbPath'
        | 'mediaPath'
        | 'mediaType'
        | 'mediaDurationSec'
        | 'aiStatus'
        | 'linksOut'
      >
    >,
    opts?: { preserveContentUpdatedAt?: boolean }
  ): Promise<VaultItem | null> {
    const existing = this.itemsMap.get(id);
    if (!existing || existing.deletedAt || existing.purgedAt) return null;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const titleChanged = patch.title !== undefined && patch.title !== existing.title;
    const bodyChanged = patch.body !== undefined && patch.body !== existing.body;
    const contentChanged =
      titleChanged ||
      bodyChanged ||
      patch.summary !== undefined ||
      patch.url !== undefined ||
      patch.ogImageUrl !== undefined ||
      patch.mediaMeta !== undefined ||
      patch.imagePath !== undefined ||
      patch.mediaPath !== undefined;

    // Auto-checkpoint revision for non-secret notes before overwriting significant changes
    if (existing.dna !== 'secret' && (titleChanged || bodyChanged)) {
      const nextBody = patch.body ?? existing.body;
      const existingRevs = this.listItemRevisions(id);
      const lastRev = existingRevs[0];
      const shouldSnapshot =
        Boolean(existing.body.trim() || existing.title.trim()) &&
        (!lastRev ||
          now - lastRev.createdAt >= AUTO_REVISION_MIN_INTERVAL_MS ||
          Math.abs(nextBody.length - lastRev.content.length) >= AUTO_REVISION_MIN_DELTA_CHARS);
      if (shouldSnapshot) {
        await this.saveItemRevision(id, 'auto', {
          title: existing.title,
          content: existing.body,
        });
      }
    }

    const nextUrl = patch.url !== undefined ? patch.url : existing.url;
    const nextBody = patch.body !== undefined ? patch.body : existing.body;
    const nextLinksOut =
      patch.body !== undefined || patch.linksOut !== undefined
        ? this.reconcileLinksOutFromBody(nextBody, id, patch.linksOut)
        : existing.linksOut;

    const updated: StoredMobileItem = {
      ...existing,
      ...patch,
      url: nextUrl,
      domain:
        patch.domain !== undefined
          ? patch.domain
          : patch.url !== undefined
            ? extractUrlDomain(nextUrl)
            : existing.domain,
      platform:
        patch.platform !== undefined
          ? patch.platform
          : patch.url !== undefined
            ? detectLinkPlatform(nextUrl)
            : existing.platform,
      linksOut: nextLinksOut,
      contentHash:
        existing.dna === 'secret'
          ? existing.contentHash
          : computeLightContentHash([existing.dna, patch.title ?? existing.title, nextBody, nextUrl]),
      updatedAt: now,
      contentUpdatedAt:
        contentChanged && !opts?.preserveContentUpdatedAt ? now : existing.contentUpdatedAt,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };

    this.itemsMap.set(id, updated);
    await this.backend.put('items', id, updated);
    await this.markDirty('item', id);
    this.emitChange();
    return this.getItemById(id);
  }

  public async deleteItem(id: string): Promise<boolean> {
    const existing = this.itemsMap.get(id);
    if (!existing || existing.deletedAt || existing.purgedAt) return false;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const deleted: StoredMobileItem = {
      ...existing,
      // Preserve encryptedSecretPayload on soft-delete so Trash restore is lossless;
      // permanent scrub happens in purgeItemPermanently() / emptyTrash().
      deletedAt: now,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.itemsMap.set(id, deleted);
    await this.backend.put('items', id, deleted);
    await this.markDirty('item', id);
    this.emitChange();
    return true;
  }

  public async restoreItem(id: string): Promise<VaultItem | null> {
    const existing = this.itemsMap.get(id);
    if (!existing || existing.purgedAt != null) return null;
    if (existing.deletedAt == null) return this.getItemById(id);
    const now = this.nextMonotonicTs(existing.updatedAt);
    const restored: StoredMobileItem = {
      ...existing,
      deletedAt: null,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.itemsMap.set(id, restored);
    await this.backend.put('items', id, restored);
    await this.markDirty('item', id);
    this.emitChange();
    return this.getItemById(id);
  }

  public async purgeItemPermanently(id: string): Promise<boolean> {
    const existing = this.itemsMap.get(id);
    if (!existing || existing.purgedAt != null) return false;
    const mediaToClean = this.collectItemMediaNames(existing);
    const now = this.nextMonotonicTs(existing.updatedAt);
    const purged: StoredMobileItem = {
      ...existing,
      title: '',
      body: '',
      summary: '',
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
      encryptedSecretPayload: null,
      secretMeta: null,
      tags: [],
      externalId: null,
      annotations: [],
      linksOut: [],
      deletedAt: existing.deletedAt ?? now,
      purgedAt: now,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.itemsMap.set(id, purged);
    await this.backend.put('items', id, purged);

    // Also remove local revisions of purged item
    const revIds: string[] = [];
    this.revisionsMap.forEach((r, rk) => {
      if (r.itemId === id) revIds.push(rk);
    });
    for (const rk of revIds) {
      this.revisionsMap.delete(rk);
      await this.backend.delete('item_revisions', rk);
      await this.clearDirtyKeyForce('item_revision', rk);
    }

    await this.enqueuePendingBlobDeletes(mediaToClean, id);
    await this.deleteMediaFilesIfUnreferenced(mediaToClean, id);
    await this.markDirty('item', id);
    this.emitChange();
    return true;
  }

  public async emptyTrash(): Promise<{ purgedCount: number }> {
    const trashed = this.listTrashedItems();
    let purgedCount = 0;
    for (const item of trashed) {
      const ok = await this.purgeItemPermanently(item.id);
      if (ok) purgedCount += 1;
    }
    return { purgedCount };
  }

  public async restoreRawItem(snapshot: StoredMobileItem): Promise<VaultItem | null> {
    const current = this.itemsMap.get(snapshot.id);
    if (current?.purgedAt != null) return null;
    const baseUpdated = Math.max(snapshot.updatedAt, current?.updatedAt ?? 0);
    const baseVersion = Math.max(snapshot.syncVersion ?? 1, current?.syncVersion ?? 1);
    const now = this.nextMonotonicTs(baseUpdated);
    const restored: StoredMobileItem = {
      ...snapshot,
      deletedAt: null,
      purgedAt: null,
      updatedAt: now,
      syncVersion: baseVersion + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.itemsMap.set(restored.id, restored);
    await this.backend.put('items', restored.id, restored);
    await this.markDirty('item', restored.id);
    this.emitChange();
    return this.getItemById(restored.id);
  }

  // ==================== Vault Secrets (TOTP 2FA + Hardware Keystore) ====================

  public async upsertSecret(input: StructuredSecretInput): Promise<VaultItem> {
    const locale = this.getLocale();
    if (this.isVaultLocked()) {
      throw new Error(tm('vaultCrypto.locked', undefined, locale));
    }
    const existing = input.id ? this.itemsMap.get(input.id) : undefined;
    let existingDec: SecretPayload | null = null;
    if (existing?.encryptedSecretPayload) {
      try {
        existingDec = await this.localCrypto.decryptSecretPayload(existing.encryptedSecretPayload);
      } catch (err) {
        if (err instanceof Error && err.message === tm('vaultCrypto.locked', undefined, locale)) {
          throw err;
        }
        throw new Error(tm('vaultCrypto.pinReencryptErr', undefined, locale));
      }
    }

    const parsedTotp =
      typeof input.totpUriOrSecret === 'string' && input.totpUriOrSecret.trim()
        ? parseOtpAuthUri(input.totpUriOrSecret)
        : null;
    if (typeof input.totpUriOrSecret === 'string' && input.totpUriOrSecret.trim() && !parsedTotp) {
      throw new Error(tm('vault.totpParseError', undefined, locale));
    }

    const keepExistingTotp = input.totpUriOrSecret === undefined && Boolean(existingDec?.totpSecret);
    const totpPayloadFields: Partial<SecretPayload> = parsedTotp
      ? {
          totpSecret: parsedTotp.secret,
          ...(parsedTotp.issuer ? { totpIssuer: parsedTotp.issuer } : {}),
          ...(parsedTotp.account ? { totpAccount: parsedTotp.account } : {}),
          totpAlgorithm: input.totpAlgorithm ?? parsedTotp.algorithm,
          totpDigits: input.totpDigits ?? parsedTotp.digits,
          totpPeriod: input.totpPeriod ?? parsedTotp.period,
        }
      : keepExistingTotp && existingDec
        ? {
            totpSecret: existingDec.totpSecret,
            ...(existingDec.totpIssuer ? { totpIssuer: existingDec.totpIssuer } : {}),
            ...(existingDec.totpAccount ? { totpAccount: existingDec.totpAccount } : {}),
            totpAlgorithm: existingDec.totpAlgorithm,
            totpDigits: existingDec.totpDigits,
            totpPeriod: existingDec.totpPeriod,
          }
        : {};

    const meta = buildSecretMetaFromInput(
      input,
      keepExistingTotp ? existing?.secretMeta ?? undefined : undefined
    );

    const payload: SecretPayload = {
      service: meta.service,
      login: (input.login ?? '').trim(),
      secretValue: input.secretValue.trim(),
      notes: (input.notes ?? '').trim(),
      ...(input.kind === 'bank_card'
        ? {
            cardHolder: (input.cardHolder ?? input.login ?? '').trim() || undefined,
            expiry: input.expiry?.trim() || undefined,
            cvv: input.cvv?.trim() || undefined,
          }
        : {}),
      ...totpPayloadFields,
    };
    const encryptedSecretPayload = await this.localCrypto.encryptSecretPayload(payload);
    const title = input.title?.trim() || meta.service;

    const secretSummary =
      input.kind === 'bank_card'
        ? tm('vault.kindBankCard', undefined, locale)
        : input.kind === 'password'
          ? tm('vault.kindPassword', undefined, locale)
          : input.kind === 'api_key'
            ? tm('vault.kindApiKey', undefined, locale)
            : input.kind === 'seed'
              ? tm('vault.kindSeed', undefined, locale)
              : tm('vault.kindNote', undefined, locale);

    if (existing) {
      const now = this.nextMonotonicTs(existing.updatedAt);
      const updated: StoredMobileItem = {
        ...existing,
        deletedAt: null,
        purgedAt: null,
        dna: 'secret',
        title,
        summary: secretSummary,
        orbit: input.orbit ?? existing.orbit,
        focusBoardId: input.focusBoardId !== undefined ? input.focusBoardId : existing.focusBoardId,
        tags: input.tags ?? existing.tags,
        hasEncryptedPayload: true,
        encryptedSecretPayload,
        secretMeta: meta,
        contentHash: generateUuid(),
        aiStatus: 'skipped_secret',
        updatedAt: now,
        contentUpdatedAt: now,
        syncVersion: (existing.syncVersion ?? 1) + 1,
        lastDeviceId: this.getSyncState('device_id'),
      };
      this.itemsMap.set(updated.id, updated);
      await this.backend.put('items', updated.id, updated);
      await this.markDirty('item', updated.id);
      this.emitChange();
      return this.getItemById(updated.id)!;
    }

    const now = Date.now();
    const id = input.id || generateUuid();
    const stored: StoredMobileItem = {
      id,
      dna: 'secret',
      subKind: null,
      orbit: input.orbit ?? '',
      modeCaptured: 'autopilot',
      focusBoardId: input.focusBoardId ?? null,
      title,
      body: '',
      summary: secretSummary,
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
      hasEncryptedPayload: true,
      encryptedSecretPayload,
      secretMeta: meta,
      tags: input.tags ?? [],
      source: 'vault_ui',
      externalId: null,
      contentHash: generateUuid(),
      aiStatus: 'skipped_secret',
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
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.itemsMap.set(id, stored);
    await this.backend.put('items', id, stored);
    await this.markDirty('item', id);
    this.emitChange();
    return this.getItemById(id)!;
  }

  public async revealSecret(itemId: string): Promise<SecretPayload | null> {
    if (this.isVaultLocked()) {
      throw new Error(tm('vaultCrypto.locked', undefined, this.getLocale()));
    }
    const raw = this.itemsMap.get(itemId);
    if (!raw || raw.deletedAt || raw.purgedAt || !raw.encryptedSecretPayload) return null;
    return this.localCrypto.decryptSecretPayload(raw.encryptedSecretPayload);
  }

  public async getTotpCode(itemId: string, nowMs = Date.now()): Promise<TotpCodeSnapshot | null> {
    const payload = await this.revealSecret(itemId);
    if (!payload?.totpSecret) return null;
    try {
      return generateTotp({
        secret: payload.totpSecret,
        algorithm: payload.totpAlgorithm ?? 'SHA1',
        digits: payload.totpDigits ?? 6,
        period: payload.totpPeriod ?? 30,
        nowMs,
      });
    } catch {
      return null;
    }
  }

  public async getSecretFieldValue(
    itemId: string,
    field: SecretCopyField
  ): Promise<string | null> {
    const payload = await this.revealSecret(itemId);
    if (!payload) return null;
    if (field === 'secretValue') return payload.secretValue || null;
    if (field === 'login') return payload.login || payload.cardHolder || null;
    if (field === 'cvv') return payload.cvv || null;
    if (field === 'expiry') return payload.expiry || null;
    if (field === 'notes') return payload.notes || null;
    if (field === 'totp') {
      if (!payload.totpSecret) return null;
      try {
        return generateTotp({
          secret: payload.totpSecret,
          algorithm: payload.totpAlgorithm ?? 'SHA1',
          digits: payload.totpDigits ?? 6,
          period: payload.totpPeriod ?? 30,
        }).code;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ==================== Orbits & Focus Boards ====================

  public async createOrbit(input: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
  }): Promise<OrbitDef> {
    const now = Date.now();
    const id = generateUuid();
    const sortOrder = this.orbitsMap.size;
    const stored: StoredMobileOrbit = {
      id,
      name: input.name.trim() || tm('store.newOrbitName', undefined, this.getLocale()),
      description: input.description?.trim() ?? '',
      icon: input.icon ?? 'Folder',
      color: input.color ?? '#E86A33',
      sortOrder,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.orbitsMap.set(id, stored);
    await this.backend.put('orbits', id, stored);
    await this.markDirty('orbit', id);
    this.emitChange();
    return stored;
  }

  public async updateOrbit(id: string, patch: OrbitUpdateInput): Promise<OrbitDef | null> {
    const existing = this.orbitsMap.get(id);
    if (!existing) return null;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const updated: StoredMobileOrbit = {
      ...existing,
      ...patch,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.orbitsMap.set(id, updated);
    await this.backend.put('orbits', id, updated);
    await this.markDirty('orbit', id);
    this.emitChange();
    return updated;
  }

  public async deleteOrbit(id: string): Promise<boolean> {
    const existing = this.orbitsMap.get(id);
    if (!existing || existing.deletedAt) return false;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const deleted: StoredMobileOrbit = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.orbitsMap.set(id, deleted);
    await this.backend.put('orbits', id, deleted);
    await this.markDirty('orbit', id, true);

    for (const item of this.itemsMap.values()) {
      if (!item.deletedAt && !item.purgedAt && item.orbit === id) {
        const ts = this.nextMonotonicTs(item.updatedAt);
        const updated: StoredMobileItem = {
          ...item,
          orbit: '',
          updatedAt: ts,
          syncVersion: (item.syncVersion ?? 1) + 1,
          lastDeviceId: this.getSyncState('device_id'),
        };
        this.itemsMap.set(item.id, updated);
        await this.backend.put('items', item.id, updated);
        await this.markDirty('item', item.id, true);
      }
    }
    this.mutationListener?.('orbit', id);
    this.emitChange();
    return true;
  }

  public async createBoard(input: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
  }): Promise<FocusBoard> {
    const now = Date.now();
    const id = generateUuid();
    const stored: StoredMobileBoard = {
      id,
      name: input.name.trim() || tm('store.newBoardName', undefined, this.getLocale()),
      description: input.description?.trim() ?? '',
      icon: input.icon ?? 'Sparkle',
      color: input.color ?? '#E86A33',
      sortOrder: this.boardsMap.size,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.boardsMap.set(id, stored);
    await this.backend.put('focus_boards', id, stored);
    await this.markDirty('focus_board', id);
    this.emitChange();
    return stored;
  }

  public async updateBoard(id: string, patch: FocusBoardUpdateInput): Promise<FocusBoard | null> {
    const existing = this.boardsMap.get(id);
    if (!existing) return null;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const updated: StoredMobileBoard = {
      ...existing,
      ...patch,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.boardsMap.set(id, updated);
    await this.backend.put('focus_boards', id, updated);
    await this.markDirty('focus_board', id);
    this.emitChange();
    return updated;
  }

  public async deleteBoard(id: string): Promise<boolean> {
    const existing = this.boardsMap.get(id);
    if (!existing || existing.deletedAt) return false;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const deleted: StoredMobileBoard = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.boardsMap.set(id, deleted);
    await this.backend.put('focus_boards', id, deleted);
    await this.markDirty('focus_board', id, true);

    for (const item of this.itemsMap.values()) {
      if (!item.deletedAt && !item.purgedAt && item.focusBoardId === id) {
        const ts = this.nextMonotonicTs(item.updatedAt);
        const updated: StoredMobileItem = {
          ...item,
          focusBoardId: null,
          updatedAt: ts,
          syncVersion: (item.syncVersion ?? 1) + 1,
          lastDeviceId: this.getSyncState('device_id'),
        };
        this.itemsMap.set(item.id, updated);
        await this.backend.put('items', item.id, updated);
        await this.markDirty('item', item.id, true);
      }
    }
    this.mutationListener?.('focus_board', id);
    this.emitChange();
    return true;
  }

  // ==================== Calendar Events ====================

  public async upsertCalendarEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const existing = input.id ? this.calendarMap.get(input.id) : undefined;
    const now = this.nextMonotonicTs(existing?.updatedAt);
    const id = existing?.id || input.id || generateUuid();
    const record: StoredMobileCalendarEvent = {
      id,
      title: input.title.trim() || tm('calendar.defaultEventTitle', undefined, this.getLocale()),
      notes: input.notes ?? existing?.notes ?? '',
      location: input.location ?? existing?.location ?? '',
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: Boolean(input.allDay),
      hasEndTime: input.hasEndTime ?? true,
      color: input.color ?? existing?.color ?? '#E86A33',
      kind: input.kind ?? existing?.kind ?? 'event',
      recurrence: input.recurrence ?? existing?.recurrence ?? 'none',
      isDone: input.isDone ?? existing?.isDone ?? false,
      linkedItemId: input.linkedItemId ?? existing?.linkedItemId ?? null,
      checklist: input.checklist ?? existing?.checklist ?? [],
      attachments: input.attachments ?? existing?.attachments ?? [],
      externalSource: input.externalSource ?? existing?.externalSource ?? null,
      externalId: input.externalId ?? existing?.externalId ?? null,
      etag: existing?.etag ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      syncVersion: (existing?.syncVersion ?? 0) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.calendarMap.set(id, record);
    await this.backend.put('calendar_events', id, record);
    await this.markDirty('calendar_event', id);
    this.emitChange();
    return record;
  }

  public async deleteCalendarEvent(id: string): Promise<boolean> {
    const existing = this.calendarMap.get(id);
    if (!existing || existing.deletedAt) return false;
    const now = this.nextMonotonicTs(existing.updatedAt);
    const deleted: StoredMobileCalendarEvent = {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: (existing.syncVersion ?? 1) + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.calendarMap.set(id, deleted);
    await this.backend.put('calendar_events', id, deleted);
    await this.markDirty('calendar_event', id);
    this.emitChange();
    return true;
  }

  public async restoreRawCalendarEvent(
    snapshot: StoredMobileCalendarEvent
  ): Promise<CalendarEvent | null> {
    const current = this.calendarMap.get(snapshot.id);
    const baseUpdated = Math.max(snapshot.updatedAt, current?.updatedAt ?? 0);
    const baseVersion = Math.max(snapshot.syncVersion ?? 1, current?.syncVersion ?? 1);
    const now = this.nextMonotonicTs(baseUpdated);
    const restored: StoredMobileCalendarEvent = {
      ...snapshot,
      deletedAt: null,
      updatedAt: now,
      syncVersion: baseVersion + 1,
      lastDeviceId: this.getSyncState('device_id'),
    };
    this.calendarMap.set(restored.id, restored);
    await this.backend.put('calendar_events', restored.id, restored);
    await this.markDirty('calendar_event', restored.id);
    this.emitChange();
    const { lastDeviceId: _ld, ...pub } = restored;
    return pub;
  }

  // ==================== Vault Tasks + Kanban Board (Shared Task Helpers) ====================

  private buildReconciledTasksForItem(
    item: VaultItem,
    columns: TaskBoardColumn[]
  ): { entries: VaultTaskEntry[]; taskMetaMap: Record<string, TaskBoardItemMeta> } {
    const itemTitle = item.title?.trim() || tm('common.untitledNote', undefined, this.getLocale());
    const mdTasks = sharedParseMarkdownTasks(item.body || '');
    const actions = item.mediaMeta?.actionItems ?? [];
    const checked = new Set(item.mediaMeta?.checkedActionIndices ?? []);

    const reconcilable: Array<{
      taskKey: string;
      text: string;
      done: boolean;
      textHash: string;
      sourceType: 'markdown' | 'voice_action';
      taskIndex: number;
    }> = [];

    for (const entry of mdTasks) {
      reconcilable.push({
        taskKey: entry.taskKey,
        text: entry.text,
        done: entry.done,
        textHash: entry.textHash,
        sourceType: 'markdown',
        taskIndex: entry.index,
      });
    }

    actions.forEach((rawText, idx) => {
      const text = (rawText ?? '').trim();
      if (!text) return;
      reconcilable.push({
        taskKey: `va:${idx}`,
        text,
        done: checked.has(idx),
        textHash: normalizeTaskTextHash(text),
        sourceType: 'voice_action',
        taskIndex: idx,
      });
    });

    const taskMetaMap = reconcileTaskMeta(reconcilable, item.mediaMeta?.taskMeta, columns);
    const entries: VaultTaskEntry[] = reconcilable.map((r) => {
      const meta = taskMetaMap[r.taskKey]!;
      const effectiveDue = meta.dueAt ?? item.remindAt ?? null;
      return {
        id: `${item.id}:${r.taskKey}`,
        itemId: item.id,
        itemTitle,
        sourceType: r.sourceType,
        taskIndex: r.taskIndex,
        text: r.text,
        done: r.done,
        orbit: item.orbit || null,
        remindAt: effectiveDue,
        dueAt: meta.dueAt ?? null,
        updatedAt: item.contentUpdatedAt || item.updatedAt,
        taskKey: r.taskKey,
        columnId: meta.columnId,
        boardOrder: meta.boardOrder,
        priority: meta.priority ?? 'none',
      };
    });

    return { entries, taskMetaMap };
  }

  public listVaultTasks(): VaultTaskEntry[] {
    const columns = this.listTaskBoardColumns();
    const tasks: VaultTaskEntry[] = [];
    const items = this.listItems({ includeSecrets: false });
    for (const item of items) {
      const { entries } = this.buildReconciledTasksForItem(item, columns);
      tasks.push(...entries);
    }
    return tasks;
  }

  public async toggleVaultTask(task: VaultTaskEntry): Promise<VaultItem | null> {
    const current = this.itemsMap.get(task.itemId);
    if (!current || current.deletedAt || current.purgedAt) return null;
    const columns = this.listTaskBoardColumns();
    const nextDone = !task.done;
    const taskKey = task.taskKey ?? (task.sourceType === 'markdown' ? `md:${task.taskIndex}` : `va:${task.taskIndex}`);

    const { taskMetaMap } = this.buildReconciledTasksForItem(this.toPublicItem(current), columns);
    const prevMeta = taskMetaMap[taskKey];
    const doneColId = columns.find((c) => c.isDone || c.id === 'done')?.id ?? 'done';
    const inboxColId = columns.find((c) => !c.isDone && c.id !== 'done')?.id ?? columns[0]?.id ?? 'inbox';

    const nextColumnId = nextDone
      ? doneColId
      : prevMeta?.prevColumnId && !isDoneColumn(prevMeta.prevColumnId, columns)
        ? prevMeta.prevColumnId
        : inboxColId;

    const updatedTaskMeta: Record<string, TaskBoardItemMeta> = {
      ...taskMetaMap,
      [taskKey]: {
        ...(prevMeta ?? { boardOrder: task.taskIndex * 1000, priority: 'none', dueAt: null }),
        columnId: nextColumnId,
        prevColumnId: nextDone
          ? prevMeta?.columnId && !isDoneColumn(prevMeta.columnId, columns)
            ? prevMeta.columnId
            : prevMeta?.prevColumnId
          : prevMeta?.prevColumnId,
        textHash: normalizeTaskTextHash(task.text),
      },
    };

    if (task.sourceType === 'markdown') {
      const toggled = toggleMarkdownTaskInBody(current.body || '', task.taskIndex, nextDone);
      if (!toggled) return null;
      const meta: MediaMeta = { ...(current.mediaMeta ?? {}), taskMeta: updatedTaskMeta };
      return this.updateItem(
        current.id,
        { body: toggled.body, mediaMeta: meta },
        { preserveContentUpdatedAt: true }
      );
    }

    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const actions = Array.isArray(meta.actionItems) ? meta.actionItems : [];
    if (task.taskIndex < 0 || task.taskIndex >= actions.length) return null;
    const checked = new Set(
      Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []
    );
    if (nextDone) checked.add(task.taskIndex);
    else checked.delete(task.taskIndex);
    meta.checkedActionIndices = Array.from(checked).sort((a, b) => a - b);
    meta.taskMeta = updatedTaskMeta;
    return this.updateItem(current.id, { mediaMeta: meta }, { preserveContentUpdatedAt: true });
  }

  public async moveTaskOnBoard(input: {
    itemId: string;
    taskKey: string;
    columnId: string;
    boardOrder: number;
  }): Promise<VaultItem | null> {
    const current = this.itemsMap.get(input.itemId);
    if (!current || current.deletedAt || current.purgedAt) return null;
    const parsedKey = parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    const columns = this.listTaskBoardColumns();
    const { taskMetaMap } = this.buildReconciledTasksForItem(this.toPublicItem(current), columns);
    const canonicalKey = parsedKey.sourceType === 'markdown' ? `md:${parsedKey.index}` : `va:${parsedKey.index}`;
    const existingMeta = taskMetaMap[canonicalKey];
    const targetIsDone = isDoneColumn(input.columnId, columns);

    const prevColumnId = targetIsDone
      ? existingMeta?.columnId && !isDoneColumn(existingMeta.columnId, columns)
        ? existingMeta.columnId
        : existingMeta?.prevColumnId
      : input.columnId;

    const nextTaskMeta: Record<string, TaskBoardItemMeta> = {
      ...taskMetaMap,
      [canonicalKey]: {
        ...(existingMeta ?? { priority: 'none', dueAt: null }),
        columnId: input.columnId,
        ...(prevColumnId ? { prevColumnId } : {}),
        boardOrder: Number.isFinite(input.boardOrder) ? input.boardOrder : 0,
      },
    };

    if (parsedKey.sourceType === 'markdown') {
      const toggled = toggleMarkdownTaskInBody(current.body || '', parsedKey.index, targetIsDone);
      const nextBody = toggled ? toggled.body : current.body;
      const meta: MediaMeta = { ...(current.mediaMeta ?? {}), taskMeta: nextTaskMeta };
      return this.updateItem(current.id, { body: nextBody, mediaMeta: meta });
    }

    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const actions = Array.isArray(meta.actionItems) ? meta.actionItems : [];
    if (parsedKey.index < 0 || parsedKey.index >= actions.length) return null;
    const checked = new Set(Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []);
    if (targetIsDone) checked.add(parsedKey.index);
    else checked.delete(parsedKey.index);
    meta.checkedActionIndices = Array.from(checked).sort((a, b) => a - b);
    meta.taskMeta = nextTaskMeta;
    return this.updateItem(current.id, { mediaMeta: meta });
  }

  public async updateTaskMeta(input: {
    itemId: string;
    taskKey: string;
    priority?: TaskPriority;
    dueAt?: number | null;
    columnId?: string;
    boardOrder?: number;
  }): Promise<VaultItem | null> {
    const current = this.itemsMap.get(input.itemId);
    if (!current || current.deletedAt || current.purgedAt) return null;
    const parsedKey = parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    if (input.columnId !== undefined) {
      const moved = await this.moveTaskOnBoard({
        itemId: input.itemId,
        taskKey: input.taskKey,
        columnId: input.columnId,
        boardOrder: input.boardOrder ?? 0,
      });
      if (!moved) return null;
    }

    const fresh = this.itemsMap.get(input.itemId);
    if (!fresh) return null;
    const columns = this.listTaskBoardColumns();
    const { taskMetaMap } = this.buildReconciledTasksForItem(this.toPublicItem(fresh), columns);
    const canonicalKey = parsedKey.sourceType === 'markdown' ? `md:${parsedKey.index}` : `va:${parsedKey.index}`;
    const existingMeta = taskMetaMap[canonicalKey] ?? {
      columnId: columns[0]?.id ?? 'inbox',
      boardOrder: parsedKey.index * 1000,
      priority: 'none' as TaskPriority,
      dueAt: null,
    };

    const updatedMeta: TaskBoardItemMeta = {
      ...existingMeta,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.boardOrder !== undefined ? { boardOrder: input.boardOrder } : {}),
    };

    const meta: MediaMeta = {
      ...(fresh.mediaMeta ?? {}),
      taskMeta: {
        ...taskMetaMap,
        [canonicalKey]: updatedMeta,
      },
    };
    return this.updateItem(fresh.id, { mediaMeta: meta });
  }

  public async addQuickTask(
    text: string,
    orbit = '',
    dueAt: number | null = null,
    columnId?: string,
    priority: TaskPriority = 'none'
  ): Promise<VaultItem> {
    const clean = text.trim();
    const columns = this.listTaskBoardColumns();
    const targetCol = columnId || columns.find((c) => !c.isDone)?.id || 'inbox';
    const done = isDoneColumn(targetCol, columns);
    const taskMeta: Record<string, TaskBoardItemMeta> = {
      'md:0': {
        columnId: targetCol,
        boardOrder: Date.now(),
        priority,
        dueAt,
        textHash: normalizeTaskTextHash(clean),
      },
    };
    return this.createItem({
      dna: 'note',
      title: clean.slice(0, 80),
      body: `- [${done ? 'x' : ' '}] ${clean}`,
      orbit,
      remindAt: dueAt,
      mediaMeta: { taskMeta },
      source: 'vault_ui',
    });
  }

  public async updateVaultTaskText(task: VaultTaskEntry, rawNextText: string): Promise<VaultItem | null> {
    const nextText = rawNextText.replace(/[\r\n]+/g, ' ').trim();
    if (!nextText) return null;
    const current = this.itemsMap.get(task.itemId);
    if (!current || current.deletedAt || current.purgedAt) return null;
    const columns = this.listTaskBoardColumns();
    const { taskMetaMap } = this.buildReconciledTasksForItem(this.toPublicItem(current), columns);
    const taskKey = task.taskKey ?? (task.sourceType === 'markdown' ? `md:${task.taskIndex}` : `va:${task.taskIndex}`);
    const existingMeta = taskMetaMap[taskKey];
    const nextTaskMetaMap = existingMeta
      ? {
          ...taskMetaMap,
          [taskKey]: { ...existingMeta, textHash: normalizeTaskTextHash(nextText) },
        }
      : taskMetaMap;

    if (task.sourceType === 'markdown') {
      const lines = (current.body || '').split(/\r?\n/);
      const parsed = parseMarkdownTasks(current.body || '');
      const target = parsed.find((t) => t.taskIndex === task.taskIndex);
      if (!target) return null;
      const line = lines[target.lineIndex];
      if (typeof line !== 'string') return null;
      const match = MARKDOWN_TASK_RE.exec(line);
      if (!match) return null;
      lines[target.lineIndex] = `${match[1] ?? ''}[${match[2] ?? ' '}]${match[3] ?? ''}${nextText}`;
      const isSingleTaskNote = parsed.length === 1 && current.title.trim() === task.text.trim();
      return this.updateItem(current.id, {
        body: lines.join('\n'),
        mediaMeta: { ...(current.mediaMeta ?? {}), taskMeta: nextTaskMetaMap },
        ...(isSingleTaskNote ? { title: nextText.slice(0, 80) } : {}),
      });
    }

    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const actions = Array.isArray(meta.actionItems) ? [...meta.actionItems] : [];
    if (task.taskIndex < 0 || task.taskIndex >= actions.length) return null;
    actions[task.taskIndex] = nextText;
    meta.actionItems = actions;
    meta.taskMeta = nextTaskMetaMap;
    return this.updateItem(current.id, { mediaMeta: meta });
  }

  public async deleteVaultTask(task: VaultTaskEntry): Promise<StoredMobileItem | null> {
    const current = this.itemsMap.get(task.itemId);
    if (!current || current.deletedAt || current.purgedAt) return null;
    const snapshot: StoredMobileItem = {
      ...current,
      tags: [...current.tags],
      mediaMeta: current.mediaMeta
        ? {
            ...current.mediaMeta,
            actionItems: current.mediaMeta.actionItems ? [...current.mediaMeta.actionItems] : undefined,
            checkedActionIndices: current.mediaMeta.checkedActionIndices
              ? [...current.mediaMeta.checkedActionIndices]
              : undefined,
            taskMeta: current.mediaMeta.taskMeta ? { ...current.mediaMeta.taskMeta } : undefined,
          }
        : null,
    };

    if (task.sourceType === 'markdown') {
      const lines = (current.body || '').split(/\r?\n/);
      const parsed = parseMarkdownTasks(current.body || '');
      const target = parsed.find((t) => t.taskIndex === task.taskIndex);
      if (!target) return null;
      lines.splice(target.lineIndex, 1);
      const remainingBody = lines.join('\n').trim();
      const hasAttachments = Boolean(current.imagePath || current.mediaPath || current.url);
      const hasCustomTitle =
        Boolean(current.title.trim()) &&
        !isUntitledPlaceholderTitle(current.title) &&
        current.title.trim() !== task.text.trim();
      const hasMetadata =
        current.tags.length > 0 ||
        current.remindAt != null ||
        current.annotations.length > 0 ||
        current.linksOut.length > 0;
      if (!remainingBody && !hasAttachments && !hasCustomTitle && !hasMetadata && parsed.length === 1) {
        await this.deleteItem(current.id);
      } else {
        await this.updateItem(current.id, { body: remainingBody });
      }
      return snapshot;
    }

    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const actions = Array.isArray(meta.actionItems) ? [...meta.actionItems] : [];
    if (task.taskIndex < 0 || task.taskIndex >= actions.length) return null;
    actions.splice(task.taskIndex, 1);
    const nextChecked = (meta.checkedActionIndices ?? [])
      .filter((i) => i !== task.taskIndex)
      .map((i) => (i > task.taskIndex ? i - 1 : i));
    meta.actionItems = actions;
    meta.checkedActionIndices = nextChecked;
    await this.updateItem(current.id, { mediaMeta: meta });
    return snapshot;
  }

  // ==================== Incoming Sync Apply (Deterministic LWW + Purge + Conflict Revisions) ====================

  public getEntitySyncStamp(
    entityType: SyncEntityType | string,
    entityId: string
  ): { updatedAt: number; syncVersion: number; deletedAt: number | null } | null {
    if (entityType === 'item') {
      const row = this.itemsMap.get(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.purgedAt ?? row.deletedAt ?? null,
      };
    }
    if (entityType === 'orbit') {
      const row = this.orbitsMap.get(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt ?? row.createdAt ?? 0,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.deletedAt ?? null,
      };
    }
    if (entityType === 'focus_board') {
      const row = this.boardsMap.get(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt ?? row.createdAt ?? 0,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.deletedAt ?? null,
      };
    }
    if (entityType === 'calendar_event') {
      const row = this.calendarMap.get(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.deletedAt ?? null,
      };
    }
    if (entityType === 'item_revision') {
      const row = this.revisionsMap.get(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt ?? row.createdAt,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.deletedAt ?? null,
      };
    }
    if (entityType === 'workspace_prefs') {
      const updated = Number(this.getSyncState('workspace_prefs_updated_at') || '0') || 0;
      if (updated <= 0) return null;
      return {
        updatedAt: updated,
        syncVersion: Number(this.getSyncState('workspace_prefs_sync_version') || '1') || 1,
        deletedAt: null,
      };
    }
    return null;
  }

  public async applySyncedOrbit(
    payload: SyncedOrbitPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    const existing = this.orbitsMap.get(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt ?? existing.createdAt ?? 0,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt ?? null,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;
    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }
    const stored: StoredMobileOrbit = {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      color: payload.color,
      sortOrder: payload.sortOrder,
      isBuiltin: payload.isBuiltin,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      deletedAt: payload.deletedAt,
      syncVersion: payload.syncVersion,
      lastDeviceId: remoteDeviceId,
    };
    this.orbitsMap.set(stored.id, stored);
    await this.backend.put('orbits', stored.id, stored);
    await this.clearDirtyKeyForce('orbit', stored.id);
    this.bumpDataVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public async applySyncedBoard(
    payload: SyncedFocusBoardPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    const existing = this.boardsMap.get(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt ?? existing.createdAt,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt ?? null,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;
    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }
    const stored: StoredMobileBoard = {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      color: payload.color,
      sortOrder: payload.sortOrder,
      isActive: payload.isActive,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      deletedAt: payload.deletedAt,
      syncVersion: payload.syncVersion,
      lastDeviceId: remoteDeviceId,
    };
    this.boardsMap.set(stored.id, stored);
    await this.backend.put('focus_boards', stored.id, stored);
    await this.clearDirtyKeyForce('focus_board', stored.id);
    this.bumpDataVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public async applySyncedCalendarEvent(
    payload: SyncedCalendarEventPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean }> {
    const existing = this.calendarMap.get(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;
    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }
    let safeExtSource = payload.externalSource;
    let safeExtId = payload.externalId;
    if (safeExtSource && safeExtId) {
      for (const other of this.calendarMap.values()) {
        if (
          other.id !== payload.id &&
          other.externalSource === safeExtSource &&
          other.externalId === safeExtId
        ) {
          safeExtSource = null;
          safeExtId = null;
          break;
        }
      }
    }
    const stored: StoredMobileCalendarEvent = {
      id: payload.id,
      title: payload.title,
      notes: payload.notes,
      location: payload.location,
      startAt: payload.startAt,
      endAt: payload.endAt,
      allDay: payload.allDay,
      hasEndTime: payload.hasEndTime,
      color: payload.color,
      kind: payload.kind,
      recurrence: payload.recurrence,
      isDone: payload.isDone,
      linkedItemId: payload.linkedItemId,
      checklist: payload.checklist ?? [],
      attachments: payload.attachments ?? [],
      externalSource: safeExtSource,
      externalId: safeExtId,
      etag: payload.etag,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      deletedAt: payload.deletedAt,
      syncVersion: payload.syncVersion,
      lastDeviceId: remoteDeviceId,
    };
    this.calendarMap.set(stored.id, stored);
    await this.backend.put('calendar_events', stored.id, stored);
    await this.clearDirtyKeyForce('calendar_event', stored.id);
    this.bumpDataVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public async applySyncedItem(
    payload: SyncedItemPayload,
    localEncryptedSecret: string | null,
    remoteDeviceId: string,
    localDeviceId: string
  ): Promise<{ applied: boolean; localStrictlyNewer: boolean; item: VaultItem | null }> {
    const existing = this.itemsMap.get(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt ?? existing.purgedAt ?? null,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;

    const remotePurgedAt = payload.purgedAt ?? null;
    const effectiveRemoteDeletedAt = payload.deletedAt ?? remotePurgedAt;

    // Permanent purge is strictly irreversible: a stale or clock-skewed remote live/trashed
    // record must NEVER resurrect a locally purged item; advance local tombstone & re-mark dirty to heal cloud.
    if (existing?.purgedAt != null && remotePurgedAt == null) {
      const bumpedUpdatedAt = Math.max(payload.updatedAt + 1, existing.updatedAt + 1, Date.now());
      const bumpedSyncVersion = Math.max(existing.syncVersion ?? 1, payload.syncVersion) + 1;
      await this.bumpEntityTimestampForRetry('item', payload.id, bumpedUpdatedAt, bumpedSyncVersion);
      await this.markDirty('item', payload.id, true);
      return {
        applied: false,
        localStrictlyNewer: true,
        item: null,
      };
    }

    const cmp = compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: effectiveRemoteDeletedAt,
      deviceId: remoteDeviceId,
    });

    const isRemotePurge = remotePurgedAt != null;
    // Remote permanent purge ALWAYS wins unconditionally regardless of clock skew / cmp
    const forcePurgeWin = isRemotePurge && (!existing || existing.purgedAt == null);

    if (cmp !== 'remote' && !forcePurgeWin) {
      const remoteContentDiffers = Boolean(
        existing &&
          (existing.deletedAt != null ||
            (payload.title ?? '') !== (existing.title ?? '') ||
            (payload.body ?? '') !== (existing.body ?? '') ||
            (payload.orbit ?? '') !== (existing.orbit ?? '') ||
            (payload.remindAt ?? null) !== (existing.remindAt ?? null) ||
            JSON.stringify(payload.tags ?? []) !== JSON.stringify(existing.tags ?? []) ||
            (payload.mediaMeta?.transcript ?? '') !== (existing.mediaMeta?.transcript ?? '') ||
            JSON.stringify(payload.extractedActions ?? []) !==
              JSON.stringify(existing.extractedActions ?? []))
      );
      const remoteTextChangedOrRestored = Boolean(
        existing &&
          (existing.deletedAt != null ||
            (payload.title ?? '') !== (existing.title ?? '') ||
            (payload.body ?? '') !== (existing.body ?? ''))
      );
      const remoteRevHash = computeLightContentHash([payload.title ?? '', payload.body ?? '']);
      const alreadyInRevisions = Boolean(
        existing &&
          Array.from(this.revisionsMap.values()).some(
            (r) => r.itemId === existing.id && !r.deletedAt && r.contentHash === remoteRevHash
          )
      );
      // Preserve losing remote live edit in item_revisions (source = 'sync_conflict') if its text wasn't already captured
      if (
        cmp === 'local' &&
        existing &&
        existing.dna !== 'secret' &&
        !existing.purgedAt &&
        !effectiveRemoteDeletedAt &&
        !isRemotePurge &&
        ((payload.body || '').trim().length > 0 || (payload.title || '').trim().length > 0) &&
        remoteContentDiffers &&
        remoteTextChangedOrRestored &&
        !alreadyInRevisions
      ) {
        await this.saveItemRevision(existing.id, 'sync_conflict', {
          title: payload.title,
          content: payload.body,
          deviceName: tm('store.remoteDevice', { id: remoteDeviceId.slice(0, 8) }, this.getLocale()),
        });
      }
      return {
        applied: false,
        localStrictlyNewer: cmp === 'local',
        item: existing && !existing.deletedAt && !existing.purgedAt ? this.getItemById(existing.id) : null,
      };
    }

    // Handle remote permanent purge cleanly: scrub payload, media refs & revisions!
    if (isRemotePurge) {
      const mediaToClean = existing ? this.collectItemMediaNames(existing) : [];
      const purged: StoredMobileItem = {
        id: payload.id,
        dna: payload.dna,
        subKind: null,
        orbit: '',
        modeCaptured: payload.modeCaptured,
        focusBoardId: null,
        title: '',
        body: '',
        summary: '',
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
        encryptedSecretPayload: null,
        secretMeta: null,
        tags: [],
        source: payload.source,
        externalId: null,
        contentHash: payload.contentHash,
        aiStatus: payload.aiStatus,
        aiConfidence: null,
        isPinned: false,
        isArchived: false,
        isDemo: false,
        remindAt: null,
        remindedAt: null,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        contentUpdatedAt: payload.contentUpdatedAt,
        deletedAt: payload.deletedAt ?? payload.purgedAt!,
        purgedAt: payload.purgedAt!,
        canvasX: null,
        canvasY: null,
        canvasW: null,
        canvasH: null,
        canvasFrame: null,
        annotations: [],
        linksOut: [],
        syncVersion: payload.syncVersion,
        lastDeviceId: remoteDeviceId,
      };
      this.itemsMap.set(purged.id, purged);
      await this.backend.put('items', purged.id, purged);
      await this.clearDirtyKeyForce('item', purged.id);
      if (mediaToClean.length > 0) {
        await this.enqueuePendingBlobDeletes(mediaToClean, purged.id);
        await this.deleteMediaFilesIfUnreferenced(mediaToClean, purged.id);
      }
      const revIds: string[] = [];
      this.revisionsMap.forEach((r, rk) => {
        if (r.itemId === purged.id) revIds.push(rk);
      });
      for (const rk of revIds) {
        this.revisionsMap.delete(rk);
        await this.backend.delete('item_revisions', rk);
        await this.clearDirtyKeyForce('item_revision', rk);
      }
      return { applied: true, localStrictlyNewer: false, item: null };
    }

    // Preserve losing local edit / secret payload on LWW overwrite conflict
    const localContentDiffers = Boolean(
      existing &&
        (effectiveRemoteDeletedAt != null ||
          (payload.title ?? '') !== (existing.title ?? '') ||
          (payload.body ?? '') !== (existing.body ?? '') ||
          (payload.orbit ?? '') !== (existing.orbit ?? '') ||
          (payload.remindAt ?? null) !== (existing.remindAt ?? null) ||
          JSON.stringify(payload.tags ?? []) !== JSON.stringify(existing.tags ?? []) ||
          (payload.mediaMeta?.transcript ?? '') !== (existing.mediaMeta?.transcript ?? '') ||
          JSON.stringify(payload.extractedActions ?? []) !==
            JSON.stringify(existing.extractedActions ?? []))
    );
    const isConcurrentLocalEdit = Boolean(
      existing &&
        (this.dirtyMap.has(`item:${existing.id}`) ||
          (existing.lastDeviceId === localDeviceId && remoteDeviceId !== localDeviceId))
    );
    if (
      existing &&
      existing.dna !== 'secret' &&
      !existing.deletedAt &&
      !existing.purgedAt &&
      (existing.body.trim().length > 0 || existing.title.trim().length > 0) &&
      localContentDiffers &&
      isConcurrentLocalEdit
    ) {
      await this.saveItemRevision(existing.id, 'sync_conflict', {
        title: existing.title,
        content: existing.body,
        deviceName: this.deviceNameLabel,
      });
    } else if (
      existing &&
      existing.dna === 'secret' &&
      !existing.deletedAt &&
      !existing.purgedAt &&
      existing.encryptedSecretPayload &&
      localEncryptedSecret &&
      existing.encryptedSecretPayload !== localEncryptedSecret &&
      isConcurrentLocalEdit
    ) {
      const conflictId = generateUuid();
      const conflictTitle = tm(
        'sync.secretConflictCopy',
        { title: existing.title || 'Secret' },
        this.getLocale()
      ).slice(0, 140);
      const nowCopy = Date.now();
      const conflictCopy: StoredMobileItem = {
        ...existing,
        id: conflictId,
        title: conflictTitle,
        tags: [...existing.tags],
        source: 'sync_conflict' as ItemSource,
        contentHash: `conflict:${existing.id}:${existing.syncVersion}:${nowCopy}`,
        createdAt: nowCopy,
        updatedAt: nowCopy,
        contentUpdatedAt: nowCopy,
        deletedAt: null,
        purgedAt: null,
        syncVersion: 1,
        lastDeviceId: localDeviceId,
      };
      this.itemsMap.set(conflictId, conflictCopy);
      await this.backend.put('items', conflictId, conflictCopy);
      await this.markDirty('item', conflictId, true);
    }

    // On reversible soft-delete from remote, preserve local encrypted secret payload if remote omitted it
    const preservedSecret =
      localEncryptedSecret ??
      (payload.deletedAt != null && existing?.encryptedSecretPayload ? existing.encryptedSecretPayload : null);

    const stored: StoredMobileItem = {
      id: payload.id,
      dna: payload.dna,
      subKind: payload.subKind,
      orbit: payload.orbit,
      modeCaptured: payload.modeCaptured,
      focusBoardId: payload.focusBoardId,
      title: payload.title,
      body: payload.body,
      summary: payload.summary,
      url: payload.url,
      domain: payload.domain,
      platform: payload.platform,
      imagePath: payload.imagePath,
      thumbPath: payload.thumbPath,
      mediaPath: payload.mediaPath,
      mediaType: payload.mediaType,
      mediaDurationSec: payload.mediaDurationSec,
      mediaMeta: payload.mediaMeta,
      ogImageUrl: payload.ogImageUrl,
      ocrText: payload.ocrText,
      extractedActions: payload.extractedActions ?? [],
      colorPalette: payload.colorPalette ?? [],
      hasEncryptedPayload: Boolean(preservedSecret),
      encryptedSecretPayload: preservedSecret,
      secretMeta: payload.secretMeta,
      tags: payload.tags ?? [],
      source: payload.source,
      externalId: payload.externalId,
      contentHash: payload.contentHash,
      aiStatus: payload.aiStatus,
      aiConfidence: payload.aiConfidence,
      isPinned: payload.isPinned,
      isMuted: Boolean(payload.isMuted),
      isArchived: payload.isArchived,
      isDemo: false,
      remindAt: payload.remindAt,
      remindedAt: payload.remindedAt,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      contentUpdatedAt: payload.contentUpdatedAt,
      deletedAt: payload.deletedAt,
      purgedAt: null,
      canvasX: payload.canvasX,
      canvasY: payload.canvasY,
      canvasW: payload.canvasW,
      canvasH: payload.canvasH,
      canvasFrame: payload.canvasFrame,
      annotations: payload.annotations ?? [],
      linksOut: payload.linksOut ?? [],
      syncVersion: payload.syncVersion,
      lastDeviceId: remoteDeviceId,
    };
    this.itemsMap.set(stored.id, stored);
    await this.backend.put('items', stored.id, stored);
    await this.clearDirtyKeyForce('item', stored.id);
    this.bumpDataVersion();
    return {
      applied: true,
      localStrictlyNewer: false,
      item: payload.deletedAt ? null : this.getItemById(stored.id),
    };
  }

  public notifySyncedBatch(): void {
    this.emitChange();
  }
}
