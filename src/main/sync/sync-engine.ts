import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
  type SupportedStorage,
} from '@supabase/supabase-js';
import {
  DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SYNC_SUPABASE_URL,
  extractInlineMediaFilenames,
  sanitizeMediaMetaForSync,
  SYNC_MIN_KDF_ITERATIONS,
  SYNC_SCHEMA_VERSION,
  type SyncActionResult,
  type SyncAuthResult,
  type SyncDeviceInfo,
  type SyncedCalendarEventPayload,
  type SyncedFocusBoardPayload,
  type SyncedItemPayload,
  type SyncedItemRevisionPayload,
  type SyncedOrbitPayload,
  type SyncedWorkspacePrefsPayload,
  type SyncEntityType,
  type SyncKeyEnvelopeRow,
  type SyncPlatform,
  type SyncRecordRow,
  type SyncServerConfigInput,
  type SyncSetupPassphraseResult,
  type SyncStateKind,
  type SyncStatus,
} from '@shared/sync-contract';
import { APP_VERSION } from '@shared/app-version';
import type { AppLocale, SecretPayload, VaultItem } from '@shared/types';
import type { VaultRepository } from '../db/repository';
import { isPrivateOrLocalHostname } from '../pipeline/unfurler';
import type { VaultCrypto } from '../security/vault-crypto';
import {
  createKeyEnvelope,
  decryptRecordPayload,
  encryptRecordPayload,
  rewrapEnvelopePassphrase,
  rewrapEnvelopeRecoveryKey,
  setSyncCryptoLocale,
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
  verifyKeyCheckToken,
} from './sync-crypto';
import { SyncMediaManager } from './sync-media';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SyncEngineCallbacks {
  onStatusChanged?: (status: SyncStatus) => void;
  onItemUpserted?: (item: VaultItem) => void;
  onItemDeleted?: (id: string) => void;
  onOrbitsChanged?: () => void;
  onBoardsChanged?: () => void;
  onCalendarChanged?: () => void;
  onBatchSynced?: () => void;
  onWorkspacePrefsChanged?: () => void;
  onMediaCleanup?: (filenames: string[]) => void;
}

export interface SyncEngineOptions {
  dataDir: string;
  mediaDir: string;
  repo: VaultRepository;
  vaultCrypto: VaultCrypto;
  safeStorage?: SafeStorageAdapter;
  isPackaged?: boolean;
  appVersion?: string;
  deviceName?: string;
  kdfIterationsOverride?: number;
  disableTimers?: boolean;
  disableRealtime?: boolean;
  openExternal?: (url: string) => Promise<void> | void;
  callbacks?: SyncEngineCallbacks;
}

const SYNC_POLL_INTERVAL_MS = 30_000;
const DIRTY_DEBOUNCE_MS = 1_500;
const REALTIME_DEBOUNCE_MS = 450;
const PULL_PAGE_SIZE = 200;
const PULL_SEQ_OVERLAP = 25;
const PUSH_BATCH_SIZE = 100;
const MAX_PUSH_BATCHES_PER_CYCLE = 50;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH_UI_THRESHOLD = 6;
const OPTIONAL_SYNC_ENTITY_TYPES = new Set<SyncEntityType>(['item_revision', 'workspace_prefs']);

function isEntityTypeConstraintError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '23514') return true;
  const msg = String(err.message ?? '');
  return /23514|sync_records_entity_type_check|entity_type/i.test(msg);
}

function isVaultLockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('Сейф заблокирован') || msg.toLowerCase().includes('vault is locked');
}

function normalizePlatform(raw: NodeJS.Platform): SyncPlatform {
  if (raw === 'win32' || raw === 'darwin' || raw === 'linux' || raw === 'android') {
    return raw;
  }
  return 'linux';
}

function isRussianMessage(msg: string): boolean {
  return /[а-яё]/i.test(msg);
}

function translateSyncError(err: unknown, locale: AppLocale = 'ru'): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();
  const isEn = locale === 'en';
  if (lower.includes('invalid login credentials')) {
    return isEn ? 'Invalid email or password' : 'Неверная почта или пароль';
  }
  if (lower.includes('email not confirmed')) {
    return isEn
      ? 'Email not confirmed yet — click the confirmation link in your inbox and sign in'
      : 'Почта ещё не подтверждена — перейди по ссылке из письма и нажми «Войти»';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return isEn
      ? 'An account with this email already exists — switch to Sign in'
      : 'Аккаунт с этой почтой уже существует — переключись на «Войти»';
  }
  if (lower.includes('password should be at least')) {
    return isEn ? 'Password must be at least 6 characters' : 'Пароль должен содержать не менее 6 символов';
  }
  if (lower.includes('unable to validate email') || lower.includes('invalid email')) {
    return isEn ? 'Check your email address format' : 'Проверь формат электронной почты';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return isEn ? 'Too many attempts — wait a minute and try again' : 'Слишком много попыток — подожди минуту и попробуй снова';
  }
  if (
    lower.includes('jwt expired') ||
    lower.includes('invalid refresh token') ||
    lower.includes('refresh_token_not_found') ||
    lower.includes('auth session missing')
  ) {
    return isEn ? 'Sync session expired — sign in again' : 'Сессия синхронизации истекла — войди в аккаунт снова';
  }
  if (lower.includes('row-level security') || lower.includes('permission denied')) {
    return isEn
      ? 'Missing cloud storage permissions — try signing out and back in'
      : 'Нет прав доступа к облачному хранилищу — попробуй перезайти в аккаунт';
  }
  if (lower.includes('duplicate key') || lower.includes('23505')) {
    return isEn
      ? 'Encryption key for this account was already created on another device'
      : 'Ключ шифрования для этого аккаунта уже создан на другом устройстве';
  }
  if (lower.includes('provider is not enabled') || lower.includes('unsupported provider')) {
    return isEn
      ? 'Google sign-in is temporarily unavailable — sign in with email & password'
      : 'Вход через Google временно недоступен — войди по почте и паролю';
  }
  if (lower.includes('access_denied')) {
    return isEn ? 'Google sign-in was cancelled' : 'Вход через Google был отменён';
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset')
  ) {
    return isEn
      ? 'Cannot reach cloud sync — changes are saved locally and will upload when back online'
      : 'Нет связи с облаком синхронизации — данные сохранены локально и уйдут при появлении сети';
  }
  // Never expose raw English SQL/Postgres/SDK traces to end users
  if (
    raw &&
    !/(?:postgrest|postgres|pgrst|sqlstate|jwt)/i.test(raw) &&
    (isEn ? /^[a-z0-9\s.,:;!?\-'"()]+$/i.test(raw) && raw.length <= 160 : isRussianMessage(raw))
  ) {
    return raw;
  }
  return isEn
    ? 'Sync failed — please try again shortly'
    : 'Не удалось выполнить синхронизацию — попробуй повторить чуть позже';
}

function isNetworkLikeError(err: unknown): boolean {
  const lower = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket')
  );
}

class LocalSecureStore {
  private readonly storePath: string;
  private readonly saltPath: string;
  private fallbackKey: Buffer | null = null;
  private cache: Record<string, string> = {};
  private ephemeralCache: Record<string, string> = {};

  constructor(
    private readonly dataDir: string,
    private readonly safeStorage?: SafeStorageAdapter,
    private readonly isPackaged = false
  ) {
    this.storePath = path.join(dataDir, '.sync-secrets.json');
    this.saltPath = path.join(dataDir, '.sync-local.salt');
    this.load();
  }

  public isOsProtected(): boolean {
    return Boolean(this.safeStorage?.isEncryptionAvailable());
  }

  private isFallbackDiskKeyAllowed(): boolean {
    return !this.isPackaged && process.env.KAPSULA_ALLOW_FALLBACK_KEY === '1';
  }

  private getFallbackKey(): Buffer {
    if (this.fallbackKey) return this.fallbackKey;
    let salt: Buffer;
    if (fs.existsSync(this.saltPath)) {
      salt = fs.readFileSync(this.saltPath);
    } else {
      salt = crypto.randomBytes(16);
      fs.writeFileSync(this.saltPath, salt, { mode: 0o600 });
    }
    this.fallbackKey = crypto.pbkdf2Sync(
      `${os.hostname()}:${this.dataDir}:kapsula-sync-local-v1`,
      salt,
      40_000,
      32,
      'sha256'
    );
    return this.fallbackKey;
  }

