import type {
  AiStatus,
  AppearanceConfig,
  CalendarChecklistItem,
  CalendarEventKind,
  CalendarRecurrence,
  CanvasAnnotation,
  CaptureMode,
  ContentDna,
  ExtractedAction,
  ItemRevisionSource,
  ItemSource,
  ItemSubKind,
  MediaMeta,
  SecretMeta,
  SecretPayload,
  TaskBoardColumn,
} from './types';

// Built-in Kapsula Sync cloud project (public URL + publishable key only — RLS enforced per auth.uid())
export const DEFAULT_SYNC_SUPABASE_URL = 'https://gxkvuwipzbqocbxgyqty.supabase.co';
export const DEFAULT_SYNC_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_0Yjs60VzrxtrX7AbwiRDAA_BYbwU5UL';

export const SYNC_CRYPTO_VERSION = 1;
export const SYNC_KDF_ALG = 'pbkdf2-sha256' as const;
export const SYNC_KDF_ITERATIONS = 600_000;
export const SYNC_MIN_KDF_ITERATIONS = 100_000;
export const SYNC_MAX_KDF_ITERATIONS = 5_000_000;
export const SYNC_RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SYNC_RECOVERY_BYTE_LENGTH = 20; // 160-bit CSPRNG -> 32 unambiguous Base32 chars
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_STORAGE_BUCKET = 'kapsula-blobs';
export const SYNC_BLOB_MAGIC = 'KAPS1';
export const SYNC_BLOB_HEADER_BYTES = 5 + 12 + 16; // magic + iv + authTag

export type SyncEntityType =
  | 'item'
  | 'orbit'
  | 'focus_board'
  | 'calendar_event'
  | 'item_revision'
  | 'workspace_prefs';

export type SyncStateKind =
  | 'signed_out'
  | 'awaiting_email_confirm'
  | 'needs_passphrase_setup'
  | 'needs_passphrase_unlock'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error';

export type SyncPlatform = 'win32' | 'darwin' | 'android' | 'ios' | 'linux' | 'web';

export interface SyncDeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: SyncPlatform;
  appVersion: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export interface SyncStatus {
  state: SyncStateKind;
  email: string | null;
  userId: string | null;
  deviceId: string;
  deviceName: string;
  lastSyncAt: number | null;
  pendingCount: number;
  syncedRecordsCount: number;
  realtimeConnected: boolean;
  hasCustomServer: boolean;
  supabaseUrl: string;
  error: string | null;
  devices: SyncDeviceInfo[];
  hasRecoveryKeyBackupHint: boolean;
  lastReconcileAt?: number | null;
  failedDirtyCount?: number;
}

export interface SyncAuthInput {
  email: string;
  password: string;
}

export interface SyncAuthResult {
  ok: boolean;
  needsEmailConfirmation?: boolean;
  needsPassphraseSetup?: boolean;
  needsPassphraseUnlock?: boolean;
  error?: string;
  status: SyncStatus;
}

export interface SyncSetupPassphraseResult {
  ok: boolean;
  recoveryKey?: string;
  initialSyncOk?: boolean;
  error?: string;
  status: SyncStatus;
}

export interface SyncActionResult {
  ok: boolean;
  error?: string;
  pushed?: number;
  pulled?: number;
  blobsUploaded?: number;
  blobsDownloaded?: number;
  status: SyncStatus;
}

