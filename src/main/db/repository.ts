import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectPlatformIntent, expandBilingualQuery } from '@shared/bilingual-search';
import { DEFAULT_APPEARANCE_CONFIG } from '@shared/color-engine';
import {
  DEFAULT_MONTHLY_CAP_USD,
  MAX_TAGS_PER_ITEM,
  SECTION_COLOR_PALETTE,
  getOrganicSectionCatalog,
} from '@shared/constants';
import { detectLocale, normalizeLocale, translate } from '@shared/i18n';
import { truncateAtWordBoundary } from '@shared/html-entities';
import { isUntitledPlaceholderTitle } from '@shared/item-helpers';
import {
  extractWikiLinkTitles,
  getDefaultTaskBoardColumns,
  isDoneColumn,
  normalizeTaskTextHash,
  parseMarkdownTasks,
  reconcileTaskMeta,
  toggleMarkdownTaskInBody,
} from '@shared/task-helpers';
import type {
  AiProvider,
  AiStatus,
  AppLocale,
  AppearanceConfig,
  BudgetSummary,
  CalendarChecklistItem,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventKind,
  CanvasAnnotation,
  CaptureMode,
  ContentDna,
  CreateTaskInput,
  ExtractedAction,
  FocusBoard,
  FocusBoardUpdateInput,
  ItemRevision,
  ItemRevisionSource,
  ItemSource,
  ItemSubKind,
  MediaMeta,
  OrbitDef,
  OrbitUpdateInput,
  SecretMeta,
  TaskBoardColumn,
  TaskBoardItemMeta,
  TaskPriority,
  VaultInventorySummary,
  VaultItem,
  VaultQuery,
  VaultTaskEntry,
} from '@shared/types';
import {
  extractInlineMediaFilenames,
  type SyncedCalendarEventPayload,
  type SyncedFocusBoardPayload,
  type SyncedItemPayload,
  type SyncedItemRevisionPayload,
  type SyncedOrbitPayload,
  type SyncedWorkspacePrefsPayload,
  type SyncEntityType,
} from '@shared/sync-contract';
import { initSchema } from './schema';

export interface CreateItemRecordInput {
  id?: string;
  dna: ContentDna;
  subKind?: ItemSubKind;
  orbit: string;
  modeCaptured: CaptureMode;
  focusBoardId?: string | null;
  title: string;
  body?: string;
  summary?: string;
  url?: string | null;
  domain?: string | null;
  platform?: string | null;
  imagePath?: string | null;
  thumbPath?: string | null;
  mediaPath?: string | null;
  mediaType?: string | null;
  mediaDurationSec?: number | null;
  mediaMeta?: MediaMeta | null;
  ogImageUrl?: string | null;
  ocrText?: string;
  extractedActions?: ExtractedAction[];
  colorPalette?: string[];
  encryptedPayload?: string | null;
  secretMeta?: SecretMeta | null;
  tags?: string[];
  source: ItemSource;
  externalId?: string | null;
  contentHash: string;
  aiStatus?: AiStatus;
  aiConfidence?: number | null;
  isPinned?: boolean;
  isMuted?: boolean;
  isDemo?: boolean;
  remindAt?: number | null;
  remindedAt?: number | null;
  createdAt?: number;
  canvasX?: number | null;
  canvasY?: number | null;
  canvasW?: number | null;
  canvasH?: number | null;
  canvasFrame?: string | null;
  annotations?: CanvasAnnotation[];
  linksOut?: string[];
  skipSyncDirty?: boolean;
}

export interface UpdateItemPatch {
  dna?: ContentDna;
  subKind?: ItemSubKind;
  orbit?: string;
  focusBoardId?: string | null;
  title?: string;
  body?: string;
  summary?: string;
  url?: string | null;
  domain?: string | null;
  platform?: string | null;
  imagePath?: string | null;
  thumbPath?: string | null;
  mediaPath?: string | null;
  mediaType?: string | null;
  mediaDurationSec?: number | null;
  mediaMeta?: MediaMeta | null;
  ogImageUrl?: string | null;
  ocrText?: string;
  extractedActions?: ExtractedAction[];
  colorPalette?: string[];
  encryptedPayload?: string | null;
  secretMeta?: SecretMeta | null;
  tags?: string[];
  aiStatus?: AiStatus;
  aiConfidence?: number | null;
  isPinned?: boolean;
  isMuted?: boolean;
  isArchived?: boolean;
  remindAt?: number | null;
  remindedAt?: number | null;
  canvasX?: number | null;
  canvasY?: number | null;
  canvasW?: number | null;
  canvasH?: number | null;
  canvasFrame?: string | null;
  annotations?: CanvasAnnotation[];
  linksOut?: string[];
  skipSyncDirty?: boolean;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n]!;
}

const RU_ENDING_RE =
  /(?:ость|ение|ание|ями|ами|ого|его|ому|ему|ыми|ими|иях|иям|ием|ою|ею|ей|ов|ев|ий|ый|ой|ая|яя|ое|ее|ую|юю|ые|ие|ях|ам|ям|ом|ем|ах|[аяоеуыиью])$/i;

function computeSearchStem(tok: string): string {
  if (tok.length < 5) return tok;
  if (/[а-яё]/i.test(tok)) {
    const stripped = tok.replace(RU_ENDING_RE, '');
    if (stripped.length >= 4) return stripped;
    return tok.slice(0, Math.max(4, tok.length - 1));
  }
  return tok;
}

type SemanticMatchKind =
  | 'bank_card'
  | 'secret'
  | 'shot'
  | 'link'
  | 'voice'
  | 'doc'
  | 'contact'
  | 'snippet';

function detectSemanticKinds(tok: string): SemanticMatchKind[] {
  const kinds: SemanticMatchKind[] = [];
  if (/^(?:карт|банк|visa|mastercard|мир$)/i.test(tok)) kinds.push('bank_card');
  if (/^(?:сейф|секрет|парол|ключ|токен|pin|пин|cvv)/i.test(tok)) kinds.push('secret');
  if (/^(?:скрин|снимок|картинк|изображен|фото)/i.test(tok)) kinds.push('shot');
  if (/^(?:ссылк|сайт|линк|url)/i.test(tok)) kinds.push('link');
  if (/^(?:голос|аудио|дикт|звонк)/i.test(tok)) kinds.push('voice');
  if (/^(?:файл|докум|пдф|pdf)/i.test(tok)) kinds.push('doc');
  if (/^(?:контакт|телеф|номер|почт|email)/i.test(tok)) kinds.push('contact');
  if (/^(?:код|сниппет|скрипт|команд)/i.test(tok)) kinds.push('snippet');
  return kinds;
}