  private encryptValueForDisk(
    plain: string,
    requireOsProtection = false,
    disallowFallbackDisk = false
  ): string | null {
    if (this.safeStorage?.isEncryptionAvailable()) {
      try {
        return `os:${this.safeStorage.encryptString(plain).toString('base64')}`;
      } catch (err) {
        if (requireOsProtection) {
          throw err;
        }
        // On macOS Keychain denial for non-DEK keys, never write weak fb: fallback unless explicitly enabled for tests
      }
    } else if (requireOsProtection) {
      throw new Error('OS safeStorage is unavailable');
    }

    if (disallowFallbackDisk || !this.isFallbackDiskKeyAllowed()) {
      return null;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getFallbackKey(), iv, {
      authTagLength: 16,
    });
    const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `fb:${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }

  private decryptValue(encoded: string): string | null {
    try {
      if (encoded.startsWith('os:')) {
        if (!this.safeStorage?.isEncryptionAvailable()) return null;
        return this.safeStorage.decryptString(Buffer.from(encoded.slice(3), 'base64'));
      }
      if (encoded.startsWith('fb:')) {
        if (!this.isFallbackDiskKeyAllowed()) return null;
        const [ivB64, tagB64, dataB64] = encoded.slice(3).split('.');
        if (!ivB64 || !tagB64 || !dataB64) return null;
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        if (iv.length !== 12 || tag.length !== 16) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.getFallbackKey(), iv, {
          authTagLength: 16,
        });
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([
          decipher.update(Buffer.from(dataB64, 'base64')),
          decipher.final(),
        ]);
        return dec.toString('utf8');
      }
      return null;
    } catch {
      return null;
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Record<string, string>;
      if (raw && typeof raw === 'object') {
        this.cache = raw;
      }
    } catch {
      this.cache = {};
    }
  }

  private persist(): void {
    const tmp = `${this.storePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.storePath);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
    }
  }

  public get(key: string): string | null {
    if (key in this.ephemeralCache) {
      return this.ephemeralCache[key] ?? null;
    }
    const enc = this.cache[key];
    if (!enc) return null;
    if (key.startsWith('sb:') && enc.startsWith('fb:')) {
      return null;
    }
    return this.decryptValue(enc);
  }

  public set(
    key: string,
    value: string,
    opts?: { requireOsProtection?: boolean; disallowFallbackDisk?: boolean }
  ): void {
    const encrypted = this.encryptValueForDisk(
      value,
      Boolean(opts?.requireOsProtection),
      Boolean(opts?.disallowFallbackDisk)
    );
    if (encrypted === null) {
      // Keep strictly in-memory when OS protection is unavailable or disallowed for disk fallback
      this.ephemeralCache[key] = value;
      return;
    }
    delete this.ephemeralCache[key];
    this.cache[key] = encrypted;
    this.persist();
  }

  public remove(key: string): void {
    delete this.ephemeralCache[key];
    if (key in this.cache) {
      delete this.cache[key];
      this.persist();
    }
  }

  public removeByPrefix(prefix: string): void {
    for (const k of Object.keys(this.ephemeralCache)) {
      if (k.startsWith(prefix)) {
        delete this.ephemeralCache[k];
      }
    }
    let changed = false;
    for (const k of Object.keys(this.cache)) {
      if (k.startsWith(prefix)) {
        delete this.cache[k];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  public createSupabaseStorageAdapter(): SupportedStorage {
    return {
      getItem: (key: string) => this.get(`sb:${key}`),
      setItem: (key: string, value: string) =>
        this.set(`sb:${key}`, value, { disallowFallbackDisk: true }),
      removeItem: (key: string) => this.remove(`sb:${key}`),
    };
  }
}

export class SyncEngine {
  private readonly repo: VaultRepository;
  private readonly vaultCrypto: VaultCrypto;
  private readonly mediaDir: string;
  private readonly mediaManager: SyncMediaManager;
  private readonly secureStore: LocalSecureStore;
  private readonly callbacks: SyncEngineCallbacks;
  private readonly isPackaged: boolean;
  private readonly appVersion: string;
  private readonly kdfIterations?: number;
  private readonly disableTimers: boolean;
  private readonly disableRealtime: boolean;
  private readonly openExternal?: (url: string) => Promise<void> | void;

  private client: SupabaseClient | null = null;
  private googleAuthInFlight = false;
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeConnected = false;
  private realtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeReconnectAttempt = 0;

  private deviceId: string;
  private deviceName: string;
  private state: SyncStateKind = 'signed_out';
  private email: string | null = null;
  private userId: string | null = null;
  private dek: Buffer | null = null;
  private needsEnvelopeVerification = false;
  private lastSyncAt: number | null = null;
  private lastReconcileAt: number | null = null;
  private lastError: string | null = null;
  private devices: SyncDeviceInfo[] = [];
  private disabledOptionalEntityTypes = new Set<SyncEntityType>();

  private authGeneration = 0;
  private inFlightSync: Promise<SyncActionResult> | null = null;
  private pendingResync = false;
  private pendingFullReconcile = false;
  private completedFullReconcileSeq = 0;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: SyncEngineOptions) {
    this.repo = opts.repo;
    this.vaultCrypto = opts.vaultCrypto;
    this.mediaDir = opts.mediaDir;
    this.mediaManager = new SyncMediaManager(opts.mediaDir, opts.repo);
    this.isPackaged = Boolean(opts.isPackaged);
    this.secureStore = new LocalSecureStore(opts.dataDir, opts.safeStorage, this.isPackaged);
    this.callbacks = opts.callbacks ?? {};
    this.appVersion = opts.appVersion ?? APP_VERSION;
    this.kdfIterations = opts.kdfIterationsOverride;
    this.disableTimers = Boolean(opts.disableTimers);
    this.disableRealtime = Boolean(opts.disableRealtime);
    this.openExternal = opts.openExternal;

    let storedDeviceId = this.repo.getSyncState('device_id');
    if (!storedDeviceId) {
      storedDeviceId = crypto.randomUUID();
      this.repo.setSyncState('device_id', storedDeviceId);
    }
    this.deviceId = storedDeviceId;
    this.repo.setLocalDeviceId(this.deviceId);
    this.deviceName =
      opts.deviceName ||
      this.repo.getSyncState('device_name') ||
      os.hostname() ||
      'Kapsula Desktop';
    const savedLastSync = this.repo.getSyncState('last_sync_at');
    this.lastSyncAt = savedLastSync ? Number(savedLastSync) || null : null;
    const savedLastReconcile = this.repo.getSyncState('last_reconcile_at');
    this.lastReconcileAt = savedLastReconcile ? Number(savedLastReconcile) || null : null;

    this.repo.setMutationListener(() => {
      this.scheduleDirtyPush();
    });
    setSyncCryptoLocale(this.repo.getLocale());
  }

  public setLocale(locale: AppLocale): void {
    setSyncCryptoLocale(locale);
  }

  private get isEn(): boolean {
    return this.repo.getLocale() === 'en';
  }

  private formatSyncErr(err: unknown): string {
    return translateSyncError(err, this.repo.getLocale());
  }

  private getMinKdfIterations(): number {
    return this.kdfIterations ? Math.min(this.kdfIterations, SYNC_MIN_KDF_ITERATIONS) : SYNC_MIN_KDF_ITERATIONS;
  }

  private getServerConfig(): { url: string; key: string; isCustom: boolean } {
    const customUrl = this.repo.getSyncState('custom_supabase_url')?.trim() || '';
    const customKey = this.secureStore.get('custom_supabase_key')?.trim() || '';
    if (customUrl && customKey) {
      return { url: customUrl, key: customKey, isCustom: true };
    }
    return {
      url: DEFAULT_SYNC_SUPABASE_URL,
      key: DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
      isCustom: false,
    };
  }

  public getSupabaseBaseUrl(): string {
    return this.getServerConfig().url;
  }

  public getSupabasePublishableKey(): string {
    return this.getServerConfig().key;
  }

  public async getActiveAccessToken(): Promise<string | null> {
    if (this.disposed) return null;
    try {
      const client = this.ensureClient();
      const { data, error } = await client.auth.getSession();
      if (error || !data.session?.access_token) {
        return null;
      }
      const expiresAtSec = data.session.expires_at ?? 0;
      if (expiresAtSec > 0 && expiresAtSec * 1000 < Date.now() + 60_000) {
        try {
          const refreshed = await client.auth.refreshSession();
          if (!refreshed.error && refreshed.data.session?.access_token) {
            return refreshed.data.session.access_token;
          }
        } catch {
          // Fall back to existing access token if refresh failed temporarily
        }
      }
      return data.session.access_token;
    } catch {
      return null;
    }
  }

  private ensureClient(): SupabaseClient {
    if (this.client) return this.client;
    const { url, key } = this.getServerConfig();
    this.client = createClient(url, key, {
      auth: {
        storage: this.secureStore.createSupabaseStorageAdapter(),
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    });
    return this.client;
  }

  private resetClient(): void {
    this.teardownRealtime();
    try {
      this.client?.auth?.stopAutoRefresh?.();
    } catch {
      // ignore
    }
    this.client = null;
  }

  private setDek(next: Buffer | null): void {
    if (this.dek && this.dek !== next) {
      this.dek.fill(0);
    }
    this.dek = next;
  }

  public getStatus(): SyncStatus {
    const cfg = this.getServerConfig();
    return {
      state: this.state,
      email: this.email,
      userId: this.userId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      lastSyncAt: this.lastSyncAt,
      pendingCount: this.repo.countDirtyEntities(),
      syncedRecordsCount: this.repo.countSyncableRecords(),
      realtimeConnected: this.realtimeConnected,
      hasCustomServer: cfg.isCustom,
      supabaseUrl: cfg.url,
      error: this.lastError,
      devices: this.devices,
      hasRecoveryKeyBackupHint: this.repo.getSyncState('recovery_key_saved') === '1',
      lastReconcileAt: this.lastReconcileAt,
      failedDirtyCount: this.repo.countFailedDirtyEntities(),
    };
  }

  private emitStatus(): void {
    if (this.disposed) return;
    this.callbacks.onStatusChanged?.(this.getStatus());
  }

  public async initialize(): Promise<SyncStatus> {
    try {
      const client = this.ensureClient();
      const { data, error } = await client.auth.getSession();
      if (error || !data.session?.user) {
        const pendingEmail = this.repo.getSyncState('pending_confirm_email');
        if (pendingEmail) {
          this.email = pendingEmail;
          this.state = 'awaiting_email_confirm';
        } else {
          this.state = 'signed_out';
        }
        this.emitStatus();
        return this.getStatus();
      }

      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? null;
      this.repo.deleteSyncState('pending_confirm_email');

      await this.resolveKeyStateAfterAuth();

      if (this.dek) {
        this.startBackgroundLoops();
        void this.syncNow().catch(() => {});
      }
    } catch (err) {
      if (isNetworkLikeError(err)) {
        const cachedUserId = this.repo.getSyncState('last_user_id');
        const cachedEmail = this.repo.getSyncState('last_user_email');
        const cachedDek = cachedUserId ? this.loadCachedDek(cachedUserId) : null;
        if (cachedUserId && cachedDek) {
          this.userId = cachedUserId;
          this.email = cachedEmail;
          this.setDek(cachedDek);
          this.needsEnvelopeVerification = true;
          this.state = 'offline';
          this.lastError = null;
          this.startBackgroundLoops();
        } else {
          this.state = 'offline';
          this.lastError = this.formatSyncErr(err);
        }
      } else {
        this.state = 'signed_out';
      }
      this.emitStatus();
    }
    return this.getStatus();
  }

  private loadCachedDek(userId: string): Buffer | null {
    const raw = this.secureStore.get(`dek:${userId}`);
    if (!raw) return null;
    try {
      const buf = Buffer.from(raw, 'base64');
      return buf.length === 32 ? buf : null;
    } catch {
      return null;
    }
  }

  private saveCachedDek(userId: string, dek: Buffer): void {
    // In packaged production builds, never persist DEK to disk without OS safeStorage protection
    if (this.isPackaged && !this.secureStore.isOsProtected()) {
      return;
    }
    try {
      this.secureStore.set(`dek:${userId}`, dek.toString('base64'), {
        requireOsProtection: this.isPackaged,
      });
    } catch {
      // Keep DEK in memory for this session if OS keychain access was denied
    }
  }

  private clearCachedDek(userId: string | null): void {
    if (userId) {
      this.secureStore.remove(`dek:${userId}`);
    }
  }

  private async fetchRemoteEnvelope(userId: string): Promise<SyncKeyEnvelopeRow | null> {
    const client = this.ensureClient();
    const { data, error } = await client
      .from('sync_key_envelopes')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    return (data as SyncKeyEnvelopeRow | null) ?? null;
  }

  private async resolveKeyStateAfterAuth(): Promise<void> {
    if (!this.userId) return;
    this.repo.setSyncState('last_user_id', this.userId);
    this.repo.setSyncState('last_data_owner_id', this.userId);
    if (this.email) this.repo.setSyncState('last_user_email', this.email);

    const remoteEnvelope = await this.fetchRemoteEnvelope(this.userId);
    if (!remoteEnvelope) {
      this.setDek(null);
      this.needsEnvelopeVerification = false;
      this.state = 'needs_passphrase_setup';
      this.lastError = null;
      this.emitStatus();
      return;
    }

    const cached = this.dek ?? this.loadCachedDek(this.userId);
    if (cached && verifyKeyCheckToken(cached, this.userId, remoteEnvelope.key_check_token)) {
      this.setDek(cached);
      this.needsEnvelopeVerification = false;
      this.ensureInitialEnqueueForUser(this.userId);
      this.state = 'synced';
      this.lastError = null;
      this.emitStatus();
      return;
    }

    this.clearCachedDek(this.userId);
    this.setDek(null);
    this.needsEnvelopeVerification = false;
    this.state = 'needs_passphrase_unlock';
    this.lastError = null;
    this.emitStatus();
  }

  private wipeLocalUserData(): void {
    this.repo.wipeAllUserData();
    try {
      if (this.mediaDir && fs.existsSync(this.mediaDir)) {
        for (const entry of fs.readdirSync(this.mediaDir, { withFileTypes: true })) {
          if (entry.isFile()) {
            try {
              fs.unlinkSync(path.join(this.mediaDir, entry.name));
            } catch {
              // ignore individual unlink failure
            }
          }
        }
      }
    } catch {
      // ignore missing mediaDir
    }
    this.vaultCrypto.resetForAccountWipe();
    this.callbacks.onOrbitsChanged?.();
    this.callbacks.onBoardsChanged?.();
    this.callbacks.onCalendarChanged?.();
    this.callbacks.onBatchSynced?.();
  }

  private resetCursorOnAccountSwitch(nextUserId: string): void {
    const prevOwnerId =
      this.repo.getSyncState('last_data_owner_id') || this.repo.getSyncState('last_user_id');
    if (prevOwnerId && prevOwnerId !== nextUserId) {
      // Hard cross-account isolation: wipe previous owner's local data before binding nextUserId
      this.wipeLocalUserData();
      this.repo.deleteSyncState('last_cursor');
      this.repo.deleteSyncState('initial_enqueued_user');
      this.repo.clearSyncBlobCache();
    }
  }

  public async setServerConfig(input: SyncServerConfigInput | null): Promise<SyncStatus> {
    let normalizedUrl = '';
    let cleanKey = '';
    if (input && (input.supabaseUrl.trim() || input.supabasePublishableKey.trim())) {
      normalizedUrl = input.supabaseUrl.trim().replace(/\/+$/, '');
      cleanKey = input.supabasePublishableKey.trim();
      let parsed: URL;
      try {
        parsed = new URL(normalizedUrl);
      } catch {
        throw new Error(
          this.isEn ? 'Invalid sync server URL' : 'Некорректный адрес сервера Supabase'
        );
      }
      if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        isPrivateOrLocalHostname(parsed.hostname) ||
        parsed.username ||
        parsed.password ||
        /\s/.test(normalizedUrl)
      ) {
        throw new Error(
          this.isEn
            ? 'Sync server URL must be a valid public HTTPS address'
            : 'Адрес сервера синхронизации должен быть публичным HTTPS-адресом'
        );
      }
      if (cleanKey.length < 16) {
        throw new Error(
          this.isEn
            ? 'Enter a valid public project key'
            : 'Укажи корректный публичный ключ проекта Supabase'
        );
      }
    }

    await this.signOut({ preserveUnownedOfflineData: true });
    if (!normalizedUrl || !cleanKey) {
      this.repo.deleteSyncState('custom_supabase_url');
      this.secureStore.remove('custom_supabase_key');
    } else {
      this.repo.setSyncState('custom_supabase_url', normalizedUrl);
      this.secureStore.set('custom_supabase_key', cleanKey);
    }
    this.resetClient();
    this.emitStatus();
    return this.getStatus();
  }

  public async signUp(email: string, password: string): Promise<SyncAuthResult> {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return {
        ok: false,
        error: this.isEn ? 'Enter a valid email address' : 'Введи корректный адрес почты',
        status: this.getStatus(),
      };
    }
    if (password.length < 6) {
      return {
        ok: false,
        error: this.isEn
          ? 'Password must be at least 6 characters'
          : 'Пароль должен содержать не менее 6 символов',
        status: this.getStatus(),
      };
    }

    try {
      this.authGeneration += 1;
      const client = this.ensureClient();
      const { data, error } = await client.auth.signUp({
        email: cleanEmail,
        password,
      });
      if (error) {
        const msg = this.formatSyncErr(error);
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      if (!data.session) {
        this.email = cleanEmail;
        this.userId = data.user?.id ?? null;
        this.state = 'awaiting_email_confirm';
        this.lastError = null;
        this.repo.setSyncState('pending_confirm_email', cleanEmail);
        this.emitStatus();
        return {
          ok: true,
          needsEmailConfirmation: true,
          status: this.getStatus(),
        };
      }

      this.resetCursorOnAccountSwitch(data.session.user.id);
      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? cleanEmail;
      this.repo.deleteSyncState('pending_confirm_email');
      await this.resolveKeyStateAfterAuth();

      if (this.dek) {
        this.startBackgroundLoops();
        void this.syncNow().catch(() => {});
      }

      return {
        ok: true,
        needsPassphraseSetup: this.state === 'needs_passphrase_setup',
        needsPassphraseUnlock: this.state === 'needs_passphrase_unlock',
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signIn(email: string, password: string): Promise<SyncAuthResult> {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      return {
        ok: false,
        error: this.isEn ? 'Enter email and password' : 'Введи почту и пароль',
        status: this.getStatus(),
      };
    }

    try {
      this.authGeneration += 1;
      const client = this.ensureClient();
      const { data, error } = await client.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error || !data.session?.user) {
        const msg = this.formatSyncErr(
          error ?? (this.isEn ? 'Sign-in failed' : 'Не удалось войти')
        );
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      this.resetCursorOnAccountSwitch(data.session.user.id);
      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? cleanEmail;
      this.repo.deleteSyncState('pending_confirm_email');
      await this.resolveKeyStateAfterAuth();

      if (this.dek) {
        this.startBackgroundLoops();
        void this.syncNow().catch(() => {});
      }

      return {
        ok: true,
        needsPassphraseSetup: this.state === 'needs_passphrase_setup',
        needsPassphraseUnlock: this.state === 'needs_passphrase_unlock',
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signInWithGoogle(opts?: {
    openExternal?: (url: string) => Promise<void> | void;
    timeoutMs?: number;
  }): Promise<SyncAuthResult> {
    if (this.googleAuthInFlight) {
      return {
        ok: false,
        error: this.isEn
          ? 'Google sign-in window is already open in your browser'
          : 'Окно входа через Google уже открыто в браузере',
        status: this.getStatus(),
      };
    }

    const openExternalFn = opts?.openExternal ?? this.openExternal;
    if (!openExternalFn) {
      return {
        ok: false,
        error: this.isEn
          ? 'Could not open browser for Google sign-in'
          : 'Не удалось открыть браузер для входа через Google',
        status: this.getStatus(),
      };
    }

    const timeoutMs = opts?.timeoutMs ?? 180_000;
    this.googleAuthInFlight = true;
    this.lastError = null;

    let server: http.Server | null = null;
    try {
      const client = this.ensureClient();
      const callbackPromise = new Promise<{ code: string; redirectTo: string }>(
        (resolve, reject) => {
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            fn();
          };

          const timeout = setTimeout(() => {
            finish(() =>
              reject(
                new Error(
                  this.isEn
                    ? 'Google sign-in timed out — please try again'
                    : 'Время ожидания входа через Google истекло — попробуй ещё раз'
                )
              )
            );
          }, timeoutMs);

          const isEn = this.isEn;
          const successHtml = isEn
            ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kapsula</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#161614;color:#f4f3ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px;border-radius:16px;background:#20201d;border:1px solid rgba(255,255,255,0.08)"><h2 style="margin:0 0 10px;font-size:20px">Signed in to Kapsula</h2><p style="margin:0;color:#b6b4ad;font-size:14px;line-height:1.5">You can close this tab and return to the app.</p></div></body></html>'
            : '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Kapsula</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#161614;color:#f4f3ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px;border-radius:16px;background:#20201d;border:1px solid rgba(255,255,255,0.08)"><h2 style="margin:0 0 10px;font-size:20px">Вход в Kapsula выполнен</h2><p style="margin:0;color:#b6b4ad;font-size:14px;line-height:1.5">Можешь закрыть вкладку и вернуться в приложение.</p></div></body></html>';
          const errorHtml = isEn
            ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kapsula</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#161614;color:#f4f3ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px;border-radius:16px;background:#20201d;border:1px solid rgba(255,255,255,0.08)"><h2 style="margin:0 0 10px;font-size:20px">Sign-in not completed</h2><p style="margin:0;color:#b6b4ad;font-size:14px;line-height:1.5">Close this tab, return to Kapsula, and try again.</p></div></body></html>'
            : '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Kapsula</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#161614;color:#f4f3ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:32px;border-radius:16px;background:#20201d;border:1px solid rgba(255,255,255,0.08)"><h2 style="margin:0 0 10px;font-size:20px">Вход не завершён</h2><p style="margin:0;color:#b6b4ad;font-size:14px;line-height:1.5">Можешь закрыть вкладку, вернуться в Kapsula и попробовать снова.</p></div></body></html>';

          let redirectTo = '';
          const callbackState = crypto.randomBytes(24).toString('hex');

          server = http.createServer((req, res) => {
            try {
              const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
              if (reqUrl.pathname !== '/callback') {
                res.writeHead(204);
                res.end();
                return;
              }
              const providedState = reqUrl.searchParams.get('kapsula_state') || '';
              const stateBufA = Buffer.from(providedState, 'utf8');
              const stateBufB = Buffer.from(callbackState, 'utf8');
              if (
                stateBufA.length !== stateBufB.length ||
                !crypto.timingSafeEqual(stateBufA, stateBufB)
              ) {
                res.writeHead(400);
                res.end();
                return;
              }
              const errParam = reqUrl.searchParams.get('error');
              const errDesc = reqUrl.searchParams.get('error_description');
              const code = reqUrl.searchParams.get('code');

              if (errParam || !code) {
                res.writeHead(200, {
                  'Content-Type': 'text/html; charset=utf-8',
                  Connection: 'close',
                });
                res.end(errorHtml);
                const msg =
                  errParam === 'access_denied'
                    ? isEn
                      ? 'Google sign-in was cancelled'
                      : 'Вход через Google был отменён'
                    : this.formatSyncErr(
                        errDesc ||
                          errParam ||
                          (isEn
                            ? 'Could not complete Google sign-in'
                            : 'Не удалось завершить вход через Google')
                      );
                finish(() => reject(new Error(msg)));
                return;
              }

              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                Connection: 'close',
              });
              res.end(successHtml);
              finish(() => resolve({ code, redirectTo }));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });

          server.on('error', () => {
            finish(() =>
              reject(
                new Error(
                  isEn
                    ? 'Could not open local address for Google sign-in'
                    : 'Не удалось открыть локальный адрес для входа через Google'
                )
              )
            );
          });

          server.listen(0, '127.0.0.1', () => {
            const addr = server?.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            if (!port) {
              finish(() =>
                reject(
                  new Error(
                    isEn
                      ? 'Could not open local port for sign-in'
                      : 'Не удалось открыть локальный порт для входа'
                  )
                )
              );
              return;
            }
            redirectTo = `http://127.0.0.1:${port}/callback?kapsula_state=${callbackState}`;

            void (async () => {
              try {
                const { data, error } = await client.auth.signInWithOAuth({
                  provider: 'google',
                  options: {
                    redirectTo,
                    skipBrowserRedirect: true,
                    queryParams: { prompt: 'select_account' },
                  },
                });
                if (error || !data?.url) {
                  finish(() =>
                    reject(
                      new Error(
                        this.formatSyncErr(
                          error ??
                            (isEn
                              ? 'Could not start Google sign-in'
                              : 'Не удалось открыть вход через Google')
                        )
                      )
                    )
                  );
                  return;
                }
                const parsedOAuthUrl = new URL(data.url);
                if (parsedOAuthUrl.protocol !== 'https:') {
                  throw new Error(
                    isEn
                      ? 'Unsupported OAuth redirect address'
                      : 'Неподдерживаемый адрес входа'
                  );
                }
                await openExternalFn(parsedOAuthUrl.toString());
              } catch (openErr) {
                finish(() => reject(new Error(this.formatSyncErr(openErr))));
              }
            })();
          });
        }
      );

      const { code } = await callbackPromise;
      const { data: exData, error: exErr } = await client.auth.exchangeCodeForSession(code);
      if (exErr || !exData.session?.user) {
        const msg = this.formatSyncErr(
          exErr ??
            (this.isEn
              ? 'Could not confirm Google sign-in'
              : 'Не удалось подтвердить вход через Google')
        );
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      this.authGeneration += 1;
      this.resetCursorOnAccountSwitch(exData.session.user.id);
      this.userId = exData.session.user.id;
      this.email = exData.session.user.email ?? null;
      this.repo.deleteSyncState('pending_confirm_email');
      await this.resolveKeyStateAfterAuth();

      if (this.dek) {
        this.startBackgroundLoops();
        void this.syncNow().catch(() => {});
      }

      return {
        ok: true,
        needsPassphraseSetup: this.state === 'needs_passphrase_setup',
        needsPassphraseUnlock: this.state === 'needs_passphrase_unlock',
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    } finally {
      this.googleAuthInFlight = false;
      try {
        (server as http.Server | null)?.closeAllConnections?.();
      } catch {
        // ignore
      }
      try {
        (server as http.Server | null)?.close();
      } catch {
        // ignore
      }
    }
  }

  public async setupPassphrase(passphrase: string): Promise<SyncSetupPassphraseResult> {
    if (!this.userId) {
      return {
        ok: false,
        error: this.isEn ? 'Sign in to your sync account first' : 'Сначала войди в аккаунт синхронизации',
        status: this.getStatus(),
      };
    }

    try {
      const existing = await this.fetchRemoteEnvelope(this.userId);
      if (existing) {
        this.state = 'needs_passphrase_unlock';
        this.emitStatus();
        return {
          ok: false,
          error: this.isEn
            ? 'An encryption key already exists for this account on another device — enter your existing passphrase'
            : 'Ключ шифрования для этого аккаунта уже создан на другом устройстве — введи существующую фразу',
          status: this.getStatus(),
        };
      }

      setSyncCryptoLocale(this.repo.getLocale());
      const { dek, recoveryKey, envelope } = await createKeyEnvelope(
        this.userId,
        passphrase,
        this.kdfIterations
      );

      const client = this.ensureClient();
      const { error } = await client.from('sync_key_envelopes').insert(envelope);
      if (error) {
        dek.fill(0);
        const low = (error.message || '').toLowerCase();
        if (low.includes('duplicate') || low.includes('23505')) {
          this.state = 'needs_passphrase_unlock';
          this.emitStatus();
          return {
            ok: false,
            error: this.isEn
              ? 'An encryption key was just created on another device — enter your existing passphrase'
              : 'Ключ шифрования только что создан на другом устройстве — введи существующую фразу',
            status: this.getStatus(),
          };
        }
        throw new Error(error.message);
      }

      this.setDek(dek);
      this.needsEnvelopeVerification = false;
      this.saveCachedDek(this.userId, dek);
      this.ensureInitialEnqueueForUser(this.userId);
      this.lastError = null;
      this.state = 'synced';
      this.emitStatus();

      this.startBackgroundLoops();
      const syncRes = await this.syncNow();

      return {
        ok: true,
        recoveryKey,
        initialSyncOk: syncRes.ok,
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async regenerateRecoveryKey(): Promise<SyncSetupPassphraseResult> {
    if (!this.userId || !this.dek) {
      return {
        ok: false,
        error: this.isEn
          ? 'Connect and unlock cloud sync on this device first'
          : 'Сначала подключи и расшифруй синхронизацию на этом устройстве',
        status: this.getStatus(),
      };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return {
          ok: false,
          error: this.isEn ? 'Encryption key not found in cloud' : 'Ключ шифрования не найден в облаке',
          status: this.getStatus(),
        };
      }

      const { recoveryKey, envelope: updated } = rewrapEnvelopeRecoveryKey(
        this.userId,
        this.dek,
        envelope
      );
      const client = this.ensureClient();
      const { error } = await client
        .from('sync_key_envelopes')
        .update({
          wrapped_dek_recovery: updated.wrapped_dek_recovery,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', this.userId);
      if (error) throw new Error(error.message);

      this.repo.setSyncState('recovery_key_saved', '1');
      this.lastError = null;
      this.emitStatus();
      return {
        ok: true,
        recoveryKey,
        status: this.getStatus(),
      };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async unlockWithPassphrase(passphrase: string): Promise<SyncActionResult> {
    if (!this.userId) {
      return {
        ok: false,
        error: this.isEn ? 'Sign in to your sync account first' : 'Сначала войди в аккаунт синхронизации',
        status: this.getStatus(),
      };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        this.state = 'needs_passphrase_setup';
        this.emitStatus();
        return {
          ok: false,
          error: this.isEn
            ? 'No encryption passphrase has been set for this account yet'
            : 'Для этого аккаунта ещё не задана секретная фраза',
          status: this.getStatus(),
        };
      }

      setSyncCryptoLocale(this.repo.getLocale());
      const dek = await unwrapDekWithPassphrase(
        this.userId,
        passphrase,
        envelope,
        this.getMinKdfIterations()
      );
      this.setDek(dek);
      this.needsEnvelopeVerification = false;
      this.saveCachedDek(this.userId, dek);
      this.ensureInitialEnqueueForUser(this.userId);
      this.lastError = null;
      this.state = 'synced';
      this.emitStatus();

      this.startBackgroundLoops();
      return await this.syncNow();
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async unlockWithRecoveryKey(
    recoveryKey: string,
    newPassphrase?: string
  ): Promise<SyncActionResult> {
    if (!this.userId) {
      return {
        ok: false,
        error: this.isEn ? 'Sign in to your sync account first' : 'Сначала войди в аккаунт синхронизации',
        status: this.getStatus(),
      };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return {
          ok: false,
          error: this.isEn
            ? 'Encryption key for this account has not been created yet'
            : 'Ключ шифрования для этого аккаунта ещё не создан',
          status: this.getStatus(),
        };
      }

      setSyncCryptoLocale(this.repo.getLocale());
      const dek = unwrapDekWithRecoveryKey(this.userId, recoveryKey, envelope);

      if (newPassphrase && newPassphrase.trim().length > 0) {
        const updated = await rewrapEnvelopePassphrase(
          this.userId,
          dek,
          newPassphrase,
          envelope,
          this.kdfIterations
        );
        const client = this.ensureClient();
        const { error } = await client
          .from('sync_key_envelopes')
          .update({
            kdf_alg: updated.kdf_alg,
            kdf_iterations: updated.kdf_iterations,
            kdf_salt: updated.kdf_salt,
            wrapped_dek_passphrase: updated.wrapped_dek_passphrase,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', this.userId);
        if (error) {
          dek.fill(0);
          throw new Error(error.message);
        }
      }

      this.setDek(dek);
      this.needsEnvelopeVerification = false;
      this.saveCachedDek(this.userId, dek);
      this.ensureInitialEnqueueForUser(this.userId);
      this.lastError = null;
      this.state = 'synced';
      this.emitStatus();

      this.startBackgroundLoops();
      return await this.syncNow();
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async changePassphrase(
    currentPassphrase: string,
    newPassphrase: string
  ): Promise<SyncActionResult> {
    if (!this.userId) {
      return {
        ok: false,
        error: this.isEn ? 'Sign in to your sync account first' : 'Сначала войди в аккаунт синхронизации',
        status: this.getStatus(),
      };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return {
          ok: false,
          error: this.isEn ? 'Encryption key not found' : 'Ключ шифрования не найден',
          status: this.getStatus(),
        };
      }
      setSyncCryptoLocale(this.repo.getLocale());
      const dek = await unwrapDekWithPassphrase(
        this.userId,
        currentPassphrase,
        envelope,
        this.getMinKdfIterations()
      );
      const updated = await rewrapEnvelopePassphrase(
        this.userId,
        dek,
        newPassphrase,
        envelope,
        this.kdfIterations
      );
      const client = this.ensureClient();
      const { error } = await client
        .from('sync_key_envelopes')
        .update({
          kdf_alg: updated.kdf_alg,
          kdf_iterations: updated.kdf_iterations,
          kdf_salt: updated.kdf_salt,
          wrapped_dek_passphrase: updated.wrapped_dek_passphrase,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', this.userId);
      if (error) {
        dek.fill(0);
        throw new Error(error.message);
      }

      this.setDek(dek);
      this.saveCachedDek(this.userId, dek);
      this.lastError = null;
      this.emitStatus();
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signOut(opts?: { preserveUnownedOfflineData?: boolean }): Promise<SyncStatus> {
    this.authGeneration += 1;
    this.pendingResync = false;
    this.stopBackgroundLoops();
    const prevUserId = this.userId;
    const prevOwnerId =
      this.repo.getSyncState('last_data_owner_id') || this.repo.getSyncState('last_user_id');
    try {
      if (this.client) {
        await this.client.auth.signOut();
      }
    } catch {
      // Ignore network failure during local signOut
    }
    this.clearCachedDek(prevUserId);
    // Always purge persisted Supabase session tokens + local user data on sign-out (Decision #2),
    // preserving unowned offline data only when switching custom server URL prior to any account sign-in
    this.secureStore.removeByPrefix('sb:');
    if (!(opts?.preserveUnownedOfflineData && !prevUserId && !prevOwnerId)) {
      this.wipeLocalUserData();
    }
    this.disabledOptionalEntityTypes.clear();
    this.setDek(null);
    this.needsEnvelopeVerification = false;
    this.userId = null;
    this.email = null;
    this.lastSyncAt = null;
    this.lastReconcileAt = null;
    this.lastError = null;
    this.devices = [];
    this.state = 'signed_out';
    this.emitStatus();
    return this.getStatus();
  }

  public async deleteAccount(): Promise<{ ok: boolean; error?: string; status: SyncStatus }> {
    const token = await this.getActiveAccessToken();
    if (!token || !this.userId) {
      return {
        ok: false,
        error: this.isEn
          ? 'Sign in to your cloud account first'
          : 'Сначала войди в облачный аккаунт',
        status: this.getStatus(),
      };
    }

    try {
      const resp = await fetch(`${this.getSupabaseBaseUrl()}/functions/v1/delete-account`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: this.getSupabasePublishableKey(),
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!resp.ok || !json?.ok) {
        const msg =
          json?.error ||
          (this.isEn ? 'Could not delete cloud account' : 'Не удалось удалить аккаунт в облаке');
        return { ok: false, error: msg, status: this.getStatus() };
      }
      await this.signOut();
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      return { ok: false, error: this.formatSyncErr(err), status: this.getStatus() };
    }
  }

  public handleSystemResume(): void {
    if (this.disposed || !this.userId || !this.dek) return;
    if (!this.disableRealtime && !this.realtimeConnected) {
      this.teardownRealtime();
      this.subscribeRealtime(this.userId);
    }
    void this.syncNow().catch(() => {});
  }

  private ensureInitialEnqueueForUser(userId: string): void {
    if (this.repo.getSyncState('initial_enqueued_user') !== userId) {
      this.repo.enqueueAllEntitiesForInitialSync();
      this.repo.setSyncState('initial_enqueued_user', userId);
    }
  }

  private scheduleDirtyPush(): void {
    if (this.disposed || this.disableTimers) return;
    if (!this.userId || !this.dek) return;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      if (this.disposed) return;
      void this.syncNow().catch(() => {});
    }, DIRTY_DEBOUNCE_MS);
    if (typeof this.dirtyTimer.unref === 'function') this.dirtyTimer.unref();
  }

  private startBackgroundLoops(): void {
    if (this.disposed) return;
    if (!this.disableTimers && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        if (this.userId && this.dek && !this.inFlightSync) {
          void this.syncNow().catch(() => {});
        }
      }, SYNC_POLL_INTERVAL_MS);
      if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    }
    if (!this.disableRealtime && this.userId && !this.realtimeChannel) {
      this.subscribeRealtime(this.userId);
    }
  }

  private stopBackgroundLoops(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    if (this.realtimeTimer) {
      clearTimeout(this.realtimeTimer);
      this.realtimeTimer = null;
    }
    if (this.realtimeReconnectTimer) {
      clearTimeout(this.realtimeReconnectTimer);
      this.realtimeReconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.teardownRealtime();
  }

  private scheduleRealtimeReconnect(userId: string): void {
    if (this.disposed || this.disableRealtime || this.userId !== userId || !this.dek) return;
    if (this.realtimeReconnectTimer) return;
    const delays = [3_000, 10_000, 30_000];
    const delay = delays[Math.min(this.realtimeReconnectAttempt, delays.length - 1)]!;
    this.realtimeReconnectAttempt += 1;
    this.realtimeReconnectTimer = setTimeout(() => {
      this.realtimeReconnectTimer = null;
      if (this.disposed || this.userId !== userId || !this.dek) return;
      this.teardownRealtime();
      this.subscribeRealtime(userId);
    }, delay);
    if (typeof this.realtimeReconnectTimer.unref === 'function') {
      this.realtimeReconnectTimer.unref();
    }
  }

  private subscribeRealtime(userId: string): void {
    try {
      const client = this.ensureClient();
      const channel = client
        .channel(`kapsula-sync-${userId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'sync_records',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            if (this.disposed || this.userId !== userId) return;
            const nextRow = payload.new as { device_id?: string } | null;
            if (nextRow?.device_id && nextRow.device_id === this.deviceId) {
              return;
            }
            if (this.realtimeTimer) clearTimeout(this.realtimeTimer);
            this.realtimeTimer = setTimeout(() => {
              this.realtimeTimer = null;
              if (this.disposed || this.userId !== userId) return;
              void this.syncNow().catch(() => {});
            }, REALTIME_DEBOUNCE_MS);
            if (typeof this.realtimeTimer.unref === 'function') this.realtimeTimer.unref();
          }
        )
        .subscribe((status) => {
          if (this.disposed || this.userId !== userId) return;
          if (status === 'SUBSCRIBED') {
            this.realtimeConnected = true;
            this.realtimeReconnectAttempt = 0;
            this.emitStatus();
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            this.realtimeConnected = false;
            this.emitStatus();
            this.scheduleRealtimeReconnect(userId);
          }
        });
      this.realtimeChannel = channel;
    } catch {
      this.realtimeConnected = false;
    }
  }

  private teardownRealtime(): void {
    this.realtimeConnected = false;
    if (this.realtimeChannel && this.client) {
      try {
        void this.client.removeChannel(this.realtimeChannel);
      } catch {
        // Ignore teardown errors
      }
    }
    this.realtimeChannel = null;
  }

  public async syncNow(opts?: { forceFullReconcile?: boolean }): Promise<SyncActionResult> {
    if (this.inFlightSync) {
      this.pendingResync = true;
      if (opts?.forceFullReconcile) {
        this.pendingFullReconcile = true;
      }
      return this.inFlightSync;
    }
    const gen = this.authGeneration;
    const run = this.executeSyncCycle(gen, opts).finally(() => {
      this.inFlightSync = null;
      if (this.pendingResync && !this.disposed && gen === this.authGeneration && this.userId && this.dek) {
        const nextFull = this.pendingFullReconcile;
        this.pendingResync = false;
        this.pendingFullReconcile = false;
        void this.syncNow(nextFull ? { forceFullReconcile: true } : undefined).catch(() => {});
      }
    });
    this.inFlightSync = run;
    return run;
  }

  /**
   * Performs a full reconciliation from cursor = 0: pulls all remote records & tombstones,
   * ensures every local tombstone is present remotely (with delete-wins clock-skew healing),
   * and stamps lastReconcileAt.
   */
  public async reconcileFull(): Promise<SyncStatus> {
    const startSeq = this.completedFullReconcileSeq;
    let queuedFull = false;
    while (this.inFlightSync) {
      if (!queuedFull && this.completedFullReconcileSeq === startSeq) {
        this.pendingResync = true;
        this.pendingFullReconcile = true;
        queuedFull = true;
      }
      await this.inFlightSync.catch(() => {});
    }
    if (!this.disposed && this.userId && this.dek && this.completedFullReconcileSeq === startSeq) {
      await this.syncNow({ forceFullReconcile: true });
    }
    return this.getStatus();
  }

  /**
   * Bounded best-effort flush used in app.on('before-quit') BEFORE dispose() so recent
   * deletes and edits created inside the dirty debounce window reach the cloud before exit.
   */
  public async flushNow(timeoutMs = 2500): Promise<void> {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    if (this.disposed || !this.userId || !this.dek) return;
    if (!this.inFlightSync && this.repo.countDirtyEntities() === 0) return;

    const flushWork = async () => {
      if (this.inFlightSync) {
        await this.inFlightSync.catch(() => {});
      }
      if (!this.disposed && this.userId && this.dek && this.repo.countDirtyEntities() > 0) {
        await this.syncNow().catch(() => {});
      }
    };

    await Promise.race([
      flushWork(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(100, timeoutMs));
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }

  public handleVaultUnlocked(): void {
    if (this.disposed || !this.userId || !this.dek) return;
    if (this.repo.getSyncState('pending_secret_reconcile') === '1') {
      this.repo.deleteSyncState('pending_secret_reconcile');
      void this.reconcileFull().catch(() => {});
      return;
    }
    if (this.repo.countDirtyEntities() > 0) {
      void this.syncNow().catch(() => {});
    }
  }

  private async upsertSyncRecordWithReturn(
    client: SupabaseClient,
    record: Record<string, unknown>
  ): Promise<{
    returnedRow: {
      server_seq?: number;
      updated_at?: number;
      sync_version?: number;
      deleted_at?: number | null;
      device_id?: string;
    } | null;
    selectSupported: boolean;
    error: { message: string; code?: string } | null;
  }> {
    const req = client
      .from('sync_records')
      .upsert(record, { onConflict: 'user_id,entity_type,entity_id' });

    const hasSelect = typeof (req as unknown as { select?: unknown })?.select === 'function';
    const res = hasSelect
      ? await (
          req as unknown as {
            select: (cols: string) => Promise<{
              data?: unknown;
              error: { message: string; code?: string } | null;
            }>;
          }
        ).select('server_seq, updated_at, sync_version, deleted_at, device_id')
      : await (req as unknown as Promise<{
          data?: unknown;
          error: { message: string; code?: string } | null;
        }>);

    if (res?.error) {
      return { returnedRow: null, selectSupported: hasSelect, error: res.error };
    }
    const rawData = res?.data;
    const row = Array.isArray(rawData)
      ? (rawData[0] as Record<string, unknown> | undefined)
      : rawData && typeof rawData === 'object'
        ? (rawData as Record<string, unknown>)
        : undefined;
    return {
      returnedRow: row
        ? {
            server_seq: typeof row.server_seq === 'number' ? row.server_seq : Number(row.server_seq ?? 0),
            updated_at: typeof row.updated_at === 'number' ? row.updated_at : Number(row.updated_at ?? 0),
            sync_version:
              typeof row.sync_version === 'number' ? row.sync_version : Number(row.sync_version ?? 1),
            deleted_at:
              row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
            device_id: typeof row.device_id === 'string' ? row.device_id : undefined,
          }
        : null,
      selectSupported: hasSelect,
      error: null,
    };
  }

  private async executeSyncCycle(
    gen: number,
    opts?: { forceFullReconcile?: boolean }
  ): Promise<SyncActionResult> {
    if (!this.userId || !this.dek) {
      return {
        ok: false,
        error:
          this.state === 'needs_passphrase_unlock'
            ? this.isEn
              ? 'Enter your encryption passphrase to start syncing'
              : 'Введи секретную фразу шифрования для запуска синхронизации'
            : this.isEn
              ? 'Cloud sync is not connected'
              : 'Синхронизация не подключена',
        status: this.getStatus(),
      };
    }

    const cancelledMsg = this.isEn ? 'Sync cancelled' : 'Синхронизация отменена';
    setSyncCryptoLocale(this.repo.getLocale());

    const client = this.ensureClient();
    const userId = this.userId;
    const dek = Buffer.from(this.dek); // snapshot copy so signOut zeroing cannot corrupt mid-flight crypto

    this.state = 'syncing';
    this.lastError = null;
    this.emitStatus();

    let pushed = 0;
    let pulled = 0;
    let blobsUploaded = 0;
    let blobsDownloaded = 0;
    const recordErrors: unknown[] = [];

    try {
      // If we booted offline with cached DEK, verify against remote envelope first once online
      if (this.needsEnvelopeVerification) {
        const remoteEnv = await this.fetchRemoteEnvelope(userId);
        if (gen !== this.authGeneration || this.disposed) {
          return { ok: false, error: cancelledMsg, status: this.getStatus() };
        }
        if (!remoteEnv) {
          this.setDek(null);
          this.state = 'needs_passphrase_setup';
          this.emitStatus();
          return {
            ok: false,
            error: this.isEn ? 'Set an encryption passphrase' : 'Задай секретную фразу шифрования',
            status: this.getStatus(),
          };
        }
        if (!verifyKeyCheckToken(dek, userId, remoteEnv.key_check_token)) {
          this.clearCachedDek(userId);
          this.setDek(null);
          this.state = 'needs_passphrase_unlock';
          this.emitStatus();
          return {
            ok: false,
            error: this.isEn
              ? 'Encryption key changed — enter your current passphrase'
              : 'Ключ шифрования изменился — введи актуальную секретную фразу',
            status: this.getStatus(),
          };
        }
        this.needsEnvelopeVerification = false;
      }

      // 1. ALWAYS PULL REMOTE DELTAS FIRST (prevents stale offline device from overwriting newer cloud state!)
      const savedCursor = Number(this.repo.getSyncState('last_cursor') || '0') || 0;
      const autoReconcileDue =
        savedCursor > 0 &&
        (!this.lastReconcileAt || Date.now() - this.lastReconcileAt >= RECONCILE_INTERVAL_MS);
      const isFullReconcile = Boolean(opts?.forceFullReconcile || autoReconcileDue);
      const startFromZero = isFullReconcile || savedCursor === 0;

      // Overlap rewind (`lastCursor - 25`) closes Postgres MVCC out-of-order server_seq commit gaps safely (idempotent via LWW)
      let queryCursor = startFromZero ? 0 : Math.max(0, savedCursor - PULL_SEQ_OVERLAP);
      let highWaterCursor = savedCursor;

      let orbitsTouched = false;
      let boardsTouched = false;
      let calendarTouched = false;
      let workspacePrefsTouched = false;
      const upsertedItems: VaultItem[] = [];
      const deletedItemIds: string[] = [];
      const freedMediaAll = new Set<string>();
      const remoteSeenDuringFull = new Map<
        string,
        { updated_at: number; deleted_at: number | null; sync_version: number; device_id: string; purged?: boolean }
      >();
      const failedPullKeys = new Set<string>();
      let cursorBlockedByRowError = false;

      try {
        while (true) {
          if (gen !== this.authGeneration || this.disposed) {
            return { ok: false, error: cancelledMsg, status: this.getStatus() };
          }

          const { data: rows, error: pullErr } = await client
            .from('sync_records')
            .select('*')
            .eq('user_id', userId)
            .gt('server_seq', queryCursor)
            .order('server_seq', { ascending: true })
            .limit(PULL_PAGE_SIZE);

          if (pullErr) {
            throw new Error(pullErr.message);
          }
          const batch = (rows ?? []) as SyncRecordRow[];
          if (batch.length === 0) break;

          let pageMaxSeq = queryCursor;

          for (const row of batch) {
            if (gen !== this.authGeneration || this.disposed) {
              return { ok: false, error: cancelledMsg, status: this.getStatus() };
            }
            const nextSeq = Number(row.server_seq) || queryCursor;
            pageMaxSeq = Math.max(pageMaxSeq, nextSeq);

            if (isFullReconcile) {
              remoteSeenDuringFull.set(`${row.entity_type}:${row.entity_id}`, {
                updated_at: Number(row.updated_at ?? 0),
                deleted_at: row.deleted_at == null ? null : Number(row.deleted_at),
                sync_version: Number(row.sync_version ?? 1),
                device_id: row.device_id,
              });
            }

            if (row.device_id === this.deviceId) {
              const localStamp = this.repo.getEntitySyncStamp(row.entity_type, row.entity_id);
              const remoteUpdated = Number(row.updated_at ?? 0);
              const remoteVersion = Number(row.sync_version ?? 1);
              const remoteDeleted = row.deleted_at != null;
              const localHasSameOrNewer =
                localStamp !== null &&
                localStamp.updatedAt >= remoteUpdated &&
                localStamp.syncVersion >= remoteVersion &&
                (localStamp.deletedAt != null) === remoteDeleted;
              if (localHasSameOrNewer) {
                if (!cursorBlockedByRowError && nextSeq > highWaterCursor) {
                  highWaterCursor = nextSeq;
                  this.repo.setSyncState('last_cursor', String(highWaterCursor));
                }
                continue;
              }
            }
            if (row.schema_version > SYNC_SCHEMA_VERSION) {
              // Skip future-version record safely without wedging the cursor
              if (!cursorBlockedByRowError && nextSeq > highWaterCursor) {
                highWaterCursor = nextSeq;
                this.repo.setSyncState('last_cursor', String(highWaterCursor));
              }
              continue;
            }

            try {
              const dl = await this.applyIncomingRecord(client, userId, dek, row, gen);
              if (isFullReconcile && dl.wasPurged) {
                const seen = remoteSeenDuringFull.get(`${row.entity_type}:${row.entity_id}`);
                if (seen) seen.purged = true;
              }
              blobsDownloaded += dl.blobsDownloaded;
              if (dl.freedMedia && dl.freedMedia.length > 0) {
                for (const f of dl.freedMedia) freedMediaAll.add(f);
              }
              if (dl.applied) {
                pulled++;
                if (row.entity_type === 'orbit') orbitsTouched = true;
                if (row.entity_type === 'focus_board') boardsTouched = true;
                if (row.entity_type === 'calendar_event') calendarTouched = true;
                if (row.entity_type === 'workspace_prefs') workspacePrefsTouched = true;
                if (dl.upsertedItem) upsertedItems.push(dl.upsertedItem);
                if (dl.deletedItemId) deletedItemIds.push(dl.deletedItemId);
              } else if (dl.localStrictlyNewer) {
                // Local state is strictly newer than stale cloud row — re-queue push to self-heal cloud!
                this.repo.markDirty(row.entity_type, row.entity_id);
              }
            } catch (rowErr) {
              if (isNetworkLikeError(rowErr)) {
                throw rowErr;
              }
              if (isFullReconcile) {
                failedPullKeys.add(`${row.entity_type}:${row.entity_id}`);
              }
              if (isVaultLockedError(rowErr)) {
                this.repo.setSyncState('pending_secret_reconcile', '1');
              } else {
                // Isolate corrupt/unreadable single record so subsequent deletes & notes still pull cleanly,
                // while holding last_cursor behind the first failed record for retry.
                cursorBlockedByRowError = true;
                recordErrors.push(rowErr);
              }
            }

            if (!cursorBlockedByRowError && nextSeq > highWaterCursor) {
              highWaterCursor = nextSeq;
              this.repo.setSyncState('last_cursor', String(highWaterCursor));
            }
          }

          if (batch.length < PULL_PAGE_SIZE || pageMaxSeq <= queryCursor) break;
          queryCursor = pageMaxSeq;
        }

        // On full reconcile, push any local tombstones missing remotely or overridden by stale live rows
        if (isFullReconcile) {
          const localTombstones = this.repo.listLocalTombstones();
          const vaultLocked = this.vaultCrypto.isLocked();
          for (const tomb of localTombstones) {
            const tombKey = `${tomb.entityType}:${tomb.entityId}`;
            if (failedPullKeys.has(tombKey)) {
              continue;
            }
            if (vaultLocked && tomb.entityType === 'item' && tomb.dna === 'secret') {
              this.repo.setSyncState('pending_secret_reconcile', '1');
              continue;
            }
            const remoteInfo = remoteSeenDuringFull.get(tombKey);
            if (!remoteInfo) {
              this.repo.markDirty(tomb.entityType, tomb.entityId);
            } else if (
              remoteInfo.deleted_at == null ||
              (tomb.purgedAt != null && remoteInfo.device_id !== this.deviceId && !remoteInfo.purged)
            ) {
              // Remote still has live (or unpurged) row while local was deleted/purged — bump timestamp & push tombstone
              const bumpedUpdatedAt = Math.max(remoteInfo.updated_at + 1, Date.now());
              const bumpedSyncVersion = Math.max(tomb.syncVersion, remoteInfo.sync_version) + 1;
              this.repo.bumpEntityTimestampForSyncConflict(
                tomb.entityType,
                tomb.entityId,
                bumpedUpdatedAt,
                bumpedSyncVersion
              );
              this.repo.markDirty(tomb.entityType, tomb.entityId);
            }
          }
        }
      } finally {
        if (gen === this.authGeneration && !this.disposed) {
          if (freedMediaAll.size > 0) {
            this.callbacks.onMediaCleanup?.(Array.from(freedMediaAll));
          }

          // Emit batched UI updates cleanly (even if a later pull page threw after page 1 committed to SQLite)
          if (
            upsertedItems.length + deletedItemIds.length > BATCH_UI_THRESHOLD &&
            this.callbacks.onBatchSynced
          ) {
            this.callbacks.onBatchSynced();
          } else {
            for (const it of upsertedItems) this.callbacks.onItemUpserted?.(it);
            for (const id of deletedItemIds) this.callbacks.onItemDeleted?.(id);
            if (orbitsTouched) this.callbacks.onOrbitsChanged?.();
            if (boardsTouched) this.callbacks.onBoardsChanged?.();
            if (calendarTouched) this.callbacks.onCalendarChanged?.();
          }
          if (workspacePrefsTouched) {
            this.callbacks.onWorkspacePrefsChanged?.();
          }
        }
      }

      if (gen !== this.authGeneration || this.disposed) {
        return { ok: false, error: cancelledMsg, status: this.getStatus() };
      }

      // 2. PUSH ALL DIRTY LOCAL ENTITIES IN DEPENDENCY-ORDERED BATCHES WITH PER-RECORD ISOLATION
      const deferredLockedKeys = new Set<string>();
      let batchesProcessed = 0;

      while (batchesProcessed < MAX_PUSH_BATCHES_PER_CYCLE) {
        if (gen !== this.authGeneration || this.disposed) {
          return { ok: false, error: cancelledMsg, status: this.getStatus() };
        }
        const dirtyBatch = this.repo
          .listDirtyEntities(PUSH_BATCH_SIZE)
          .filter((e) => !deferredLockedKeys.has(`${e.entityType}:${e.entityId}`));
        if (dirtyBatch.length === 0) break;
        batchesProcessed += 1;

        for (const entry of dirtyBatch) {
          if (gen !== this.authGeneration || this.disposed) {
            return { ok: false, error: cancelledMsg, status: this.getStatus() };
          }
          if (this.disabledOptionalEntityTypes.has(entry.entityType)) {
            this.repo.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
            continue;
          }

          try {
            let built = await this.buildOutgoingRecord(
              client,
              userId,
              dek,
              entry.entityType,
              entry.entityId
            );
            if (!built) {
              this.repo.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
              continue;
            }
            blobsUploaded += built.blobsUploaded;

            const buildRowForUpsert = (rec: NonNullable<typeof built>) => {
              const enc = encryptRecordPayload(
                dek,
                userId,
                entry.entityType,
                entry.entityId,
                rec.payload
              );
              return {
                user_id: userId,
                entity_type: entry.entityType,
                entity_id: entry.entityId,
                updated_at: rec.updatedAt,
                deleted_at: rec.deletedAt,
                sync_version: rec.syncVersion,
                device_id: this.deviceId,
                schema_version: SYNC_SCHEMA_VERSION,
                payload_ciphertext: enc.payload_ciphertext,
                payload_iv: enc.payload_iv,
                payload_tag: enc.payload_tag,
              };
            };

            let upsertResult = await this.upsertSyncRecordWithReturn(
              client,
              buildRowForUpsert(built)
            );

            // Graceful fallback when live Supabase Postgres has not yet widened sync_records_entity_type_check (23514)
            if (
              upsertResult.error &&
              OPTIONAL_SYNC_ENTITY_TYPES.has(entry.entityType) &&
              isEntityTypeConstraintError(upsertResult.error)
            ) {
              this.disabledOptionalEntityTypes.add(entry.entityType);
              this.repo.clearDirtyByEntityType(entry.entityType);
              continue;
            }

            if (upsertResult.error) {
              throw new Error(upsertResult.error.message);
            }

            // Detect silent server drop or missing confirmation row from upsert().select()
            const ret = upsertResult.returnedRow;
            if (upsertResult.selectSupported && !ret) {
              const noRowMsg = this.isEn
                ? 'Server did not confirm sync write'
                : 'Сервер не подтвердил запись синхронизации';
              deferredLockedKeys.add(`${entry.entityType}:${entry.entityId}`);
              recordErrors.push(new Error(noRowMsg));
              continue;
            }
            const serverDroppedWrite = Boolean(
              ret &&
                ((ret.device_id && ret.device_id !== this.deviceId) ||
                  (ret.deleted_at ?? null) !== (built.deletedAt ?? null) ||
                  (typeof ret.updated_at === 'number' && ret.updated_at > built.updatedAt))
            );

            if (serverDroppedWrite && ret) {
              if ((built.deletedAt != null && ret.deleted_at == null) || built.isPurged) {
                // Delete / purge wins over clock skew: bump local timestamp strictly past server's and retry once
                const bumpedUpdatedAt = Math.max((ret.updated_at ?? 0) + 1, Date.now());
                const bumpedSyncVersion = Math.max(built.syncVersion, ret.sync_version ?? 1) + 1;
                this.repo.bumpEntityTimestampForSyncConflict(
                  entry.entityType,
                  entry.entityId,
                  bumpedUpdatedAt,
                  bumpedSyncVersion
                );
                const rebuilt = await this.buildOutgoingRecord(
                  client,
                  userId,
                  dek,
                  entry.entityType,
                  entry.entityId
                );
                if (rebuilt) {
                  built = rebuilt;
                  blobsUploaded += rebuilt.blobsUploaded;
                  upsertResult = await this.upsertSyncRecordWithReturn(
                    client,
                    buildRowForUpsert(rebuilt)
                  );
                  if (upsertResult.error) {
                    throw new Error(upsertResult.error.message);
                  }
                  if (upsertResult.selectSupported && !upsertResult.returnedRow) {
                    const retryNoRowMsg = this.isEn
                      ? 'Server did not confirm sync write'
                      : 'Сервер не подтвердил запись синхронизации';
                    deferredLockedKeys.add(`${entry.entityType}:${entry.entityId}`);
                    recordErrors.push(new Error(retryNoRowMsg));
                    continue;
                  }
                }
              } else if (ret.device_id && ret.device_id !== this.deviceId) {
                // Server kept a newer record from another device — pull it and preserve losing note text in sync_conflict!
                const { data: remoteLatest } = await client
                  .from('sync_records')
                  .select('*')
                  .eq('user_id', userId)
                  .eq('entity_type', entry.entityType)
                  .eq('entity_id', entry.entityId)
                  .maybeSingle();
                if (remoteLatest) {
                  const dl = await this.applyIncomingRecord(
                    client,
                    userId,
                    dek,
                    remoteLatest as SyncRecordRow,
                    gen
                  );
                  blobsDownloaded += dl.blobsDownloaded;
                  if (dl.freedMedia && dl.freedMedia.length > 0) {
                    this.callbacks.onMediaCleanup?.(dl.freedMedia);
                  }
                  if (dl.applied) {
                    pulled++;
                    if (dl.upsertedItem) this.callbacks.onItemUpserted?.(dl.upsertedItem);
                    if (dl.deletedItemId) this.callbacks.onItemDeleted?.(dl.deletedItemId);
                  }
                }
              }
            }

            this.repo.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
            pushed++;
            if (pushed === 1 || pushed % 3 === 0) {
              this.emitStatus();
            }
          } catch (pushRowErr) {
            if (isNetworkLikeError(pushRowErr)) {
              throw pushRowErr;
            }
            if (isVaultLockedError(pushRowErr)) {
              deferredLockedKeys.add(`${entry.entityType}:${entry.entityId}`);
              continue;
            }
            const errMsg = pushRowErr instanceof Error ? pushRowErr.message : String(pushRowErr ?? '');
            this.repo.recordDirtyFailure(entry.entityType, entry.entityId, errMsg);
            recordErrors.push(pushRowErr);
          }
        }

        // If we drained a full batch of 100 and hit max batch cap, schedule immediate continuation
        if (batchesProcessed >= MAX_PUSH_BATCHES_PER_CYCLE && dirtyBatch.length >= PUSH_BATCH_SIZE) {
          this.pendingResync = true;
        }
      }

      // 3. Drain deferred permanent media blob deletes before finalizing cycle
      const pendingDeletes = this.repo.getPendingBlobDeletes();
      if (pendingDeletes.length > 0) {
        try {
          const deletedBlobIds = await this.mediaManager.deleteBlobs(client, userId, pendingDeletes);
          if (deletedBlobIds.length > 0) {
            this.repo.removePendingBlobDeletes(deletedBlobIds);
          }
        } catch {
          // Non-fatal: remaining blob deletes retry on next sync cycle
        }
      }

      // 4. Upsert current device heartbeat & refresh device roster
      await this.syncDeviceRoster(client, userId);

      if (gen !== this.authGeneration || this.disposed) {
        return { ok: false, error: cancelledMsg, status: this.getStatus() };
      }

      const finishedAt = Date.now();
      this.lastSyncAt = finishedAt;
      this.repo.setSyncState('last_sync_at', String(finishedAt));
      if (isFullReconcile || startFromZero) {
        this.lastReconcileAt = finishedAt;
        this.repo.setSyncState('last_reconcile_at', String(finishedAt));
        this.completedFullReconcileSeq += 1;
      }

      if (recordErrors.length > 0) {
        const msg = this.formatSyncErr(recordErrors[0]);
        this.lastError = msg;
        this.state = 'error';
        this.emitStatus();
        return {
          ok: false,
          error: msg,
          pushed,
          pulled,
          blobsUploaded,
          blobsDownloaded,
          status: this.getStatus(),
        };
      }

      this.state = 'synced';
      this.lastError = null;
      this.emitStatus();

      return {
        ok: true,
        pushed,
        pulled,
        blobsUploaded,
        blobsDownloaded,
        status: this.getStatus(),
      };
    } catch (err) {
      if (gen !== this.authGeneration || this.disposed) {
        return { ok: false, error: cancelledMsg, status: this.getStatus() };
      }
      const msg = this.formatSyncErr(err);
      this.lastError = msg;
      this.state = isNetworkLikeError(err) ? 'offline' : 'error';
      this.emitStatus();
      return {
        ok: false,
        error: msg,
        pushed,
        pulled,
        blobsUploaded,
        blobsDownloaded,
        status: this.getStatus(),
      };
    } finally {
      dek.fill(0);
    }
  }

  private async buildOutgoingRecord(
    client: SupabaseClient,
    userId: string,
    dek: Buffer,
    entityType: SyncEntityType,
    entityId: string
  ): Promise<{
    payload: unknown;
    updatedAt: number;
    deletedAt: number | null;
    syncVersion: number;
    blobsUploaded: number;
    isPurged?: boolean;
  } | null> {
    if (entityType === 'orbit') {
      const row = this.repo.getRawOrbitById(entityId);
      if (!row) return null;
      const updatedAt = row.updated_at ?? row.created_at ?? Date.now();
      const payload: SyncedOrbitPayload = {
        v: 1,
        id: row.id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        color: row.color,
        sortOrder: row.sort_order,
        isBuiltin: row.is_builtin === 1,
        createdAt: row.created_at ?? updatedAt,
        updatedAt,
        deletedAt: row.deleted_at ?? null,
        syncVersion: row.sync_version ?? 1,
      };
      return {
        payload,
        updatedAt,
        deletedAt: payload.deletedAt,
        syncVersion: payload.syncVersion,
        blobsUploaded: 0,
      };
    }

    if (entityType === 'focus_board') {
      const row = this.repo.getRawFocusBoardById(entityId);
      if (!row) return null;
      const updatedAt = row.updated_at ?? row.created_at;
      const payload: SyncedFocusBoardPayload = {
        v: 1,
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        icon: row.icon,
        color: row.color,
        sortOrder: row.sort_order ?? 0,
        isActive: row.is_active === 1,
        createdAt: row.created_at,
        updatedAt,
        deletedAt: row.deleted_at ?? null,
        syncVersion: row.sync_version ?? 1,
      };
      return {
        payload,
        updatedAt,
        deletedAt: payload.deletedAt,
        syncVersion: payload.syncVersion,
        blobsUploaded: 0,
      };
    }

    if (entityType === 'calendar_event') {
      const ev = this.repo.getRawCalendarEventById(entityId);
      if (!ev) return null;
      const mediaResult = ev.deletedAt
        ? { refs: [], uploadedCount: 0 }
        : await this.mediaManager.ensureUploaded(client, userId, dek, ev.attachments ?? []);
      const payload: SyncedCalendarEventPayload = {
        v: 1,
        id: ev.id,
        title: ev.title,
        notes: ev.notes,
        location: ev.location,
        startAt: ev.startAt,
        endAt: ev.endAt,
        allDay: ev.allDay,
        hasEndTime: ev.hasEndTime,
        color: ev.color,
        kind: ev.kind,
        recurrence: ev.recurrence ?? 'none',
        isDone: ev.isDone,
        linkedItemId: ev.linkedItemId,
        checklist: ev.checklist ?? [],
        attachments: ev.attachments ?? [],
        externalSource: ev.externalSource,
        externalId: ev.externalId,
        etag: ev.etag,
        createdAt: ev.createdAt,
        updatedAt: ev.updatedAt,
        deletedAt: ev.deletedAt,
        syncVersion: ev.syncVersion ?? 1,
        mediaRefs: mediaResult.refs,
      };
      return {
        payload,
        updatedAt: ev.updatedAt,
        deletedAt: ev.deletedAt,
        syncVersion: payload.syncVersion,
        blobsUploaded: mediaResult.uploadedCount,
      };
    }

    if (entityType === 'item_revision') {
      if (this.disabledOptionalEntityTypes.has('item_revision')) return null;
      const rev = this.repo.getRawItemRevisionById(entityId);
      if (!rev) return null;
      const parent = this.repo.getRawRowById(rev.item_id);
      if (!parent || parent.is_demo === 1 || parent.dna === 'secret') return null;
      if (!rev.deleted_at && !this.repo.isRevisionWithinSyncWindow(rev.item_id, rev.id, 15)) {
        return null;
      }
      const updatedAt = rev.updated_at || rev.created_at;
      const payload: SyncedItemRevisionPayload = {
        v: 1,
        id: rev.id,
        itemId: rev.item_id,
        title: rev.deleted_at ? '' : rev.title,
        content: rev.deleted_at ? '' : rev.content,
        source: rev.source,
        contentHash: rev.content_hash ?? '',
        deviceName: rev.device_name ?? null,
        createdAt: rev.created_at,
        updatedAt,
        deletedAt: rev.deleted_at ?? null,
        syncVersion: rev.sync_version ?? 1,
      };
      return {
        payload,
        updatedAt,
        deletedAt: payload.deletedAt,
        syncVersion: payload.syncVersion,
        blobsUploaded: 0,
      };
    }

    if (entityType === 'workspace_prefs') {
      if (this.disabledOptionalEntityTypes.has('workspace_prefs')) return null;
      const prefs = this.repo.getWorkspacePrefsForSync();
      if (!prefs) return null;
      return {
        payload: prefs,
        updatedAt: prefs.updatedAt,
        deletedAt: prefs.deletedAt,
        syncVersion: prefs.syncVersion,
        blobsUploaded: 0,
      };
    }

    if (entityType !== 'item') return null;

    // entityType === 'item'
    const rawRow = this.repo.getRawRowById(entityId);
    if (!rawRow || rawRow.is_demo === 1) return null;
    const item = this.repo.getItemById(entityId, { includeDeleted: true, includePurged: true });
    if (!item) return null;

    const isPurged = item.purgedAt != null;

    // Cross-platform Secret Boundary (AD-3): NEVER silently coerce decryption error to null on live or soft-deleted items!
    let secretPayload: SecretPayload | null = null;
    if (rawRow.encrypted_payload && !isPurged) {
      if (!item.deletedAt) {
        try {
          secretPayload = this.vaultCrypto.decryptSecret(rawRow.encrypted_payload);
        } catch (err) {
          if (isVaultLockedError(err)) {
            throw err;
          }
          throw new Error(
            this.isEn
              ? 'Could not read local Vault secret for sync — sync paused to protect Vault data'
              : 'Не удалось прочитать локальный секрет для отправки в облако — синхронизация приостановлена для защиты данных Сейфа'
          );
        }
      } else {
        // Keep encrypted secret payload in E2EE envelope during reversible Trash so restore works cross-device.
        // Defer push while Vault is PIN-locked rather than emitting secretPayload: null and wiping cloud data.
        if (this.vaultCrypto.isLocked()) {
          throw new Error(
            this.isEn ? 'Vault is locked by master PIN' : 'Сейф заблокирован мастер-кодом'
          );
        }
        try {
          secretPayload = this.vaultCrypto.decryptSecret(rawRow.encrypted_payload);
        } catch (err) {
          if (isVaultLockedError(err)) {
            throw err;
          }
          secretPayload = null;
        }
      }
    }

    const mediaNames: Array<string | null | undefined> =
      item.deletedAt || isPurged
        ? []
        : [
            item.imagePath,
            item.thumbPath,
            item.mediaPath,
            ...(item.mediaMeta?.galleryPaths ?? []),
            ...extractInlineMediaFilenames(item.body),
          ];
    const mediaResult = await this.mediaManager.ensureUploaded(client, userId, dek, mediaNames);

    const payload: SyncedItemPayload = {
      v: 1,
      id: item.id,
      dna: item.dna,
      subKind: isPurged ? null : item.subKind,
      orbit: isPurged ? '' : item.orbit,
      modeCaptured: item.modeCaptured,
      focusBoardId: isPurged ? null : item.focusBoardId,
      title: isPurged ? '' : item.title,
      body: isPurged ? '' : item.body,
      summary: isPurged ? '' : item.summary,
      url: isPurged ? null : item.url,
      domain: isPurged ? null : item.domain,
      platform: isPurged ? null : item.platform,
      imagePath: isPurged ? null : item.imagePath,
      thumbPath: isPurged ? null : item.thumbPath,
      mediaPath: isPurged ? null : item.mediaPath,
      mediaType: isPurged ? null : item.mediaType,
      mediaDurationSec: isPurged ? null : item.mediaDurationSec,
      mediaMeta: isPurged ? null : sanitizeMediaMetaForSync(item.mediaMeta),
      ogImageUrl: isPurged ? null : item.ogImageUrl,
      ocrText: isPurged ? '' : item.ocrText,
      extractedActions: isPurged ? [] : item.extractedActions,
      colorPalette: isPurged ? [] : item.colorPalette,
      secretPayload,
      secretMeta: isPurged ? null : item.secretMeta,
      tags: isPurged ? [] : item.tags,
      source: item.source,
      externalId: isPurged ? null : item.externalId,
      contentHash: item.contentHash,
      aiStatus: item.aiStatus,
      aiConfidence: isPurged ? null : item.aiConfidence,
      isPinned: isPurged ? false : item.isPinned,
      isArchived: isPurged ? false : item.isArchived,
      remindAt: isPurged ? null : item.remindAt,
      remindedAt: isPurged ? null : item.remindedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      contentUpdatedAt: item.contentUpdatedAt,
      deletedAt: item.deletedAt ?? (isPurged ? item.purgedAt ?? item.updatedAt : null),
      purgedAt: item.purgedAt ?? null,
      canvasX: isPurged ? null : item.canvasX,
      canvasY: isPurged ? null : item.canvasY,
      canvasW: isPurged ? null : item.canvasW,
      canvasH: isPurged ? null : item.canvasH,
      canvasFrame: isPurged ? null : item.canvasFrame,
      annotations: isPurged ? [] : item.annotations,
      linksOut: isPurged ? [] : item.linksOut,
      syncVersion: item.syncVersion ?? 1,
      mediaRefs: mediaResult.refs,
    };

    return {
      payload,
      updatedAt: item.updatedAt,
      deletedAt: payload.deletedAt,
      syncVersion: payload.syncVersion,
      blobsUploaded: mediaResult.uploadedCount,
      isPurged,
    };
  }

  private async applyIncomingRecord(
    client: SupabaseClient,
    userId: string,
    dek: Buffer,
    row: SyncRecordRow,
    gen: number
  ): Promise<{
    applied: boolean;
    localStrictlyNewer: boolean;
    blobsDownloaded: number;
    upsertedItem?: VaultItem;
    deletedItemId?: string;
    freedMedia?: string[];
    wasPurged?: boolean;
  }> {
    const encFields = {
      payload_ciphertext: row.payload_ciphertext,
      payload_iv: row.payload_iv,
      payload_tag: row.payload_tag,
    };

    if (row.entity_type === 'orbit') {
      const payload = decryptRecordPayload<SyncedOrbitPayload>(
        dek,
        userId,
        'orbit',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(
          this.isEn
            ? 'Corrupted synced section record'
            : 'Нарушена целостность синхронизируемого раздела'
        );
      }
      const res = this.repo.applySyncedOrbit(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'focus_board') {
      const payload = decryptRecordPayload<SyncedFocusBoardPayload>(
        dek,
        userId,
        'focus_board',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(
          this.isEn
            ? 'Corrupted synced board record'
            : 'Нарушена целостность синхронизируемой доски'
        );
      }
      const res = this.repo.applySyncedFocusBoard(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'calendar_event') {
      const payload = decryptRecordPayload<SyncedCalendarEventPayload>(
        dek,
        userId,
        'calendar_event',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(
          this.isEn
            ? 'Corrupted synced calendar event'
            : 'Нарушена целостность события календаря'
        );
      }
      let blobsDownloaded = 0;
      if (!payload.deletedAt && payload.mediaRefs?.length) {
        blobsDownloaded = await this.mediaManager.ensureDownloaded(
          client,
          userId,
          dek,
          payload.mediaRefs
        );
      }
      if (gen !== this.authGeneration || this.disposed) {
        return { applied: false, localStrictlyNewer: false, blobsDownloaded: 0 };
      }
      const res = this.repo.applySyncedCalendarEvent(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded };
    }

    if (row.entity_type === 'item_revision') {
      const payload = decryptRecordPayload<SyncedItemRevisionPayload>(
        dek,
        userId,
        'item_revision',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(
          this.isEn
            ? 'Corrupted synced note version'
            : 'Нарушена целостность версии заметки'
        );
      }
      const res = this.repo.applySyncedItemRevision(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'workspace_prefs') {
      const payload = decryptRecordPayload<SyncedWorkspacePrefsPayload>(
        dek,
        userId,
        'workspace_prefs',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1) {
        throw new Error(
          this.isEn
            ? 'Corrupted workspace preferences payload'
            : 'Нарушена целостность настроек рабочего пространства'
        );
      }
      const res = this.repo.applySyncedWorkspacePrefs(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type !== 'item') {
      // Unknown future entity type: ignore gracefully without wedging sync
      return { applied: false, localStrictlyNewer: false, blobsDownloaded: 0 };
    }

    // item
    const payload = decryptRecordPayload<SyncedItemPayload>(
      dek,
      userId,
      'item',
      row.entity_id,
      encFields
    );
    if (payload.v !== 1 || payload.id !== row.entity_id) {
      throw new Error(
        this.isEn
          ? 'Corrupted synced item record'
          : 'Нарушена целостность синхронизируемой записи'
      );
    }

    const isPurged = payload.purgedAt != null;
    const isDeleted = payload.deletedAt != null || isPurged;

    let blobsDownloaded = 0;
    if (!isDeleted && payload.mediaRefs?.length) {
      blobsDownloaded = await this.mediaManager.ensureDownloaded(
        client,
        userId,
        dek,
        payload.mediaRefs
      );
    }
    if (gen !== this.authGeneration || this.disposed) {
      return { applied: false, localStrictlyNewer: false, blobsDownloaded: 0 };
    }

    // Re-wrap cross-platform secret payload with THIS device's local VaultCrypto (AD-3)
    let localEncryptedPayload: string | null = null;
    if (!isPurged) {
      if (payload.secretPayload) {
        localEncryptedPayload = this.vaultCrypto.encryptSecret(payload.secretPayload);
      } else if (payload.deletedAt) {
        // Preserve existing local encrypted payload during reversible Trash if remote sent only tombstone metadata
        const existingLocal = this.repo.getRawRowById(payload.id);
        localEncryptedPayload = existingLocal?.encrypted_payload ?? null;
      }
    }

    const res = this.repo.applySyncedItem(
      payload,
      localEncryptedPayload,
      row.device_id,
      this.deviceId
    );
    return {
      applied: res.applied,
      localStrictlyNewer: res.localStrictlyNewer,
      blobsDownloaded,
      upsertedItem: res.applied && !isDeleted && res.item ? res.item : undefined,
      deletedItemId: res.applied && isDeleted ? payload.id : undefined,
      freedMedia: res.freedMedia,
      wasPurged: isPurged,
    };
  }

  private async syncDeviceRoster(client: SupabaseClient, userId: string): Promise<void> {
    try {
      await client.from('sync_devices').upsert(
        {
          user_id: userId,
          device_id: this.deviceId,
          device_name: this.deviceName,
          platform: normalizePlatform(process.platform),
          app_version: this.appVersion,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,device_id' }
      );

      const { data } = await client
        .from('sync_devices')
        .select('device_id, device_name, platform, app_version, last_seen_at')
        .eq('user_id', userId)
        .order('last_seen_at', { ascending: false })
        .limit(20);

      if (Array.isArray(data)) {
        this.devices = data.map((d) => ({
          deviceId: String(d.device_id),
          deviceName: String(d.device_name),
          platform: d.platform as SyncPlatform,
          appVersion: String(d.app_version ?? '1.0.0'),
          lastSeenAt: String(d.last_seen_at),
          isCurrent: String(d.device_id) === this.deviceId,
        }));
      }
    } catch {
      // Device list is informational — never fail a sync cycle on it
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.authGeneration += 1;
    this.repo.setMutationListener(null);
    this.stopBackgroundLoops();
    this.resetClient();
    this.setDek(null);
  }
}