export interface SyncServerConfigInput {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

// Supabase Postgres row shapes
export interface SyncKeyEnvelopeRow {
  user_id: string;
  version: number;
  kdf_alg: string;
  kdf_iterations: number;
  kdf_salt: string;
  wrapped_dek_passphrase: string;
  wrapped_dek_recovery: string;
  key_check_token: string;
  created_at?: string;
  updated_at?: string;
}

export interface SyncRecordRow {
  user_id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  server_seq: number;
  updated_at: number;
  deleted_at: number | null;
  sync_version: number;
  device_id: string;
  schema_version: number;
  payload_ciphertext: string;
  payload_iv: string;
  payload_tag: string;
  server_updated_at?: string;
}

export interface SyncBlobRow {
  user_id: string;
  blob_id: string;
  byte_size: number;
  ext: string;
  created_at?: string;
}

export interface SyncMediaRef {
  localName: string;
  blobId: string;
  ext: string;
  byteSize: number;
}

// Decrypted E2EE entity payloads (cross-platform JSON contract v1)
export interface SyncedItemPayload {
  v: 1;
  id: string;
  dna: ContentDna;
  subKind: ItemSubKind;
  orbit: string;
  modeCaptured: CaptureMode;
  focusBoardId: string | null;
  title: string;
  body: string;
  summary: string;
  url: string | null;
  domain: string | null;
  platform: string | null;
  imagePath: string | null;
  thumbPath: string | null;
  mediaPath: string | null;
  mediaType: string | null;
  mediaDurationSec: number | null;
  mediaMeta: MediaMeta | null;
  ogImageUrl: string | null;
  ocrText: string;
  extractedActions: ExtractedAction[];
  colorPalette: string[];
  // Cross-platform plaintext secret inside the E2EE envelope (never sent unencrypted)
  secretPayload: SecretPayload | null;
  secretMeta: SecretMeta | null;
  tags: string[];
  source: ItemSource;
  externalId: string | null;
  contentHash: string;
  aiStatus: AiStatus;
  aiConfidence: number | null;
  isPinned: boolean;
  isArchived: boolean;
  remindAt: number | null;
  remindedAt: number | null;
  createdAt: number;
  updatedAt: number;
  contentUpdatedAt: number;
  deletedAt: number | null;
  purgedAt?: number | null;
  canvasX: number | null;
  canvasY: number | null;
  canvasW: number | null;
  canvasH: number | null;
  canvasFrame: string | null;
  annotations: CanvasAnnotation[];
  linksOut: string[];
  syncVersion: number;
  mediaRefs: SyncMediaRef[];
}

export interface SyncedOrbitPayload {
  v: 1;
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: number;
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
}

export interface SyncedFocusBoardPayload {
  v: 1;
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
}

export interface SyncedCalendarEventPayload {
  v: 1;
  id: string;
  title: string;
  notes: string;
  location: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  hasEndTime: boolean;
  color: string;
  kind: CalendarEventKind;
  recurrence: CalendarRecurrence;
  isDone: boolean;
  linkedItemId: string | null;
  checklist: CalendarChecklistItem[];
  attachments: string[];
  externalSource: string | null;
  externalId: string | null;
  etag: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
  mediaRefs: SyncMediaRef[];
}

export interface SyncedItemRevisionPayload {
  v: 1;
  id: string;
  itemId: string;
  title: string | null;
  content: string;
  source: ItemRevisionSource;
  contentHash: string;
  deviceName: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
}

export interface SyncedWorkspacePrefsPayload {
  v: 1;
  id: 'default';
  taskBoardColumns?: TaskBoardColumn[];
  appearance?: AppearanceConfig;
  updatedAt: number;
  deletedAt: number | null;
  syncVersion: number;
}

export type SyncedEntityPayload =
  | SyncedItemPayload
  | SyncedOrbitPayload
  | SyncedFocusBoardPayload
  | SyncedCalendarEventPayload
  | SyncedItemRevisionPayload
  | SyncedWorkspacePrefsPayload;

export function buildRecordAad(
  userId: string,
  entityType: SyncEntityType,
  entityId: string
): string {
  return `kapsula:v1:${userId}:${entityType}:${entityId}`;
}

export function buildBlobAad(userId: string, blobId: string): string {
  return `kapsula:blob:v1:${userId}:${blobId}`;
}

const INLINE_MEDIA_URL_RE = /kapsula-media:\/\/local\/([^\s)"'<>`?#]+)/gi;
const FORBIDDEN_MEDIA_CHAR_RE = /[/\\:*?"<>|\x00-\x1f\x7f]/;

/**
 * Extracts all sanitized, deduplicated local media filenames referenced via
 * `kapsula-media://local/<filename>` inside note Markdown/HTML bodies.
 * Rejects path traversal segments (`..`, slashes, control characters).
 */
export function extractInlineMediaFilenames(body: string | null | undefined): string[] {
  if (!body || !body.includes('kapsula-media://')) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  INLINE_MEDIA_URL_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE_MEDIA_URL_RE.exec(body)) !== null) {
    const rawSegment = match[1];
    if (!rawSegment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      continue;
    }
    const candidate = decoded.trim();
    if (
      !candidate ||
      candidate.length > 220 ||
      candidate === '.' ||
      candidate === '..' ||
      candidate.startsWith('.') ||
      candidate.endsWith('.') ||
      candidate.includes('..') ||
      FORBIDDEN_MEDIA_CHAR_RE.test(candidate)
    ) {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}
