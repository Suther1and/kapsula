import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
  type SupportedStorage,
} from '@supabase/supabase-js';
import { APP_VERSION } from '@shared/app-version';
import {
  DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SYNC_SUPABASE_URL,
  extractInlineMediaFilenames,
  SYNC_KDF_ITERATIONS,
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
import type { SecretPayload } from '@shared/types';
import type { AppLocale } from '@shared/i18n/core';
import { hasCyrillicChars, isKnownLocalizedMobileMessage } from '@shared/i18n/mobile-dict';
import { getRuntimeMobileLocale, tm } from '../lib/mobile-i18n';
import { mobileBridge } from '../native/bridge';
import type { MobileVaultStore } from '../storage/mobile-store';
import {
  base64ToBytes,
  bytesToBase64,
  createKeyEnvelope,
  decryptRecordPayload,
  encryptRecordPayload,
  rewrapEnvelopePassphrase,
  rewrapEnvelopeRecoveryKey,
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
  verifyKeyCheckToken,
} from './mobile-crypto';
import { MobileSyncMediaManager } from './mobile-media';

export interface MobileSyncEngineOptions {
  store: MobileVaultStore;
  appVersion?: string;
  deviceName?: string;
  platform?: SyncPlatform;
  kdfIterationsOverride?: number;
  disableTimers?: boolean;
  disableRealtime?: boolean;
  clientFactory?: (url: string, key: string, storage: SupportedStorage) => SupabaseClient;
  onStatusChanged?: (status: SyncStatus) => void;
  isVaultLocked?: () => boolean;
}

const SYNC_POLL_INTERVAL_MS = 30_000;
const DIRTY_DEBOUNCE_MS = 1_500;
const REALTIME_DEBOUNCE_MS = 450;
const PULL_PAGE_SIZE = 200;
const PUSH_BATCH_SIZE = 100;
const CURSOR_OVERLAP_REWIND = 25;
const AUTO_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isOptionalEntityType(t: SyncEntityType): boolean {
  return t === 'item_revision' || t === 'workspace_prefs';
}

function isEntityTypeCheckConstraintError(err: unknown): boolean {
  const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  const msg = (err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message?: unknown }).message ?? '') : String(err ?? '')).toLowerCase();
  return (
    code === '23514' ||
    msg.includes('23514') ||
    msg.includes('sync_records_entity_type_check') ||
    (msg.includes('check constraint') && msg.includes('entity_type'))
  );
}

function isAuthFatalError(err: unknown): boolean {
  const lower = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    lower.includes('jwt expired') ||
    lower.includes('invalid refresh token') ||
    lower.includes('refresh_token_not_found') ||
    lower.includes('auth session missing')
  );
}

export function translateMobileSyncError(err: unknown, locale?: AppLocale): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();
  if (lower.includes('invalid login credentials')) {
    return tm('sync.errInvalidCredentials', undefined, activeLocale);
  }
  if (lower.includes('email not confirmed')) {
    return tm('sync.errEmailNotConfirmed', undefined, activeLocale);
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return tm('sync.errAlreadyRegistered', undefined, activeLocale);
  }
  if (lower.includes('password should be at least')) {
    return tm('sync.errPasswordMin6', undefined, activeLocale);
  }
  if (lower.includes('unable to validate email') || lower.includes('invalid email')) {
    return tm('sync.errInvalidEmail', undefined, activeLocale);
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return tm('sync.errRateLimit', undefined, activeLocale);
  }
  if (lower.includes('provider is not enabled') || lower.includes('unsupported provider')) {
    return tm('sync.errGoogleDisabled', undefined, activeLocale);
  }
  if (lower.includes('access_denied') || lower.includes('oauth cancel')) {
    return tm('sync.errGoogleCancelled', undefined, activeLocale);
  }
  if (
    lower.includes('code verifier') ||
    lower.includes('invalid flow state') ||
    lower.includes('bad_oauth_state') ||
    lower.includes('pkce')
  ) {
    return tm('sync.errOauthExpired', undefined, activeLocale);
  }
  if (
    lower.includes('jwt expired') ||
    lower.includes('invalid refresh token') ||
    lower.includes('refresh_token_not_found') ||
    lower.includes('auth session missing')
  ) {
    return tm('sync.errSessionExpired', undefined, activeLocale);
  }
  if (lower.includes('row-level security') || lower.includes('permission denied')) {
    return tm('sync.errAccessDenied', undefined, activeLocale);
  }
  if (lower.includes('duplicate key') || lower.includes('23505')) {
    return tm('sync.errEnvelopeExists', undefined, activeLocale);
  }
  if (isNetworkLikeError(err)) {
    return tm('sync.errOffline', undefined, activeLocale);
  }
  if (
    raw &&
    !/(?:postgrest|postgres|pgrst|sqlstate|jwt)/i.test(raw) &&
    (isKnownLocalizedMobileMessage(raw, activeLocale) ||
      (activeLocale === 'ru' && hasCyrillicChars(raw)))
  ) {
    return raw;
  }
  return tm('sync.errGeneric', undefined, activeLocale);
}

function isNetworkLikeError(err: unknown): boolean {
  const lower = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('offline')
  );
}

function generateDeviceUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class MobileSyncEngine {
  private readonly store: MobileVaultStore;
  private readonly mediaManager: MobileSyncMediaManager;
  private readonly hasExplicitAppVersion: boolean;
  private appVersion: string;
  private readonly platform: SyncPlatform;
  private readonly kdfIterations: number;
  private readonly disableTimers: boolean;
  private readonly disableRealtime: boolean;
  private readonly clientFactory?: MobileSyncEngineOptions['clientFactory'];
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();

  private deviceId = '';
  private deviceName: string;
  private client: SupabaseClient | null = null;
  private activeClientUrl = '';
  private activeClientKey = '';
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeConnected = false;

  private state: SyncStateKind = 'signed_out';
  private userId: string | null = null;
  private email: string | null = null;
  private dek: Uint8Array | null = null;
  private lastSyncAt: number | null = null;
  private lastReconcileAt: number | null = null;
  private lastError: string | null = null;
  private devices: SyncDeviceInfo[] = [];
  private needsEnvelopeVerification = false;
  private readonly disabledOptionalTypes = new Set<SyncEntityType>();

  private authGeneration = 0;
  private disposed = false;
  private initPromise: Promise<SyncStatus> | null = null;
  private hasCustomServerConfigured = false;
  private inFlightSync: Promise<SyncActionResult> | null = null;
  private pendingResync = false;

  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeReconnectAttempt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private removeOnlineListener: (() => void) | null = null;
  private isVaultLocked?: () => boolean;

  constructor(options: MobileSyncEngineOptions) {
    this.store = options.store;
    this.mediaManager = new MobileSyncMediaManager(this.store);
    this.hasExplicitAppVersion = Boolean(options.appVersion);
    this.appVersion = options.appVersion ?? APP_VERSION;
    this.platform = options.platform ?? 'android';
    this.deviceName = options.deviceName ?? 'Android Fold';
    this.kdfIterations = options.kdfIterationsOverride ?? SYNC_KDF_ITERATIONS;
    this.disableTimers = Boolean(options.disableTimers);
    this.disableRealtime = Boolean(options.disableRealtime);
    this.clientFactory = options.clientFactory;
    this.isVaultLocked = options.isVaultLocked;
    if (options.onStatusChanged) {
      this.statusListeners.add(options.onStatusChanged);
    }
  }

  public setVaultLockedProvider(fn: (() => boolean) | undefined): void {
    this.isVaultLocked = fn;
  }

  public onStatusChanged(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatus(): void {
    const snap = this.getStatus();
    this.statusListeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // isolate subscriber errors
      }
    });
  }

  private getMinKdfIterations(): number {
    return Math.min(this.kdfIterations, SYNC_MIN_KDF_ITERATIONS);
  }

  private setDek(next: Uint8Array | null): void {
    if (this.dek) {
      this.dek.fill(0);
    }
    if (next) {
      const copy = new Uint8Array(new ArrayBuffer(next.byteLength));
      copy.set(next);
      this.dek = copy;
    } else {
      this.dek = null;
    }
  }

  public getStatus(): SyncStatus {
    const customUrl = this.store.getSyncState('custom_supabase_url');
    return {
      state: this.state,
      email: this.email,
      userId: this.userId,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      lastSyncAt: this.lastSyncAt,
      pendingCount: this.store.countDirtyEntities(),
      syncedRecordsCount: this.store.countSyncableRecords(),
      realtimeConnected: this.realtimeConnected,
      hasCustomServer: this.hasCustomServerConfigured && Boolean(customUrl),
      supabaseUrl:
        this.hasCustomServerConfigured && customUrl ? customUrl : DEFAULT_SYNC_SUPABASE_URL,
      error: this.lastError,
      devices: [...this.devices],
      hasRecoveryKeyBackupHint: this.store.getSyncState('recovery_key_saved') === '1',
      lastReconcileAt: this.lastReconcileAt,
      failedDirtyCount: this.store.countFailedDirtyEntities(),
    };
  }

  public async init(): Promise<SyncStatus> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initInternal();
    return this.initPromise;
  }

  private async initInternal(): Promise<SyncStatus> {
    this.disposed = false;
    await this.store.init();

    let savedDeviceId = this.store.getSyncState('device_id');
    if (!savedDeviceId) {
      savedDeviceId = generateDeviceUuid();
      await this.store.setSyncState('device_id', savedDeviceId);
    }
    this.deviceId = savedDeviceId;

    const customUrl = this.store.getSyncState('custom_supabase_url');
    const customKey = customUrl ? await this.store.getSecureValue('custom_supabase_key') : null;
    this.hasCustomServerConfigured = Boolean(customUrl && customKey);

    if (this.deviceName === 'Android Fold') {
      try {
        const info = await mobileBridge.getDeviceInfo();
        const label = [info.manufacturer, info.model].filter(Boolean).join(' ').trim();
        if (label) this.deviceName = label;
      } catch {
        // keep fallback
      }
    }

    if (!this.hasExplicitAppVersion && mobileBridge.isNativeAndroid()) {
      try {
        const ver = await mobileBridge.getAppVersion();
        if (ver?.versionName) this.appVersion = ver.versionName;
      } catch {
        // keep fallback
      }
    }

    this.store.setDeviceNameLabel(this.deviceName);

    const lastSyncRaw = this.store.getSyncState('last_sync_at');
    this.lastSyncAt = lastSyncRaw ? Number(lastSyncRaw) || null : null;
    const lastRecRaw = this.store.getSyncState('last_reconcile_at');
    this.lastReconcileAt = lastRecRaw ? Number(lastRecRaw) || null : null;

    this.store.setMutationListener(() => {
      this.scheduleDirtyPush();
      this.emitStatus();
    });

    if (typeof window !== 'undefined' && !this.disableTimers && !this.removeOnlineListener) {
      const onOnline = () => {
        if (this.userId && this.dek) {
          this.handleAppResume();
        }
      };
      window.addEventListener('online', onOnline);
      this.removeOnlineListener = () => window.removeEventListener('online', onOnline);
    }

    const pendingEmail = this.store.getSyncState('pending_confirm_email');
    if (pendingEmail) {
      this.email = pendingEmail;
      this.state = 'awaiting_email_confirm';
    }

    await this.restoreExistingSession();
    this.emitStatus();
    return this.getStatus();
  }

  private async getServerConfig(): Promise<{ url: string; key: string }> {
    const customUrl = this.store.getSyncState('custom_supabase_url');
    const customKey = await this.store.getSecureValue('custom_supabase_key');
    if (customUrl && customKey) {
      return { url: customUrl, key: customKey };
    }
    return {
      url: DEFAULT_SYNC_SUPABASE_URL,
      key: DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY,
    };
  }

  private createAuthStorage(): SupportedStorage {
    return {
      getItem: (key: string) => this.store.getSecureValue(`sb:${key}`),
      setItem: (key: string, value: string) => this.store.setSecureValue(`sb:${key}`, value),
      removeItem: (key: string) => this.store.removeSecureValue(`sb:${key}`),
    };
  }

  private async ensureClient(): Promise<SupabaseClient> {
    const { url, key } = await this.getServerConfig();
    if (this.client && this.activeClientUrl === url && this.activeClientKey === key) {
      return this.client;
    }
    this.teardownRealtime();
    const storage = this.createAuthStorage();
    this.client = this.clientFactory
      ? this.clientFactory(url, key, storage)
      : createClient(url, key, {
          auth: {
            storage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            flowType: 'pkce',
          },
        });
    this.activeClientUrl = url;
    this.activeClientKey = key;
    return this.client;
  }

  public getSupabaseBaseUrl(): string {
    if (this.activeClientUrl) return this.activeClientUrl;
    const customUrl = this.store.getSyncState('custom_supabase_url');
    if (this.hasCustomServerConfigured && customUrl) return customUrl;
    return DEFAULT_SYNC_SUPABASE_URL;
  }

  public async getSupabasePublishableKey(): Promise<string> {
    if (this.activeClientKey) return this.activeClientKey;
    const { key } = await this.getServerConfig();
    return key;
  }

  public async getActiveAccessToken(): Promise<string | null> {
    if (this.disposed) return null;
    if (!this.client && !this.userId) return null;
    try {
      const client = await this.ensureClient();
      const { data, error } = await client.auth.getSession();
      if (error || !data?.session?.access_token) return null;
      const expiresAtSec = data.session.expires_at ?? 0;
      const nowSec = Math.floor(Date.now() / 1000);
      if (
        expiresAtSec > 0 &&
        expiresAtSec - nowSec < 60 &&
        typeof client.auth.refreshSession === 'function'
      ) {
        try {
          const refreshed = await client.auth.refreshSession();
          if (refreshed.data?.session?.access_token) {
            return refreshed.data.session.access_token;
          }
        } catch {
          // fall back to existing token if offline/transient
        }
      }
      return data.session.access_token;
    } catch {
      return null;
    }
  }

  private resetClient(): void {
    this.teardownRealtime();
    try {
      const auth = this.client?.auth as unknown as { stopAutoRefresh?: () => void } | undefined;
      auth?.stopAutoRefresh?.();
    } catch {
      // ignore
    }
    this.client = null;
    this.activeClientUrl = '';
    this.activeClientKey = '';
  }

  private async loadCachedDek(userId: string): Promise<Uint8Array | null> {
    const b64 = await this.store.getSecureValue(`dek:${userId}`);
    if (!b64) return null;
    try {
      const bytes = base64ToBytes(b64);
      return bytes.length === 32 ? bytes : null;
    } catch {
      return null;
    }
  }

  private async saveCachedDek(userId: string, dek: Uint8Array): Promise<void> {
    // Strictly require hardware AndroidKeyStore on native Android (C3 — never downgrade DEK to wfb)
    if (mobileBridge.isNativeAndroid()) {
      try {
        await this.store.setSecureValue(`dek:${userId}`, bytesToBase64(dek), {
          requireOsProtection: true,
        });
      } catch {
        // Keep DEK in RAM only if Keystore is unavailable
      }
      return;
    }
    await this.store.setSecureValue(`dek:${userId}`, bytesToBase64(dek));
  }

  private async clearCachedDek(userId: string | null): Promise<void> {
    if (!userId) return;
    await this.store.removeSecureValue(`dek:${userId}`);
  }

  private async fallbackToOfflineCachedDek(): Promise<boolean> {
    const lastUserId = this.store.getSyncState('last_user_id');
    const lastEmail = this.store.getSyncState('last_user_email');
    if (!lastUserId || !lastEmail) return false;
    const cachedDek = await this.loadCachedDek(lastUserId);
    if (!cachedDek) return false;
    this.userId = lastUserId;
    this.email = lastEmail;
    this.setDek(cachedDek);
    this.needsEnvelopeVerification = true;
    this.state = 'offline';
    this.startBackgroundLoops();
    return true;
  }

  private async restoreExistingSession(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const { data, error } = await client.auth.getSession();
      if (error) {
        if (isNetworkLikeError(error)) {
          await this.fallbackToOfflineCachedDek();
        }
        return;
      }
      if (!data.session?.user) {
        return;
      }

      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? this.store.getSyncState('last_user_email');
      await this.store.setSyncState('last_user_id', this.userId);
      if (this.email) await this.store.setSyncState('last_user_email', this.email);

      await this.resolveKeyStateAfterAuth();
      if (this.dek) {
        this.startBackgroundLoops();
        void this.syncNow().catch(() => {});
      }
    } catch (err) {
      if (isNetworkLikeError(err)) {
        await this.fallbackToOfflineCachedDek();
      }
    }
  }

  private async fetchRemoteEnvelope(userId: string): Promise<SyncKeyEnvelopeRow | null> {
    const client = await this.ensureClient();
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

  private async resetCursorOnAccountSwitch(nextUserId: string): Promise<void> {
    const prevUserId = this.store.getSyncState('last_user_id');
    if (prevUserId && prevUserId !== nextUserId) {
      await this.store.deleteSyncState('last_cursor');
      await this.store.deleteSyncState('initial_enqueued_user');
      await this.store.clearSyncBlobCache();
    }
    await this.store.setSyncState('last_user_id', nextUserId);
  }

  private async ensureInitialEnqueueForUser(userId: string): Promise<void> {
    if (this.store.getSyncState('initial_enqueued_user') === userId) return;
    await this.store.enqueueAllSyncableEntities();
    await this.store.setSyncState('initial_enqueued_user', userId);
  }

  private async resolveKeyStateAfterAuth(): Promise<void> {
    if (!this.userId) return;
    const cachedDek = await this.loadCachedDek(this.userId);
    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        this.setDek(null);
        this.state = 'needs_passphrase_setup';
        this.emitStatus();
        return;
      }
      if (cachedDek && (await verifyKeyCheckToken(cachedDek, this.userId, envelope.key_check_token))) {
        this.setDek(cachedDek);
        this.needsEnvelopeVerification = false;
        this.state = 'synced';
        await this.ensureInitialEnqueueForUser(this.userId);
        this.emitStatus();
        return;
      }
      if (cachedDek) {
        await this.clearCachedDek(this.userId);
      }
      this.setDek(null);
      this.state = 'needs_passphrase_unlock';
      this.emitStatus();
    } catch (err) {
      if (cachedDek && isNetworkLikeError(err)) {
        this.setDek(cachedDek);
        this.needsEnvelopeVerification = true;
        this.state = 'offline';
        this.emitStatus();
        return;
      }
      throw err;
    }
  }

  public async configureServer(input: SyncServerConfigInput): Promise<SyncStatus> {
    const normalizedUrl = input.supabaseUrl.trim().replace(/\/+$/, '');
    const cleanKey = input.supabasePublishableKey.trim();
    if (normalizedUrl || cleanKey) {
      const locale = this.store.getLocale();
      let parsed: URL;
      try {
        parsed = new URL(normalizedUrl);
      } catch {
        throw new Error(tm('sync.invalidServerUrl', undefined, locale));
      }
      if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        /\s/.test(normalizedUrl)
      ) {
        throw new Error(tm('sync.serverHttpsRequired', undefined, locale));
      }
      if (cleanKey.length < 16) {
        throw new Error(tm('sync.invalidServerKey', undefined, locale));
      }
    }

    await this.signOut();
    if (!normalizedUrl || !cleanKey) {
      await this.store.deleteSyncState('custom_supabase_url');
      await this.store.removeSecureValue('custom_supabase_key');
      this.hasCustomServerConfigured = false;
    } else {
      await this.store.setSyncState('custom_supabase_url', normalizedUrl);
      await this.store.setSecureValue('custom_supabase_key', cleanKey);
      this.hasCustomServerConfigured = true;
    }
    this.resetClient();
    this.emitStatus();
    return this.getStatus();
  }

  public async signUp(email: string, password: string): Promise<SyncAuthResult> {
    const locale = this.store.getLocale();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return { ok: false, error: tm('sync.enterValidEmail', undefined, locale), status: this.getStatus() };
    }
    if (password.length < 6) {
      return {
        ok: false,
        error: tm('sync.errPasswordMin6', undefined, locale),
        status: this.getStatus(),
      };
    }

    try {
      this.authGeneration += 1;
      const client = await this.ensureClient();
      const { data, error } = await client.auth.signUp({ email: cleanEmail, password });
      if (error) {
        const msg = translateMobileSyncError(error, locale);
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      if (!data.session) {
        this.email = cleanEmail;
        this.userId = data.user?.id ?? null;
        this.state = 'awaiting_email_confirm';
        this.lastError = null;
        await this.store.setSyncState('pending_confirm_email', cleanEmail);
        this.emitStatus();
        return { ok: true, needsEmailConfirmation: true, status: this.getStatus() };
      }

      await this.resetCursorOnAccountSwitch(data.session.user.id);
      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? cleanEmail;
      await this.store.setSyncState('last_user_email', this.email);
      await this.store.deleteSyncState('pending_confirm_email');
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
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signIn(email: string, password: string): Promise<SyncAuthResult> {
    const locale = this.store.getLocale();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      return { ok: false, error: tm('sync.enterEmailAndPassword', undefined, locale), status: this.getStatus() };
    }

    try {
      this.authGeneration += 1;
      const client = await this.ensureClient();
      const { data, error } = await client.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (error || !data.session?.user) {
        const msg = translateMobileSyncError(error ?? tm('sync.signInFailed', undefined, locale), locale);
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      await this.resetCursorOnAccountSwitch(data.session.user.id);
      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? cleanEmail;
      await this.store.setSyncState('last_user_email', this.email);
      await this.store.deleteSyncState('pending_confirm_email');
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
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signInWithGoogle(): Promise<SyncAuthResult> {
    const locale = this.store.getLocale();
    try {
      this.authGeneration += 1;
      const client = await this.ensureClient();
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: 'com.notesplus.kapsula://auth-callback',
          skipBrowserRedirect: true,
          queryParams: { prompt: 'select_account' },
        },
      });
      if (error || !data?.url) {
        const msg = translateMobileSyncError(
          error ?? tm('sync.googleStartFailed', undefined, locale),
          locale
        );
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }
      this.lastError = null;
      this.emitStatus();
      await mobileBridge.openExternalUrl(data.url);
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async completeOAuthCallback(url: string): Promise<SyncAuthResult> {
    const locale = this.store.getLocale();
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      const msg = tm('sync.googleBadCallback', undefined, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }

    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const oauthErr =
      parsed.searchParams.get('error_description') ||
      parsed.searchParams.get('error') ||
      hashParams.get('error_description') ||
      hashParams.get('error');
    if (oauthErr) {
      const msg = translateMobileSyncError(oauthErr, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
      const msg = tm('sync.googleFinishFailed', undefined, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }

    try {
      this.authGeneration += 1;
      const client = await this.ensureClient();
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error || !data?.session?.user) {
        const msg = translateMobileSyncError(
          error ?? tm('sync.googleConfirmFailed', undefined, locale),
          locale
        );
        this.lastError = msg;
        this.emitStatus();
        return { ok: false, error: msg, status: this.getStatus() };
      }

      await this.resetCursorOnAccountSwitch(data.session.user.id);
      this.userId = data.session.user.id;
      this.email = data.session.user.email ?? this.store.getSyncState('last_user_email');
      if (this.email) await this.store.setSyncState('last_user_email', this.email);
      await this.store.deleteSyncState('pending_confirm_email');
      this.lastError = null;
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
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async setupPassphrase(passphrase: string): Promise<SyncSetupPassphraseResult> {
    const locale = this.store.getLocale();
    if (!this.userId) {
      return { ok: false, error: tm('sync.signInFirst', undefined, locale), status: this.getStatus() };
    }

    try {
      const existing = await this.fetchRemoteEnvelope(this.userId);
      if (existing) {
        this.state = 'needs_passphrase_unlock';
        this.emitStatus();
        return {
          ok: false,
          error: tm('sync.envelopeCreatedElsewhere', undefined, locale),
          status: this.getStatus(),
        };
      }

      const { dek, recoveryKey, envelope } = await createKeyEnvelope(
        this.userId,
        passphrase,
        this.kdfIterations
      );
      const client = await this.ensureClient();
      const { error } = await client.from('sync_key_envelopes').insert(envelope);
      if (error) {
        dek.fill(0);
        const low = (error.message || '').toLowerCase();
        if (low.includes('duplicate') || low.includes('23505')) {
          this.state = 'needs_passphrase_unlock';
          this.emitStatus();
          return {
            ok: false,
            error: tm('sync.envelopeJustCreatedElsewhere', undefined, locale),
            status: this.getStatus(),
          };
        }
        throw new Error(error.message);
      }

      this.setDek(dek);
      dek.fill(0);
      this.needsEnvelopeVerification = false;
      await this.saveCachedDek(this.userId, this.dek!);
      await this.ensureInitialEnqueueForUser(this.userId);
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
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async unlockWithPassphrase(passphrase: string): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (!this.userId) {
      return { ok: false, error: tm('sync.signInFirst', undefined, locale), status: this.getStatus() };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        this.state = 'needs_passphrase_setup';
        this.emitStatus();
        return {
          ok: false,
          error: tm('sync.noPassphraseYet', undefined, locale),
          status: this.getStatus(),
        };
      }

      const dek = await unwrapDekWithPassphrase(
        this.userId,
        passphrase,
        envelope,
        this.getMinKdfIterations()
      );
      this.setDek(dek);
      dek.fill(0);
      this.needsEnvelopeVerification = false;
      await this.saveCachedDek(this.userId, this.dek!);
      await this.ensureInitialEnqueueForUser(this.userId);
      this.lastError = null;
      this.state = 'synced';
      this.emitStatus();

      this.startBackgroundLoops();
      return await this.syncNow();
    } catch (err) {
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async unlockWithRecoveryKey(
    recoveryKey: string,
    newPassphrase?: string
  ): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (!this.userId) {
      return { ok: false, error: tm('sync.signInFirst', undefined, locale), status: this.getStatus() };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return {
          ok: false,
          error: tm('sync.keyNotCreated', undefined, locale),
          status: this.getStatus(),
        };
      }

      const dek = await unwrapDekWithRecoveryKey(this.userId, recoveryKey, envelope);
      if (newPassphrase && newPassphrase.trim().length > 0) {
        const updated = await rewrapEnvelopePassphrase(
          this.userId,
          dek,
          newPassphrase,
          envelope,
          this.kdfIterations
        );
        const client = await this.ensureClient();
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
      dek.fill(0);
      this.needsEnvelopeVerification = false;
      await this.saveCachedDek(this.userId, this.dek!);
      await this.ensureInitialEnqueueForUser(this.userId);
      this.lastError = null;
      this.state = 'synced';
      this.emitStatus();

      this.startBackgroundLoops();
      return await this.syncNow();
    } catch (err) {
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async regenerateRecoveryKey(): Promise<SyncSetupPassphraseResult> {
    const locale = this.store.getLocale();
    if (!this.userId || !this.dek) {
      return {
        ok: false,
        error: tm('sync.connectAndUnlockFirst', undefined, locale),
        status: this.getStatus(),
      };
    }

    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return { ok: false, error: tm('sync.keyNotFoundCloud', undefined, locale), status: this.getStatus() };
      }
      const { recoveryKey, envelope: updated } = await rewrapEnvelopeRecoveryKey(
        this.userId,
        this.dek,
        envelope
      );
      const client = await this.ensureClient();
      const { error } = await client
        .from('sync_key_envelopes')
        .update({
          wrapped_dek_recovery: updated.wrapped_dek_recovery,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', this.userId);
      if (error) throw new Error(error.message);

      await this.store.setSyncState('recovery_key_saved', '1');
      this.lastError = null;
      this.emitStatus();
      return { ok: true, recoveryKey, status: this.getStatus() };
    } catch (err) {
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async changePassphrase(
    currentPassphrase: string,
    newPassphrase: string
  ): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (!this.userId) {
      return { ok: false, error: tm('sync.signInFirst', undefined, locale), status: this.getStatus() };
    }
    try {
      const envelope = await this.fetchRemoteEnvelope(this.userId);
      if (!envelope) {
        return { ok: false, error: tm('sync.keyNotFound', undefined, locale), status: this.getStatus() };
      }
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
      const client = await this.ensureClient();
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
      dek.fill(0);
      await this.saveCachedDek(this.userId, this.dek!);
      this.lastError = null;
      this.emitStatus();
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      const msg = translateMobileSyncError(err, locale);
      this.lastError = msg;
      this.emitStatus();
      return { ok: false, error: msg, status: this.getStatus() };
    }
  }

  public async signOut(): Promise<SyncStatus> {
    this.authGeneration += 1;
    this.pendingResync = false;
    this.stopBackgroundLoops();
    const prevUserId = this.userId;
    try {
      if (this.client) {
        await this.client.auth.signOut();
      }
    } catch {
      // ignore offline error
    }
    this.resetClient();
    await this.clearCachedDek(prevUserId);
    await this.store.removeSecureByPrefix('sb:');
    await this.store.deleteSyncState('pending_confirm_email');
    await this.store.deleteSyncState('last_cursor');
    await this.store.deleteSyncState('last_sync_at');
    await this.store.deleteSyncState('last_reconcile_at');
    await this.store.deleteSyncState('last_user_id');
    await this.store.deleteSyncState('last_user_email');
    await this.store.deleteSyncState('initial_enqueued_user');
    await this.store.deleteSyncState('recovery_key_saved');
    await this.store.clearSyncBlobCache();
    await this.store.clearAllDirtyEntities();
    this.disabledOptionalTypes.clear();
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

  public handleAppResume(): void {
    if (this.disposed || !this.userId || !this.dek) return;
    if (!this.disableRealtime && !this.realtimeConnected) {
      this.teardownRealtime();
      this.setupRealtime();
    }
    void this.syncNow().catch(() => {});
  }

  private scheduleDirtyPush(): void {
    if (this.disposed || this.disableTimers || !this.userId || !this.dek) return;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.syncNow().catch(() => {});
    }, DIRTY_DEBOUNCE_MS);
  }

  private startBackgroundLoops(): void {
    if (this.disposed) return;
    if (!this.disableRealtime) {
      this.setupRealtime();
    }
    if (!this.disableTimers && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        if (!this.disposed && this.userId && this.dek) {
          void this.syncNow().catch(() => {});
        }
      }, SYNC_POLL_INTERVAL_MS);
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
    this.realtimeReconnectAttempt = 0;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.teardownRealtime();
  }

  private scheduleRealtimeReconnect(): void {
    if (this.disposed || this.disableRealtime || this.disableTimers || !this.userId || !this.dek) {
      return;
    }
    if (this.realtimeReconnectTimer) return;
    const delayMs = Math.min(30_000, 3_000 * Math.pow(2, this.realtimeReconnectAttempt));
    this.realtimeReconnectAttempt = Math.min(this.realtimeReconnectAttempt + 1, 5);
    this.realtimeReconnectTimer = setTimeout(() => {
      this.realtimeReconnectTimer = null;
      if (this.disposed || !this.userId || !this.dek) return;
      this.teardownRealtime();
      this.setupRealtime();
    }, delayMs);
  }

  private setupRealtime(): void {
    if (!this.client || !this.userId || this.realtimeChannel || this.disposed) return;
    const activeUserId = this.userId;
    try {
      const channel = this.client
        .channel(`kapsula-mobile-sync:${activeUserId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'sync_records',
            filter: `user_id=eq.${activeUserId}`,
          },
          (payload) => {
            if (this.disposed || this.userId !== activeUserId) return;
            const devId = (payload.new as { device_id?: string } | null)?.device_id;
            if (devId && devId === this.deviceId) return;
            if (this.realtimeTimer) clearTimeout(this.realtimeTimer);
            this.realtimeTimer = setTimeout(() => {
              this.realtimeTimer = null;
              void this.syncNow().catch(() => {});
            }, REALTIME_DEBOUNCE_MS);
          }
        )
        .subscribe((status) => {
          if (this.disposed || this.userId !== activeUserId) return;
          if (status === 'SUBSCRIBED') {
            this.realtimeConnected = true;
            this.realtimeReconnectAttempt = 0;
            this.emitStatus();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.realtimeConnected = false;
            this.emitStatus();
            this.scheduleRealtimeReconnect();
          }
        });
      this.realtimeChannel = channel;
    } catch {
      this.realtimeConnected = false;
      this.scheduleRealtimeReconnect();
    }
  }

  private teardownRealtime(): void {
    if (this.realtimeChannel && this.client) {
      try {
        void this.client.removeChannel(this.realtimeChannel);
      } catch {
        // ignore
      }
    }
    this.realtimeChannel = null;
    this.realtimeConnected = false;
  }

  public async syncNow(): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (this.disposed) {
      return { ok: false, error: tm('sync.stopped', undefined, locale), status: this.getStatus() };
    }
    if (this.inFlightSync) {
      this.pendingResync = true;
      return this.inFlightSync;
    }

    const gen = this.authGeneration;
    const savedCursor = Number(this.store.getSyncState('last_cursor') || '0') || 0;
    const dueAutoReconcile =
      savedCursor > 0 &&
      (!this.lastReconcileAt || Date.now() - this.lastReconcileAt >= AUTO_RECONCILE_INTERVAL_MS);

    const run = this.executeSyncCycle(gen, dueAutoReconcile).finally(() => {
      if (this.inFlightSync === run) {
        this.inFlightSync = null;
      }
      if (this.pendingResync && !this.disposed && gen === this.authGeneration) {
        this.pendingResync = false;
        void this.syncNow().catch(() => {});
      }
    });
    this.inFlightSync = run;
    return run;
  }

  public async reconcileFull(): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (this.disposed) {
      return { ok: false, error: tm('sync.stopped', undefined, locale), status: this.getStatus() };
    }
    if (this.inFlightSync) {
      try {
        await this.inFlightSync;
      } catch {
        // proceed to reconcile
      }
    }
    const gen = this.authGeneration;
    const run = this.executeSyncCycle(gen, true).finally(() => {
      if (this.inFlightSync === run) {
        this.inFlightSync = null;
      }
      if (this.pendingResync && !this.disposed && gen === this.authGeneration) {
        this.pendingResync = false;
        void this.syncNow().catch(() => {});
      }
    });
    this.inFlightSync = run;
    return run;
  }

  private async upsertSyncRecordWithSelect(
    client: SupabaseClient,
    rowPayload: Record<string, unknown>
  ): Promise<{
    serverRow: {
      server_seq?: number;
      updated_at?: number;
      sync_version?: number;
      deleted_at?: number | null;
      device_id?: string;
    } | null;
    error: { message: string; code?: string } | null;
  }> {
    const query = client
      .from('sync_records')
      .upsert(rowPayload, { onConflict: 'user_id,entity_type,entity_id' });

    const hasSelect =
      query && typeof (query as unknown as { select?: unknown }).select === 'function';
    const res = hasSelect
      ? await (
          query as unknown as {
            select: (
              cols: string
            ) => Promise<{ data?: unknown; error: { message: string; code?: string } | null }>;
          }
        ).select('server_seq, updated_at, sync_version, deleted_at, device_id')
      : await (query as unknown as Promise<{
          data?: unknown;
          error: { message: string; code?: string } | null;
        }>);

    if (res?.error) {
      return { serverRow: null, error: res.error };
    }
    const data = res?.data;
    const serverRow = Array.isArray(data)
      ? (data[0] ?? null)
      : data && typeof data === 'object'
        ? data
        : null;
    return {
      serverRow: serverRow as {
        server_seq?: number;
        updated_at?: number;
        sync_version?: number;
        deleted_at?: number | null;
        device_id?: string;
      } | null,
      error: null,
    };
  }

  private async executeSyncCycle(gen: number, fullReconcile = false): Promise<SyncActionResult> {
    const locale = this.store.getLocale();
    if (!this.userId || !this.dek) {
      return {
        ok: false,
        error:
          this.state === 'needs_passphrase_unlock'
            ? tm('sync.enterPassphraseToSync', undefined, locale)
            : tm('sync.notConnected', undefined, locale),
        status: this.getStatus(),
      };
    }

    const client = await this.ensureClient();
    const userId = this.userId;
    const dek = new Uint8Array(new ArrayBuffer(this.dek.byteLength));
    dek.set(this.dek);

    this.state = 'syncing';
    this.lastError = null;
    this.emitStatus();

    let pushed = 0;
    let pulled = 0;
    let blobsUploaded = 0;
    let blobsDownloaded = 0;

    try {
      if (this.needsEnvelopeVerification) {
        const remoteEnv = await this.fetchRemoteEnvelope(userId);
        if (gen !== this.authGeneration || this.disposed) {
          return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
        }
        if (!remoteEnv) {
          this.setDek(null);
          this.state = 'needs_passphrase_setup';
          this.emitStatus();
          return { ok: false, error: tm('sync.setPassphraseFirst', undefined, locale), status: this.getStatus() };
        }
        if (!(await verifyKeyCheckToken(dek, userId, remoteEnv.key_check_token))) {
          await this.clearCachedDek(userId);
          this.setDek(null);
          this.state = 'needs_passphrase_unlock';
          this.emitStatus();
          return {
            ok: false,
            error: tm('sync.keyChangedEnterNew', undefined, locale),
            status: this.getStatus(),
          };
        }
        this.needsEnvelopeVerification = false;
      }

      // 1. PULL-BEFORE-PUSH with MVCC overlap-rewind (or cursor=0 on full reconcile)
      const persistedCursor = Number(this.store.getSyncState('last_cursor') || '0') || 0;
      let queryCursor = fullReconcile ? 0 : Math.max(0, persistedCursor - CURSOR_OVERLAP_REWIND);
      let highWaterCursor = persistedCursor;
      let anyPulledChanges = false;
      const remoteSeenDuringFull = fullReconcile
        ? new Map<
            string,
            {
              updated_at: number;
              deleted_at: number | null;
              sync_version: number;
              device_id: string;
              purged?: boolean;
            }
          >()
        : null;
      const failedPullKeys = fullReconcile ? new Set<string>() : null;

      try {
        while (true) {
          if (gen !== this.authGeneration || this.disposed) {
            return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
          }

          const { data: rows, error: pullErr } = await client
            .from('sync_records')
            .select('*')
            .eq('user_id', userId)
            .gt('server_seq', queryCursor)
            .order('server_seq', { ascending: true })
            .limit(PULL_PAGE_SIZE);

          if (pullErr) throw new Error(pullErr.message);
          const batch = (rows ?? []) as SyncRecordRow[];
          if (batch.length === 0) break;

          for (const row of batch) {
            if (gen !== this.authGeneration || this.disposed) {
              return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
            }
            const nextSeq = Number(row.server_seq) || queryCursor;
            const recordKey = `${row.entity_type}:${row.entity_id}`;
            remoteSeenDuringFull?.set(recordKey, {
              updated_at: Number(row.updated_at ?? 0),
              deleted_at: row.deleted_at == null ? null : Number(row.deleted_at),
              sync_version: Number(row.sync_version ?? 1),
              device_id: row.device_id,
            });

            if (row.device_id === this.deviceId || row.schema_version > SYNC_SCHEMA_VERSION) {
              queryCursor = Math.max(queryCursor, nextSeq);
              if (nextSeq > highWaterCursor) {
                highWaterCursor = nextSeq;
                await this.store.setSyncState('last_cursor', String(highWaterCursor));
              }
              continue;
            }

            try {
              const dl = await this.applyIncomingRecord(client, userId, dek, row);
              if (fullReconcile && dl.wasPurged) {
                const seen = remoteSeenDuringFull?.get(recordKey);
                if (seen) seen.purged = true;
              }
              blobsDownloaded += dl.blobsDownloaded;
              if (dl.applied) {
                pulled += 1;
                anyPulledChanges = true;
              } else if (dl.localStrictlyNewer) {
                await this.store.markDirty(row.entity_type, row.entity_id, true);
              }
            } catch (rowErr) {
              if (isNetworkLikeError(rowErr) || isAuthFatalError(rowErr)) {
                throw rowErr;
              }
              failedPullKeys?.add(recordKey);
              // Isolate corrupt/unknown incoming record so subsequent deletes & notes still pull!
            }

            queryCursor = Math.max(queryCursor, nextSeq);
            if (nextSeq > highWaterCursor) {
              highWaterCursor = nextSeq;
              await this.store.setSyncState('last_cursor', String(highWaterCursor));
            }
          }

          if (batch.length < PULL_PAGE_SIZE) break;
        }
      } finally {
        if (anyPulledChanges) {
          this.store.notifySyncedBatch();
        }
      }

      // On full reconcile, push any local tombstones missing remotely or overridden by stale live rows
      // (strictly skipping failed pulls & locked soft-deleted secrets so we never wipe restored secrets!)
      if (fullReconcile) {
        await this.store.resetDirtyRetryBackoff();
        if (remoteSeenDuringFull) {
          for (const tomb of this.store.listLocalTombstoneIds()) {
            const tombKey = `${tomb.entityType}:${tomb.entityId}`;
            if (failedPullKeys?.has(tombKey)) {
              continue;
            }
            if (tomb.dna === 'secret' && tomb.purgedAt == null && this.isVaultLocked?.()) {
              continue;
            }
            const remoteInfo = remoteSeenDuringFull.get(tombKey);
            if (!remoteInfo) {
              await this.store.markDirty(tomb.entityType, tomb.entityId, true);
            } else if (
              remoteInfo.deleted_at == null ||
              (tomb.purgedAt != null && remoteInfo.device_id !== this.deviceId && !remoteInfo.purged)
            ) {
              const bumpedUpdatedAt = Math.max(remoteInfo.updated_at + 1, Date.now());
              const bumpedSyncVersion = Math.max(tomb.syncVersion, remoteInfo.sync_version) + 1;
              await this.store.bumpEntityTimestampForRetry(
                tomb.entityType,
                tomb.entityId,
                bumpedUpdatedAt,
                bumpedSyncVersion
              );
              await this.store.markDirty(tomb.entityType, tomb.entityId, true);
            }
          }
        }
      }

      // 2. PUSH LOCAL DIRTY ENTITIES IN DEPENDENCY ORDER (per-record dead-letter isolation + full queue drain)
      const attemptedInCycle = new Set<string>();
      while (true) {
        if (gen !== this.authGeneration || this.disposed) {
          return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
        }
        const dirtyBatch = this.store
          .listDirtyEntities(PUSH_BATCH_SIZE)
          .filter((entry) => !attemptedInCycle.has(`${entry.key}:${entry.dirtySeq}`));
        if (dirtyBatch.length === 0) break;

        for (const entry of dirtyBatch) {
          if (gen !== this.authGeneration || this.disposed) {
            return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
          }
          attemptedInCycle.add(`${entry.key}:${entry.dirtySeq}`);

          if (this.disabledOptionalTypes.has(entry.entityType)) {
            await this.store.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
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
              await this.store.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
              continue;
            }
            blobsUploaded += built.blobsUploaded;

            let enc = await encryptRecordPayload(
              dek,
              userId,
              entry.entityType,
              entry.entityId,
              built.payload
            );
            let upsertRes = await this.upsertSyncRecordWithSelect(client, {
              user_id: userId,
              entity_type: entry.entityType,
              entity_id: entry.entityId,
              updated_at: built.updatedAt,
              deleted_at: built.deletedAt,
              sync_version: built.syncVersion,
              device_id: this.deviceId,
              schema_version: SYNC_SCHEMA_VERSION,
              payload_ciphertext: enc.payload_ciphertext,
              payload_iv: enc.payload_iv,
              payload_tag: enc.payload_tag,
            });

            if (upsertRes.error) {
              if (
                isOptionalEntityType(entry.entityType) &&
                isEntityTypeCheckConstraintError(upsertRes.error)
              ) {
                this.disabledOptionalTypes.add(entry.entityType);
                await this.store.clearDirtyByEntityType(entry.entityType);
                continue;
              }
              throw new Error(upsertRes.error.message);
            }

            // Detect clock-skew silent server drop on user-initiated delete/purge and retry once (delete-wins!)
            const srv = upsertRes.serverRow;
            const localIsDelete = built.deletedAt != null;
            const serverDroppedDelete =
              localIsDelete &&
              srv &&
              (srv.deleted_at == null ||
                (built.purgedAt != null &&
                  srv.device_id !== this.deviceId &&
                  Number(srv.updated_at ?? 0) > built.updatedAt));

            if (serverDroppedDelete && srv) {
              const bumpedUpdatedAt = Math.max(Number(srv.updated_at ?? 0) + 1, Date.now());
              const bumpedSyncVersion =
                Math.max(built.syncVersion, Number(srv.sync_version ?? 1)) + 1;
              await this.store.bumpEntityTimestampForRetry(
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
                enc = await encryptRecordPayload(
                  dek,
                  userId,
                  entry.entityType,
                  entry.entityId,
                  built.payload
                );
                upsertRes = await this.upsertSyncRecordWithSelect(client, {
                  user_id: userId,
                  entity_type: entry.entityType,
                  entity_id: entry.entityId,
                  updated_at: built.updatedAt,
                  deleted_at: built.deletedAt,
                  sync_version: built.syncVersion,
                  device_id: this.deviceId,
                  schema_version: SYNC_SCHEMA_VERSION,
                  payload_ciphertext: enc.payload_ciphertext,
                  payload_iv: enc.payload_iv,
                  payload_tag: enc.payload_tag,
                });
                if (upsertRes.error) {
                  throw new Error(upsertRes.error.message);
                }
              }
            } else if (srv && srv.device_id && srv.device_id !== this.deviceId) {
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
                  remoteLatest as SyncRecordRow
                );
                blobsDownloaded += dl.blobsDownloaded;
                if (dl.applied) {
                  pulled += 1;
                  this.store.notifySyncedBatch();
                }
              }
            }

            await this.store.clearDirtyEntity(entry.entityType, entry.entityId, entry.dirtySeq);
            pushed += 1;
            if (pushed === 1 || pushed % 3 === 0) {
              this.emitStatus();
            }
          } catch (recErr) {
            if (isNetworkLikeError(recErr) || isAuthFatalError(recErr)) {
              throw recErr;
            }
            if (
              isOptionalEntityType(entry.entityType) &&
              isEntityTypeCheckConstraintError(recErr)
            ) {
              this.disabledOptionalTypes.add(entry.entityType);
              await this.store.clearDirtyByEntityType(entry.entityType);
              continue;
            }
            const errMsg = translateMobileSyncError(recErr, locale);
            await this.store.recordDirtyFailure(entry.entityType, entry.entityId, errMsg);
            this.emitStatus();
          }
        }
      }

      // 3. HEARTBEAT & DEVICE ROSTER (platform: 'android')
      await this.syncDeviceRoster(client, userId);

      if (gen !== this.authGeneration || this.disposed) {
        return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
      }

      this.lastSyncAt = Date.now();
      await this.store.setSyncState('last_sync_at', String(this.lastSyncAt));
      if (fullReconcile || persistedCursor === 0) {
        this.lastReconcileAt = this.lastSyncAt;
        await this.store.setSyncState('last_reconcile_at', String(this.lastReconcileAt));
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
        return { ok: false, error: tm('sync.cancelled', undefined, locale), status: this.getStatus() };
      }
      const msg = translateMobileSyncError(err, locale);
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
    dek: Uint8Array,
    entityType: SyncEntityType,
    entityId: string
  ): Promise<{
    payload: unknown;
    updatedAt: number;
    deletedAt: number | null;
    purgedAt?: number | null;
    syncVersion: number;
    blobsUploaded: number;
  } | null> {
    if (entityType === 'orbit') {
      const row = this.store.getRawOrbit(entityId);
      if (!row) return null;
      const updatedAt = row.updatedAt ?? row.createdAt ?? Date.now();
      const payload: SyncedOrbitPayload = {
        v: 1,
        id: row.id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        color: row.color,
        sortOrder: row.sortOrder,
        isBuiltin: row.isBuiltin,
        createdAt: row.createdAt ?? updatedAt,
        updatedAt,
        deletedAt: row.deletedAt ?? null,
        syncVersion: row.syncVersion ?? 1,
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
      const row = this.store.getRawBoard(entityId);
      if (!row) return null;
      const updatedAt = row.updatedAt ?? row.createdAt;
      const payload: SyncedFocusBoardPayload = {
        v: 1,
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        icon: row.icon,
        color: row.color,
        sortOrder: row.sortOrder ?? 0,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt,
        deletedAt: row.deletedAt ?? null,
        syncVersion: row.syncVersion ?? 1,
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
      const ev = this.store.getRawCalendarEvent(entityId);
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
      const rev = this.store.getRawRevision(entityId);
      if (!rev) return null;
      const updatedAt = rev.updatedAt ?? rev.createdAt;
      const payload: SyncedItemRevisionPayload = {
        v: 1,
        id: rev.id,
        itemId: rev.itemId,
        title: rev.title ?? null,
        content: rev.content,
        source: rev.source,
        contentHash: rev.contentHash ?? '',
        deviceName: rev.deviceName ?? null,
        createdAt: rev.createdAt,
        updatedAt,
        deletedAt: rev.deletedAt ?? null,
        syncVersion: rev.syncVersion ?? 1,
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
      const payload = this.store.getWorkspacePrefsPayload();
      return {
        payload,
        updatedAt: payload.updatedAt,
        deletedAt: payload.deletedAt,
        syncVersion: payload.syncVersion,
        blobsUploaded: 0,
      };
    }

    const item = this.store.getRawItem(entityId);
    if (!item || item.isDemo) return null;

    const isPurged = item.purgedAt != null;
    let secretPayload: SecretPayload | null = null;
    if (item.encryptedSecretPayload && !isPurged) {
      try {
        secretPayload = await this.store.localCrypto.decryptSecretPayload(
          item.encryptedSecretPayload
        );
      } catch {
        throw new Error(tm('sync.secretReadFailedPaused', undefined, this.store.getLocale()));
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
      mediaMeta: isPurged ? null : item.mediaMeta,
      ogImageUrl: isPurged ? null : item.ogImageUrl,
      ocrText: isPurged ? '' : item.ocrText,
      extractedActions: isPurged ? [] : item.extractedActions,
      colorPalette: isPurged ? [] : item.colorPalette,
      secretPayload: isPurged ? null : secretPayload,
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
      deletedAt: item.deletedAt,
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
      deletedAt: item.deletedAt,
      purgedAt: item.purgedAt ?? null,
      syncVersion: payload.syncVersion,
      blobsUploaded: mediaResult.uploadedCount,
    };
  }

  private async applyIncomingRecord(
    client: SupabaseClient,
    userId: string,
    dek: Uint8Array,
    row: SyncRecordRow
  ): Promise<{
    applied: boolean;
    localStrictlyNewer: boolean;
    blobsDownloaded: number;
    wasPurged?: boolean;
  }> {
    const encFields = {
      payload_ciphertext: row.payload_ciphertext,
      payload_iv: row.payload_iv,
      payload_tag: row.payload_tag,
    };

    if (row.entity_type === 'orbit') {
      const payload = await decryptRecordPayload<SyncedOrbitPayload>(
        dek,
        userId,
        'orbit',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(tm('sync.corruptOrbit', undefined, this.store.getLocale()));
      }
      const res = await this.store.applySyncedOrbit(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'focus_board') {
      const payload = await decryptRecordPayload<SyncedFocusBoardPayload>(
        dek,
        userId,
        'focus_board',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(tm('sync.corruptBoard', undefined, this.store.getLocale()));
      }
      const res = await this.store.applySyncedBoard(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'calendar_event') {
      const payload = await decryptRecordPayload<SyncedCalendarEventPayload>(
        dek,
        userId,
        'calendar_event',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(tm('sync.corruptCalendar', undefined, this.store.getLocale()));
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
      const res = await this.store.applySyncedCalendarEvent(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded };
    }

    if (row.entity_type === 'item_revision') {
      const payload = await decryptRecordPayload<SyncedItemRevisionPayload>(
        dek,
        userId,
        'item_revision',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1 || payload.id !== row.entity_id) {
        throw new Error(tm('sync.corruptRevision', undefined, this.store.getLocale()));
      }
      const res = await this.store.applySyncedRevision(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type === 'workspace_prefs') {
      const payload = await decryptRecordPayload<SyncedWorkspacePrefsPayload>(
        dek,
        userId,
        'workspace_prefs',
        row.entity_id,
        encFields
      );
      if (payload.v !== 1) {
        throw new Error(tm('sync.corruptPrefs', undefined, this.store.getLocale()));
      }
      const res = await this.store.applySyncedWorkspacePrefs(payload, row.device_id, this.deviceId);
      return { ...res, blobsDownloaded: 0 };
    }

    if (row.entity_type !== 'item') {
      return { applied: false, localStrictlyNewer: false, blobsDownloaded: 0 };
    }

    const payload = await decryptRecordPayload<SyncedItemPayload>(
      dek,
      userId,
      'item',
      row.entity_id,
      encFields
    );
    if (payload.v !== 1 || payload.id !== row.entity_id) {
      throw new Error(tm('sync.corruptItem', undefined, this.store.getLocale()));
    }

    let blobsDownloaded = 0;
    if (!payload.deletedAt && payload.purgedAt == null && payload.mediaRefs?.length) {
      blobsDownloaded = await this.mediaManager.ensureDownloaded(
        client,
        userId,
        dek,
        payload.mediaRefs
      );
    }

    let localEncryptedSecret: string | null = null;
    if (payload.secretPayload && payload.purgedAt == null) {
      localEncryptedSecret = await this.store.localCrypto.encryptSecretPayload(
        payload.secretPayload
      );
    }

    const res = await this.store.applySyncedItem(
      payload,
      localEncryptedSecret,
      row.device_id,
      this.deviceId
    );
    return {
      applied: res.applied,
      localStrictlyNewer: res.localStrictlyNewer,
      blobsDownloaded,
      wasPurged: payload.purgedAt != null,
    };
  }

  private async syncDeviceRoster(client: SupabaseClient, userId: string): Promise<void> {
    try {
      await client.from('sync_devices').upsert(
        {
          user_id: userId,
          device_id: this.deviceId,
          device_name: this.deviceName,
          platform: this.platform,
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
      // device roster is informational
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.authGeneration += 1;
    this.store.setMutationListener(null);
    this.stopBackgroundLoops();
    if (this.removeOnlineListener) {
      this.removeOnlineListener();
      this.removeOnlineListener = null;
    }
    this.resetClient();
    this.setDek(null);
  }
}