function itemMatchesSemanticKind(item: VaultItem, kind: SemanticMatchKind): boolean {
  switch (kind) {
    case 'bank_card':
      return item.secretMeta?.kind === 'bank_card';
    case 'secret':
      return item.dna === 'secret' || Boolean(item.secretMeta);
    case 'shot':
      return item.dna === 'shot';
    case 'link':
      return item.dna === 'link' || Boolean(item.url);
    case 'voice':
      return item.dna === 'voice' || Boolean(item.mediaPath && item.mediaType?.startsWith('audio/'));
    case 'doc':
      return item.dna === 'doc';
    case 'contact':
      return (
        item.subKind === 'contact' ||
        Boolean(item.mediaMeta?.contactPhone) ||
        /(?:\+7|8|\+\d{1,3})[\s()-]*(?:\d[\s()-]*){7,}/.test(`${item.title}\n${item.body}`)
      );
    case 'snippet':
      return item.dna === 'snippet' || /```/.test(item.body);
  }
}

export function normalizeTagText(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

export function canonicalizeTags(rawTags: string[], existingUniverse: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    let norm = normalizeTagText(raw);
    if (!norm || norm.length < 2) continue;
    if (norm.length >= 4) {
      for (const existing of existingUniverse) {
        if (existing === norm) break;
        const dist = levenshtein(norm, existing);
        const closeShort = existing.length >= 4 && dist <= 1;
        const closeInflected =
          norm.length >= 6 &&
          existing.length >= 6 &&
          norm.slice(0, 4) === existing.slice(0, 4) &&
          dist <= 2;
        if (closeShort || closeInflected) {
          norm = existing;
          break;
        }
      }
    }
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
      if (result.length >= MAX_TAGS_PER_ITEM) break;
    }
  }
  return result;
}

interface ItemRow {
  id: string;
  dna: ContentDna;
  sub_kind: ItemSubKind | null;
  orbit: string;
  mode_captured: CaptureMode;
  focus_board_id: string | null;
  title: string;
  body: string;
  summary: string;
  url: string | null;
  domain: string | null;
  platform: string | null;
  image_path: string | null;
  thumb_path: string | null;
  media_path: string | null;
  media_type: string | null;
  media_duration_sec: number | null;
  media_meta_json: string | null;
  og_image_url: string | null;
  ocr_text: string;
  extracted_actions_json: string;
  color_palette_json: string;
  encrypted_payload: string | null;
  secret_meta_json: string | null;
  tags_json: string;
  source: ItemSource;
  external_id: string | null;
  content_hash: string;
  ai_status: AiStatus;
  ai_confidence: number | null;
  is_pinned: number;
  is_muted?: number;
  is_archived: number;
  is_demo: number;
  remind_at: number | null;
  reminded_at: number | null;
  created_at: number;
  updated_at: number;
  content_updated_at?: number | null;
  deleted_at?: number | null;
  purged_at?: number | null;
  canvas_x?: number | null;
  canvas_y?: number | null;
  canvas_w?: number | null;
  canvas_h?: number | null;
  canvas_frame?: string | null;
  annotations_json?: string | null;
  links_out_json?: string | null;
  title_norm?: string | null;
  sync_version?: number | null;
  last_device_id?: string | null;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRowToItem(row: ItemRow): VaultItem {
  return {
    id: row.id,
    dna: row.dna,
    subKind: row.sub_kind ?? null,
    orbit: row.orbit ?? '',
    modeCaptured: row.mode_captured,
    focusBoardId: row.focus_board_id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    url: row.url,
    domain: row.domain,
    platform: row.platform,
    imagePath: row.image_path,
    thumbPath: row.thumb_path ?? null,
    mediaPath: row.media_path ?? null,
    mediaType: row.media_type ?? null,
    mediaDurationSec: row.media_duration_sec ?? null,
    mediaMeta: safeParseJson<MediaMeta | null>(row.media_meta_json, null),
    ogImageUrl: row.og_image_url,
    ocrText: row.ocr_text,
    extractedActions: safeParseJson<ExtractedAction[]>(row.extracted_actions_json, []),
    colorPalette: safeParseJson<string[]>(row.color_palette_json, []),
    hasEncryptedPayload: Boolean(row.encrypted_payload),
    secretMeta: safeParseJson<SecretMeta | null>(row.secret_meta_json, null),
    tags: safeParseJson<string[]>(row.tags_json, []),
    source: row.source,
    externalId: row.external_id,
    contentHash: row.content_hash,
    aiStatus: row.ai_status,
    aiConfidence: row.ai_confidence,
    isPinned: row.is_pinned === 1,
    isMuted: row.is_muted === 1,
    isArchived: row.is_archived === 1,
    isDemo: row.is_demo === 1,
    remindAt: row.remind_at ?? null,
    remindedAt: row.reminded_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentUpdatedAt: row.content_updated_at ?? row.updated_at ?? row.created_at,
    deletedAt: row.deleted_at ?? null,
    purgedAt: row.purged_at ?? null,
    canvasX: row.canvas_x ?? null,
    canvasY: row.canvas_y ?? null,
    canvasW: row.canvas_w ?? null,
    canvasH: row.canvas_h ?? null,
    canvasFrame: row.canvas_frame ?? null,
    annotations: safeParseJson<CanvasAnnotation[]>(row.annotations_json, []),
    linksOut: safeParseJson<string[]>(row.links_out_json, []),
    syncVersion: row.sync_version ?? 1,
  };
}

export function getCurrentMonthKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const DEAD_LETTER_BACKOFFS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const AUTO_REVISION_INTERVAL_MS = 5 * 60_000;
const AUTO_REVISION_LENGTH_DELTA = 120;
const MAX_REVISIONS_PER_ITEM = 30;
const MAX_SYNCED_REVISIONS_PER_ITEM = 15;
const VALID_TASK_PRIORITIES = new Set<TaskPriority>(['none', 'low', 'medium', 'high', 'urgent']);

function computeRevisionHash(title: string | null, content: string): string {
  return crypto
    .createHash('sha256')
    .update(`${title ?? ''}\0${content ?? ''}`, 'utf8')
    .digest('hex');
}

function escapeSqlLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class VaultRepository {
  public readonly db: DatabaseSync;
  private txDepth = 0;
  private tagUniverseCache: string[] | null = null;
  private vaultMutationVersion = 0;
  private tasksCache: { version: number; locale: AppLocale; tasks: VaultTaskEntry[] } | null = null;
  private relatedCache = new Map<
    string,
    Array<{ item: VaultItem; reason: string; score: number }>
  >();
  private ftsDeleteStmt: ReturnType<DatabaseSync['prepare']> | null = null;
  private ftsInsertStmt: ReturnType<DatabaseSync['prepare']> | null = null;
  private mutationListener: ((entityType: SyncEntityType, entityId: string) => void) | null = null;
  private dirtySeqCounter = 0;
  private localDeviceId: string | null = null;
  private defaultOsLocale?: string | null;

  private bumpVaultMutationVersion(): void {
    this.vaultMutationVersion += 1;
    this.tasksCache = null;
    this.relatedCache.clear();
  }

  public setDefaultOsLocale(osLocale?: string | null): void {
    this.defaultOsLocale = osLocale ?? undefined;
  }

  public setLocalDeviceId(deviceId: string | null): void {
    this.localDeviceId = deviceId?.trim() || null;
  }

  public getLocalDeviceId(): string | null {
    return this.localDeviceId;
  }

  public setMutationListener(
    listener: ((entityType: SyncEntityType, entityId: string) => void) | null
  ): void {
    this.mutationListener = listener;
  }

  private nextDirtySeq(): number {
    if (this.dirtySeqCounter === 0) {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(dirty_seq), 0) AS m FROM sync_dirty')
        .get() as { m: number };
      this.dirtySeqCounter = Number(row?.m ?? 0);
    }
    this.dirtySeqCounter += 1;
    return this.dirtySeqCounter;
  }

  private monotonicTimestamp(prevUpdatedAt?: number | null): number {
    const now = Date.now();
    return prevUpdatedAt && prevUpdatedAt >= now ? prevUpdatedAt + 1 : now;
  }

  public markItemDirty(itemId: string): void {
    this.markDirty('item', itemId);
  }

  public markDirty(entityType: SyncEntityType, entityId: string): void {
    this.bumpVaultMutationVersion();
    try {
      const seq = this.nextDirtySeq();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sync_dirty
            (entity_type, entity_id, dirty_at, dirty_seq, fail_count, last_error, next_retry_at)
           VALUES (?, ?, ?, ?, 0, NULL, 0)`
        )
        .run(entityType, entityId, Date.now(), seq);
      this.mutationListener?.(entityType, entityId);
    } catch {
      // Never break local writes if sync tracking table is unavailable
    }
  }

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.function('lower_utf', (val: unknown) =>
      typeof val === 'string' ? val.toLowerCase() : ''
    );
    initSchema(this.db);
    this.localDeviceId = this.getSyncState('device_id');
    if (this.getSetting('fts_secret_exclude_v1') !== 'true') {
      this.inTx(() => {
        this.db.exec("DELETE FROM items_fts WHERE id IN (SELECT id FROM items WHERE dna = 'secret')");
        this.setSetting('fts_secret_exclude_v1', 'true');
      });
    }
  }

  private resolveWikiLinkIds(body: string | null | undefined, excludeId?: string): string[] {
    const titles = extractWikiLinkTitles(body);
    if (titles.length === 0) return [];
    const orderedNorms: string[] = [];
    const normSeen = new Set<string>();
    for (const rawTitle of titles) {
      const norm = rawTitle.trim().toLowerCase();
      if (norm && !normSeen.has(norm)) {
        normSeen.add(norm);
        orderedNorms.push(norm);
      }
    }
    if (orderedNorms.length === 0) return [];

    const placeholders = orderedNorms.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, title_norm FROM items
         WHERE deleted_at IS NULL
           AND purged_at IS NULL
           AND dna != 'secret'
           AND title_norm IN (${placeholders})
         ORDER BY created_at DESC`
      )
      .all(...orderedNorms) as Array<{ id: string; title_norm: string | null }>;

    const bestByNorm = new Map<string, string>();
    for (const row of rows) {
      if (row.title_norm && !bestByNorm.has(row.title_norm)) {
        bestByNorm.set(row.title_norm, row.id);
      }
    }

    // Fallback for legacy/raw-SQL rows inserted without title_norm
    if (bestByNorm.size < orderedNorms.length) {
      const hasNullNorm = Boolean(
        this.db.prepare('SELECT 1 FROM items WHERE title_norm IS NULL LIMIT 1').get()
      );
      if (hasNullNorm) {
        const legacyStmt = this.db.prepare(
          `SELECT id FROM items
           WHERE deleted_at IS NULL
             AND purged_at IS NULL
             AND dna != 'secret'
             AND title_norm IS NULL
             AND lower_utf(trim(title)) = ?
           ORDER BY created_at DESC
           LIMIT 1`
        );
        for (const norm of orderedNorms) {
          if (!bestByNorm.has(norm)) {
            const hit = legacyStmt.get(norm) as { id: string } | undefined;
            if (hit) bestByNorm.set(norm, hit.id);
          }
        }
      }
    }

    const seenIds = new Set<string>();
    const ids: string[] = [];
    for (const norm of orderedNorms) {
      const targetId = bestByNorm.get(norm);
      if (targetId && targetId !== excludeId && !seenIds.has(targetId)) {
        seenIds.add(targetId);
        ids.push(targetId);
      }
    }
    return ids;
  }

  private collectItemMediaRefs(row: ItemRow): string[] {
    const refs = new Set<string>();
    if (row.image_path) refs.add(row.image_path);
    if (row.thumb_path) refs.add(row.thumb_path);
    if (row.media_path) refs.add(row.media_path);
    const meta = safeParseJson<MediaMeta | null>(row.media_meta_json, null);
    if (meta?.galleryPaths) {
      for (const g of meta.galleryPaths) {
        if (typeof g === 'string' && g.trim()) refs.add(g.trim());
      }
    }
    for (const inlineFile of extractInlineMediaFilenames(row.body)) {
      refs.add(inlineFile);
    }
    return Array.from(refs);
  }

  private inTx<T>(fn: () => T): T {
    const isOuter = this.txDepth === 0;
    this.txDepth++;
    if (isOuter) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (isOuter) this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (isOuter) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  public close(): void {
    this.db.close();
  }

  public getExistingTagUniverse(): string[] {
    if (this.tagUniverseCache) {
      return [...this.tagUniverseCache];
    }
    const rows = this.db
      .prepare('SELECT tags_json FROM items WHERE deleted_at IS NULL AND is_archived = 0 LIMIT 500')
      .all() as Array<{ tags_json: string }>;
    const freq = new Map<string, number>();
    for (const r of rows) {
      const parsed = safeParseJson<string[]>(r.tags_json, []);
      for (const t of parsed) {
        const n = normalizeTagText(t);
        if (n) freq.set(n, (freq.get(n) ?? 0) + 1);
      }
    }
    this.tagUniverseCache = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([tag]) => tag);
    return [...this.tagUniverseCache];
  }

  private syncFtsRow(row: ItemRow): void {
    if (!this.ftsDeleteStmt) {
      this.ftsDeleteStmt = this.db.prepare('DELETE FROM items_fts WHERE id = ?');
    }
    this.ftsDeleteStmt.run(row.id);
    if (row.dna === 'secret') {
      return;
    }
    const tags = safeParseJson<string[]>(row.tags_json, []).join(' ');
    const meta = safeParseJson<MediaMeta | null>(row.media_meta_json, null);
    const extraSearch = [
      row.ocr_text,
      meta?.transcript ?? '',
      meta?.fileName ?? '',
      meta?.forwardAuthor ?? '',
      meta?.contactPhone ?? '',
      meta?.contactHandle ?? '',
      meta?.contactEmail ?? '',
      ...(meta?.keyPoints ?? []),
      ...(meta?.actionItems ?? []),
    ]
      .filter(Boolean)
      .join('\n');
    if (!this.ftsInsertStmt) {
      this.ftsInsertStmt = this.db.prepare(
        'INSERT INTO items_fts (id, title, summary, body, ocr_text, url, domain, tags_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
    }
    this.ftsInsertStmt.run(
      row.id,
      row.title,
      row.summary,
      row.body,
      extraSearch,
      row.url ?? '',
      row.domain ?? '',
      tags
    );
  }

  public createItem(input: CreateItemRecordInput): VaultItem {
    const now = input.createdAt ?? Date.now();
    const id = input.id ?? crypto.randomUUID();
    const universe = this.getExistingTagUniverse();
    const tags = canonicalizeTags(input.tags ?? [], universe);

    if (input.externalId) {
      const existing = this.findBySourceExternalId(input.source, input.externalId);
      if (existing) return existing;
    }

    const bodyText = input.body ?? '';
    const resolvedWikiLinks =
      input.dna === 'secret' ? [] : this.resolveWikiLinkIds(bodyText, id);
    const mergedLinksOut = Array.from(
      new Set([...(input.linksOut ?? []), ...resolvedWikiLinks])
    );

    const row = this.inTx(() => {
      this.db
        .prepare(
          `INSERT INTO items (
            id, dna, sub_kind, orbit, mode_captured, focus_board_id,
            title, title_norm, body, summary, url, domain, platform,
            image_path, thumb_path, media_path, media_type, media_duration_sec, media_meta_json, og_image_url,
            ocr_text, extracted_actions_json, color_palette_json,
            encrypted_payload, secret_meta_json, tags_json, source, external_id,
            content_hash, ai_status, ai_confidence, is_pinned, is_muted, is_archived, is_demo,
            remind_at, reminded_at, created_at, updated_at, content_updated_at,
            deleted_at, purged_at, canvas_x, canvas_y, canvas_w, canvas_h, canvas_frame,
            annotations_json, links_out_json, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          id,
          input.dna,
          input.subKind ?? null,
          input.orbit ?? '',
          input.modeCaptured,
          input.focusBoardId ?? null,
          input.title,
          (input.title || '').trim().toLowerCase(),
          bodyText,
          input.summary ?? '',
          input.url ?? null,
          input.domain ?? null,
          input.platform ?? null,
          input.imagePath ?? null,
          input.thumbPath ?? null,
          input.mediaPath ?? null,
          input.mediaType ?? null,
          input.mediaDurationSec ?? null,
          input.mediaMeta ? JSON.stringify(input.mediaMeta) : null,
          input.ogImageUrl ?? null,
          input.ocrText ?? '',
          JSON.stringify(input.extractedActions ?? []),
          JSON.stringify(input.colorPalette ?? []),
          input.encryptedPayload ?? null,
          input.secretMeta ? JSON.stringify(input.secretMeta) : null,
          JSON.stringify(tags),
          input.source,
          input.externalId ?? null,
          input.contentHash,
          input.aiStatus ?? 'local',
          input.aiConfidence ?? null,
          input.isPinned ? 1 : 0,
          input.isMuted ? 1 : 0,
          input.isDemo ? 1 : 0,
          input.remindAt ?? null,
          input.remindedAt ?? null,
          now,
          now,
          now,
          input.canvasX ?? null,
          input.canvasY ?? null,
          input.canvasW ?? null,
          input.canvasH ?? null,
          input.canvasFrame ?? null,
          JSON.stringify(input.annotations ?? []),
          JSON.stringify(mergedLinksOut),
          this.localDeviceId
        );

      const createdRow = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow;
      this.syncFtsRow(createdRow);
      this.tagUniverseCache = null;
      if (!input.isDemo && !input.skipSyncDirty) {
        this.markDirty('item', createdRow.id);
      }
      return createdRow;
    });
    return mapRowToItem(row);
  }

  public findBySourceExternalId(source: ItemSource, externalId: string): VaultItem | null {
    const row = this.db
      .prepare(
        'SELECT * FROM items WHERE source = ? AND external_id = ? AND deleted_at IS NULL AND purged_at IS NULL LIMIT 1'
      )
      .get(source, externalId) as ItemRow | undefined;
    return row ? mapRowToItem(row) : null;
  }

  public getItemById(
    id: string,
    opts: boolean | { includeDeleted?: boolean; includePurged?: boolean } = false
  ): VaultItem | null {
    const includeDeleted =
      typeof opts === 'boolean' ? opts : Boolean(opts.includeDeleted || opts.includePurged);
    const includePurged = typeof opts === 'boolean' ? false : Boolean(opts.includePurged);
    const sql = includePurged
      ? 'SELECT * FROM items WHERE id = ?'
      : includeDeleted
        ? 'SELECT * FROM items WHERE id = ? AND purged_at IS NULL'
        : 'SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL';
    const row = this.db.prepare(sql).get(id) as ItemRow | undefined;
    return row ? mapRowToItem(row) : null;
  }

  public getRawEncryptedPayload(id: string): string | null {
    const row = this.db
      .prepare('SELECT encrypted_payload FROM items WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL')
      .get(id) as { encrypted_payload: string | null } | undefined;
    return row?.encrypted_payload ?? null;
  }

  public getRawRowById(id: string): ItemRow | null {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
    return row ? { ...row } : null;
  }

  public getEntitySyncStamp(
    entityType: SyncEntityType | string,
    entityId: string
  ): { updatedAt: number; syncVersion: number; deletedAt: number | null } | null {
    if (entityType === 'item') {
      const row = this.getRawRowById(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updated_at,
        syncVersion: row.sync_version ?? 1,
        deletedAt: row.purged_at ?? row.deleted_at ?? null,
      };
    }
    if (entityType === 'orbit') {
      const row = this.getRawOrbitById(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updated_at ?? row.created_at ?? 0,
        syncVersion: row.sync_version ?? 1,
        deletedAt: row.deleted_at ?? null,
      };
    }
    if (entityType === 'focus_board') {
      const row = this.getRawFocusBoardById(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updated_at ?? row.created_at ?? 0,
        syncVersion: row.sync_version ?? 1,
        deletedAt: row.deleted_at ?? null,
      };
    }
    if (entityType === 'calendar_event') {
      const row = this.getRawCalendarEventById(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updatedAt,
        syncVersion: row.syncVersion ?? 1,
        deletedAt: row.deletedAt ?? null,
      };
    }
    if (entityType === 'item_revision') {
      const row = this.getRawItemRevisionById(entityId);
      if (!row) return null;
      return {
        updatedAt: row.updated_at || row.created_at,
        syncVersion: row.sync_version ?? 1,
        deletedAt: row.deleted_at ?? null,
      };
    }
    if (entityType === 'workspace_prefs') {
      const updated = Number(this.getSetting('workspace_prefs_updated_at') || '0') || 0;
      if (updated <= 0) return null;
      return {
        updatedAt: updated,
        syncVersion: Number(this.getSetting('workspace_prefs_sync_version') || '1') || 1,
        deletedAt: null,
      };
    }
    return null;
  }

  public restoreRawRow(row: ItemRow): VaultItem {
    const existingById = this.db.prepare('SELECT * FROM items WHERE id = ?').get(row.id) as
      | ItemRow
      | undefined;
    if (existingById) {
      if (existingById.deleted_at) {
        return this.restoreItem(row.id) ?? mapRowToItem(existingById);
      }
      return mapRowToItem(existingById);
    }

    const orbitExists = row.orbit
      ? this.db.prepare('SELECT 1 FROM orbits WHERE id = ? AND deleted_at IS NULL').get(row.orbit)
      : null;
    const safeOrbit = orbitExists ? row.orbit : '';

    const boardExists = row.focus_board_id
      ? this.db.prepare('SELECT 1 FROM focus_boards WHERE id = ? AND deleted_at IS NULL').get(row.focus_board_id)
      : null;
    const safeBoardId = boardExists ? row.focus_board_id : null;

    const safeExternalId =
      row.external_id && this.findBySourceExternalId(row.source as ItemSource, row.external_id)
        ? null
        : row.external_id;

    const now = this.monotonicTimestamp(row.updated_at);
    const nextSyncVersion = (row.sync_version ?? 1) + 1;
    const inserted = this.inTx(() => {
      this.db
        .prepare(
          `INSERT INTO items (
            id, dna, sub_kind, orbit, mode_captured, focus_board_id,
            title, title_norm, body, summary, url, domain, platform,
            image_path, thumb_path, media_path, media_type, media_duration_sec, media_meta_json, og_image_url,
            ocr_text, extracted_actions_json, color_palette_json,
            encrypted_payload, secret_meta_json, tags_json, source, external_id,
            content_hash, ai_status, ai_confidence, is_pinned, is_muted, is_archived, is_demo,
            remind_at, reminded_at, created_at, updated_at, content_updated_at, deleted_at, purged_at,
            canvas_x, canvas_y, canvas_w, canvas_h, canvas_frame, annotations_json, links_out_json,
            sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.id,
          row.dna,
          row.sub_kind ?? null,
          safeOrbit,
          row.mode_captured,
          safeBoardId,
          row.title,
          (row.title || '').trim().toLowerCase(),
          row.body,
          row.summary,
          row.url,
          row.domain,
          row.platform,
          row.image_path,
          row.thumb_path ?? null,
          row.media_path ?? null,
          row.media_type ?? null,
          row.media_duration_sec ?? null,
          row.media_meta_json ?? null,
          row.og_image_url,
          row.ocr_text,
          row.extracted_actions_json,
          row.color_palette_json,
          row.encrypted_payload,
          row.secret_meta_json,
          row.tags_json,
          row.source,
          safeExternalId,
          row.content_hash,
          row.ai_status,
          row.ai_confidence,
          row.is_pinned,
          row.is_muted ?? 0,
          row.is_archived,
          row.is_demo,
          row.remind_at ?? null,
          row.reminded_at ?? null,
          row.created_at,
          now,
          row.content_updated_at ?? row.updated_at ?? row.created_at,
          row.canvas_x ?? null,
          row.canvas_y ?? null,
          row.canvas_w ?? null,
          row.canvas_h ?? null,
          row.canvas_frame ?? null,
          row.annotations_json ?? '[]',
          row.links_out_json ?? '[]',
          nextSyncVersion,
          this.localDeviceId
        );
      const next = this.db.prepare('SELECT * FROM items WHERE id = ?').get(row.id) as unknown as ItemRow;
      this.syncFtsRow(next);
      this.tagUniverseCache = null;
      if (!next.is_demo) {
        this.markDirty('item', next.id);
      }
      return next;
    });
    return mapRowToItem(inserted);
  }

  public updateItem(
    id: string,
    patch: UpdateItemPatch,
    opts?: { skipAutoRevision?: boolean; preserveContentUpdatedAt?: boolean }
  ): VaultItem | null {
    const current = this.db
      .prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL')
      .get(id) as ItemRow | undefined;
    if (!current) return null;

    const universe = this.getExistingTagUniverse();
    const nextTags =
      patch.tags !== undefined
        ? JSON.stringify(canonicalizeTags(patch.tags, universe))
        : current.tags_json;

    const now = this.monotonicTimestamp(current.updated_at);
    const nextTitle = patch.title ?? current.title;
    const nextBody = patch.body ?? current.body;
    let nextSummary = patch.summary ?? current.summary;
    if (
      current.dna === 'shot' &&
      patch.body !== undefined &&
      patch.summary === undefined &&
      patch.aiStatus === undefined
    ) {
      const strippedShotBody = patch.body
        .replace(/!\[[^\]]*\]\(kapsula-media:\/\/[^)\n]+\)/gi, '')
        .replace(/!\[[^\]]*\]\([^)\n]+\)/g, '')
        .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
        .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      nextSummary = strippedShotBody ? strippedShotBody.slice(0, 260) : '';
    }
    const titleChanged =
      patch.title !== undefined &&
      patch.title !== current.title &&
      !isUntitledPlaceholderTitle(current.title) &&
      patch.aiStatus === undefined;
    const bodyChanged =
      patch.body !== undefined &&
      patch.body !== current.body &&
      patch.aiStatus === undefined;
    const secretChanged =
      patch.encryptedPayload !== undefined && patch.encryptedPayload !== current.encrypted_payload;
    const contentChanged =
      titleChanged ||
      bodyChanged ||
      secretChanged;

    const nextContentUpdatedAt =
      contentChanged && !opts?.preserveContentUpdatedAt
        ? now
        : current.content_updated_at ?? current.updated_at ?? current.created_at;
    const nextSyncVersion = (current.sync_version ?? 1) + 1;

    // Reconcile linksOut cleanly from [[WikiLink]] tokens whenever body updates on non-secret notes
    let nextLinksOutJson =
      patch.linksOut !== undefined
        ? JSON.stringify(patch.linksOut)
        : (current.links_out_json ?? '[]');
    if (patch.body !== undefined && current.dna !== 'secret') {
      const oldNormSet = new Set(
        extractWikiLinkTitles(current.body).map((t) => t.trim().toLowerCase()).filter(Boolean)
      );
      const newNormSet = new Set(
        extractWikiLinkTitles(patch.body).map((t) => t.trim().toLowerCase()).filter(Boolean)
      );
      const wikiTitlesChanged =
        oldNormSet.size !== newNormSet.size ||
        Array.from(oldNormSet).some((t) => !newNormSet.has(t));
      if (wikiTitlesChanged) {
        const oldWikiIds = new Set(this.resolveWikiLinkIds(current.body, id));
        const newWikiIds = this.resolveWikiLinkIds(patch.body, id);
        const baseLinks =
          patch.linksOut !== undefined
            ? patch.linksOut
            : safeParseJson<string[]>(current.links_out_json, []);
        const preserved = baseLinks.filter((linkId) => !oldWikiIds.has(linkId));
        nextLinksOutJson = JSON.stringify(Array.from(new Set([...preserved, ...newWikiIds])));
      }
    }

    const updated = this.inTx(() => {
      // Auto-checkpoint item_revisions on meaningful title/body changes for non-secret items inside the same transaction
      if (
        !opts?.skipAutoRevision &&
        current.dna !== 'secret' &&
        (patch.title !== undefined || patch.body !== undefined) &&
        (nextTitle !== current.title || nextBody !== current.body)
      ) {
        const lastRev = this.db
          .prepare(
            `SELECT id, title, content, source, content_hash, created_at
             FROM item_revisions
             WHERE item_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`
          )
          .get(id) as
          | {
              id: string;
              title: string | null;
              content: string;
              source: ItemRevisionSource;
              content_hash: string | null;
              created_at: number;
            }
          | undefined;

        const shouldCheckpoint =
          !lastRev ||
          now - lastRev.created_at >= AUTO_REVISION_INTERVAL_MS ||
          Math.abs(nextBody.length - (lastRev.content?.length ?? 0)) >= AUTO_REVISION_LENGTH_DELTA;

        if (shouldCheckpoint) {
          const lastHash =
            lastRev?.content_hash ??
            (lastRev ? computeRevisionHash(lastRev.title, lastRev.content) : null);
          const prevHash = computeRevisionHash(current.title, current.body);
          const nextHash = computeRevisionHash(nextTitle, nextBody);
          const isRecentSpecialRev =
            Boolean(lastRev) &&
            (lastRev!.source === 'beautify' ||
              lastRev!.source === 'voice' ||
              lastRev!.source === 'restore') &&
            now - lastRev!.created_at < 5000;

          if ((current.body.trim().length > 0 || current.title.trim().length > 0) && prevHash !== lastHash) {
            this.saveItemRevision(
              {
                itemId: id,
                title: current.title,
                content: current.body,
                source: 'auto',
              },
              { skipDirty: current.is_demo === 1 }
            );
          } else if (nextBody.trim().length > 0 && nextHash !== lastHash && !isRecentSpecialRev) {
            this.saveItemRevision(
              {
                itemId: id,
                title: nextTitle,
                content: nextBody,
                source: 'auto',
              },
              { skipDirty: current.is_demo === 1 }
            );
          }
        }
      }

      this.db
        .prepare(
          `UPDATE items SET
            dna = ?,
            sub_kind = ?,
            orbit = ?,
            focus_board_id = ?,
            title = ?,
            title_norm = ?,
            body = ?,
            summary = ?,
            url = ?,
            domain = ?,
            platform = ?,
            image_path = ?,
            thumb_path = ?,
            media_path = ?,
            media_type = ?,
            media_duration_sec = ?,
            media_meta_json = ?,
            og_image_url = ?,
            ocr_text = ?,
            extracted_actions_json = ?,
            color_palette_json = ?,
            encrypted_payload = ?,
            secret_meta_json = ?,
            tags_json = ?,
            ai_status = ?,
            ai_confidence = ?,
            is_pinned = ?,
            is_muted = ?,
            is_archived = ?,
            remind_at = ?,
            reminded_at = ?,
            updated_at = ?,
            content_updated_at = ?,
            canvas_x = ?,
            canvas_y = ?,
            canvas_w = ?,
            canvas_h = ?,
            canvas_frame = ?,
            annotations_json = ?,
            links_out_json = ?,
            sync_version = ?,
            last_device_id = ?
           WHERE id = ?`
        )
        .run(
          patch.dna ?? current.dna,
          patch.subKind !== undefined ? patch.subKind : current.sub_kind,
          patch.orbit !== undefined ? patch.orbit : current.orbit,
          patch.focusBoardId !== undefined ? patch.focusBoardId : current.focus_board_id,
          nextTitle,
          (nextTitle || '').trim().toLowerCase(),
          nextBody,
          nextSummary,
          patch.url !== undefined ? patch.url : current.url,
          patch.domain !== undefined ? patch.domain : current.domain,
          patch.platform !== undefined ? patch.platform : current.platform,
          patch.imagePath !== undefined ? patch.imagePath : current.image_path,
          patch.thumbPath !== undefined ? patch.thumbPath : current.thumb_path,
          patch.mediaPath !== undefined ? patch.mediaPath : current.media_path,
          patch.mediaType !== undefined ? patch.mediaType : current.media_type,
          patch.mediaDurationSec !== undefined ? patch.mediaDurationSec : current.media_duration_sec,
          patch.mediaMeta !== undefined
            ? patch.mediaMeta
              ? JSON.stringify(patch.mediaMeta)
              : null
            : current.media_meta_json,
          patch.ogImageUrl !== undefined ? patch.ogImageUrl : current.og_image_url,
          patch.ocrText ?? current.ocr_text,
          patch.extractedActions !== undefined
            ? JSON.stringify(patch.extractedActions)
            : current.extracted_actions_json,
          patch.colorPalette !== undefined
            ? JSON.stringify(patch.colorPalette)
            : current.color_palette_json,
          patch.encryptedPayload !== undefined ? patch.encryptedPayload : current.encrypted_payload,
          patch.secretMeta !== undefined
            ? patch.secretMeta
              ? JSON.stringify(patch.secretMeta)
              : null
            : current.secret_meta_json,
          nextTags,
          patch.aiStatus ?? current.ai_status,
          patch.aiConfidence !== undefined ? patch.aiConfidence : current.ai_confidence,
          patch.isPinned !== undefined ? (patch.isPinned ? 1 : 0) : current.is_pinned,
          patch.isMuted !== undefined ? (patch.isMuted ? 1 : 0) : (current.is_muted ?? 0),
          patch.isArchived !== undefined ? (patch.isArchived ? 1 : 0) : current.is_archived,
          patch.remindAt !== undefined ? patch.remindAt : current.remind_at,
          patch.remindedAt !== undefined ? patch.remindedAt : current.reminded_at,
          now,
          nextContentUpdatedAt,
          patch.canvasX !== undefined ? patch.canvasX : (current.canvas_x ?? null),
          patch.canvasY !== undefined ? patch.canvasY : (current.canvas_y ?? null),
          patch.canvasW !== undefined ? patch.canvasW : (current.canvas_w ?? null),
          patch.canvasH !== undefined ? patch.canvasH : (current.canvas_h ?? null),
          patch.canvasFrame !== undefined ? patch.canvasFrame : (current.canvas_frame ?? null),
          patch.annotations !== undefined
            ? JSON.stringify(patch.annotations)
            : (current.annotations_json ?? '[]'),
          nextLinksOutJson,
          nextSyncVersion,
          this.localDeviceId,
          id
        );

      const next = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow;
      this.syncFtsRow(next);
      this.tagUniverseCache = null;
      if (!next.is_demo) {
        this.markDirty('item', next.id);
      }
      return next;
    });
    return mapRowToItem(updated);
  }

  public deleteItem(id: string): boolean {
    const row = this.db
      .prepare('SELECT is_demo, updated_at, deleted_at, purged_at FROM items WHERE id = ?')
      .get(id) as
      | { is_demo: number; updated_at: number; deleted_at: number | null; purged_at: number | null }
      | undefined;
    if (!row || row.purged_at != null) return false;
    // Already soft-deleted in Trash: redirect cleanly to permanent purge so Trash delete never silently no-ops
    if (row.deleted_at != null) {
      return this.purgeItemPermanently(id).purged;
    }
    const now = this.monotonicTimestamp(row.updated_at);
    const deleted = this.inTx(() => {
      const res = this.db
        .prepare(
          `UPDATE items
           SET deleted_at = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ?
           WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL`
        )
        .run(now, now, this.localDeviceId, id);
      (this.ftsDeleteStmt ??= this.db.prepare('DELETE FROM items_fts WHERE id = ?')).run(id);
      this.tagUniverseCache = null;
      const changed = Number(res.changes) > 0;
      if (changed && !row.is_demo) {
        this.markDirty('item', id);
      }
      return changed;
    });
    return deleted;
  }

  public restoreItem(id: string): VaultItem | null {
    const row = this.db
      .prepare('SELECT * FROM items WHERE id = ? AND purged_at IS NULL')
      .get(id) as ItemRow | undefined;
    if (!row) return null;
    const now = this.monotonicTimestamp(row.updated_at);
    const orbitAlive = row.orbit
      ? this.db.prepare('SELECT 1 FROM orbits WHERE id = ? AND deleted_at IS NULL').get(row.orbit)
      : null;
    const boardAlive = row.focus_board_id
      ? this.db.prepare('SELECT 1 FROM focus_boards WHERE id = ? AND deleted_at IS NULL').get(row.focus_board_id)
      : null;

    const restored = this.inTx(() => {
      const hasExternalIdCollision = Boolean(
        row.external_id &&
          this.db
            .prepare(
              'SELECT 1 FROM items WHERE source = ? AND external_id = ? AND deleted_at IS NULL AND id != ?'
            )
            .get(row.source, row.external_id, id)
      );
      const safeExternalId = hasExternalIdCollision ? null : row.external_id;

      this.db
        .prepare(
          `UPDATE items
           SET deleted_at = NULL,
               orbit = ?,
               focus_board_id = ?,
               external_id = ?,
               updated_at = ?,
               sync_version = sync_version + 1,
               last_device_id = ?
           WHERE id = ? AND purged_at IS NULL`
        )
        .run(
          orbitAlive ? row.orbit : '',
          boardAlive ? row.focus_board_id : null,
          safeExternalId,
          now,
          this.localDeviceId,
          id
        );
      const next = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow;
      this.syncFtsRow(next);
      this.tagUniverseCache = null;
      if (!next.is_demo) {
        this.markDirty('item', next.id);
      }
      return next;
    });
    return mapRowToItem(restored);
  }

  /**
   * Permanently wipes item content/secrets/media refs while keeping a minimal synced tombstone
   * (`purged_at` + `deleted_at`) so all remote devices also purge and never resurrect the item.
   */
  public purgeItemPermanently(id: string): { purged: boolean; freedMedia: string[] } {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
    if (!row || row.purged_at != null) {
      return { purged: false, freedMedia: [] };
    }
    const freedMedia = this.collectItemMediaRefs(row);
    const ts = this.monotonicTimestamp(row.updated_at);
    let purgedRevisionIds: string[] = [];

    this.inTx(() => {
      this.db
        .prepare(
          `UPDATE items SET
             purged_at = ?,
             deleted_at = COALESCE(deleted_at, ?),
             updated_at = ?,
             sync_version = sync_version + 1,
             last_device_id = ?,
             title = '',
             body = '',
             summary = '',
             url = NULL,
             domain = NULL,
             platform = NULL,
             ocr_text = '',
             extracted_actions_json = '[]',
             color_palette_json = '[]',
             encrypted_payload = NULL,
             secret_meta_json = NULL,
             media_meta_json = NULL,
             image_path = NULL,
             thumb_path = NULL,
             media_path = NULL,
             media_type = NULL,
             media_duration_sec = NULL,
             og_image_url = NULL,
             external_id = NULL,
             tags_json = '[]',
             annotations_json = '[]',
             links_out_json = '[]',
             is_pinned = 0,
             is_archived = 0,
             remind_at = NULL,
             reminded_at = NULL
           WHERE id = ?`
        )
        .run(ts, ts, ts, this.localDeviceId, id);

      (this.ftsDeleteStmt ??= this.db.prepare('DELETE FROM items_fts WHERE id = ?')).run(id);

      const revs = this.db
        .prepare('SELECT id, updated_at FROM item_revisions WHERE item_id = ? AND deleted_at IS NULL')
        .all(id) as Array<{ id: string; updated_at: number }>;
      purgedRevisionIds = revs.map((r) => r.id);
      if (revs.length > 0) {
        const scrubRev = this.db.prepare(
          `UPDATE item_revisions
           SET title = '', content = '', content_hash = '', deleted_at = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ?
           WHERE id = ?`
        );
        for (const rev of revs) {
          const revTs = this.monotonicTimestamp(rev.updated_at);
          scrubRev.run(revTs, revTs, this.localDeviceId, rev.id);
        }
      }
      this.tagUniverseCache = null;
      if (!row.is_demo) {
        this.enqueuePendingBlobDeletes(freedMedia, id);
        this.markDirty('item', id);
        for (const revId of purgedRevisionIds) {
          this.markDirty('item_revision', revId);
        }
      }
    });

    return { purged: true, freedMedia };
  }

  public emptyTrash(): { purgedCount: number; purgedIds: string[]; freedMedia: string[] } {
    return this.inTx(() => {
      const trashed = this.db
        .prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL AND purged_at IS NULL')
        .all() as Array<{ id: string }>;
      const purgedIds: string[] = [];
      const freedMediaSet = new Set<string>();

      for (const row of trashed) {
        const res = this.purgeItemPermanently(row.id);
        if (res.purged) {
          purgedIds.push(row.id);
          for (const m of res.freedMedia) freedMediaSet.add(m);
        }
      }

      return {
        purgedCount: purgedIds.length,
        purgedIds,
        freedMedia: Array.from(freedMediaSet),
      };
    });
  }

  public purgeDeletedItem(id: string): boolean {
    return this.purgeItemPermanently(id).purged;
  }

  public clearDemoItems(): number {
    return this.inTx(() => {
      const demoRows = this.db
        .prepare('SELECT id FROM items WHERE is_demo = 1')
        .all() as Array<{ id: string }>;
      const ftsDel = (this.ftsDeleteStmt ??= this.db.prepare(
        'DELETE FROM items_fts WHERE id = ?'
      ));
      const dirtyRevDel = this.db.prepare(
        "DELETE FROM sync_dirty WHERE entity_type = 'item_revision' AND entity_id IN (SELECT id FROM item_revisions WHERE item_id = ?)"
      );
      const revDel = this.db.prepare('DELETE FROM item_revisions WHERE item_id = ?');
      const dirtyItemDel = this.db.prepare(
        "DELETE FROM sync_dirty WHERE entity_type = 'item' AND entity_id = ?"
      );
      const calUnlink = this.db.prepare(
        'UPDATE calendar_events SET linked_item_id = NULL WHERE linked_item_id = ?'
      );
      for (const r of demoRows) {
        ftsDel.run(r.id);
        dirtyRevDel.run(r.id);
        revDel.run(r.id);
        dirtyItemDel.run(r.id);
        calUnlink.run(r.id);
      }
      const res = this.db.prepare('DELETE FROM items WHERE is_demo = 1').run();
      this.setSetting('demo_dismissed', 'true');
      this.tagUniverseCache = null;
      if (Number(res.changes) > 0) {
        this.bumpVaultMutationVersion();
      }
      return Number(res.changes);
    });
  }

  public countItemsByMediaRef(filename: string): number {
    if (!filename) return 0;
    const likePattern = `%${escapeSqlLike(filename)}%`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM items
         WHERE purged_at IS NULL
           AND (
             image_path = ?
             OR thumb_path = ?
             OR media_path = ?
             OR body LIKE ? ESCAPE '\\'
             OR COALESCE(media_meta_json, '') LIKE ? ESCAPE '\\'
           )`
      )
      .get(filename, filename, filename, likePattern, likePattern) as { cnt: number };
    const calRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM calendar_events
         WHERE deleted_at IS NULL
           AND COALESCE(attachments_json, '') LIKE ? ESCAPE '\\'`
      )
      .get(likePattern) as { cnt: number };
    return Number(row?.cnt ?? 0) + Number(calRow?.cnt ?? 0);
  }

  public countItemsByImagePath(imagePath: string): number {
    return this.countItemsByMediaRef(imagePath);
  }

  public getDemoImagePaths(): string[] {
    const rows = this.db
      .prepare(
        'SELECT image_path, thumb_path, media_path FROM items WHERE is_demo = 1 AND (image_path IS NOT NULL OR thumb_path IS NOT NULL OR media_path IS NOT NULL)'
      )
      .all() as Array<{ image_path: string | null; thumb_path: string | null; media_path: string | null }>;
    const set = new Set<string>();
    for (const r of rows) {
      if (r.image_path) set.add(r.image_path);
      if (r.thumb_path) set.add(r.thumb_path);
      if (r.media_path) set.add(r.media_path);
    }
    return [...set];
  }

  public queryItems(q: VaultQuery = {}): VaultItem[] {
    const baseConditions: string[] = [];
    const baseParams: Array<string | number> = [];

    if (!q.includePurged) {
      baseConditions.push('i.purged_at IS NULL');
    }
    if (q.onlyDeleted) {
      baseConditions.push('i.deleted_at IS NOT NULL');
    } else if (!q.includeDeleted) {
      baseConditions.push('i.deleted_at IS NULL');
    }
    if (q.onlyDeleted) {
      if (q.archivedOnly) {
        baseConditions.push('i.is_archived = 1');
      }
    } else if (q.archivedOnly) {
      baseConditions.push('i.is_archived = 1');
    } else if (!q.includeArchived) {
      baseConditions.push('i.is_archived = 0');
    }
    if (q.includeSecrets === false) {
      baseConditions.push("i.dna != 'secret'");
    }
    if (q.isPinned) {
      baseConditions.push('i.is_pinned = 1');
    }
    if (q.remindersDueOnly) {
      baseConditions.push('i.remind_at IS NOT NULL');
    }
    if (q.unassignedOnly) {
      baseConditions.push("(i.orbit = '' OR i.orbit = 'inbox')");
    } else if (q.orbit && q.orbit !== 'all') {
      baseConditions.push('i.orbit = ?');
      baseParams.push(q.orbit);
    }
    if (q.dna) {
      baseConditions.push('i.dna = ?');
      baseParams.push(q.dna);
    }
    if (q.focusBoardId) {
      baseConditions.push('i.focus_board_id = ?');
      baseParams.push(q.focusBoardId);
    }
    if (q.tag) {
      const cleanTag = normalizeTagText(q.tag);
      if (cleanTag) {
        baseConditions.push("lower_utf(i.tags_json) LIKE ? ESCAPE '\\'");
        baseParams.push(`%"${escapeSqlLike(cleanTag)}"%`);
      }
    }
    if (typeof q.createdBefore === 'number' && Number.isFinite(q.createdBefore)) {
      baseConditions.push('i.created_at < ?');
      baseParams.push(q.createdBefore);
    }

    const searchRaw = (q.search ?? '').trim();
    const limit = Math.min(5000, Math.max(1, q.limit ?? 500));
    const offset = Math.max(0, q.offset ?? 0);
    const orderBy = q.remindersDueOnly
      ? 'ORDER BY i.remind_at ASC'
      : q.sortBy === 'updated_desc'
        ? 'ORDER BY i.is_pinned DESC, COALESCE(i.content_updated_at, i.updated_at) DESC'
        : q.sortBy === 'title_asc'
          ? 'ORDER BY i.is_pinned DESC, lower_utf(i.title) ASC'
          : q.sortBy === 'media_first'
            ? 'ORDER BY i.is_pinned DESC, CASE WHEN i.image_path IS NOT NULL OR i.media_path IS NOT NULL THEN 0 ELSE 1 END ASC, i.created_at DESC'
            : 'ORDER BY i.is_pinned DESC, i.created_at DESC';

    if (!searchRaw) {
      const whereClause = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';
      const rows = this.db
        .prepare(`SELECT i.* FROM items i ${whereClause} ${orderBy} LIMIT ? OFFSET ?`)
        .all(...baseParams, limit, offset) as unknown as ItemRow[];
      return rows.map(mapRowToItem);
    }

    const qLower = searchRaw.toLowerCase();
    const cleanTokens = qLower
      .replace(/["'*()[\]{}]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const expandedGroups = expandBilingualQuery(searchRaw);
    const tokens = cleanTokens.length > 0 ? cleanTokens : [qLower];
    const tokenSpecs = (expandedGroups.length > 0
      ? expandedGroups
      : tokens.map((t) => ({ primary: t, variants: [t] }))
    ).map((grp) => {
      const stem = computeSearchStem(grp.primary);
      const variants = Array.from(new Set([grp.primary, stem, ...grp.variants])).filter(
        (v) => v.length >= 2 || v === grp.primary
      );
      const digits = grp.primary.replace(/\D/g, '');
      const semantics = new Set<SemanticMatchKind>();
      for (const v of variants) {
        for (const k of detectSemanticKinds(v)) semantics.add(k);
      }
      return { tok: grp.primary, stem, variants, digits, semantics: Array.from(semantics) };
    });

    const candidateRows = new Map<string, ItemRow>();
    const addRows = (rows: ItemRow[]) => {
      for (const row of rows) {
        if (!candidateRows.has(row.id)) candidateRows.set(row.id, row);
      }
    };

    // 1. Gather bilingual FTS5 prefix candidates (AND across token groups first so rare multi-token hits are never drowned by 400 common hits)
    const tokenFtsGroups: string[] = [];
    const ftsSet = new Set<string>();
    for (const spec of tokenSpecs) {
      const grpSet = new Set<string>();
      for (const v of spec.variants) {
        const sanitized = v.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
        for (const word of sanitized.split(/\s+/)) {
          if (word.length >= 2) {
            const term = `"${word}"*`;
            grpSet.add(term);
            ftsSet.add(term);
          }
        }
      }
      if (grpSet.size > 0) {
        const grpList = Array.from(grpSet).slice(0, 12);
        tokenFtsGroups.push(grpList.length === 1 ? grpList[0]! : `(${grpList.join(' OR ')})`);
      }
    }
    const ftsParts = Array.from(ftsSet).slice(0, 48);

    const runFtsExpr = (expr: string) => {
      const ftsConditions = [
        ...baseConditions,
        'i.id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)',
      ];
      try {
        const rows = this.db
          .prepare(`SELECT i.* FROM items i WHERE ${ftsConditions.join(' AND ')} ${orderBy} LIMIT 400`)
          .all(...baseParams, expr) as unknown as ItemRow[];
        addRows(rows);
      } catch {
        // Fallback to LIKE scan below for edge-case queries
      }
    };

    if (tokenFtsGroups.length > 1) {
      runFtsExpr(tokenFtsGroups.slice(0, 8).join(' AND '));
    }
    if ((candidateRows.size === 0 || tokenFtsGroups.length <= 1) && ftsParts.length > 0) {
      runFtsExpr(ftsParts.join(' OR '));
    }

    // 2. Targeted semantic/digit predicates + gated 9-column SQL LIKE fallback for FTS edge cases
    const orClauses: string[] = [];
    const orParams: Array<string | number> = [];
    const targetedClauses: string[] = [];
    const targetedParams: Array<string | number> = [];
    const perTokenLikeClauses: string[] = [];
    const perTokenLikeParams: Array<string | number> = [];
    const seenLikeTerms = new Set<string>();
    const makeLikePred = (term: string): { clause: string; params: string[] } => {
      const pat = `%${escapeSqlLike(term)}%`;
      return {
        clause: `(
          lower_utf(i.title) LIKE ? ESCAPE '\\'
          OR lower_utf(i.summary) LIKE ? ESCAPE '\\'
          OR lower_utf(i.body) LIKE ? ESCAPE '\\'
          OR lower_utf(i.ocr_text) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.media_meta_json, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.secret_meta_json, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.url, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.domain, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(i.tags_json) LIKE ? ESCAPE '\\'
        )`,
        params: [pat, pat, pat, pat, pat, pat, pat, pat, pat],
      };
    };
    const addTextLike = (term: string) => {
      if (!term || seenLikeTerms.has(term) || seenLikeTerms.size >= 42) return;
      seenLikeTerms.add(term);
      const pred = makeLikePred(term);
      orClauses.push(pred.clause);
      orParams.push(...pred.params);
    };

    addTextLike(qLower);
    for (const spec of tokenSpecs) {
      const grpClauses: string[] = [];
      const grpParams: string[] = [];
      for (const variant of spec.variants) {
        addTextLike(variant);
        if (tokenSpecs.length > 1 && variant) {
          const pred = makeLikePred(variant);
          grpClauses.push(pred.clause);
          grpParams.push(...pred.params);
        }
      }
      if (tokenSpecs.length > 1 && grpClauses.length > 0 && perTokenLikeClauses.length < 6) {
        perTokenLikeClauses.push(`(${grpClauses.join(' OR ')})`);
        perTokenLikeParams.push(...grpParams);
      }
      if (spec.digits.length >= 3) {
        const dPat = `%${escapeSqlLike(spec.digits)}%`;
        targetedClauses.push(
          `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.title || ' ' || i.body || ' ' || COALESCE(i.secret_meta_json, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? ESCAPE '\\'`
        );
        targetedParams.push(dPat);
      }
      for (const sem of spec.semantics) {
        if (sem === 'bank_card') {
          targetedClauses.push(`(i.dna = 'secret' AND lower_utf(COALESCE(i.secret_meta_json, '')) LIKE '%"bank_card"%')`);
        } else if (sem === 'secret') {
          targetedClauses.push(`i.dna = 'secret'`);
        } else if (sem === 'shot') {
          targetedClauses.push(`i.dna = 'shot'`);
        } else if (sem === 'link') {
          targetedClauses.push(`(i.dna = 'link' OR i.url IS NOT NULL)`);
        } else if (sem === 'voice') {
          targetedClauses.push(`i.dna = 'voice'`);
        } else if (sem === 'doc') {
          targetedClauses.push(`i.dna = 'doc'`);
        } else if (sem === 'contact') {
          targetedClauses.push(`(i.sub_kind = 'contact' OR i.body LIKE '%+%' OR i.title LIKE '%+%')`);
        } else if (sem === 'snippet') {
          targetedClauses.push(`(i.dna = 'snippet' OR i.body LIKE '%\`\`\`%')`);
        }
      }
    }

    if (targetedClauses.length > 0) {
      const targetedConditions = [...baseConditions, `(${targetedClauses.join(' OR ')})`];
      const targetedRows = this.db
        .prepare(`SELECT i.* FROM items i WHERE ${targetedConditions.join(' AND ')} ${orderBy} LIMIT 250`)
        .all(...baseParams, ...targetedParams) as unknown as ItemRow[];
      addRows(targetedRows);
    }

    const needHeavyTextLikeScan =
      candidateRows.size < 15 ||
      ftsParts.length === 0 ||
      cleanTokens.some((t) => t.length < 2) ||
      /[@+#/.]/.test(searchRaw) ||
      q.dna === 'secret';

    if (needHeavyTextLikeScan) {
      if (tokenSpecs.length > 1 && perTokenLikeClauses.length > 1) {
        const andScanConditions = [...baseConditions, perTokenLikeClauses.join(' AND ')];
        const andRows = this.db
          .prepare(`SELECT i.* FROM items i WHERE ${andScanConditions.join(' AND ')} ${orderBy} LIMIT 400`)
          .all(...baseParams, ...perTokenLikeParams) as unknown as ItemRow[];
        addRows(andRows);
      }
      if ((tokenSpecs.length <= 1 || candidateRows.size === 0) && orClauses.length > 0) {
        const scanConditions = [...baseConditions, `(${orClauses.join(' OR ')})`];
        const rows = this.db
          .prepare(`SELECT i.* FROM items i WHERE ${scanConditions.join(' AND ')} ${orderBy} LIMIT 400`)
          .all(...baseParams, ...orParams) as unknown as ItemRow[];
        addRows(rows);
      }
    } else if (q.includeSecrets !== false && q.dna !== 'secret' && orClauses.length > 0) {
      // Secrets are excluded from FTS5; scan only indexed secret rows so unindexed secrets still surface
      const secretConditions = [...baseConditions, "i.dna = 'secret'", `(${orClauses.join(' OR ')})`];
      const secretRows = this.db
        .prepare(`SELECT i.* FROM items i WHERE ${secretConditions.join(' AND ')} ${orderBy} LIMIT 80`)
        .all(...baseParams, ...orParams) as unknown as ItemRow[];
      addRows(secretRows);
    }

    // 3. Score & verify all bilingual token groups across candidate items
    const scored: Array<{ item: VaultItem; score: number }> = [];
    for (const row of candidateRows.values()) {
      const item = mapRowToItem(row);
      const titleL = (item.title || '').toLowerCase();
      const summaryL = (item.summary || '').toLowerCase();
      const bodyL = (item.body || '').toLowerCase();
      const ocrL = (item.ocrText || '').toLowerCase();
      const domainL = (item.domain || '').toLowerCase();
      const urlL = (item.url || '').toLowerCase();
      const platformL = (item.platform || '').toLowerCase();
      const tagsL = item.tags.join(' ').toLowerCase();
      const secretL = item.secretMeta
        ? [
            item.secretMeta.service,
            item.secretMeta.loginHint,
            item.secretMeta.cardBrand,
            item.secretMeta.last4,
            item.secretMeta.kind,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
        : '';
      const metaL = item.mediaMeta
        ? [
            item.mediaMeta.forwardAuthor,
            item.mediaMeta.fileName,
            item.mediaMeta.transcript,
            item.mediaMeta.contactPhone,
            item.mediaMeta.contactEmail,
            item.mediaMeta.contactHandle,
            ...(item.mediaMeta.keyPoints ?? []),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
        : '';
      const digitsHay = `${item.title} ${item.body} ${secretL} ${item.mediaMeta?.contactPhone ?? ''}`.replace(/\D/g, '');

      let allTokensMatch = true;
      let score = item.isPinned ? 8 : 0;

      if (titleL.includes(qLower)) score += 160;
      else if (summaryL.includes(qLower) || bodyL.includes(qLower)) score += 45;

      for (const spec of tokenSpecs) {
        let tokMatched = false;
        let tokBestScore = 0;

        const checkField = (hay: string, weightExact: number, weightVariant: number) => {
          if (!hay) return;
          if (hay.includes(spec.tok)) {
            tokMatched = true;
            tokBestScore = Math.max(tokBestScore, weightExact);
            return;
          }
          for (const variant of spec.variants) {
            if (hay.includes(variant)) {
              tokMatched = true;
              tokBestScore = Math.max(tokBestScore, weightVariant);
              return;
            }
          }
        };

        if (spec.variants.some((v) => titleL.startsWith(v))) {
          tokMatched = true;
          tokBestScore = Math.max(tokBestScore, 90);
        }
        checkField(titleL, 70, 54);
        checkField(tagsL, 64, 50);
        checkField(domainL, 62, 50);
        checkField(platformL, 60, 48);
        checkField(secretL, 62, 48);
        checkField(metaL, 48, 38);
        checkField(summaryL, 42, 34);
        checkField(urlL, 40, 32);
        checkField(bodyL, 30, 24);
        checkField(ocrL, 22, 18);

        if (spec.digits.length >= 3 && digitsHay.includes(spec.digits)) {
          tokMatched = true;
          tokBestScore = Math.max(tokBestScore, 64);
        }

        for (const sem of spec.semantics) {
          if (itemMatchesSemanticKind(item, sem)) {
            tokMatched = true;
            tokBestScore = Math.max(tokBestScore, 48);
          }
        }

        if (!tokMatched) {
          allTokensMatch = false;
          break;
        }
        score += tokBestScore;
      }

      if (allTokensMatch) {
        scored.push({ item, score });
      }
    }

    scored.sort((a, b) => {
      if (q.remindersDueOnly) {
        return (a.item.remindAt ?? 0) - (b.item.remindAt ?? 0);
      }
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.item.isPinned) !== Number(a.item.isPinned)) {
        return Number(b.item.isPinned) - Number(a.item.isPinned);
      }
      return b.item.createdAt - a.item.createdAt;
    });

    return scored.slice(offset, offset + limit).map((entry) => entry.item);
  }

  public searchNonSecretForAsk(question: string, limit = 12): VaultItem[] {
    const platformIntent = detectPlatformIntent(question);
    const groups = expandBilingualQuery(question);
    if (groups.length === 0 && !platformIntent) return [];

    // Cap variants per token group so tail words in longer prompts are never truncated away
    const ftsVariants = Array.from(new Set(groups.flatMap((g) => g.variants.slice(0, 6))))
      .filter((v) => v.length >= 2)
      .slice(0, 48);
    const likeVariants = Array.from(new Set(groups.flatMap((g) => g.variants.slice(0, 4))))
      .filter((v) => v.length >= 2)
      .slice(0, 32);

    const ftsExpr = ftsVariants
      .map((t) => `"${t.replace(/[^\p{L}\p{N}_-]+/gu, '')}"*`)
      .filter((t) => t !== '""*')
      .join(' OR ');

    const candidateRows = new Map<string, ItemRow>();

    // When user explicitly asks for items from a platform (`из инстаграма`, `в телеграме`), pull all matching platform rows directly
    if (platformIntent) {
      const platRows = this.db
        .prepare(
          `SELECT i.* FROM items i
           WHERE i.deleted_at IS NULL AND i.is_archived = 0 AND i.dna != 'secret' AND (
             lower_utf(COALESCE(i.platform, '')) = ?
             OR lower_utf(COALESCE(i.domain, '')) LIKE ?
             OR lower_utf(COALESCE(i.url, '')) LIKE ?
             OR lower_utf(i.tags_json) LIKE ?
           )
           ORDER BY i.created_at DESC
           LIMIT 50`
        )
        .all(
          platformIntent.platform,
          `%${platformIntent.domains[0] ?? platformIntent.platform}%`,
          `%${platformIntent.domains[0] ?? platformIntent.platform}%`,
          `%${platformIntent.platform}%`
        ) as unknown as ItemRow[];
      for (const r of platRows) candidateRows.set(r.id, r);
    }

    if (ftsExpr) {
      try {
        const rankedRows = this.db
          .prepare(
            `SELECT i.* FROM items_fts
             JOIN items i ON i.id = items_fts.id
             WHERE items_fts MATCH ?
               AND i.deleted_at IS NULL AND i.purged_at IS NULL AND i.is_archived = 0 AND i.dna != 'secret'
             ORDER BY bm25(items_fts)
             LIMIT 48`
          )
          .all(ftsExpr) as unknown as ItemRow[];
        for (const r of rankedRows) candidateRows.set(r.id, r);

        const recentFtsRows = this.db
          .prepare(
            `SELECT i.* FROM items i
             WHERE i.deleted_at IS NULL AND i.purged_at IS NULL AND i.is_archived = 0 AND i.dna != 'secret'
               AND i.id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)
             ORDER BY i.created_at DESC
             LIMIT 32`
          )
          .all(ftsExpr) as unknown as ItemRow[];
        for (const r of recentFtsRows) candidateRows.set(r.id, r);
      } catch {
        // Proceed with substring scan
      }
    }

    if (candidateRows.size < Math.max(limit * 2, 16) && likeVariants.length > 0) {
      const combinedClauses: string[] = [];
      const combinedParams: string[] = [];
      for (const term of likeVariants) {
        const pat = `%${escapeSqlLike(term)}%`;
        combinedClauses.push(`(
          lower_utf(i.title) LIKE ? ESCAPE '\\'
          OR lower_utf(i.summary) LIKE ? ESCAPE '\\'
          OR lower_utf(i.body) LIKE ? ESCAPE '\\'
          OR lower_utf(i.ocr_text) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.url, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.domain, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.platform, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(COALESCE(i.media_meta_json, '')) LIKE ? ESCAPE '\\'
          OR lower_utf(i.tags_json) LIKE ? ESCAPE '\\'
        )`);
        combinedParams.push(pat, pat, pat, pat, pat, pat, pat, pat, pat);
      }
      const likeRows = this.db
        .prepare(
          `SELECT i.* FROM items i
           WHERE i.deleted_at IS NULL AND i.is_archived = 0 AND i.dna != 'secret' AND (${combinedClauses.join(' OR ')})
           ORDER BY i.created_at DESC
           LIMIT 60`
        )
        .all(...combinedParams) as unknown as ItemRow[];
      for (const r of likeRows) candidateRows.set(r.id, r);
    }

    const rowMatchesPlatform = (row: ItemRow): boolean => {
      if (!platformIntent) return true;
      const plat = (row.platform || '').toLowerCase();
      const dom = (row.domain || '').toLowerCase();
      const url = (row.url || '').toLowerCase();
      const tags = (row.tags_json || '').toLowerCase();
      if (plat === platformIntent.platform) return true;
      if (platformIntent.domains.some((d) => dom.includes(d) || url.includes(d))) return true;
      if (tags.includes(`"${platformIntent.platform}"`)) return true;
      return false;
    };

    const scored = [...candidateRows.values()]
      .filter(rowMatchesPlatform)
      .map((row) => {
        const hay = `${row.title}\n${row.summary}\n${row.body}\n${row.ocr_text}\n${row.media_meta_json ?? ''}\n${row.url ?? ''}\n${row.domain ?? ''}\n${row.platform ?? ''}\n${row.tags_json}`.toLowerCase();
        let score = platformIntent ? 6 : 0;
        let matchedGroups = 0;
        for (const grp of groups) {
          if (hay.includes(grp.primary)) {
            score += 5;
            matchedGroups++;
          } else if (grp.variants.some((v) => hay.includes(v))) {
            score += 3;
            matchedGroups++;
          }
        }
        return { row, score: score + matchedGroups * 4 };
      });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at)
      .slice(0, limit)
      .map((s) => mapRowToItem(s.row));
  }

  /**
   * Safe aggregate inventory metadata for AI Chat: exposes counts and masked secret descriptors
   * (brand + last4 / service name) while NEVER revealing plaintext secrets or encrypted payloads.
   */
  public getVaultInventorySummary(now = Date.now(), vaultLocked = false): VaultInventorySummary {
    const stats = this.getStats(now);
    const orbits = this.listOrbits();

    const dueRows = this.db
      .prepare(
        `SELECT id, title, dna, orbit, remind_at
         FROM items
         WHERE deleted_at IS NULL AND is_archived = 0 AND dna != 'secret' AND remind_at IS NOT NULL
         ORDER BY remind_at ASC
         LIMIT 8`
      )
      .all() as Array<{ id: string; title: string; dna: ContentDna; orbit: string; remind_at: number }>;

    const dueReminders = dueRows.map((r) => ({
      id: r.id,
      title: r.title,
      dna: r.dna,
      orbit: r.orbit,
      remindAt: r.remind_at,
    }));

    const secretRows = this.db
      .prepare(
        "SELECT id, title, orbit, secret_meta_json FROM items WHERE deleted_at IS NULL AND is_archived = 0 AND dna = 'secret' ORDER BY created_at DESC"
      )
      .all() as Array<{ id: string; title: string; orbit: string; secret_meta_json: string | null }>;

    const bankCards: VaultInventorySummary['bankCards'] = [];
    const secretServices: VaultInventorySummary['secretServices'] = [];
    const secretByOrbit: Record<string, number> = {};
    let passwordCount = 0;
    let apiKeyCount = 0;
    let bankCardCount = 0;

    for (const r of secretRows) {
      secretByOrbit[r.orbit] = (secretByOrbit[r.orbit] ?? 0) + 1;
      if (vaultLocked) continue;

      const meta = safeParseJson<SecretMeta | null>(r.secret_meta_json, null);
      const kind = meta?.kind ?? 'password';
      const cleanedItemTitle = r.title.replace(/\d{12,19}/g, '••••').trim();
      const safeTitle = cleanedItemTitle || meta?.service || translate(this.getLocale(), 'vault.secretWord');
      if (kind === 'bank_card') {
        bankCardCount++;
        const hasLast4InTitle = Boolean(meta?.last4 && safeTitle.includes(meta.last4));
        const normalizedBase = safeTitle.replace(/\s*·?\s*••••\s*\d{4}$/, '').trim() || safeTitle;
        bankCards.push({
          id: r.id,
          title:
            meta?.last4 && !hasLast4InTitle
              ? `${normalizedBase} •••• ${meta.last4}`
              : safeTitle,
          brand: meta?.cardBrand,
          last4: meta?.last4,
          orbit: r.orbit,
        });
      } else {
        if (kind === 'api_key') apiKeyCount++;
        else passwordCount++;
        secretServices.push({
          id: r.id,
          title: safeTitle,
          kind,
          orbit: r.orbit,
        });
      }
    }

    const byOrbit = orbits.map((o) => ({
      id: o.id,
      name: o.name,
      count: Math.max(0, (stats.byOrbit[o.id] ?? 0) - (vaultLocked ? (secretByOrbit[o.id] ?? 0) : 0)),
    }));
    const rawUnassigned = (stats.byOrbit[''] ?? 0) + (stats.byOrbit['inbox'] ?? 0);
    const lockedSecretUnassigned = vaultLocked
      ? (secretByOrbit[''] ?? 0) + (secretByOrbit['inbox'] ?? 0)
      : 0;
    const byDna = vaultLocked ? { ...stats.byDna, secret: 0 } : stats.byDna;

    return {
      totalItems: vaultLocked ? Math.max(0, stats.total - secretRows.length) : stats.total,
      unassignedCount: Math.max(0, rawUnassigned - lockedSecretUnassigned),
      byDna,
      byOrbit,
      vaultLocked,
      bankCardCount: vaultLocked ? 0 : bankCardCount,
      bankCards,
      passwordCount: vaultLocked ? 0 : passwordCount,
      apiKeyCount: vaultLocked ? 0 : apiKeyCount,
      secretServices,
      dueReminderCount: stats.dueRemindersCount,
      dueReminders,
    };
  }

  public getStats(now = Date.now()): {
    total: number;
    inboxCount: number;
    demoCount: number;
    pinnedCount: number;
    archivedCount: number;
    trashedCount: number;
    dueRemindersCount: number;
    byOrbit: Record<string, number>;
    byDna: Record<ContentDna, number>;
  } {
    const rows = this.db
      .prepare(
        `SELECT
           CASE
             WHEN deleted_at IS NOT NULL THEN 2
             WHEN is_archived = 1 THEN 1
             ELSE 0
           END AS bucket,
           orbit,
           dna,
           COUNT(*) AS cnt,
           SUM(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END) AS demo_cnt,
           SUM(CASE WHEN is_pinned = 1 THEN 1 ELSE 0 END) AS pinned_cnt,
           SUM(CASE WHEN remind_at IS NOT NULL AND remind_at <= ? THEN 1 ELSE 0 END) AS due_cnt
         FROM items
         WHERE purged_at IS NULL
         GROUP BY bucket, orbit, dna`
      )
      .all(now) as Array<{
      bucket: number;
      orbit: string;
      dna: ContentDna;
      cnt: number;
      demo_cnt: number;
      pinned_cnt: number;
      due_cnt: number;
    }>;

    let total = 0;
    let inboxCount = 0;
    let demoCount = 0;
    let pinnedCount = 0;
    let archivedCount = 0;
    let trashedCount = 0;
    let dueRemindersCount = 0;
    const byOrbit: Record<string, number> = {};
    const byDna: Record<ContentDna, number> = {
      link: 0,
      secret: 0,
      shot: 0,
      snippet: 0,
      note: 0,
      voice: 0,
      doc: 0,
    };

    for (const r of rows) {
      const cnt = Number(r.cnt ?? 0);
      if (r.bucket === 2) {
        trashedCount += cnt;
      } else if (r.bucket === 1) {
        archivedCount += cnt;
      } else {
        total += cnt;
        if (r.orbit === '' || r.orbit === 'inbox') {
          inboxCount += cnt;
        }
        demoCount += Number(r.demo_cnt ?? 0);
        pinnedCount += Number(r.pinned_cnt ?? 0);
        dueRemindersCount += Number(r.due_cnt ?? 0);
        byOrbit[r.orbit] = (byOrbit[r.orbit] ?? 0) + cnt;
        if (r.dna in byDna) {
          byDna[r.dna] += cnt;
        } else {
          byDna[r.dna] = cnt;
        }
      }
    }

    return {
      total,
      inboxCount,
      demoCount,
      pinnedCount,
      archivedCount,
      trashedCount,
      dueRemindersCount,
      byOrbit,
      byDna,
    };
  }

  public listRemindersWindow(endMs: number): VaultItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND remind_at IS NOT NULL AND remind_at <= ?
         ORDER BY remind_at ASC
         LIMIT 50`
      )
      .all(endMs) as unknown as ItemRow[];
    return rows.map(mapRowToItem);
  }

  public getNextPendingReminder(): VaultItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM items
         WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND remind_at IS NOT NULL AND (reminded_at IS NULL OR reminded_at < remind_at)
         ORDER BY remind_at ASC
         LIMIT 1`
      )
      .get() as ItemRow | undefined;
    return row ? mapRowToItem(row) : null;
  }

  public markReminderNotified(id: string, ts = Date.now()): void {
    const row = this.db.prepare('SELECT updated_at, is_demo FROM items WHERE id = ?').get(id) as
      | { updated_at: number; is_demo: number }
      | undefined;
    if (!row) return;
    const nextUpdated = this.monotonicTimestamp(row.updated_at);
    this.db
      .prepare(
        'UPDATE items SET reminded_at = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?'
      )
      .run(ts, nextUpdated, this.localDeviceId, id);
    if (!row.is_demo) {
      this.markDirty('item', id);
    }
  }

  public pickSerendipityItems(limit = 3): VaultItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE deleted_at IS NULL AND is_archived = 0 AND dna != 'secret'
         ORDER BY RANDOM()
         LIMIT ?`
      )
      .all(limit) as unknown as ItemRow[];
    return rows.map(mapRowToItem);
  }

  public listOrbits(): OrbitDef[] {
    const rows = this.db
      .prepare(
        `SELECT o.*, COUNT(i.id) AS item_count
         FROM orbits o
         LEFT JOIN items i ON i.orbit = o.id AND i.is_archived = 0 AND i.deleted_at IS NULL
         WHERE o.deleted_at IS NULL
         GROUP BY o.id
         ORDER BY o.sort_order ASC`
      )
      .all() as Array<{
      id: string;
      name: string;
      description: string;
      icon: string;
      color: string;
      sort_order: number;
      is_builtin: number;
      created_at?: number | null;
      updated_at?: number | null;
      deleted_at?: number | null;
      item_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
      color: r.color,
      sortOrder: r.sort_order,
      isBuiltin: r.is_builtin === 1,
      createdAt: r.created_at ?? undefined,
      updatedAt: r.updated_at ?? undefined,
      deletedAt: r.deleted_at ?? null,
      itemCount: r.item_count,
    }));
  }

  public findOrbitByNameOrSlug(nameOrId: string): OrbitDef | null {
    const clean = nameOrId.trim().toLowerCase();
    if (!clean) return null;
    const all = this.listOrbits();
    const direct = all.find(
      (o) => o.id.toLowerCase() === clean || o.name.trim().toLowerCase() === clean
    );
    if (direct) return direct;

    // Match via canonical section catalog stems so Finance / Cards / Payments don't split
    const catalog = getOrganicSectionCatalog(this.getLocale());
    const catalogMatch =
      catalog.find((tpl) => tpl.canonicalName.toLowerCase() === clean) ??
      catalog.find((tpl) => tpl.aliases.some((al) => clean.includes(al) || al.includes(clean)));
    if (catalogMatch) {
      const existingCanon = all.find((o) => {
        const oLow = o.name.toLowerCase();
        return (
          oLow === catalogMatch.canonicalName.toLowerCase() ||
          catalogMatch.aliases.some((al) => oLow.includes(al))
        );
      });
      if (existingCanon) return existingCanon;
    }

    const prefix = clean.slice(0, Math.max(4, clean.length - 1));
    return (
      all.find((o) => {
        const oLow = o.name.trim().toLowerCase();
        return oLow.startsWith(prefix) || clean.startsWith(oLow.slice(0, Math.max(4, oLow.length - 1)));
      }) ?? null
    );
  }

  public ensureOrganicOrbit(suggestedName: string, idOverride?: string): OrbitDef | null {
    const clean = suggestedName.trim().slice(0, 28);
    if (!clean) return null;
    const existing = this.findOrbitByNameOrSlug(clean);
    if (existing) return existing;
    if (idOverride) {
      const byId = this.listOrbits().find((o) => o.id === idOverride);
      if (byId) return byId;
    }

    const currentCount = this.listOrbits().length;

    const cleanLower = clean.toLowerCase();
    const catalog = getOrganicSectionCatalog(this.getLocale());
    const catalogTpl =
      catalog.find((tpl) => tpl.canonicalName.toLowerCase() === cleanLower) ??
      catalog.find((tpl) => tpl.aliases.some((al) => cleanLower.includes(al)));
    const displayName = catalogTpl?.canonicalName ?? clean.charAt(0).toUpperCase() + clean.slice(1);
    const color =
      catalogTpl?.color ??
      SECTION_COLOR_PALETTE[currentCount % SECTION_COLOR_PALETTE.length]!;
    const icon = catalogTpl?.icon ?? 'Folder';
    const description = catalogTpl?.description ?? displayName;

    return this.createOrbit({
      name: displayName,
      description,
      color,
      icon,
      id: idOverride,
    });
  }

  public createOrbit(input: {
    id?: string;
    name: string;
    description: string;
    color?: string;
    icon?: string;
  }): OrbitDef {
    const cleanName = input.name.trim().slice(0, 32);
    if (!cleanName) throw new Error(translate(this.getLocale(), 'main.repo.emptySectionName'));

    return this.inTx(() => {
      const countRow = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM orbits WHERE deleted_at IS NULL')
        .get() as { cnt: number };
      const id = input.id?.trim() || crypto.randomUUID();
      const maxSort = this.db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM orbits WHERE deleted_at IS NULL')
        .get() as { m: number };
      const now = Date.now();

      const orbit: OrbitDef = {
        id,
        name: cleanName,
        description: input.description.trim() || cleanName,
        icon: input.icon || 'Folder',
        color: input.color || SECTION_COLOR_PALETTE[countRow.cnt % SECTION_COLOR_PALETTE.length]!,
        sortOrder: maxSort.m + 1,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        itemCount: 0,
      };

      this.db
        .prepare(
          `INSERT INTO orbits (id, name, description, icon, color, sort_order, is_builtin, created_at, updated_at, deleted_at, sync_version, last_device_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 1, ?)`
        )
        .run(
          orbit.id,
          orbit.name,
          orbit.description,
          orbit.icon,
          orbit.color,
          orbit.sortOrder,
          now,
          now,
          this.localDeviceId
        );

      this.markDirty('orbit', orbit.id);
      return orbit;
    });
  }

  public updateOrbit(id: string, patch: OrbitUpdateInput): OrbitDef | null {
    return this.inTx(() => {
      const existing = this.db
        .prepare('SELECT * FROM orbits WHERE id = ? AND deleted_at IS NULL')
        .get(id) as
        | {
            id: string;
            name: string;
            description: string;
            icon: string;
            color: string;
            sort_order: number;
            updated_at?: number | null;
          }
        | undefined;
      if (!existing) return null;

      const nextName = patch.name !== undefined ? patch.name.trim().slice(0, 32) : existing.name;
      if (!nextName) throw new Error(translate(this.getLocale(), 'main.repo.emptySectionName'));
      const nextDesc = patch.description !== undefined ? patch.description.trim().slice(0, 140) : existing.description;
      const nextColor = patch.color !== undefined ? patch.color.trim() : existing.color;
      const nextIcon = patch.icon !== undefined ? patch.icon.trim() : existing.icon;
      const nextSort =
        typeof patch.sortOrder === 'number' && Number.isFinite(patch.sortOrder)
          ? patch.sortOrder
          : existing.sort_order;
      const now = this.monotonicTimestamp(existing.updated_at);

      this.db
        .prepare(
          'UPDATE orbits SET name = ?, description = ?, color = ?, icon = ?, sort_order = ?, is_builtin = 0, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?'
        )
        .run(nextName, nextDesc, nextColor, nextIcon, nextSort, now, this.localDeviceId, id);

      this.markDirty('orbit', id);
      return this.listOrbits().find((o) => o.id === id) ?? null;
    });
  }

  public reorderOrbits(orderedIds: string[]): OrbitDef[] {
    this.inTx(() => {
      const readStmt = this.db.prepare('SELECT updated_at FROM orbits WHERE id = ? AND deleted_at IS NULL');
      const stmt = this.db.prepare(
        'UPDATE orbits SET sort_order = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ? AND deleted_at IS NULL'
      );
      orderedIds.forEach((id, idx) => {
        const cur = readStmt.get(id) as { updated_at?: number | null } | undefined;
        const ts = this.monotonicTimestamp(cur?.updated_at);
        stmt.run(idx + 1, ts, this.localDeviceId, id);
      });
      for (const id of orderedIds) {
        this.markDirty('orbit', id);
      }
    });
    return this.listOrbits();
  }

  public deleteOrbit(id: string): boolean {
    return this.inTx(() => {
      const row = this.db
        .prepare('SELECT id, updated_at FROM orbits WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: string; updated_at?: number | null } | undefined;
      if (!row) return false;
      const now = this.monotonicTimestamp(row.updated_at);
      const orphaned = this.db
        .prepare("SELECT id, updated_at, is_demo FROM items WHERE orbit = ? AND deleted_at IS NULL AND purged_at IS NULL")
        .all(id) as Array<{ id: string; updated_at: number; is_demo: number }>;
      // Orphaned items move cleanly to unassigned '' (still visible in «Все записи»)
      const orphanStmt = this.db.prepare(
        "UPDATE items SET orbit = '', updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?"
      );
      for (const item of orphaned) {
        const itemTs = this.monotonicTimestamp(item.updated_at);
        orphanStmt.run(itemTs, this.localDeviceId, item.id);
      }
      const res = this.db
        .prepare(
          'UPDATE orbits SET deleted_at = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?'
        )
        .run(now, now, this.localDeviceId, id);
      const ok = Number(res.changes) > 0;
      if (ok) {
        this.markDirty('orbit', id);
        for (const item of orphaned) {
          if (!item.is_demo) {
            this.markDirty('item', item.id);
          }
        }
      }
      return ok;
    });
  }

  public listFocusBoards(): FocusBoard[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, COUNT(i.id) AS item_count
         FROM focus_boards f
         LEFT JOIN items i ON i.focus_board_id = f.id AND i.is_archived = 0 AND i.deleted_at IS NULL
         WHERE f.deleted_at IS NULL
         GROUP BY f.id
         ORDER BY f.sort_order ASC, f.created_at DESC`
      )
      .all() as Array<{
      id: string;
      name: string;
      description?: string | null;
      icon: string;
      color: string;
      sort_order?: number | null;
      is_active: number;
      created_at: number;
      updated_at?: number | null;
      deleted_at?: number | null;
      item_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      icon: r.icon,
      color: r.color,
      sortOrder: r.sort_order ?? 0,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? r.created_at,
      deletedAt: r.deleted_at ?? null,
      itemCount: r.item_count,
    }));
  }

  public createFocusBoard(name: string, color = '#3B82F6', icon = 'BookmarkSimple', description = ''): FocusBoard {
    const clean = name.trim().slice(0, 36);
    if (!clean) throw new Error(translate(this.getLocale(), 'main.repo.emptyBoardName'));
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const maxSort = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM focus_boards WHERE deleted_at IS NULL')
      .get() as { m: number };
    const sortOrder = maxSort.m + 1;
    const cleanDesc = description.trim().slice(0, 140);

    const created = this.inTx(() => {
      this.db.prepare('UPDATE focus_boards SET is_active = 0').run();
      this.db
        .prepare(
          `INSERT INTO focus_boards (id, name, description, icon, color, sort_order, is_active, created_at, updated_at, deleted_at, sync_version, last_device_id)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 1, ?)`
        )
        .run(id, clean, cleanDesc, icon, color, sortOrder, createdAt, createdAt, this.localDeviceId);
      this.setSetting('active_focus_board_id', id);
      this.markDirty('focus_board', id);
      return {
        id,
        name: clean,
        description: cleanDesc,
        icon,
        color,
        sortOrder,
        isActive: true,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        itemCount: 0,
      };
    });
    return created;
  }

  public updateFocusBoard(id: string, patch: FocusBoardUpdateInput): FocusBoard | null {
    return this.inTx(() => {
      const existing = this.db
        .prepare('SELECT * FROM focus_boards WHERE id = ? AND deleted_at IS NULL')
        .get(id) as
        | {
            id: string;
            name: string;
            description?: string;
            icon: string;
            color: string;
            sort_order?: number;
            updated_at?: number | null;
          }
        | undefined;
      if (!existing) return null;

      const nextName = patch.name !== undefined ? patch.name.trim().slice(0, 36) : existing.name;
      if (!nextName) throw new Error(translate(this.getLocale(), 'main.repo.emptyBoardName'));
      const nextDesc =
        patch.description !== undefined ? patch.description.trim().slice(0, 140) : (existing.description ?? '');
      const nextColor = patch.color !== undefined ? patch.color.trim() : existing.color;
      const nextIcon = patch.icon !== undefined ? patch.icon.trim() : existing.icon;
      const nextSort =
        typeof patch.sortOrder === 'number' && Number.isFinite(patch.sortOrder)
          ? patch.sortOrder
          : (existing.sort_order ?? 0);
      const now = this.monotonicTimestamp(existing.updated_at);

      this.db
        .prepare(
          'UPDATE focus_boards SET name = ?, description = ?, color = ?, icon = ?, sort_order = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?'
        )
        .run(nextName, nextDesc, nextColor, nextIcon, nextSort, now, this.localDeviceId, id);

      this.markDirty('focus_board', id);
      return this.listFocusBoards().find((b) => b.id === id) ?? null;
    });
  }

  public reorderFocusBoards(orderedIds: string[]): FocusBoard[] {
    this.inTx(() => {
      const readStmt = this.db.prepare('SELECT updated_at FROM focus_boards WHERE id = ? AND deleted_at IS NULL');
      const stmt = this.db.prepare(
        'UPDATE focus_boards SET sort_order = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ? AND deleted_at IS NULL'
      );
      orderedIds.forEach((id, idx) => {
        const cur = readStmt.get(id) as { updated_at?: number | null } | undefined;
        const ts = this.monotonicTimestamp(cur?.updated_at);
        stmt.run(idx + 1, ts, this.localDeviceId, id);
      });
      for (const id of orderedIds) {
        this.markDirty('focus_board', id);
      }
    });
    return this.listFocusBoards();
  }

  public setActiveFocusBoard(id: string | null): void {
    this.inTx(() => {
      this.db.prepare('UPDATE focus_boards SET is_active = 0').run();
      if (id) {
        this.db.prepare('UPDATE focus_boards SET is_active = 1 WHERE id = ? AND deleted_at IS NULL').run(id);
        this.setSetting('active_focus_board_id', id);
      } else {
        this.setSetting('active_focus_board_id', '');
      }
    });
  }

  public deleteFocusBoard(id: string): boolean {
    return this.inTx(() => {
      const boardRow = this.db
        .prepare('SELECT id, updated_at FROM focus_boards WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: string; updated_at?: number | null } | undefined;
      if (!boardRow) return false;
      const now = this.monotonicTimestamp(boardRow.updated_at);
      const orphaned = this.db
        .prepare('SELECT id, updated_at, is_demo FROM items WHERE focus_board_id = ? AND deleted_at IS NULL AND purged_at IS NULL')
        .all(id) as Array<{ id: string; updated_at: number; is_demo: number }>;
      const orphanStmt = this.db.prepare(
        'UPDATE items SET focus_board_id = NULL, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?'
      );
      for (const item of orphaned) {
        const itemTs = this.monotonicTimestamp(item.updated_at);
        orphanStmt.run(itemTs, this.localDeviceId, item.id);
      }
      const res = this.db
        .prepare(
          'UPDATE focus_boards SET deleted_at = ?, is_active = 0, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ? AND deleted_at IS NULL'
        )
        .run(now, now, this.localDeviceId, id);
      if (this.getSetting('active_focus_board_id') === id) {
        this.setSetting('active_focus_board_id', '');
      }
      const ok = Number(res.changes) > 0;
      if (ok) {
        this.markDirty('focus_board', id);
        for (const item of orphaned) {
          if (!item.is_demo) {
            this.markDirty('item', item.id);
          }
        }
      }
      return ok;
    });
  }

  public getCachedAi(contentHash: string): unknown | null {
    const row = this.db
      .prepare('SELECT response_json FROM ai_cache WHERE content_hash = ?')
      .get(contentHash) as { response_json: string } | undefined;
    if (!row) return null;
    return safeParseJson(row.response_json, null);
  }

  public setCachedAi(contentHash: string, response: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO ai_cache (content_hash, response_json, created_at) VALUES (?, ?, ?)')
      .run(contentHash, JSON.stringify(response), Date.now());
  }

  public logAiUsage(
    provider: AiProvider,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    isCloudProxy = false
  ): void {
    const storedModel =
      isCloudProxy && model !== 'cache_hit' && !model.startsWith('cloud_proxy:')
        ? `cloud_proxy:${model}`
        : model;
    this.db
      .prepare(
        'INSERT INTO ai_usage_log (id, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        crypto.randomUUID(),
        provider,
        storedModel,
        inputTokens,
        outputTokens,
        costUsd,
        Date.now()
      );
  }

  public getMonthBudgetSummary(
    provider: AiProvider,
    capUsd = DEFAULT_MONTHLY_CAP_USD,
    hasCloudKey = false
  ): BudgetSummary {
    const safeCap = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : DEFAULT_MONTHLY_CAP_USD;
    const now = new Date();
    const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spent, COUNT(*) AS calls
         FROM ai_usage_log
         WHERE created_at >= ? AND model != 'cache_hit' AND model NOT LIKE 'cloud_proxy:%'`
      )
      .get(startOfMonth) as { spent: number; calls: number };
    const cacheRow = this.db
      .prepare(
        `SELECT COUNT(*) AS hits
         FROM ai_usage_log
         WHERE created_at >= ? AND model = 'cache_hit'`
      )
      .get(startOfMonth) as { hits: number };

    const spentUsd = Number((row.spent ?? 0).toFixed(5));
    return {
      monthKey: getCurrentMonthKey(now),
      spentUsd,
      capUsd: safeCap,
      callsCount: row.calls ?? 0,
      cacheHitsCount: cacheRow.hits ?? 0,
      provider,
      hasCloudKey,
      limitReached: spentUsd >= safeCap,
    };
  }

  public getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  public setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  public saveItemRevision(
    input: {
      itemId: string;
      title: string | null;
      content: string;
      source: ItemRevisionSource;
      deviceName?: string | null;
    },
    opts?: { skipDirty?: boolean }
  ): ItemRevision {
    const contentHash = computeRevisionHash(input.title, input.content);
    const latest = this.db
      .prepare(
        `SELECT id, item_id, title, content, source, content_hash, device_name, created_at, updated_at, deleted_at, sync_version
         FROM item_revisions
         WHERE item_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(input.itemId) as
      | {
          id: string;
          item_id: string;
          title: string | null;
          content: string;
          source: ItemRevisionSource;
          content_hash: string | null;
          device_name: string | null;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
          sync_version: number;
        }
      | undefined;

    if (latest) {
      const latestHash = latest.content_hash ?? computeRevisionHash(latest.title, latest.content);
      if (latestHash === contentHash && (input.source === 'auto' || latest.source === input.source)) {
        return {
          id: latest.id,
          itemId: latest.item_id,
          title: latest.title,
          content: latest.content,
          source: latest.source,
          contentHash: latestHash,
          deviceName: latest.device_name,
          createdAt: latest.created_at,
          updatedAt: latest.updated_at || latest.created_at,
          deletedAt: latest.deleted_at ?? null,
          syncVersion: latest.sync_version ?? 1,
        };
      }
    }

    const createdAt = this.monotonicTimestamp(latest?.created_at);
    const deviceName =
      input.deviceName !== undefined ? input.deviceName : (os.hostname() || null);
    const rev: ItemRevision = {
      id: crypto.randomUUID(),
      itemId: input.itemId,
      title: input.title,
      content: input.content,
      source: input.source,
      contentHash,
      deviceName,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      syncVersion: 1,
    };

    this.inTx(() => {
      this.db
        .prepare(
          `INSERT INTO item_revisions (
            id, item_id, title, content, source, content_hash, device_name,
            created_at, updated_at, deleted_at, sync_version, last_device_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`
        )
        .run(
          rev.id,
          rev.itemId,
          rev.title,
          rev.content,
          rev.source,
          rev.contentHash ?? contentHash,
          rev.deviceName ?? null,
          rev.createdAt,
          rev.createdAt,
          this.localDeviceId
        );

      // Cap non-conflict revisions at 30 per item while protecting sync_conflict snapshots from eviction
      this.db
        .prepare(
          `DELETE FROM item_revisions
           WHERE item_id = ?
             AND deleted_at IS NULL
             AND source != 'sync_conflict'
             AND id NOT IN (
               SELECT id FROM item_revisions
               WHERE item_id = ? AND deleted_at IS NULL AND source != 'sync_conflict'
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             )`
        )
        .run(rev.itemId, rev.itemId, MAX_REVISIONS_PER_ITEM);

      if (!opts?.skipDirty) {
        const parent = this.db
          .prepare('SELECT is_demo, dna FROM items WHERE id = ?')
          .get(rev.itemId) as { is_demo: number; dna: ContentDna } | undefined;
        if (parent && !parent.is_demo && parent.dna !== 'secret') {
          this.markDirty('item_revision', rev.id);
        }
      }
    });

    return rev;
  }

  public listItemRevisions(itemId: string): ItemRevision[] {
    const rows = this.db
      .prepare(
        `SELECT id, item_id, title, content, source, content_hash, device_name, created_at, updated_at, deleted_at, sync_version
         FROM item_revisions
         WHERE item_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT 40`
      )
      .all(itemId) as Array<{
      id: string;
      item_id: string;
      title: string | null;
      content: string;
      source: ItemRevisionSource;
      content_hash: string | null;
      device_name: string | null;
      created_at: number;
      updated_at: number;
      deleted_at: number | null;
      sync_version: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      title: r.title,
      content: r.content,
      source: r.source,
      contentHash: r.content_hash,
      deviceName: r.device_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
      deletedAt: r.deleted_at ?? null,
      syncVersion: r.sync_version ?? 1,
    }));
  }

  public revertItemToRevision(itemId: string, revisionId: string): VaultItem | null {
    const rev = this.db
      .prepare(
        `SELECT id, item_id, title, content, source, created_at
         FROM item_revisions
         WHERE id = ? AND item_id = ? AND deleted_at IS NULL`
      )
      .get(revisionId, itemId) as
      | {
          id: string;
          item_id: string;
          title: string | null;
          content: string;
          source: ItemRevisionSource;
          created_at: number;
        }
      | undefined;
    if (!rev) return null;

    const current = this.getItemById(itemId);
    if (!current) return null;

    if (current.body !== rev.content || (rev.title !== null && current.title !== rev.title)) {
      this.saveItemRevision({
        itemId,
        title: current.title,
        content: current.body,
        source: 'restore',
      });
    }

    return this.updateItem(
      itemId,
      {
        ...(rev.title !== null && rev.title.trim() ? { title: rev.title } : {}),
        body: rev.content,
      },
      { skipAutoRevision: true }
    );
  }

  // ==================== Workspace Prefs (Kanban Columns & Appearance) ====================

  private sanitizeTaskBoardColumns(raw: unknown, locale: AppLocale = this.getLocale()): TaskBoardColumn[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      return getDefaultTaskBoardColumns(locale).map((c) => ({ ...c }));
    }
    const seen = new Set<string>();
    const cleaned: TaskBoardColumn[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id.trim().slice(0, 48) : '';
      const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 48) : '';
      const color =
        typeof obj.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(obj.color.trim())
          ? obj.color.trim()
          : '#94A3B8';
      const rawIcon =
        typeof obj.icon === 'string' ? obj.icon.trim().slice(0, 32) : '';
      const icon = rawIcon && /^[a-z0-9_-]+$/i.test(rawIcon) ? rawIcon : undefined;
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      cleaned.push({
        id,
        title,
        color,
        order: typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : cleaned.length,
        ...(obj.isDone === true || id === 'done' ? { isDone: true } : {}),
        ...(icon ? { icon } : {}),
      });
    }
    if (cleaned.length === 0) {
      return getDefaultTaskBoardColumns(locale).map((c) => ({ ...c }));
    }
    cleaned.sort((a, b) => a.order - b.order);
    if (!cleaned.some((c) => c.isDone || c.id === 'done')) {
      cleaned.push({
        id: 'done',
        title: locale === 'en' ? 'Done' : 'Готово',
        color: '#2EA06B',
        order: cleaned.length,
        isDone: true,
        icon: 'check',
      });
    }
    if (!cleaned.some((c) => !c.isDone && c.id !== 'done')) {
      cleaned.unshift({
        id: 'inbox',
        title: locale === 'en' ? 'Inbox' : 'Входящие',
        color: '#94A3B8',
        order: -1,
        icon: 'tray',
      });
    }
    return cleaned.map((col, idx) => ({ ...col, order: idx }));
  }

  public listTaskBoardColumns(): TaskBoardColumn[] {
    const raw = this.getSetting('task_board_columns_json');
    const locale = this.getLocale();
    if (!raw) return getDefaultTaskBoardColumns(locale).map((c) => ({ ...c }));
    return this.sanitizeTaskBoardColumns(safeParseJson<unknown>(raw, null), locale);
  }

  private bumpWorkspacePrefsSyncMeta(skipDirty = false): void {
    this.bumpVaultMutationVersion();
    this.inTx(() => {
      const prevUpdated = Number(this.getSetting('workspace_prefs_updated_at') || '0') || 0;
      const prevVer = Number(this.getSetting('workspace_prefs_sync_version') || '0') || 0;
      const nextTs = this.monotonicTimestamp(prevUpdated);
      this.setSetting('workspace_prefs_updated_at', String(nextTs));
      this.setSetting('workspace_prefs_sync_version', String(prevVer + 1));
      if (this.localDeviceId) {
        this.setSetting('workspace_prefs_last_device_id', this.localDeviceId);
      }
      if (!skipDirty) {
        this.markDirty('workspace_prefs', 'default');
      }
    });
  }

  public saveTaskBoardColumns(
    columns: TaskBoardColumn[],
    opts?: { skipDirty?: boolean }
  ): TaskBoardColumn[] {
    const sanitized = this.sanitizeTaskBoardColumns(columns);
    this.inTx(() => {
      this.setSetting('task_board_columns_json', JSON.stringify(sanitized));
      this.bumpWorkspacePrefsSyncMeta(Boolean(opts?.skipDirty));
    });
    return sanitized;
  }

  public getAppearanceConfig(): AppearanceConfig {
    const raw = this.getSetting('appearance_config_json');
    if (!raw) return { ...DEFAULT_APPEARANCE_CONFIG };
    const parsed = safeParseJson<Partial<AppearanceConfig> | null>(raw, null);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_APPEARANCE_CONFIG };
    return {
      ...DEFAULT_APPEARANCE_CONFIG,
      ...(parsed.accentMode === 'custom' || parsed.accentMode === 'preset'
        ? { accentMode: parsed.accentMode }
        : {}),
      ...(typeof parsed.accentPreset === 'string'
        ? { accentPreset: parsed.accentPreset as AppearanceConfig['accentPreset'] }
        : {}),
      ...(typeof parsed.accentHex === 'string' && parsed.accentHex.trim()
        ? { accentHex: parsed.accentHex.trim() }
        : {}),
      ...(typeof parsed.sectionAccentEnabled === 'boolean'
        ? { sectionAccentEnabled: parsed.sectionAccentEnabled }
        : {}),
      ...(typeof parsed.bgPreset === 'string'
        ? { bgPreset: parsed.bgPreset as AppearanceConfig['bgPreset'] }
        : {}),
      ...(typeof parsed.bgHue === 'number' && Number.isFinite(parsed.bgHue)
        ? { bgHue: parsed.bgHue }
        : {}),
      ...(typeof parsed.bgTint === 'number' && Number.isFinite(parsed.bgTint)
        ? { bgTint: parsed.bgTint }
        : {}),
      ...(typeof parsed.bgLightness === 'number' && Number.isFinite(parsed.bgLightness)
        ? { bgLightness: parsed.bgLightness }
        : {}),
      ...(parsed.density === 'compact' || parsed.density === 'comfortable'
        ? { density: parsed.density }
        : {}),
      ...(parsed.glassPreset === 'off' ||
      parsed.glassPreset === 'subtle' ||
      parsed.glassPreset === 'frosted' ||
      parsed.glassPreset === 'liquid'
        ? { glassPreset: parsed.glassPreset }
        : {}),
      ...(parsed.glassNativeMaterial === 'none' ||
      parsed.glassNativeMaterial === 'mica' ||
      parsed.glassNativeMaterial === 'acrylic'
        ? { glassNativeMaterial: parsed.glassNativeMaterial }
        : {}),
    };
  }

  public saveAppearanceConfig(
    patch: Partial<AppearanceConfig>,
    opts?: { skipDirty?: boolean }
  ): AppearanceConfig {
    return this.inTx(() => {
      const merged: AppearanceConfig = {
        ...this.getAppearanceConfig(),
        ...patch,
      };
      this.setSetting('appearance_config_json', JSON.stringify(merged));
      this.bumpWorkspacePrefsSyncMeta(Boolean(opts?.skipDirty));
      return merged;
    });
  }

  public getLocale(osLocale?: string | null): AppLocale {
    const stored = this.getSetting('locale');
    if (stored === 'ru' || stored === 'en') {
      return stored;
    }
    if (stored && stored.trim()) {
      return normalizeLocale(stored);
    }
    return detectLocale(process.env.KAPSULA_LOCALE, osLocale ?? this.defaultOsLocale);
  }

  public setLocale(locale: AppLocale, opts?: { skipDirty?: boolean }): AppLocale {
    const normalized = normalizeLocale(locale);
    this.inTx(() => {
      this.setSetting('locale', normalized);
      this.bumpWorkspacePrefsSyncMeta(Boolean(opts?.skipDirty));
    });
    this.bumpVaultMutationVersion();
    return normalized;
  }

  // ==================== Kanban & Vault Tasks ====================

  private collectItemTasksForReconcile(
    body: string,
    meta: MediaMeta | null
  ): Array<{
    taskKey: string;
    sourceType: 'markdown' | 'voice_action';
    taskIndex: number;
    lineIndex?: number;
    text: string;
    done: boolean;
    textHash: string;
  }> {
    const out: Array<{
      taskKey: string;
      sourceType: 'markdown' | 'voice_action';
      taskIndex: number;
      lineIndex?: number;
      text: string;
      done: boolean;
      textHash: string;
    }> = [];

    const mdTasks = parseMarkdownTasks(body || '');
    for (const entry of mdTasks) {
      out.push({
        taskKey: entry.taskKey,
        sourceType: 'markdown',
        taskIndex: entry.index,
        lineIndex: entry.lineIndex,
        text: entry.text,
        done: entry.done,
        textHash: entry.textHash,
      });
    }

    if (meta && Array.isArray(meta.actionItems)) {
      const checkedSet = new Set(
        Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []
      );
      meta.actionItems.forEach((rawText, idx) => {
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        if (!text) return;
        out.push({
          taskKey: `va:${idx}`,
          sourceType: 'voice_action',
          taskIndex: idx,
          text,
          done: checkedSet.has(idx),
          textHash: normalizeTaskTextHash(text),
        });
      });
    }

    return out;
  }

  public listVaultTasks(): VaultTaskEntry[] {
    const locale = this.getLocale();
    if (
      this.tasksCache &&
      this.tasksCache.version === this.vaultMutationVersion &&
      this.tasksCache.locale === locale
    ) {
      return this.tasksCache.tasks.slice();
    }

    const rows = this.db
      .prepare(
        `SELECT id, title, body, orbit, focus_board_id, remind_at, media_meta_json, COALESCE(content_updated_at, updated_at) AS effective_ts
         FROM items
         WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND dna != 'secret'
           AND (
             body LIKE '%[ ]%' OR body LIKE '%[x]%' OR body LIKE '%[X]%'
             OR body LIKE '%\\[ \\]%' ESCAPE '\\' OR body LIKE '%\\[x\\]%' ESCAPE '\\' OR body LIKE '%\\[X\\]%' ESCAPE '\\'
             OR COALESCE(media_meta_json, '') LIKE '%"actionItems"%'
           )
         ORDER BY effective_ts DESC
         LIMIT 5000`
      )
      .all() as Array<{
      id: string;
      title: string;
      body: string;
      orbit: string | null;
      focus_board_id: string | null;
      remind_at: number | null;
      media_meta_json: string | null;
      effective_ts: number;
    }>;

    const columns = this.listTaskBoardColumns();
    const tasks: VaultTaskEntry[] = [];

    for (const row of rows) {
      const itemTitle = row.title?.trim() || translate(locale, 'main.repo.untitledNote');
      const meta = safeParseJson<MediaMeta | null>(row.media_meta_json, null);
      const parsed = this.collectItemTasksForReconcile(row.body || '', meta);
      if (parsed.length === 0) continue;

      const isStandaloneTask = Boolean(meta?.isStandaloneTask);
      const reconciled = reconcileTaskMeta(parsed, meta?.taskMeta, columns);
      for (const entry of parsed) {
        const tm = reconciled[entry.taskKey];
        const dueAt = tm?.dueAt ?? null;
        tasks.push({
          id: `${row.id}:${entry.taskKey}`,
          itemId: row.id,
          itemTitle,
          sourceType: entry.sourceType,
          taskIndex: entry.taskIndex,
          text: entry.text,
          done: entry.done,
          orbit: row.orbit,
          focusBoardId: row.focus_board_id ?? null,
          remindAt: dueAt ?? row.remind_at,
          updatedAt: row.effective_ts,
          taskKey: entry.taskKey,
          columnId: tm?.columnId ?? (entry.done ? 'done' : 'inbox'),
          boardOrder: tm?.boardOrder ?? entry.taskIndex * 1000,
          ...(tm?.customOrder ? { customOrder: true } : {}),
          priority: tm?.priority ?? 'none',
          dueAt,
          ...(tm?.notes ? { notes: tm.notes } : {}),
          ...(isStandaloneTask ? { isStandaloneTask: true } : {}),
        });
      }
    }

    tasks.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (!a.done) {
        const ra = a.dueAt ?? a.remindAt ?? Number.MAX_SAFE_INTEGER;
        const rb = b.dueAt ?? b.remindAt ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
      }
      return b.updatedAt - a.updatedAt;
    });
    this.tasksCache = { version: this.vaultMutationVersion, locale, tasks };
    return tasks.slice();
  }

  public toggleVaultTask(input: {
    itemId: string;
    sourceType: 'markdown' | 'voice_action';
    taskIndex: number;
    done: boolean;
  }): { item: VaultItem; tasks: VaultTaskEntry[] } | null {
    const current = this.getItemById(input.itemId);
    if (!current || current.dna === 'secret') return null;

    const columns = this.listTaskBoardColumns();
    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    let nextBody = current.body || '';

    if (input.sourceType === 'markdown') {
      const toggled = toggleMarkdownTaskInBody(nextBody, input.taskIndex, input.done);
      if (!toggled) return null;
      nextBody = toggled.body;
    } else {
      const actions = Array.isArray(meta.actionItems) ? meta.actionItems : [];
      if (input.taskIndex < 0 || input.taskIndex >= actions.length) return null;
      const checked = new Set(
        Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []
      );
      if (input.done) checked.add(input.taskIndex);
      else checked.delete(input.taskIndex);
      meta.checkedActionIndices = Array.from(checked).sort((a, b) => a - b);
    }

    const updatedTasks = this.collectItemTasksForReconcile(nextBody, meta);
    meta.taskMeta = reconcileTaskMeta(updatedTasks, meta.taskMeta, columns);

    const updated = this.updateItem(
      input.itemId,
      {
        ...(input.sourceType === 'markdown' ? { body: nextBody } : {}),
        mediaMeta: meta,
      },
      { preserveContentUpdatedAt: true }
    );
    if (!updated) return null;
    return {
      item: updated,
      tasks: this.listVaultTasks(),
    };
  }

  private parseTaskKey(taskKey: string): { sourceType: 'markdown' | 'voice_action'; index: number } | null {
    const m = /^(md|va):(\d+)$/.exec((taskKey || '').trim());
    if (!m) return null;
    const index = Number(m[2]);
    if (!Number.isInteger(index) || index < 0) return null;
    return { sourceType: m[1] === 'md' ? 'markdown' : 'voice_action', index };
  }

  public moveTaskOnBoard(input: {
    itemId: string;
    taskKey: string;
    columnId: string;
    boardOrder: number;
  }): VaultItem | null {
    const current = this.getItemById(input.itemId);
    if (!current || current.dna === 'secret') return null;

    const parsedKey = this.parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    const columns = this.listTaskBoardColumns();
    const validTargetCol = columns.some((c) => c.id === input.columnId)
      ? input.columnId
      : (columns.find((c) => !isDoneColumn(c.id, columns))?.id ?? 'inbox');
    const targetIsDone = isDoneColumn(validTargetCol, columns);

    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const beforeTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    const beforeReconciled = reconcileTaskMeta(beforeTasks, meta.taskMeta, columns);
    const targetBefore = beforeTasks.find((t) => t.taskKey === input.taskKey);
    if (!targetBefore) return null;

    let nextBody = current.body || '';
    let bodyChanged = false;
    if (targetIsDone !== targetBefore.done) {
      if (parsedKey.sourceType === 'markdown') {
        const toggled = toggleMarkdownTaskInBody(nextBody, parsedKey.index, targetIsDone);
        if (!toggled) return null;
        nextBody = toggled.body;
        bodyChanged = true;
      } else {
        const checked = new Set(
          Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []
        );
        if (targetIsDone) checked.add(parsedKey.index);
        else checked.delete(parsedKey.index);
        meta.checkedActionIndices = Array.from(checked).sort((a, b) => a - b);
      }
    }

    const prevEntry = beforeReconciled[input.taskKey];
    const nextPrevCol =
      targetIsDone && prevEntry?.columnId && !isDoneColumn(prevEntry.columnId, columns)
        ? prevEntry.columnId
        : prevEntry?.prevColumnId;

    const nextTaskMetaMap: Record<string, TaskBoardItemMeta> = {
      ...beforeReconciled,
      [input.taskKey]: {
        ...(prevEntry ?? { columnId: validTargetCol, boardOrder: 0, priority: 'none', dueAt: null }),
        columnId: validTargetCol,
        ...(nextPrevCol ? { prevColumnId: nextPrevCol } : {}),
        boardOrder: Number.isFinite(input.boardOrder) ? input.boardOrder : 0,
        customOrder: true,
        textHash: targetBefore.textHash,
      },
    };

    const afterTasks = this.collectItemTasksForReconcile(nextBody, meta);
    meta.taskMeta = reconcileTaskMeta(afterTasks, nextTaskMetaMap, columns);

    return this.updateItem(
      input.itemId,
      {
        ...(bodyChanged ? { body: nextBody } : {}),
        mediaMeta: meta,
      },
      { preserveContentUpdatedAt: true }
    );
  }

  public createStandaloneTask(input: CreateTaskInput): VaultItem | null {
    const clean = (input.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return null;

    const columns = this.listTaskBoardColumns();
    const fallbackOpenCol = columns.find((c) => !isDoneColumn(c.id, columns))?.id ?? 'inbox';
    const validCol =
      input.columnId && columns.some((c) => c.id === input.columnId)
        ? input.columnId
        : fallbackOpenCol;
    const done = isDoneColumn(validCol, columns);

    const existingTasks = this.listVaultTasks();
    const colTasks = existingTasks.filter((t) => t.columnId === validCol);
    const maxOrder = colTasks.reduce((m, t) => {
      const ord = typeof t.boardOrder === 'number' && Number.isFinite(t.boardOrder) ? t.boardOrder : 0;
      return ord > m ? ord : m;
    }, 0);
    const boardOrder = colTasks.length === 0 ? 1000 : maxOrder + 1000;

    const priority: TaskPriority =
      input.priority && VALID_TASK_PRIORITIES.has(input.priority) ? input.priority : 'none';
    const dueAt = typeof input.dueAt === 'number' && Number.isFinite(input.dueAt) ? input.dueAt : null;
    const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : undefined;
    const orbit = typeof input.orbit === 'string' ? input.orbit.trim() : '';
    const focusBoardId =
      typeof input.focusBoardId === 'string' && input.focusBoardId.trim()
        ? input.focusBoardId.trim()
        : null;
    const body = `- [${done ? 'x' : ' '}] ${clean}`;
    const title = truncateAtWordBoundary(clean, 72) || clean.slice(0, 72);
    const contentHash = crypto
      .createHash('sha256')
      .update(`task:${crypto.randomUUID()}:${body}`)
      .digest('hex');

    return this.createItem({
      dna: 'note',
      orbit,
      focusBoardId,
      modeCaptured: 'buffer',
      title,
      body,
      mediaMeta: {
        isStandaloneTask: true,
        taskMeta: {
          'md:0': {
            columnId: validCol,
            boardOrder,
            priority,
            dueAt,
            ...(notes ? { notes } : {}),
            textHash: normalizeTaskTextHash(clean),
          },
        },
      },
      source: 'vault_ui',
      contentHash,
      aiStatus: 'local',
      remindAt: dueAt,
    });
  }

  public updateTaskMeta(input: {
    itemId: string;
    taskKey: string;
    priority?: TaskPriority;
    dueAt?: number | null;
    columnId?: string;
    orbit?: string | null;
    focusBoardId?: string | null;
    notes?: string | null;
  }): VaultItem | null {
    const current = this.getItemById(input.itemId);
    if (!current || current.dna === 'secret') return null;

    const parsedKey = this.parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    const columns = this.listTaskBoardColumns();
    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const beforeTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    const beforeReconciled = reconcileTaskMeta(beforeTasks, meta.taskMeta, columns);
    const targetBefore = beforeTasks.find((t) => t.taskKey === input.taskKey);
    if (!targetBefore) return null;

    const prevEntry = beforeReconciled[input.taskKey] ?? {
      columnId: targetBefore.done ? 'done' : 'inbox',
      boardOrder: targetBefore.taskIndex * 1000,
      priority: 'none' as TaskPriority,
      dueAt: null,
      textHash: targetBefore.textHash,
    };

    let nextBody = current.body || '';
    let bodyChanged = false;
    let nextColumnId = prevEntry.columnId;
    let nextPrevColumnId = prevEntry.prevColumnId;

    if (typeof input.columnId === 'string' && columns.some((c) => c.id === input.columnId)) {
      const targetIsDone = isDoneColumn(input.columnId, columns);
      if (targetIsDone && !isDoneColumn(prevEntry.columnId, columns)) {
        nextPrevColumnId = prevEntry.columnId;
      }
      nextColumnId = input.columnId;
      if (targetIsDone !== targetBefore.done) {
        if (parsedKey.sourceType === 'markdown') {
          const toggled = toggleMarkdownTaskInBody(nextBody, parsedKey.index, targetIsDone);
          if (toggled) {
            nextBody = toggled.body;
            bodyChanged = true;
          }
        } else {
          const checked = new Set(
            Array.isArray(meta.checkedActionIndices) ? meta.checkedActionIndices : []
          );
          if (targetIsDone) checked.add(parsedKey.index);
          else checked.delete(parsedKey.index);
          meta.checkedActionIndices = Array.from(checked).sort((a, b) => a - b);
        }
      }
    }

    const nextPriority: TaskPriority =
      input.priority && VALID_TASK_PRIORITIES.has(input.priority)
        ? input.priority
        : (prevEntry.priority ?? 'none');
    const nextDueAt =
      input.dueAt !== undefined
        ? typeof input.dueAt === 'number' && Number.isFinite(input.dueAt)
          ? input.dueAt
          : null
        : (prevEntry.dueAt ?? null);
    const nextNotes =
      input.notes !== undefined
        ? typeof input.notes === 'string' && input.notes.trim()
          ? input.notes.trim()
          : undefined
        : prevEntry.notes;

    const nextEntry: TaskBoardItemMeta = {
      columnId: nextColumnId,
      ...(nextPrevColumnId ? { prevColumnId: nextPrevColumnId } : {}),
      boardOrder: prevEntry.boardOrder,
      ...(prevEntry.customOrder ? { customOrder: true } : {}),
      priority: nextPriority,
      dueAt: nextDueAt,
      ...(nextNotes ? { notes: nextNotes } : {}),
      textHash: targetBefore.textHash,
    };

    const updatedMap: Record<string, TaskBoardItemMeta> = {
      ...beforeReconciled,
      [input.taskKey]: nextEntry,
    };

    const afterTasks = this.collectItemTasksForReconcile(nextBody, meta);
    meta.taskMeta = reconcileTaskMeta(afterTasks, updatedMap, columns);

    const patch: UpdateItemPatch = {
      ...(bodyChanged ? { body: nextBody } : {}),
      mediaMeta: meta,
    };
    if (input.orbit !== undefined) {
      patch.orbit = typeof input.orbit === 'string' ? input.orbit.trim() : '';
    }
    if (input.focusBoardId !== undefined) {
      patch.focusBoardId =
        typeof input.focusBoardId === 'string' && input.focusBoardId.trim()
          ? input.focusBoardId.trim()
          : null;
    }
    if (meta.isStandaloneTask && input.dueAt !== undefined) {
      patch.remindAt = nextDueAt;
    }

    return this.updateItem(input.itemId, patch, { preserveContentUpdatedAt: true });
  }

  public updateVaultTaskText(input: {
    itemId: string;
    taskKey: string;
    text: string;
  }): VaultItem | null {
    const nextText = (input.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!nextText) return null;
    const current = this.getItemById(input.itemId);
    if (!current || current.dna === 'secret') return null;

    const parsedKey = this.parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    const columns = this.listTaskBoardColumns();
    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const beforeTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    const beforeReconciled = reconcileTaskMeta(beforeTasks, meta.taskMeta, columns);
    const target = beforeTasks.find((t) => t.taskKey === input.taskKey);
    if (!target) return null;

    const nextHash = normalizeTaskTextHash(nextText);
    const updatedMap: Record<string, TaskBoardItemMeta> = {
      ...beforeReconciled,
      ...(beforeReconciled[input.taskKey]
        ? {
            [input.taskKey]: {
              ...beforeReconciled[input.taskKey]!,
              textHash: nextHash,
            },
          }
        : {}),
    };

    if (parsedKey.sourceType === 'markdown') {
      const lines = (current.body || '').split(/\r?\n/);
      const rawLine = target.lineIndex !== undefined ? lines[target.lineIndex] : undefined;
      if (typeof rawLine !== 'string') return null;
      const lineRe = /^(\s*[-*•]\s+(?:\\\[|\[)[ xX](?:\\\]|\])\s+)(.+)$/;
      const match = lineRe.exec(rawLine);
      if (!match) return null;
      lines[target.lineIndex!] = `${match[1]}${nextText}`;
      const nextBody = lines.join('\n');
      const mdCount = beforeTasks.filter((t) => t.sourceType === 'markdown').length;
      const isSingleTaskNote =
        mdCount === 1 &&
        (Boolean(meta.isStandaloneTask) ||
          current.title.trim() === target.text.trim() ||
          current.title.trim() === truncateAtWordBoundary(target.text.trim(), 72).trim());
      const afterTasks = this.collectItemTasksForReconcile(nextBody, meta);
      meta.taskMeta = reconcileTaskMeta(afterTasks, updatedMap, columns);
      return this.updateItem(input.itemId, {
        body: nextBody,
        ...(isSingleTaskNote ? { title: truncateAtWordBoundary(nextText, 72) || nextText.slice(0, 72) } : {}),
        mediaMeta: meta,
      });
    }

    const actions = Array.isArray(meta.actionItems) ? [...meta.actionItems] : [];
    if (parsedKey.index < 0 || parsedKey.index >= actions.length) return null;
    actions[parsedKey.index] = nextText;
    meta.actionItems = actions;
    const afterTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    meta.taskMeta = reconcileTaskMeta(afterTasks, updatedMap, columns);
    return this.updateItem(input.itemId, { mediaMeta: meta });
  }

  public deleteVaultTask(input: {
    itemId: string;
    taskKey: string;
  }): { item: VaultItem | null; deletedItemId?: string } | null {
    const current = this.getItemById(input.itemId);
    if (!current || current.dna === 'secret') return null;

    const parsedKey = this.parseTaskKey(input.taskKey);
    if (!parsedKey) return null;

    const columns = this.listTaskBoardColumns();
    const meta: MediaMeta = { ...(current.mediaMeta ?? {}) };
    const beforeTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    const beforeReconciled = reconcileTaskMeta(beforeTasks, meta.taskMeta, columns);
    const target = beforeTasks.find((t) => t.taskKey === input.taskKey);
    if (!target) return null;

    const remainingMetaSeed: Record<string, TaskBoardItemMeta> = { ...beforeReconciled };
    delete remainingMetaSeed[input.taskKey];

    if (parsedKey.sourceType === 'markdown') {
      const lines = (current.body || '').split(/\r?\n/);
      if (target.lineIndex === undefined || target.lineIndex < 0 || target.lineIndex >= lines.length) {
        return null;
      }
      lines.splice(target.lineIndex, 1);
      const remainingBody = lines.join('\n').trim();
      const hasAttachments = Boolean(current.imagePath || current.mediaPath || current.url);
      const hasVoiceActions = Boolean(meta.actionItems && meta.actionItems.length > 0);
      const isStandalone = Boolean(meta.isStandaloneTask);
      const titleMatchesTask =
        isUntitledPlaceholderTitle(current.title) ||
        current.title.trim() === target.text.trim() ||
        current.title.trim() === truncateAtWordBoundary(target.text.trim(), 72).trim();
      const hasPreservedMeta =
        !isStandalone &&
        (current.tags.length > 0 ||
          Boolean(current.remindAt) ||
          Boolean(current.annotations && current.annotations.length > 0) ||
          Boolean(current.linksOut && current.linksOut.length > 0) ||
          !titleMatchesTask);
      const mdCount = beforeTasks.filter((t) => t.sourceType === 'markdown').length;

      if (!remainingBody && !hasAttachments && !hasVoiceActions && !hasPreservedMeta && mdCount === 1) {
        this.deleteItem(current.id);
        return { item: null, deletedItemId: current.id };
      }

      const afterTasks = this.collectItemTasksForReconcile(remainingBody, meta);
      meta.taskMeta = reconcileTaskMeta(afterTasks, remainingMetaSeed, columns);
      const updated = this.updateItem(current.id, { body: remainingBody, mediaMeta: meta });
      return { item: updated };
    }

    const actions = Array.isArray(meta.actionItems) ? [...meta.actionItems] : [];
    if (parsedKey.index < 0 || parsedKey.index >= actions.length) return null;
    actions.splice(parsedKey.index, 1);
    const nextChecked = (meta.checkedActionIndices ?? [])
      .filter((i) => i !== parsedKey.index)
      .map((i) => (i > parsedKey.index ? i - 1 : i));
    meta.actionItems = actions;
    meta.checkedActionIndices = nextChecked;
    const afterTasks = this.collectItemTasksForReconcile(current.body || '', meta);
    meta.taskMeta = reconcileTaskMeta(afterTasks, remainingMetaSeed, columns);
    const updated = this.updateItem(current.id, { mediaMeta: meta });
    return { item: updated };
  }

  // ==================== Calendar Events ====================

  public listCalendarEvents(range?: { startAt?: number; endAt?: number; includeDeleted?: boolean }): CalendarEvent[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (!range?.includeDeleted) {
      conditions.push('deleted_at IS NULL');
    }
    if (typeof range?.startAt === 'number' && Number.isFinite(range.startAt)) {
      conditions.push("(end_at > ? OR (end_at = start_at AND start_at >= ?) OR (recurrence IS NOT NULL AND recurrence != 'none'))");
      params.push(range.startAt, range.startAt);
    }
    if (typeof range?.endAt === 'number' && Number.isFinite(range.endAt)) {
      conditions.push('start_at < ?');
      params.push(range.endAt);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM calendar_events ${where} ORDER BY start_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapCalendarEventRow(r));
  }

  private mapCalendarEventRow(r: Record<string, unknown>): CalendarEvent {
    let checklist: CalendarChecklistItem[] = [];
    if (typeof r.checklist_json === 'string' && r.checklist_json.trim()) {
      try {
        const raw = JSON.parse(r.checklist_json) as unknown;
        if (Array.isArray(raw)) {
          checklist = raw
            .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
            .map((x) => ({
              id: typeof x.id === 'string' ? x.id : crypto.randomUUID(),
              text: typeof x.text === 'string' ? x.text : '',
              done: Boolean(x.done),
            }))
            .filter((x) => x.text.trim().length > 0);
        }
      } catch {
        checklist = [];
      }
    }
    let attachments: string[] = [];
    if (typeof r.attachments_json === 'string' && r.attachments_json.trim()) {
      try {
        const raw = JSON.parse(r.attachments_json) as unknown;
        if (Array.isArray(raw)) {
          attachments = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        }
      } catch {
        attachments = [];
      }
    }
    return {
      id: String(r.id),
      title: String(r.title),
      notes: String(r.notes ?? ''),
      location: String(r.location ?? ''),
      startAt: Number(r.start_at),
      endAt: Number(r.end_at),
      allDay: Number(r.all_day) === 1,
      hasEndTime: Number(r.has_end_time ?? 0) === 1,
      color: String(r.color ?? '#E86A33'),
      kind: (r.kind as CalendarEventKind) || 'event',
      recurrence: (typeof r.recurrence === 'string' ? r.recurrence : 'none') as CalendarEvent['recurrence'],
      isDone: Number(r.is_done) === 1,
      linkedItemId: r.linked_item_id ? String(r.linked_item_id) : null,
      checklist,
      attachments,
      externalSource: r.external_source ? String(r.external_source) : null,
      externalId: r.external_id ? String(r.external_id) : null,
      etag: r.etag ? String(r.etag) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      deletedAt: r.deleted_at ? Number(r.deleted_at) : null,
      syncVersion: Number(r.sync_version ?? 1),
    };
  }

  public getCalendarEventById(id: string): CalendarEvent | null {
    const r = this.db
      .prepare('SELECT * FROM calendar_events WHERE id = ? AND deleted_at IS NULL')
      .get(id) as Record<string, unknown> | undefined;
    return r ? this.mapCalendarEventRow(r) : null;
  }

  public findCalendarEventByExternalId(source: string, externalId: string): CalendarEvent | null {
    const r = this.db
      .prepare('SELECT * FROM calendar_events WHERE external_source = ? AND external_id = ? LIMIT 1')
      .get(source, externalId) as Record<string, unknown> | undefined;
    return r ? this.mapCalendarEventRow(r) : null;
  }

  public findCalendarEventByLinkedItemId(linkedItemId: string): CalendarEvent | null {
    const r = this.db
      .prepare('SELECT * FROM calendar_events WHERE linked_item_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1')
      .get(linkedItemId) as Record<string, unknown> | undefined;
    return r ? this.mapCalendarEventRow(r) : null;
  }

  public upsertCalendarEvent(
    input: CalendarEventInput & {
      externalSource?: string | null;
      externalId?: string | null;
      etag?: string | null;
      deletedAt?: number | null;
      resurrectDeleted?: boolean;
    }
  ): CalendarEvent {
    const baseNow = Date.now();
    const cleanTitle = (input.title || '').trim().slice(0, 140) || translate(this.getLocale(), 'main.repo.eventFallback');
    const startAt = Number.isFinite(input.startAt) ? input.startAt : baseNow;
    const endAt = Math.max(startAt, Number.isFinite(input.endAt) ? input.endAt : startAt + 3_600_000);

    return this.inTx(() => {
      let existing = input.id ? this.getCalendarEventById(input.id) : null;
      if (!existing && input.externalSource && input.externalId) {
        existing = this.findCalendarEventByExternalId(input.externalSource, input.externalId);
      }
      if (!existing && input.externalSource === 'vault_auto' && input.linkedItemId) {
        existing = this.findCalendarEventByLinkedItemId(input.linkedItemId);
      }

      // Guard against resurrecting a locally deleted external (.ics/Google) event unless caller explicitly restores it
      if (existing && existing.deletedAt != null && input.deletedAt === undefined && !input.resurrectDeleted) {
        return existing;
      }

      const now = this.monotonicTimestamp(existing?.updatedAt);
      const id = existing?.id || input.id || crypto.randomUUID();
      if (existing) {
        const nextChecklist = input.checklist !== undefined ? input.checklist : existing.checklist;
        const nextAttachments = input.attachments !== undefined ? input.attachments : existing.attachments;
        this.db
          .prepare(
            `UPDATE calendar_events SET
              title = ?, notes = ?, location = ?, start_at = ?, end_at = ?, all_day = ?, has_end_time = ?,
              color = ?, kind = ?, recurrence = ?, is_done = ?, linked_item_id = ?, checklist_json = ?, attachments_json = ?,
              external_source = ?, external_id = ?, etag = ?,
              updated_at = ?, deleted_at = ?, sync_version = sync_version + 1, last_device_id = ?
             WHERE id = ?`
          )
          .run(
            cleanTitle,
            (input.notes ?? existing.notes).trim(),
            (input.location ?? existing.location).trim(),
            startAt,
            endAt,
            input.allDay !== undefined ? (input.allDay ? 1 : 0) : existing.allDay ? 1 : 0,
            input.hasEndTime !== undefined ? (input.hasEndTime ? 1 : 0) : existing.hasEndTime ? 1 : 0,
            input.color ?? existing.color,
            input.kind ?? existing.kind,
            input.recurrence ?? existing.recurrence ?? 'none',
            input.isDone !== undefined ? (input.isDone ? 1 : 0) : existing.isDone ? 1 : 0,
            input.linkedItemId !== undefined ? input.linkedItemId : existing.linkedItemId,
            JSON.stringify(nextChecklist),
            JSON.stringify(nextAttachments),
            input.externalSource !== undefined ? input.externalSource : existing.externalSource,
            input.externalId !== undefined ? input.externalId : existing.externalId,
            input.etag !== undefined ? input.etag : existing.etag,
            now,
            input.deletedAt !== undefined ? input.deletedAt : null,
            this.localDeviceId,
            id
          );
        this.markDirty('calendar_event', id);
        return (
          this.getCalendarEventById(id) ?? {
            ...existing,
            title: cleanTitle,
            deletedAt: input.deletedAt ?? null,
          }
        );
      }

      this.db
        .prepare(
          `INSERT INTO calendar_events (
            id, title, notes, location, start_at, end_at, all_day, has_end_time, color, kind, recurrence, is_done,
            linked_item_id, checklist_json, attachments_json, external_source, external_id, etag,
            created_at, updated_at, deleted_at, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          id,
          cleanTitle,
          (input.notes ?? '').trim(),
          (input.location ?? '').trim(),
          startAt,
          endAt,
          input.allDay ? 1 : 0,
          input.hasEndTime ? 1 : 0,
          input.color ?? '#E86A33',
          input.kind ?? 'event',
          input.recurrence ?? 'none',
          input.isDone ? 1 : 0,
          input.linkedItemId ?? null,
          JSON.stringify(input.checklist ?? []),
          JSON.stringify(input.attachments ?? []),
          input.externalSource ?? null,
          input.externalId ?? null,
          input.etag ?? null,
          now,
          now,
          input.deletedAt ?? null,
          this.localDeviceId
        );
      this.markDirty('calendar_event', id);
      return this.getCalendarEventById(id)!;
    });
  }

  public deleteCalendarEvent(id: string): boolean {
    return this.inTx(() => {
      const existing = this.db
        .prepare('SELECT updated_at FROM calendar_events WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { updated_at: number } | undefined;
      if (!existing) return false;
      const now = this.monotonicTimestamp(existing.updated_at);
      const res = this.db
        .prepare(
          'UPDATE calendar_events SET deleted_at = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ? AND deleted_at IS NULL'
        )
        .run(now, now, this.localDeviceId, id);
      const ok = Number(res.changes) > 0;
      if (ok) {
        this.markDirty('calendar_event', id);
      }
      return ok;
    });
  }

  // ==================== Related Items & Wiki Backlinks ====================

  public listBacklinksToItem(itemId: string): VaultItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE deleted_at IS NULL AND is_archived = 0 AND dna != 'secret'
           AND id != ? AND lower_utf(links_out_json) LIKE ?
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all(itemId, `%"${itemId.toLowerCase()}"%`) as unknown as ItemRow[];
    return rows.map(mapRowToItem);
  }

  public listRelatedItems(itemId: string, limit = 5): Array<{ item: VaultItem; reason: string; score: number }> {
    const locale = this.getLocale();
    const cacheKey = `${this.vaultMutationVersion}:${locale}:${itemId}:${limit}`;
    const cached = this.relatedCache.get(cacheKey);
    if (cached) return cached.slice();

    const target = this.getItemById(itemId);
    if (!target || target.dna === 'secret') return [];

    const sourceText = `${target.title} ${target.summary} ${target.body.slice(0, 600)} ${target.tags.join(' ')}`;
    const seenPrimary = new Set<string>();
    const groups = expandBilingualQuery(sourceText).filter((grp) => {
      if (grp.primary.length < 3) return false;
      const key = grp.primary.toLowerCase();
      if (seenPrimary.has(key)) return false;
      seenPrimary.add(key);
      return true;
    });
    const targetTags = new Set(target.tags.map((t) => t.toLowerCase()));
    const targetLinks = new Set(target.linksOut);

    const candMap = new Map<string, ItemRow>();
    const addCandidateRows = (rows: ItemRow[]) => {
      for (const r of rows) {
        if (r.id !== itemId && !candMap.has(r.id)) {
          candMap.set(r.id, r);
        }
      }
    };

    // 1. Direct forward wiki-links
    if (target.linksOut.length > 0) {
      const linkIds = target.linksOut.filter((id) => id && id !== itemId).slice(0, 60);
      if (linkIds.length > 0) {
        const placeholders = linkIds.map(() => '?').join(', ');
        const forwardRows = this.db
          .prepare(
            `SELECT * FROM items
             WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND dna != 'secret'
               AND id IN (${placeholders})`
          )
          .all(...linkIds) as unknown as ItemRow[];
        addCandidateRows(forwardRows);
      }
    }

    // 2. Direct wiki backlinks
    const backlinkRows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND dna != 'secret'
           AND id != ? AND lower_utf(links_out_json) LIKE ?
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all(itemId, `%"${itemId.toLowerCase()}"%`) as unknown as ItemRow[];
    addCandidateRows(backlinkRows);

    // 3. Same Focus Board (indexed via idx_items_focus_board_active)
    if (target.focusBoardId) {
      const boardRows = this.db
        .prepare(
          `SELECT * FROM items
           WHERE focus_board_id = ? AND is_archived = 0 AND deleted_at IS NULL AND purged_at IS NULL
             AND dna != 'secret' AND id != ?
           ORDER BY created_at DESC
           LIMIT 40`
        )
        .all(target.focusBoardId, itemId) as unknown as ItemRow[];
      addCandidateRows(boardRows);
    }

    // 4. Shared topic/tag matches via FTS5
    const ftsTermSet = new Set<string>();
    for (const tag of target.tags.slice(0, 8)) {
      const clean = tag.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
      for (const w of clean.split(/\s+/)) {
        if (w.length >= 2) ftsTermSet.add(`"${w.toLowerCase()}"*`);
      }
    }
    for (const grp of groups.slice(0, 12)) {
      for (const v of grp.variants.slice(0, 3)) {
        const clean = v.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
        for (const w of clean.split(/\s+/)) {
          if (w.length >= 2) ftsTermSet.add(`"${w.toLowerCase()}"*`);
        }
      }
    }
    const ftsExpr = Array.from(ftsTermSet).slice(0, 36).join(' OR ');
    if (ftsExpr) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT i.* FROM items i
             WHERE i.deleted_at IS NULL AND i.purged_at IS NULL AND i.is_archived = 0 AND i.dna != 'secret' AND i.id != ?
               AND i.id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)
             ORDER BY i.created_at DESC
             LIMIT 100`
          )
          .all(itemId, ftsExpr) as unknown as ItemRow[];
        addCandidateRows(ftsRows);
      } catch {
        // Fallback handled below
      }
    }

    // 5. Small recent fallback when targeted hits are sparse
    if (candMap.size < 40) {
      const recentRows = this.db
        .prepare(
          `SELECT * FROM items
           WHERE deleted_at IS NULL AND purged_at IS NULL AND is_archived = 0 AND dna != 'secret' AND id != ?
           ORDER BY created_at DESC
           LIMIT 40`
        )
        .all(itemId) as unknown as ItemRow[];
      addCandidateRows(recentRows);
    }

    const scored: Array<{ item: VaultItem; reason: string; score: number }> = [];
    for (const row of candMap.values()) {
      const cand = mapRowToItem(row);
      let score = 0;
      const reasons: string[] = [];

      if (targetLinks.has(cand.id) || cand.linksOut.includes(target.id)) {
        score += 40;
        reasons.push(translate(locale, 'main.repo.reasonDirect'));
      }
      if (target.focusBoardId && cand.focusBoardId === target.focusBoardId) {
        score += 14;
        reasons.push(translate(locale, 'main.repo.reasonBoard'));
      }
      const sharedTags = cand.tags.filter((t) => targetTags.has(t.toLowerCase()));
      if (sharedTags.length > 0) {
        score += sharedTags.length * 10;
        reasons.push(
          translate(locale, 'main.repo.reasonTags', {
            tags: `#${sharedTags.slice(0, 2).join(', #')}`,
          })
        );
      }
      if (target.orbit && cand.orbit === target.orbit && score > 0) {
        score += 4;
      }

      const hay = `${cand.title} ${cand.summary} ${cand.body.slice(0, 500)} ${cand.domain ?? ''} ${cand.tags.join(' ')}`.toLowerCase();
      let tokenHits = 0;
      const hitTokens: string[] = [];
      for (const grp of groups) {
        if (grp.primary.length < 3) continue;
        if (grp.variants.some((v) => hay.includes(v))) {
          tokenHits++;
          if (hitTokens.length < 2) hitTokens.push(grp.primary);
        }
      }
      if (tokenHits >= 2) {
        score += tokenHits * 6;
        if (reasons.length === 0) {
          reasons.push(
            translate(locale, 'main.repo.reasonTopic', { tokens: hitTokens.join(', ') })
          );
        }
      }

      if (score >= 12) {
        scored.push({
          item: cand,
          reason: reasons[0] ?? translate(locale, 'main.repo.reasonSimilar'),
          score,
        });
      }
    }

    const result = scored.sort((a, b) => b.score - a.score).slice(0, limit);
    if (this.relatedCache.size >= 64) {
      const oldestKey = this.relatedCache.keys().next().value;
      if (oldestKey) this.relatedCache.delete(oldestKey);
    }
    this.relatedCache.set(cacheKey, result);
    return result.slice();
  }

  // ==================== E2EE Cloud Sync Persistence & LWW Merge ====================

  public getSyncState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  public setSyncState(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
  }

  public deleteSyncState(key: string): void {
    this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
  }

  public listDirtyEntities(
    limit = 200,
    now = Date.now()
  ): Array<{
    entityType: SyncEntityType;
    entityId: string;
    dirtyAt: number;
    dirtySeq: number;
    failCount: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, dirty_at, dirty_seq, fail_count
         FROM sync_dirty
         WHERE next_retry_at <= ?
         ORDER BY
           CASE entity_type
             WHEN 'orbit' THEN 0
             WHEN 'focus_board' THEN 1
             WHEN 'item' THEN 2
             WHEN 'calendar_event' THEN 3
             WHEN 'item_revision' THEN 4
             WHEN 'workspace_prefs' THEN 5
             ELSE 6
           END ASC,
           dirty_seq ASC,
           dirty_at ASC
         LIMIT ?`
      )
      .all(now, limit) as Array<{
      entity_type: SyncEntityType;
      entity_id: string;
      dirty_at: number;
      dirty_seq: number;
      fail_count: number;
    }>;
    return rows.map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      dirtyAt: r.dirty_at,
      dirtySeq: r.dirty_seq,
      failCount: Number(r.fail_count ?? 0),
    }));
  }

  public isEntityDirty(entityType: SyncEntityType, entityId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM sync_dirty WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId);
    return Boolean(row);
  }

  public recordDirtyFailure(
    entityType: SyncEntityType,
    entityId: string,
    errorMessage: string,
    now = Date.now()
  ): void {
    const existing = this.db
      .prepare('SELECT fail_count FROM sync_dirty WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { fail_count: number } | undefined;
    if (!existing) return;
    const nextFail = Number(existing.fail_count ?? 0) + 1;
    const backoff =
      DEAD_LETTER_BACKOFFS_MS[Math.min(nextFail - 1, DEAD_LETTER_BACKOFFS_MS.length - 1)]!;
    this.db
      .prepare(
        `UPDATE sync_dirty
         SET fail_count = ?, last_error = ?, next_retry_at = ?
         WHERE entity_type = ? AND entity_id = ?`
      )
      .run(nextFail, errorMessage.slice(0, 500), now + backoff, entityType, entityId);
  }

  public countFailedDirtyEntities(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM sync_dirty WHERE fail_count > 0')
      .get() as { cnt: number };
    return Number(row?.cnt ?? 0);
  }

  public clearDirtyByEntityType(entityType: SyncEntityType): void {
    this.db.prepare('DELETE FROM sync_dirty WHERE entity_type = ?').run(entityType);
  }

  public clearDirtyEntity(entityType: SyncEntityType, entityId: string, maxDirtySeq: number): void {
    this.db
      .prepare('DELETE FROM sync_dirty WHERE entity_type = ? AND entity_id = ? AND dirty_seq <= ?')
      .run(entityType, entityId, maxDirtySeq);
  }

  public clearAllDirtyEntities(): void {
    this.db.prepare('DELETE FROM sync_dirty').run();
  }

  public countDirtyEntities(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM sync_dirty').get() as { cnt: number };
    return row.cnt;
  }

  public countSyncableRecords(): number {
    const i = (this.db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_demo = 0 AND deleted_at IS NULL AND purged_at IS NULL').get() as { c: number }).c;
    const o = (this.db.prepare('SELECT COUNT(*) AS c FROM orbits WHERE deleted_at IS NULL').get() as { c: number }).c;
    const b = (this.db.prepare('SELECT COUNT(*) AS c FROM focus_boards WHERE deleted_at IS NULL').get() as { c: number }).c;
    const e = (this.db.prepare('SELECT COUNT(*) AS c FROM calendar_events WHERE deleted_at IS NULL').get() as { c: number }).c;
    return i + o + b + e;
  }

  public listLocalTombstones(): Array<{
    entityType: SyncEntityType;
    entityId: string;
    dna?: ContentDna;
    updatedAt: number;
    deletedAt: number;
    purgedAt?: number | null;
    syncVersion: number;
  }> {
    const out: Array<{
      entityType: SyncEntityType;
      entityId: string;
      dna?: ContentDna;
      updatedAt: number;
      deletedAt: number;
      purgedAt?: number | null;
      syncVersion: number;
    }> = [];

    const items = this.db
      .prepare('SELECT id, dna, updated_at, deleted_at, purged_at, sync_version FROM items WHERE is_demo = 0 AND deleted_at IS NOT NULL')
      .all() as Array<{
      id: string;
      dna: ContentDna;
      updated_at: number;
      deleted_at: number;
      purged_at: number | null;
      sync_version: number;
    }>;
    for (const r of items) {
      out.push({
        entityType: 'item',
        entityId: r.id,
        dna: r.dna,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
        purgedAt: r.purged_at ?? null,
        syncVersion: r.sync_version ?? 1,
      });
    }

    const orbits = this.db
      .prepare('SELECT id, updated_at, deleted_at, sync_version FROM orbits WHERE deleted_at IS NOT NULL')
      .all() as Array<{ id: string; updated_at: number | null; deleted_at: number; sync_version: number }>;
    for (const r of orbits) {
      out.push({
        entityType: 'orbit',
        entityId: r.id,
        updatedAt: r.updated_at ?? r.deleted_at,
        deletedAt: r.deleted_at,
        syncVersion: r.sync_version ?? 1,
      });
    }

    const boards = this.db
      .prepare('SELECT id, updated_at, deleted_at, sync_version FROM focus_boards WHERE deleted_at IS NOT NULL')
      .all() as Array<{ id: string; updated_at: number | null; deleted_at: number; sync_version: number }>;
    for (const r of boards) {
      out.push({
        entityType: 'focus_board',
        entityId: r.id,
        updatedAt: r.updated_at ?? r.deleted_at,
        deletedAt: r.deleted_at,
        syncVersion: r.sync_version ?? 1,
      });
    }

    const events = this.db
      .prepare('SELECT id, updated_at, deleted_at, sync_version FROM calendar_events WHERE deleted_at IS NOT NULL')
      .all() as Array<{ id: string; updated_at: number; deleted_at: number; sync_version: number }>;
    for (const r of events) {
      out.push({
        entityType: 'calendar_event',
        entityId: r.id,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
        syncVersion: r.sync_version ?? 1,
      });
    }

    return out;
  }

  /**
   * Advances a local entity's updated_at / sync_version / last_device_id when the remote Postgres
   * LWW trigger rejected a local delete/purge due to wall-clock skew on another device.
   */
  public bumpEntityTimestampForSyncConflict(
    entityType: SyncEntityType,
    entityId: string,
    minUpdatedAt: number,
    minSyncVersion: number
  ): void {
    const ts = Math.max(minUpdatedAt, Date.now());
    const ver = Math.max(1, Math.floor(minSyncVersion));
    if (entityType === 'item') {
      this.db
        .prepare(
          `UPDATE items
           SET updated_at = ?,
               sync_version = CASE WHEN sync_version >= ? THEN sync_version + 1 ELSE ? END,
               last_device_id = ?
           WHERE id = ?`
        )
        .run(ts, ver, ver, this.localDeviceId, entityId);
    } else if (entityType === 'orbit') {
      this.db
        .prepare(
          `UPDATE orbits
           SET updated_at = ?,
               sync_version = CASE WHEN sync_version >= ? THEN sync_version + 1 ELSE ? END,
               last_device_id = ?
           WHERE id = ?`
        )
        .run(ts, ver, ver, this.localDeviceId, entityId);
    } else if (entityType === 'focus_board') {
      this.db
        .prepare(
          `UPDATE focus_boards
           SET updated_at = ?,
               sync_version = CASE WHEN sync_version >= ? THEN sync_version + 1 ELSE ? END,
               last_device_id = ?
           WHERE id = ?`
        )
        .run(ts, ver, ver, this.localDeviceId, entityId);
    } else if (entityType === 'calendar_event') {
      this.db
        .prepare(
          `UPDATE calendar_events
           SET updated_at = ?,
               sync_version = CASE WHEN sync_version >= ? THEN sync_version + 1 ELSE ? END,
               last_device_id = ?
           WHERE id = ?`
        )
        .run(ts, ver, ver, this.localDeviceId, entityId);
    } else if (entityType === 'item_revision') {
      this.db
        .prepare(
          `UPDATE item_revisions
           SET updated_at = ?,
               sync_version = CASE WHEN sync_version >= ? THEN sync_version + 1 ELSE ? END,
               last_device_id = ?
           WHERE id = ?`
        )
        .run(ts, ver, ver, this.localDeviceId, entityId);
    } else if (entityType === 'workspace_prefs') {
      this.setSetting('workspace_prefs_updated_at', String(ts));
      this.setSetting('workspace_prefs_sync_version', String(ver));
      if (this.localDeviceId) {
        this.setSetting('workspace_prefs_last_device_id', this.localDeviceId);
      }
    }
  }

  public enqueueAllEntitiesForInitialSync(): number {
    const now = Date.now();
    return this.inTx(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO sync_dirty
          (entity_type, entity_id, dirty_at, dirty_seq, fail_count, last_error, next_retry_at)
         VALUES (?, ?, ?, ?, 0, NULL, 0)`
      );
      let count = 0;
      const orbits = this.db.prepare('SELECT id FROM orbits').all() as Array<{ id: string }>;
      for (const r of orbits) {
        stmt.run('orbit', r.id, now, this.nextDirtySeq());
        count++;
      }
      const boards = this.db.prepare('SELECT id FROM focus_boards').all() as Array<{ id: string }>;
      for (const r of boards) {
        stmt.run('focus_board', r.id, now, this.nextDirtySeq());
        count++;
      }
      const items = this.db
        .prepare('SELECT id FROM items WHERE is_demo = 0')
        .all() as Array<{ id: string }>;
      for (const r of items) {
        stmt.run('item', r.id, now, this.nextDirtySeq());
        count++;
      }
      const events = this.db
        .prepare('SELECT id FROM calendar_events')
        .all() as Array<{ id: string }>;
      for (const r of events) {
        stmt.run('calendar_event', r.id, now, this.nextDirtySeq());
        count++;
      }
      // Enqueue up to the newest 15 non-deleted revisions per non-demo non-secret item
      const revStmt = this.db.prepare(
        `SELECT id FROM item_revisions
         WHERE item_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      );
      for (const it of items) {
        const revs = revStmt.all(it.id, MAX_SYNCED_REVISIONS_PER_ITEM) as Array<{ id: string }>;
        for (const rev of revs) {
          stmt.run('item_revision', rev.id, now, this.nextDirtySeq());
          count++;
        }
      }
      if (this.getSetting('workspace_prefs_updated_at')) {
        stmt.run('workspace_prefs', 'default', now, this.nextDirtySeq());
        count++;
      }
      return count;
    });
  }

  public getRawItemRevisionById(id: string): {
    id: string;
    item_id: string;
    title: string | null;
    content: string;
    source: ItemRevisionSource;
    content_hash: string | null;
    device_name: string | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    sync_version: number;
    last_device_id: string | null;
  } | null {
    const row = this.db.prepare('SELECT * FROM item_revisions WHERE id = ?').get(id) as
      | {
          id: string;
          item_id: string;
          title: string | null;
          content: string;
          source: ItemRevisionSource;
          content_hash: string | null;
          device_name: string | null;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
          sync_version: number;
          last_device_id: string | null;
        }
      | undefined;
    return row ?? null;
  }

  public isRevisionWithinSyncWindow(itemId: string, revisionId: string, maxCount = MAX_SYNCED_REVISIONS_PER_ITEM): boolean {
    const rows = this.db
      .prepare(
        `SELECT id FROM item_revisions
         WHERE item_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(itemId, maxCount) as Array<{ id: string }>;
    return rows.some((r) => r.id === revisionId);
  }

  public getWorkspacePrefsForSync(): SyncedWorkspacePrefsPayload | null {
    const updatedRaw = this.getSetting('workspace_prefs_updated_at');
    if (!updatedRaw) return null;
    const updatedAt = Number(updatedRaw) || Date.now();
    const syncVersion = Number(this.getSetting('workspace_prefs_sync_version') || '1') || 1;
    const hasColumns = Boolean(this.getSetting('task_board_columns_json'));
    const hasAppearance = Boolean(this.getSetting('appearance_config_json'));
    const storedLocale = this.getSetting('locale');
    const hasLocale = storedLocale === 'ru' || storedLocale === 'en';
    if (!hasColumns && !hasAppearance && !hasLocale) return null;
    return {
      v: 1,
      id: 'default',
      ...(hasColumns ? { taskBoardColumns: this.listTaskBoardColumns() } : {}),
      ...(hasAppearance ? { appearance: this.getAppearanceConfig() } : {}),
      ...(hasLocale ? { locale: storedLocale } : {}),
      updatedAt,
      deletedAt: null,
      syncVersion,
    };
  }

  public applySyncedWorkspacePrefs(
    payload: SyncedWorkspacePrefsPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean } {
    const localUpdatedRaw = this.getSetting('workspace_prefs_updated_at');
    const localMeta = localUpdatedRaw
      ? {
          updatedAt: Number(localUpdatedRaw) || 0,
          syncVersion: Number(this.getSetting('workspace_prefs_sync_version') || '1') || 1,
          deletedAt: null,
          deviceId: this.getSetting('workspace_prefs_last_device_id') || localDeviceId,
        }
      : null;

    const cmp = this.compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt ?? null,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }

    this.inTx(() => {
      if (Array.isArray(payload.taskBoardColumns) && payload.taskBoardColumns.length > 0) {
        const sanitized = this.sanitizeTaskBoardColumns(payload.taskBoardColumns);
        this.setSetting('task_board_columns_json', JSON.stringify(sanitized));
      }
      if (payload.appearance && typeof payload.appearance === 'object') {
        const merged: AppearanceConfig = {
          ...this.getAppearanceConfig(),
          ...payload.appearance,
        };
        this.setSetting('appearance_config_json', JSON.stringify(merged));
      }
      if (payload.locale === 'ru' || payload.locale === 'en') {
        this.setSetting('locale', payload.locale);
      }
      this.setSetting('workspace_prefs_updated_at', String(payload.updatedAt));
      this.setSetting('workspace_prefs_sync_version', String(payload.syncVersion));
      this.setSetting('workspace_prefs_last_device_id', remoteDeviceId);
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'workspace_prefs' AND entity_id = 'default'")
        .run();
    });

    this.bumpVaultMutationVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public applySyncedItemRevision(
    payload: SyncedItemRevisionPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean } {
    const parent = this.getRawRowById(payload.itemId);
    if (parent?.purged_at != null && !payload.deletedAt) {
      // Never resurrect revisions belonging to a permanently purged item
      return { applied: false, localStrictlyNewer: false };
    }

    const existing = this.getRawItemRevisionById(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updated_at || existing.created_at,
          syncVersion: existing.sync_version ?? 1,
          deletedAt: existing.deleted_at ?? null,
          deviceId: existing.last_device_id || localDeviceId,
        }
      : null;

    const cmp = this.compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt ?? null,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }

    const contentHash = payload.contentHash || computeRevisionHash(payload.title, payload.content);

    this.inTx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO item_revisions (
            id, item_id, title, content, source, content_hash, device_name,
            created_at, updated_at, deleted_at, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.id,
          payload.itemId,
          payload.deletedAt ? '' : payload.title,
          payload.deletedAt ? '' : payload.content,
          payload.source,
          payload.deletedAt ? '' : contentHash,
          payload.deviceName ?? null,
          payload.createdAt,
          payload.updatedAt,
          payload.deletedAt ?? null,
          payload.syncVersion,
          remoteDeviceId
        );
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'item_revision' AND entity_id = ?")
        .run(payload.id);
    });

    return { applied: true, localStrictlyNewer: false };
  }

  public getRawOrbitById(id: string): {
    id: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    sort_order: number;
    is_builtin: number;
    created_at: number | null;
    updated_at: number | null;
    deleted_at: number | null;
    sync_version: number | null;
    last_device_id: string | null;
  } | null {
    const row = this.db.prepare('SELECT * FROM orbits WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          description: string;
          icon: string;
          color: string;
          sort_order: number;
          is_builtin: number;
          created_at: number | null;
          updated_at: number | null;
          deleted_at: number | null;
          sync_version: number | null;
          last_device_id: string | null;
        }
      | undefined;
    return row ?? null;
  }

  public getRawFocusBoardById(id: string): {
    id: string;
    name: string;
    description: string | null;
    icon: string;
    color: string;
    sort_order: number | null;
    is_active: number;
    created_at: number;
    updated_at: number | null;
    deleted_at: number | null;
    sync_version: number | null;
    last_device_id: string | null;
  } | null {
    const row = this.db.prepare('SELECT * FROM focus_boards WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          description: string | null;
          icon: string;
          color: string;
          sort_order: number | null;
          is_active: number;
          created_at: number;
          updated_at: number | null;
          deleted_at: number | null;
          sync_version: number | null;
          last_device_id: string | null;
        }
      | undefined;
    return row ?? null;
  }

  public getRawCalendarEventById(id: string): (CalendarEvent & { lastDeviceId?: string | null }) | null {
    const r = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      ...this.mapCalendarEventRow(r),
      lastDeviceId: typeof r.last_device_id === 'string' ? r.last_device_id : null,
    };
  }

  public getBlobCache(localName: string): {
    localName: string;
    blobId: string;
    sha256: string;
    byteSize: number;
    mtimeMs: number;
    uploadedForUser: string | null;
  } | null {
    const row = this.db
      .prepare('SELECT local_name, blob_id, sha256, byte_size, mtime_ms, uploaded_for_user FROM sync_blob_cache WHERE local_name = ?')
      .get(localName) as
      | {
          local_name: string;
          blob_id: string;
          sha256: string;
          byte_size: number;
          mtime_ms: number;
          uploaded_for_user: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      localName: row.local_name,
      blobId: row.blob_id,
      sha256: row.sha256,
      byteSize: row.byte_size,
      mtimeMs: Number(row.mtime_ms ?? 0),
      uploadedForUser: row.uploaded_for_user,
    };
  }

  public upsertBlobCache(entry: {
    localName: string;
    blobId: string;
    sha256: string;
    byteSize: number;
    mtimeMs: number;
    uploadedForUser: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_blob_cache (local_name, blob_id, sha256, byte_size, mtime_ms, uploaded_for_user)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.localName,
        entry.blobId,
        entry.sha256,
        entry.byteSize,
        entry.mtimeMs,
        entry.uploadedForUser
      );
  }

  public clearSyncBlobCache(): void {
    this.db.prepare('DELETE FROM sync_blob_cache').run();
  }

  private isMediaReferencedElsewhere(localName: string, excludeItemId?: string): boolean {
    const activeItems = this.db
      .prepare('SELECT id, image_path, thumb_path, media_path, media_meta_json, body FROM items WHERE purged_at IS NULL AND id != ?')
      .all(excludeItemId ?? '') as Array<{
      id: string;
      image_path: string | null;
      thumb_path: string | null;
      media_path: string | null;
      media_meta_json: string | null;
      body: string;
    }>;
    for (const row of activeItems) {
      if (row.image_path === localName || row.thumb_path === localName || row.media_path === localName) {
        return true;
      }
      if (row.media_meta_json && row.media_meta_json.includes(localName)) {
        const meta = safeParseJson<MediaMeta | null>(row.media_meta_json, null);
        if (meta?.galleryPaths?.includes(localName)) return true;
      }
      if (row.body && row.body.includes(localName)) {
        if (extractInlineMediaFilenames(row.body).includes(localName)) return true;
      }
    }
    const calRows = this.db
      .prepare('SELECT attachments_json FROM calendar_events WHERE deleted_at IS NULL')
      .all() as Array<{ attachments_json: string }>;
    for (const c of calRows) {
      if (c.attachments_json && c.attachments_json.includes(localName)) {
        const list = safeParseJson<string[]>(c.attachments_json, []);
        if (list.includes(localName)) return true;
      }
    }
    return false;
  }

  public getPendingBlobDeletes(): string[] {
    const raw = this.getSyncState('pending_blob_deletes');
    if (!raw) return [];
    const parsed = safeParseJson<unknown>(raw, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v));
  }

  public removePendingBlobDeletes(blobIds: string[]): void {
    if (blobIds.length === 0) return;
    const drop = new Set(blobIds);
    const remaining = this.getPendingBlobDeletes().filter((id) => !drop.has(id));
    if (remaining.length === 0) {
      this.deleteSyncState('pending_blob_deletes');
    } else {
      this.setSyncState('pending_blob_deletes', JSON.stringify(remaining));
    }
  }

  public enqueuePendingBlobDeletes(localNames: string[], excludeItemId?: string): void {
    if (!localNames || localNames.length === 0) return;
    const queue = new Set(this.getPendingBlobDeletes());
    let changed = false;

    for (const rawName of localNames) {
      const name = (rawName || '').trim();
      if (!name) continue;
      if (this.isMediaReferencedElsewhere(name, excludeItemId)) continue;

      const cached = this.getBlobCache(name);
      if (!cached || !/^[a-f0-9]{64}$/i.test(cached.blobId)) continue;

      // Ensure no other live/trashed media file maps to the same deduplicated content-addressed blobId
      const siblings = this.db
        .prepare('SELECT local_name FROM sync_blob_cache WHERE blob_id = ? AND local_name != ?')
        .all(cached.blobId, name) as Array<{ local_name: string }>;
      const sharedStillUsed = siblings.some((s) =>
        this.isMediaReferencedElsewhere(s.local_name, excludeItemId)
      );
      if (sharedStillUsed) continue;

      if (!queue.has(cached.blobId)) {
        queue.add(cached.blobId);
        changed = true;
      }
    }

    if (changed) {
      this.setSyncState('pending_blob_deletes', JSON.stringify(Array.from(queue)));
    }
  }

  /**
   * Decision #2 (SYNC-01): Wipes all personal user records, secrets, integrations, and AI caches
   * on sign-out / account deletion / account switch while preserving device identity & UI prefs.
   */
  public wipeAllUserData(): void {
    this.inTx(() => {
      this.db.exec(`
        DELETE FROM items;
        DELETE FROM items_fts;
        DELETE FROM item_revisions;
        DELETE FROM orbits;
        DELETE FROM focus_boards;
        DELETE FROM calendar_events;
        DELETE FROM ai_cache;
        DELETE FROM ai_usage_log;
        DELETE FROM sync_dirty;
        DELETE FROM sync_blob_cache;
      `);

      this.db
        .prepare(
          "DELETE FROM sync_state WHERE key NOT IN ('device_id', 'device_name', 'custom_supabase_url')"
        )
        .run();

      this.db
        .prepare(
          `DELETE FROM settings WHERE
             key LIKE 'api_key_%'
             OR key LIKE 'gcal_%'
             OR key LIKE 'tg_%'
             OR key LIKE 'pin_%'
             OR key = 'master_pin_hash'
             OR key = 'clipper_paired_origins'
             OR key = 'email_inbound_token'
             OR key LIKE 'ai_provider%'`
        )
        .run();
      this.tagUniverseCache = null;
      this.bumpVaultMutationVersion();
    });
  }

  private compareLww(
    local: { updatedAt: number; syncVersion: number; deletedAt: number | null; deviceId: string } | null,
    remote: { updatedAt: number; syncVersion: number; deletedAt: number | null; deviceId: string }
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

  public applySyncedOrbit(
    payload: SyncedOrbitPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean } {
    const existing = this.getRawOrbitById(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updated_at ?? existing.created_at ?? 0,
          syncVersion: existing.sync_version ?? 1,
          deletedAt: existing.deleted_at ?? null,
          deviceId: existing.last_device_id || localDeviceId,
        }
      : null;
    const cmp = this.compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }

    this.inTx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO orbits (
            id, name, description, icon, color, sort_order, is_builtin, created_at, updated_at, deleted_at, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.id,
          payload.name,
          payload.description,
          payload.icon,
          payload.color,
          payload.sortOrder,
          payload.isBuiltin ? 1 : 0,
          payload.createdAt,
          payload.updatedAt,
          payload.deletedAt,
          payload.syncVersion,
          remoteDeviceId
        );
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'orbit' AND entity_id = ?")
        .run(payload.id);
    });
    this.bumpVaultMutationVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public applySyncedFocusBoard(
    payload: SyncedFocusBoardPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean } {
    const existing = this.getRawFocusBoardById(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updated_at ?? existing.created_at ?? 0,
          syncVersion: existing.sync_version ?? 1,
          deletedAt: existing.deleted_at ?? null,
          deviceId: existing.last_device_id || localDeviceId,
        }
      : null;
    const cmp = this.compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: payload.deletedAt,
      deviceId: remoteDeviceId,
    });
    if (cmp !== 'remote') {
      return { applied: false, localStrictlyNewer: cmp === 'local' };
    }

    const nextActive = payload.deletedAt ? 0 : existing ? existing.is_active : 0;
    this.inTx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO focus_boards (
            id, name, description, icon, color, sort_order, is_active, created_at, updated_at, deleted_at, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.id,
          payload.name,
          payload.description ?? '',
          payload.icon,
          payload.color,
          payload.sortOrder ?? 0,
          nextActive,
          payload.createdAt,
          payload.updatedAt,
          payload.deletedAt,
          payload.syncVersion,
          remoteDeviceId
        );
      if (payload.deletedAt && this.getSetting('active_focus_board_id') === payload.id) {
        this.setSetting('active_focus_board_id', '');
      }
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'focus_board' AND entity_id = ?")
        .run(payload.id);
    });
    this.bumpVaultMutationVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public applySyncedCalendarEvent(
    payload: SyncedCalendarEventPayload,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean } {
    const existing = this.getRawCalendarEventById(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updatedAt,
          syncVersion: existing.syncVersion ?? 1,
          deletedAt: existing.deletedAt,
          deviceId: existing.lastDeviceId || localDeviceId,
        }
      : null;
    const cmp = this.compareLww(localMeta, {
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
      const conflict = this.db
        .prepare('SELECT id FROM calendar_events WHERE external_source = ? AND external_id = ? AND id != ?')
        .get(safeExtSource, safeExtId, payload.id) as { id: string } | undefined;
      if (conflict) {
        safeExtSource = null;
        safeExtId = null;
      }
    }

    this.inTx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO calendar_events (
            id, title, notes, location, start_at, end_at, all_day, has_end_time, color, kind, recurrence, is_done,
            linked_item_id, checklist_json, attachments_json, external_source, external_id, etag,
            created_at, updated_at, deleted_at, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.id,
          payload.title,
          payload.notes,
          payload.location,
          payload.startAt,
          payload.endAt,
          payload.allDay ? 1 : 0,
          payload.hasEndTime ? 1 : 0,
          payload.color,
          payload.kind,
          payload.recurrence ?? 'none',
          payload.isDone ? 1 : 0,
          payload.linkedItemId,
          JSON.stringify(payload.checklist ?? []),
          JSON.stringify(payload.attachments ?? []),
          safeExtSource,
          safeExtId,
          payload.etag,
          payload.createdAt,
          payload.updatedAt,
          payload.deletedAt,
          payload.syncVersion,
          remoteDeviceId
        );
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'calendar_event' AND entity_id = ?")
        .run(payload.id);
    });
    this.bumpVaultMutationVersion();
    return { applied: true, localStrictlyNewer: false };
  }

  public applySyncedItem(
    payload: SyncedItemPayload,
    localEncryptedPayload: string | null,
    remoteDeviceId: string,
    localDeviceId: string
  ): { applied: boolean; localStrictlyNewer: boolean; item: VaultItem | null; freedMedia: string[] } {
    const existing = this.getRawRowById(payload.id);
    const localMeta = existing
      ? {
          updatedAt: existing.updated_at,
          syncVersion: existing.sync_version ?? 1,
          deletedAt: existing.deleted_at ?? null,
          deviceId: existing.last_device_id || localDeviceId,
        }
      : null;

    const remotePurgedAt = payload.purgedAt ?? null;
    const effectiveRemoteDeletedAt = payload.deletedAt ?? remotePurgedAt;

    // Permanent purge is strictly irreversible: a stale or clock-skewed remote live/trashed
    // record must NEVER resurrect a locally purged item; advance local tombstone to heal cloud.
    if (existing?.purged_at != null && remotePurgedAt == null) {
      const bumpedUpdatedAt = Math.max(payload.updatedAt + 1, existing.updated_at + 1, Date.now());
      const bumpedSyncVersion = Math.max(existing.sync_version ?? 1, payload.syncVersion) + 1;
      this.bumpEntityTimestampForSyncConflict('item', payload.id, bumpedUpdatedAt, bumpedSyncVersion);
      return {
        applied: false,
        localStrictlyNewer: true,
        item: null,
        freedMedia: [],
      };
    }

    const cmp = this.compareLww(localMeta, {
      updatedAt: payload.updatedAt,
      syncVersion: payload.syncVersion,
      deletedAt: effectiveRemoteDeletedAt,
      deviceId: remoteDeviceId,
    });

    if (cmp !== 'remote') {
      const existingMeta = existing ? safeParseJson<MediaMeta | null>(existing.media_meta_json, null) : null;
      const existingTags = existing ? safeParseJson<string[]>(existing.tags_json, []) : [];
      const existingActions = existing
        ? safeParseJson<ExtractedAction[]>(existing.extracted_actions_json, [])
        : [];
      const remoteContentDiffers = Boolean(
        existing &&
          (existing.deleted_at != null ||
            (payload.title ?? '') !== (existing.title ?? '') ||
            (payload.body ?? '') !== (existing.body ?? '') ||
            (payload.orbit ?? '') !== (existing.orbit ?? '') ||
            (payload.remindAt ?? null) !== (existing.remind_at ?? null) ||
            JSON.stringify(payload.tags ?? []) !== JSON.stringify(existingTags) ||
            (payload.mediaMeta?.transcript ?? '') !== (existingMeta?.transcript ?? '') ||
            JSON.stringify(payload.extractedActions ?? []) !== JSON.stringify(existingActions))
      );
      const remoteTextChangedOrRestored = Boolean(
        existing &&
          (existing.deleted_at != null ||
            (payload.title ?? '') !== (existing.title ?? '') ||
            (payload.body ?? '') !== (existing.body ?? ''))
      );
      const remoteRevHash = computeRevisionHash(payload.title, payload.body);
      const alreadyInRevisions = Boolean(
        this.db
          .prepare(
            'SELECT 1 FROM item_revisions WHERE item_id = ? AND content_hash = ? AND deleted_at IS NULL LIMIT 1'
          )
          .get(payload.id, remoteRevHash)
      );
      // Preserve losing remote live edit in item_revisions (source = 'sync_conflict') if its text wasn't already captured
      if (
        cmp === 'local' &&
        existing &&
        existing.dna !== 'secret' &&
        !existing.purged_at &&
        !effectiveRemoteDeletedAt &&
        !remotePurgedAt &&
        ((payload.body || '').trim().length > 0 || (payload.title || '').trim().length > 0) &&
        remoteContentDiffers &&
        remoteTextChangedOrRestored &&
        !alreadyInRevisions
      ) {
        this.saveItemRevision({
          itemId: payload.id,
          title: payload.title,
          content: payload.body,
          source: 'sync_conflict',
          deviceName: translate(this.getLocale(), 'main.repo.remoteDevice', {
            id: remoteDeviceId.slice(0, 8),
          }),
        });
      }
      return {
        applied: false,
        localStrictlyNewer: cmp === 'local',
        item: existing && !existing.deleted_at && !existing.purged_at ? mapRowToItem(existing) : null,
        freedMedia: [],
      };
    }

    const isPurged = remotePurgedAt != null;
    const freedMedia = isPurged && existing ? this.collectItemMediaRefs(existing) : [];

    const existingMetaForLocal = existing ? safeParseJson<MediaMeta | null>(existing.media_meta_json, null) : null;
    const existingTagsForLocal = existing ? safeParseJson<string[]>(existing.tags_json, []) : [];
    const existingActionsForLocal = existing
      ? safeParseJson<ExtractedAction[]>(existing.extracted_actions_json, [])
      : [];
    const localContentDiffers = Boolean(
      existing &&
        (effectiveRemoteDeletedAt != null ||
          (payload.title ?? '') !== (existing.title ?? '') ||
          (payload.body ?? '') !== (existing.body ?? '') ||
          (payload.orbit ?? '') !== (existing.orbit ?? '') ||
          (payload.remindAt ?? null) !== (existing.remind_at ?? null) ||
          JSON.stringify(payload.tags ?? []) !== JSON.stringify(existingTagsForLocal) ||
          (payload.mediaMeta?.transcript ?? '') !== (existingMetaForLocal?.transcript ?? '') ||
          JSON.stringify(payload.extractedActions ?? []) !== JSON.stringify(existingActionsForLocal))
    );
    const isConcurrentLocalEdit = Boolean(
      existing &&
        (this.isEntityDirty('item', payload.id) ||
          (existing.last_device_id === localDeviceId && remoteDeviceId !== localDeviceId))
    );

    // Preserve losing local edit in item_revisions (source = 'sync_conflict') before overwriting
    if (
      !isPurged &&
      existing &&
      !existing.deleted_at &&
      !existing.purged_at &&
      existing.dna !== 'secret' &&
      (existing.body.trim().length > 0 || existing.title.trim().length > 0) &&
      isConcurrentLocalEdit &&
      localContentDiffers
    ) {
      this.saveItemRevision({
        itemId: payload.id,
        title: existing.title,
        content: existing.body,
        source: 'sync_conflict',
      });
    } else if (
      !isPurged &&
      existing &&
      !existing.deleted_at &&
      !existing.purged_at &&
      existing.dna === 'secret' &&
      existing.encrypted_payload &&
      localEncryptedPayload &&
      existing.encrypted_payload !== localEncryptedPayload &&
      isConcurrentLocalEdit
    ) {
      // Concurrent secret edit: preserve losing local encrypted payload in an encrypted conflict copy without plaintext leak
      const conflictSuffix = this.getLocale() === 'en' ? 'conflict copy' : 'конфликтная копия';
      const conflictTitle = `${existing.title || 'Secret'} (${conflictSuffix})`.slice(0, 140);
      this.createItem({
        dna: 'secret',
        subKind: (existing.sub_kind as ItemSubKind | null) ?? undefined,
        orbit: existing.orbit,
        modeCaptured: (existing.mode_captured as CaptureMode) || 'ghost',
        focusBoardId: existing.focus_board_id,
        title: conflictTitle,
        body: existing.body,
        encryptedPayload: existing.encrypted_payload,
        secretMeta: safeParseJson<SecretMeta | null>(existing.secret_meta_json, null),
        tags: existingTagsForLocal,
        source: 'sync_conflict' as ItemSource,
        contentHash: `conflict:${existing.id}:${existing.sync_version}:${Date.now()}`,
      });
    }

    let safeExternalId = isPurged ? null : payload.externalId;
    if (safeExternalId) {
      const conflict = this.db
        .prepare('SELECT id FROM items WHERE source = ? AND external_id = ? AND id != ? AND deleted_at IS NULL')
        .get(payload.source, safeExternalId, payload.id) as { id: string } | undefined;
      if (conflict) {
        safeExternalId = null;
      }
    }

    const row = this.inTx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO items (
            id, dna, sub_kind, orbit, mode_captured, focus_board_id,
            title, title_norm, body, summary, url, domain, platform,
            image_path, thumb_path, media_path, media_type, media_duration_sec, media_meta_json, og_image_url,
            ocr_text, extracted_actions_json, color_palette_json,
            encrypted_payload, secret_meta_json, tags_json, source, external_id,
            content_hash, ai_status, ai_confidence, is_pinned, is_muted, is_archived, is_demo,
            remind_at, reminded_at, created_at, updated_at, content_updated_at,
            deleted_at, purged_at, canvas_x, canvas_y, canvas_w, canvas_h, canvas_frame,
            annotations_json, links_out_json, sync_version, last_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          payload.id,
          payload.dna,
          isPurged ? null : payload.subKind,
          isPurged ? '' : (payload.orbit ?? ''),
          payload.modeCaptured,
          isPurged ? null : payload.focusBoardId,
          isPurged ? '' : payload.title,
          isPurged ? '' : (payload.title || '').trim().toLowerCase(),
          isPurged ? '' : payload.body,
          isPurged ? '' : payload.summary,
          isPurged ? null : payload.url,
          isPurged ? null : payload.domain,
          isPurged ? null : payload.platform,
          isPurged ? null : payload.imagePath,
          isPurged ? null : payload.thumbPath,
          isPurged ? null : payload.mediaPath,
          isPurged ? null : payload.mediaType,
          isPurged ? null : payload.mediaDurationSec,
          isPurged ? null : payload.mediaMeta ? JSON.stringify(payload.mediaMeta) : null,
          isPurged ? null : payload.ogImageUrl,
          isPurged ? '' : payload.ocrText,
          isPurged ? '[]' : JSON.stringify(payload.extractedActions ?? []),
          isPurged ? '[]' : JSON.stringify(payload.colorPalette ?? []),
          isPurged ? null : localEncryptedPayload,
          isPurged ? null : payload.secretMeta ? JSON.stringify(payload.secretMeta) : null,
          isPurged ? '[]' : JSON.stringify(payload.tags ?? []),
          payload.source,
          safeExternalId,
          payload.contentHash,
          payload.aiStatus,
          isPurged ? null : payload.aiConfidence,
          isPurged ? 0 : payload.isPinned ? 1 : 0,
          isPurged ? 0 : payload.isMuted ? 1 : 0,
          isPurged ? 0 : payload.isArchived ? 1 : 0,
          isPurged ? null : payload.remindAt,
          isPurged ? null : payload.remindedAt,
          payload.createdAt,
          payload.updatedAt,
          payload.contentUpdatedAt ?? payload.updatedAt,
          effectiveRemoteDeletedAt,
          remotePurgedAt,
          isPurged ? null : payload.canvasX,
          isPurged ? null : payload.canvasY,
          isPurged ? null : payload.canvasW,
          isPurged ? null : payload.canvasH,
          isPurged ? null : payload.canvasFrame,
          isPurged ? '[]' : JSON.stringify(payload.annotations ?? []),
          isPurged ? '[]' : JSON.stringify(payload.linksOut ?? []),
          payload.syncVersion,
          remoteDeviceId
        );

      const saved = this.db.prepare('SELECT * FROM items WHERE id = ?').get(payload.id) as unknown as ItemRow;
      if (effectiveRemoteDeletedAt || isPurged) {
        (this.ftsDeleteStmt ??= this.db.prepare('DELETE FROM items_fts WHERE id = ?')).run(payload.id);
      } else {
        this.syncFtsRow(saved);
      }
      if (isPurged) {
        this.db
          .prepare(
            `UPDATE item_revisions
             SET title = '', content = '', content_hash = '', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
             WHERE item_id = ?`
          )
          .run(remotePurgedAt, payload.updatedAt, payload.id);
      }
      this.db
        .prepare("DELETE FROM sync_dirty WHERE entity_type = 'item' AND entity_id = ?")
        .run(payload.id);
      this.tagUniverseCache = null;
      return saved;
    });

    if (isPurged && freedMedia.length > 0) {
      this.enqueuePendingBlobDeletes(freedMedia, payload.id);
    }

    this.bumpVaultMutationVersion();
    return {
      applied: true,
      localStrictlyNewer: false,
      item: row.deleted_at || row.purged_at ? null : mapRowToItem(row),
      freedMedia,
    };
  }
}
