import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { damerauDistanceWithin, scoreBilingualFields } from '@shared/bilingual-search';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import * as thumbnailService from '@main/pipeline/thumbnail-service';
import { importMarkdownFolder } from '@main/bridges/markdown-importer';
import { VaultCrypto } from '@main/security/vault-crypto';
import { SyncEngine } from '@main/sync/sync-engine';
import type { SupabaseClient } from '@supabase/supabase-js';

const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function createTestEnv(prefix = 'kapsula-e0-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'vault.sqlite');
  const mediaDir = path.join(dir, 'media');
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  const cryptoVault = new VaultCrypto(dir, null);
  const pipeline = new CapturePipeline({
    repo,
    cryptoVault,
    dataDir: dir,
    getConfig: () => ({
      activeMode: 'autopilot',
      activeFocusBoardId: null,
      aiProvider: 'local',
      apiKey: null,
      monthlyCapUsd: 2.0,
      enableAutoOcr: false,
      enableUrlUnfurl: false,
    }),
  });
  return { dir, dbPath, mediaDir, repo, cryptoVault, pipeline };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore close errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('Echelon 0 #2: bilingual-search Int32Array & 2-pass parity', () => {
  it('computes bounded Damerau-Levenshtein accurately for short, identical, empty, and >64 char strings', () => {
    expect(damerauDistanceWithin('капсула', 'капсула', 2)).toBe(0);
    expect(damerauDistanceWithin('', 'abc', 3)).toBe(3);
    expect(damerauDistanceWithin('abc', '', 2)).toBe(3); // > maxDist
    expect(damerauDistanceWithin('капсула', 'капусла', 2)).toBe(1);
    expect(damerauDistanceWithin('выделение', 'выдление', 2)).toBe(1);

    const longA = `${'a'.repeat(70)}bc${'d'.repeat(20)}`;
    const longB = `${'a'.repeat(70)}cb${'d'.repeat(20)}`;
    expect(damerauDistanceWithin(longA, longB, 2)).toBe(1);

    const longDiff = `${'a'.repeat(75)}xyz`;
    expect(damerauDistanceWithin(longA, longDiff, 2)).toBe(3); // early exit > maxDist

    // Clamp final DP return to maxDist + 1 when final rowMin <= maxDist
    expect(damerauDistanceWithin('abcd', 'efghij', 4)).toBe(5);
  });

  it('preserves exact/variant scores with allowFuzzy: false and falls back cleanly with allowFuzzy: true', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    try {
      const exactFields = {
        title: 'Архитектура Kapsula',
        body: 'Обычный текст заметки',
        tags: ['проект'],
        updatedAt: Date.now() - 10_000,
      };
      const strictExact = scoreBilingualFields(exactFields, 'kapsula', { allowFuzzy: false });
      const fullExact = scoreBilingualFields(exactFields, 'kapsula', { allowFuzzy: true });
      expect(strictExact).toBeGreaterThan(0);
      expect(strictExact).toBe(fullExact);

      // Transliterated / synonym variant works in pass 1 without fuzzy
      const strictVariant = scoreBilingualFields(exactFields, 'капсула', { allowFuzzy: false });
      expect(strictVariant).toBe(scoreBilingualFields(exactFields, 'капсула'));
      expect(strictVariant).toBeGreaterThan(0);

      // Typo query skips fuzzy in pass 1 and matches in pass 2
      const typoFields = {
        title: 'Выделение текста в заметке',
        body: 'Подробное описание',
      };
      expect(scoreBilingualFields(typoFields, 'выдление', { allowFuzzy: false })).toBe(0);
      expect(scoreBilingualFields(typoFields, 'выдление', { allowFuzzy: true })).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Echelon 0 #5: thumbnail leak fix & purge cleanup', () => {
  it('creates no thumb_* when generateThumb defaults to false, creates thumb_* when true, and purges all thumb_* files', async () => {
    const { mediaDir, repo, pipeline } = createTestEnv('kapsula-e0-thumb-');

    const thumbSpy = vi
      .spyOn(thumbnailService, 'generateThumbnailAndAnalyze')
      .mockImplementation((_buf, dir, stem) => {
        fs.mkdirSync(dir, { recursive: true });
        const thumbName = `thumb_${stem}.jpg`;
        fs.writeFileSync(path.join(dir, thumbName), Buffer.from('mock-thumb'));
        return { thumbPath: thumbName, isLightBanner: false, palette: ['#112233'], width: 2, height: 2 };
      });

    // 1. Inline note image (default generateThumb=false) -> zero thumb_* files
    const inlineSaved = await pipeline.saveNoteImageAsset({
      base64: `data:image/png;base64,${SAMPLE_PNG_BASE64}`,
      fileName: 'inline.png',
    });
    expect(inlineSaved.thumbFilename).toBeUndefined();
    expect(thumbSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(mediaDir)).toEqual([inlineSaved.filename]);

    // 2. Explicit generateThumb: true -> creates thumb_<stem>.jpg
    const coverSaved = await pipeline.saveNoteImageAsset({
      base64: `data:image/png;base64,${SAMPLE_PNG_BASE64}`,
      fileName: 'cover.png',
      generateThumb: true,
    });
    expect(coverSaved.thumbFilename).toBe(`thumb_${path.basename(coverSaved.filename, '.png')}.jpg`);
    expect(thumbSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(mediaDir, coverSaved.thumbFilename!))).toBe(true);

    // 3. Purge item referencing inline image -> cleans up BOTH the image and any legacy orphan thumb_*
    const note = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Note with inline image',
      body: `![pic](${inlineSaved.mediaUrl})`,
      source: 'vault_ui',
      contentHash: 'note-inline-purge-test',
    });
    const purged = repo.purgeItemPermanently(note.id);
    expect(purged.purged).toBe(true);
    pipeline.cleanupUnreferencedMedia(purged.freedMedia);

    expect(fs.readdirSync(mediaDir)).toEqual([]);
  });

  it('generates cover thumbnail only for the first image during Markdown import and leaves 0 orphan thumbs after purge', async () => {
    const { dir, mediaDir, repo, pipeline } = createTestEnv('kapsula-e0-md-');
    const mdDir = path.join(dir, 'vault-md');
    fs.mkdirSync(mdDir, { recursive: true });

    const png1 = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
    // Make second PNG distinct by changing a chunk-safe byte? Use 1x1 valid PNG for img2
    const png2Base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const png2 = Buffer.from(png2Base64, 'base64');

    fs.writeFileSync(path.join(mdDir, 'first.png'), png1);
    fs.writeFileSync(path.join(mdDir, 'second.png'), png2);
    fs.writeFileSync(
      path.join(mdDir, 'TwoImages.md'),
      '# Two Images\n\n![one](first.png)\n\n![two](second.png)\n',
      'utf8'
    );

    const thumbSpy = vi
      .spyOn(thumbnailService, 'generateThumbnailAndAnalyze')
      .mockImplementation((_buf, mDir, stem) => {
        fs.mkdirSync(mDir, { recursive: true });
        const thumbName = `thumb_${stem}.jpg`;
        fs.writeFileSync(path.join(mDir, thumbName), Buffer.from('mock-cover-thumb'));
        return { thumbPath: thumbName, isLightBanner: false, palette: ['#223344'], width: 2, height: 2 };
      });

    const res = await importMarkdownFolder(mdDir, { repo, pipeline });
    expect(res.importedCount).toBe(1);
    // Only the FIRST image should generate a cover thumbnail
    expect(thumbSpy).toHaveBeenCalledTimes(1);

    const imported = repo.queryItems({ limit: 10 })[0]!;
    expect(imported.thumbPath).toMatch(/^thumb_[a-f0-9]+\.jpg$/);
    const mediaBeforePurge = fs.readdirSync(mediaDir);
    expect(mediaBeforePurge.filter((f) => f.startsWith('thumb_'))).toHaveLength(1);
    expect(mediaBeforePurge).toHaveLength(3); // first + second + 1 cover thumb

    const purged = repo.purgeItemPermanently(imported.id);
    pipeline.cleanupUnreferencedMedia(purged.freedMedia);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  it('does not generate a fallback thumb_* for image #2 when image #1 fails thumbnailing during Markdown import', async () => {
    const { dir, mediaDir, repo, pipeline } = createTestEnv('kapsula-e0-md-fail-thumb-');
    const mdDir = path.join(dir, 'vault-md-fail');
    fs.mkdirSync(mdDir, { recursive: true });

    const png1 = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
    const png2Base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const png2 = Buffer.from(png2Base64, 'base64');

    fs.writeFileSync(path.join(mdDir, 'first.png'), png1);
    fs.writeFileSync(path.join(mdDir, 'second.png'), png2);
    fs.writeFileSync(
      path.join(mdDir, 'FailFirstThumb.md'),
      '# Fail First Thumb\n\n![one](first.png)\n\n![two](second.png)\n',
      'utf8'
    );

    const thumbSpy = vi
      .spyOn(thumbnailService, 'generateThumbnailAndAnalyze')
      .mockImplementation(() => {
        throw new Error('simulated thumbnail failure');
      });

    const res = await importMarkdownFolder(mdDir, { repo, pipeline });
    expect(res.importedCount).toBe(1);
    // !coverFilename prevents attempting thumbnail generation on image #2
    expect(thumbSpy).toHaveBeenCalledTimes(1);

    const imported = repo.queryItems({ limit: 10 })[0]!;
    expect(imported.imagePath).toBeTruthy();
    expect(imported.thumbPath).toBeNull();
    expect(fs.readdirSync(mediaDir).filter((f) => f.startsWith('thumb_'))).toEqual([]);
  });
});

describe('Echelon 0 #5: SQLite PRAGMAs, indexes, TTL/cap pruning, WAL checkpoint & sync_dirty guard', () => {
  it('enables synchronous=NORMAL, temp_store=MEMORY, creates AI indexes, and truncates WAL on close()', () => {
    const { dbPath, repo } = createTestEnv('kapsula-e0-pragma-');

    const syncMode = (repo.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
    const tempStore = (repo.db.prepare('PRAGMA temp_store').get() as { temp_store: number }).temp_store;
    expect(syncMode).toBe(1); // NORMAL
    expect(tempStore).toBe(2); // MEMORY

    const idxRows = repo.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_ai_usage_log_created_at', 'idx_ai_cache_created_at')")
      .all() as Array<{ name: string }>;
    expect(idxRows.map((r) => r.name).sort()).toEqual([
      'idx_ai_cache_created_at',
      'idx_ai_usage_log_created_at',
    ]);

    repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'WAL test',
      body: 'body',
      source: 'vault_ui',
      contentHash: 'wal-test-hash',
    });

    // Pop from openRepos and close explicitly to verify WAL truncate
    openRepos.pop();
    repo.close();

    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0);
    }
  });

  it('evicts expired ai_cache TTL entries, caps ai_cache at 2000 rows, and prunes old ai_usage_log while preserving current month budget', () => {
    const { repo } = createTestEnv('kapsula-e0-ai-');

    // 1. Expired ai_cache (> 30d) is evicted on getCachedAi
    const oldTs = Date.now() - 35 * 24 * 60 * 60 * 1000;
    repo.db
      .prepare('INSERT INTO ai_cache (content_hash, response_json, created_at) VALUES (?, ?, ?)')
      .run('expired-hash', JSON.stringify({ orbit: 'work' }), oldTs);
    expect(repo.getCachedAi('expired-hash')).toBeNull();
    expect(
      repo.db.prepare('SELECT COUNT(*) AS c FROM ai_cache WHERE content_hash = ?').get('expired-hash')
    ).toEqual({ c: 0 });

    // 2. Cap ai_cache at 2000 rows
    const now = Date.now();
    const insertCache = repo.db.prepare(
      'INSERT INTO ai_cache (content_hash, response_json, created_at) VALUES (?, ?, ?)'
    );
    repo.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 2050; i += 1) {
      insertCache.run(`h-${i}`, '{"ok":true}', now - 60_000 + i);
    }
    repo.db.exec('COMMIT');
    repo.setCachedAi('h-newest', { ok: true });
    const cacheCount = (repo.db.prepare('SELECT COUNT(*) AS c FROM ai_cache').get() as { c: number }).c;
    expect(cacheCount).toBe(2000);
    expect(repo.getCachedAi('h-newest')).toEqual({ ok: true });
    expect(repo.getCachedAi('h-0')).toBeNull();

    // 3. ai_usage_log pruning: old (>90d) pruned, current month preserved intact
    const veryOldTs = Date.now() - 120 * 24 * 60 * 60 * 1000;
    repo.db
      .prepare(
        'INSERT INTO ai_usage_log (id, provider, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run('old-usage-1', 'openrouter', 'gpt-4o-mini', 100, 50, 0.5, veryOldTs);

    repo.logAiUsage('openrouter', 'gpt-4o-mini', 200, 100, 0.123);
    expect(
      repo.db.prepare("SELECT COUNT(*) AS c FROM ai_usage_log WHERE id = 'old-usage-1'").get()
    ).toEqual({ c: 0 });
    const summary = repo.getMonthBudgetSummary('openrouter', 5, true);
    expect(summary.callsCount).toBe(1);
    expect(summary.spentUsd).toBe(0.123);
  });

  it('does not accumulate sync_dirty when SyncEngine is signed out with no account, and re-enables on auth', async () => {
    const { dir, mediaDir, repo, cryptoVault } = createTestEnv('kapsula-e0-dirty-');

    // Seed pre-existing stale sync_dirty row before SyncEngine initializes signed out
    repo.markDirty('item', 'stale-offline-row');
    expect((repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty').get() as { c: number }).c).toBe(1);

    const mockClient = {
      auth: {
        async getSession() {
          return { data: { session: null }, error: null };
        },
        async signOut() {
          return { error: null };
        },
      },
    } as unknown as SupabaseClient;

    const engine = new SyncEngine({
      repo,
      vaultCrypto: cryptoVault,
      mediaDir,
      dataDir: dir,
      disableTimers: true,
      disableRealtime: true,
    });
    (engine as unknown as { client: SupabaseClient }).client = mockClient;

    const status = await engine.initialize();
    expect(status.state).toBe('signed_out');
    expect(repo.isSyncDirtyTrackingEnabled()).toBe(false);
    expect((repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty').get() as { c: number }).c).toBe(0);

    // Local mutations while signed out must NOT populate sync_dirty
    repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Signed out note',
      body: 'No sync dirty row',
      source: 'vault_ui',
      contentHash: 'signed-out-hash',
    });
    expect((repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty').get() as { c: number }).c).toBe(0);

    // Turning tracking on (as SyncEngine does on auth) resumes sync_dirty tracking
    repo.setSyncDirtyTrackingEnabled(true);
    repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Signed in note',
      body: 'Tracks sync dirty',
      source: 'vault_ui',
      contentHash: 'signed-in-hash',
    });
    expect((repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty').get() as { c: number }).c).toBe(1);

    await engine.signOut();
    expect(repo.isSyncDirtyTrackingEnabled()).toBe(false);
  });

  it('orders same-millisecond items deterministically by rowid DESC across queryItems sorts and setCachedAi cap pruning', () => {
    const { repo } = createTestEnv('kapsula-e0-rowid-tie-');
    const fixedTs = 1_760_000_000_000;

    const item1 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Tie Item 1',
      body: 'first',
      source: 'vault_ui',
      contentHash: 'tie-item-1',
      createdAt: fixedTs,
    });
    const item2 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Tie Item 2',
      body: 'second',
      source: 'vault_ui',
      contentHash: 'tie-item-2',
      createdAt: fixedTs,
    });
    const item3 = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Tie Item 3',
      body: 'third media',
      imagePath: 'shot-3.png',
      source: 'vault_ui',
      contentHash: 'tie-item-3',
      createdAt: fixedTs,
    });
    const item4 = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Tie Item 4',
      body: 'fourth media',
      imagePath: 'shot-4.png',
      source: 'vault_ui',
      contentHash: 'tie-item-4',
      createdAt: fixedTs,
    });

    // created_desc (default): newest-inserted (rowid DESC) first
    expect(repo.queryItems({ limit: 10 }).map((i) => i.id)).toEqual([
      item4.id,
      item3.id,
      item2.id,
      item1.id,
    ]);

    // updated_desc: identical content_updated_at/updated_at -> newest-inserted first
    expect(repo.queryItems({ sortBy: 'updated_desc', limit: 10 }).map((i) => i.id)).toEqual([
      item4.id,
      item3.id,
      item2.id,
      item1.id,
    ]);

    // media_first: media items first (rowid DESC), then non-media items (rowid DESC)
    expect(repo.queryItems({ sortBy: 'media_first', limit: 10 }).map((i) => i.id)).toEqual([
      item4.id,
      item3.id,
      item2.id,
      item1.id,
    ]);

    // setCachedAi cap pruning tie: 2000 rows sharing exact same created_at -> newest rowid survives, earliest rowid evicted
    vi.useFakeTimers();
    vi.setSystemTime(fixedTs);
    try {
      const insertCache = repo.db.prepare(
        'INSERT INTO ai_cache (content_hash, response_json, created_at) VALUES (?, ?, ?)'
      );
      repo.db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < 2000; i += 1) {
        insertCache.run(`tie-cache-${i}`, JSON.stringify({ idx: i }), fixedTs);
      }
      repo.db.exec('COMMIT');

      repo.setCachedAi('tie-cache-newest', { idx: 2000 });
      expect(repo.db.prepare('SELECT COUNT(*) AS c FROM ai_cache').get()).toEqual({ c: 2000 });
      expect(repo.getCachedAi('tie-cache-0')).toBeNull();
      expect(repo.getCachedAi('tie-cache-1')).toEqual({ idx: 1 });
      expect(repo.getCachedAi('tie-cache-newest')).toEqual({ idx: 2000 });
    } finally {
      vi.useRealTimers();
    }
  });
});
