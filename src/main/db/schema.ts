import type { DatabaseSync } from 'node:sqlite';
import {
  cleanBrokenTextArtifacts,
  cleanInstagramText,
  decodeHtmlEntities,
  truncateAtWordBoundary,
} from '@shared/html-entities';

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      dna TEXT NOT NULL,
      orbit TEXT NOT NULL DEFAULT '',
      mode_captured TEXT NOT NULL,
      focus_board_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      url TEXT,
      domain TEXT,
      platform TEXT,
      image_path TEXT,
      og_image_url TEXT,
      ocr_text TEXT NOT NULL DEFAULT '',
      extracted_actions_json TEXT NOT NULL DEFAULT '[]',
      color_palette_json TEXT NOT NULL DEFAULT '[]',
      encrypted_payload TEXT,
      secret_meta_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      external_id TEXT,
      content_hash TEXT NOT NULL,
      ai_status TEXT NOT NULL DEFAULT 'local',
      ai_confidence REAL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_ext
      ON items(source, external_id)
      WHERE external_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_items_orbit_created
      ON items(orbit, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_items_dna
      ON items(dna);

    CREATE INDEX IF NOT EXISTS idx_items_hash
      ON items(content_hash);

    CREATE INDEX IF NOT EXISTS idx_items_feed
      ON items(is_archived, is_pinned DESC, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      id UNINDEXED,
      title,
      summary,
      body,
      ocr_text,
      url,
      domain,
      tags_text,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS orbits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS focus_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_cache (
      content_hash TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_revisions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_item_revisions_item
      ON item_revisions(item_id, created_at DESC);
  `);

  // Strictly additive v3 columns — existing user DBs stay intact
  ensureColumn(db, 'items', 'sub_kind', 'TEXT');
  ensureColumn(db, 'items', 'thumb_path', 'TEXT');
  ensureColumn(db, 'items', 'media_path', 'TEXT');
  ensureColumn(db, 'items', 'media_type', 'TEXT');
  ensureColumn(db, 'items', 'media_duration_sec', 'REAL');
  ensureColumn(db, 'items', 'media_meta_json', 'TEXT');
  ensureColumn(db, 'items', 'remind_at', 'INTEGER');
  ensureColumn(db, 'items', 'reminded_at', 'INTEGER');

  // v6 sync-ready tombstones, chronology separation, moodboard canvas, annotations, wiki-links, and calendar
  ensureColumn(db, 'items', 'content_updated_at', 'INTEGER');
  ensureColumn(db, 'items', 'deleted_at', 'INTEGER DEFAULT NULL');
  ensureColumn(db, 'items', 'canvas_x', 'REAL');
  ensureColumn(db, 'items', 'canvas_y', 'REAL');
  ensureColumn(db, 'items', 'canvas_w', 'REAL');
  ensureColumn(db, 'items', 'canvas_h', 'REAL');
  ensureColumn(db, 'items', 'canvas_frame', 'TEXT');
  ensureColumn(db, 'items', 'annotations_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'items', 'links_out_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'items', 'sync_version', 'INTEGER NOT NULL DEFAULT 1');

  ensureColumn(db, 'orbits', 'created_at', 'INTEGER');
  ensureColumn(db, 'orbits', 'updated_at', 'INTEGER');
  ensureColumn(db, 'orbits', 'deleted_at', 'INTEGER DEFAULT NULL');
  ensureColumn(db, 'orbits', 'sync_version', 'INTEGER NOT NULL DEFAULT 1');

  ensureColumn(db, 'focus_boards', 'description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'focus_boards', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'focus_boards', 'updated_at', 'INTEGER');
  ensureColumn(db, 'focus_boards', 'deleted_at', 'INTEGER DEFAULT NULL');
  ensureColumn(db, 'focus_boards', 'sync_version', 'INTEGER NOT NULL DEFAULT 1');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_remind
      ON items(remind_at)
      WHERE remind_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_items_deleted
      ON items(deleted_at);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#E86A33',
      kind TEXT NOT NULL DEFAULT 'event',
      is_done INTEGER NOT NULL DEFAULT 0,
      linked_item_id TEXT,
      external_source TEXT,
      external_id TEXT,
      etag TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      sync_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_cal_range
      ON calendar_events(deleted_at, start_at, end_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_ext
      ON calendar_events(external_source, external_id)
      WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
  `);

  ensureColumn(db, 'calendar_events', 'location', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'calendar_events', 'has_end_time', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'calendar_events', 'checklist_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'calendar_events', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'calendar_events', 'recurrence', "TEXT NOT NULL DEFAULT 'none'");

  // Guard legacy v1/v2 triggers & FTS schema drift before any item mutation
  const legacyTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'items'")
    .all() as Array<{ name: string; sql: string | null }>;
  for (const trig of legacyTriggers) {
    if (trig.sql && /items_fts/i.test(trig.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS "${trig.name.replace(/"/g, '""')}"`);
    }
  }

  const ftsCols = db.prepare('PRAGMA table_info(items_fts)').all() as Array<{ name: string }>;
  const expectedFtsCols = ['id', 'title', 'summary', 'body', 'ocr_text', 'url', 'domain', 'tags_text'];
  const ftsSchemaMatches =
    ftsCols.length === expectedFtsCols.length &&
    expectedFtsCols.every((col) => ftsCols.some((c) => c.name === col));

  if (!ftsSchemaMatches) {
    db.exec(`
      DROP TABLE IF EXISTS items_fts;
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        id UNINDEXED,
        title,
        summary,
        body,
        ocr_text,
        url,
        domain,
        tags_text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }

  const itemCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM items').get() as { cnt: number };
  const ftsCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM items_fts').get() as { cnt: number };
  if (itemCountRow.cnt > 0 && ftsCountRow.cnt === 0) {
    const existingRows = db
      .prepare(
        "SELECT id, title, summary, body, ocr_text, url, domain, tags_json, media_meta_json FROM items WHERE dna != 'secret'"
      )
      .all() as Array<{
      id: string;
      title: string;
      summary: string;
      body: string;
      ocr_text: string;
      url: string | null;
      domain: string | null;
      tags_json: string;
      media_meta_json: string | null;
    }>;
    const insertFts = db.prepare(
      'INSERT INTO items_fts (id, title, summary, body, ocr_text, url, domain, tags_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of existingRows) {
        let tagsText = '';
        try {
          const parsedTags = JSON.parse(r.tags_json || '[]') as unknown;
          if (Array.isArray(parsedTags)) tagsText = parsedTags.map(String).join(' ');
        } catch {
          tagsText = '';
        }
        let extra = r.ocr_text || '';
        if (r.media_meta_json) {
          try {
            const meta = JSON.parse(r.media_meta_json) as Record<string, unknown>;
            extra = [
              r.ocr_text,
              typeof meta.transcript === 'string' ? meta.transcript : '',
              typeof meta.fileName === 'string' ? meta.fileName : '',
              typeof meta.forwardAuthor === 'string' ? meta.forwardAuthor : '',
              typeof meta.contactPhone === 'string' ? meta.contactPhone : '',
              typeof meta.contactHandle === 'string' ? meta.contactHandle : '',
              typeof meta.contactEmail === 'string' ? meta.contactEmail : '',
            ]
              .filter(Boolean)
              .join('\n');
          } catch {
            // keep ocr_text
          }
        }
        insertFts.run(
          r.id,
          r.title,
          r.summary,
          r.body,
          extra,
          r.url ?? '',
          r.domain ?? '',
          tagsText
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // v3 brownfield migration:
  // - Never force-seed hardcoded orbits on empty databases
  // - On existing databases, drop empty built-in placeholder orbits and allow editing all surviving sections
  // - Clean internal crypto jargon out of stored item summaries
  const migratedRow = db.prepare("SELECT value FROM settings WHERE key = 'v3_vault_migrated'").get() as
    | { value: string }
    | undefined;
  if (!migratedRow) {
    db.exec(`
      DELETE FROM orbits
      WHERE is_builtin = 1
        AND id NOT IN (SELECT DISTINCT orbit FROM items WHERE orbit IS NOT NULL AND orbit != '');
      UPDATE orbits SET is_builtin = 0;
      UPDATE items
        SET summary = CASE
          WHEN summary LIKE '%Банковская карта%' THEN 'Банковская карта · хранится локально под защитой'
          WHEN summary LIKE '%API-ключ%' THEN 'API-ключ · зашифрован на этом устройстве'
          WHEN summary LIKE '%Секретная заметка%' THEN 'Секретная заметка · зашифрована на этом устройстве'
          ELSE 'Зашифровано на этом устройстве'
        END
      WHERE summary LIKE '%DPAPI%' OR summary LIKE '%AES-256%';
    `);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v3_vault_migrated', '1')").run();
  }

  // v5 one-time clean migration: strip obvious test-clutter notes while preserving real data & API keys
  const v5Migrated = db.prepare("SELECT value FROM settings WHERE key = 'v5_studio_clean'").get() as
    | { value: string }
    | undefined;
  if (!v5Migrated) {
    const clutterTitles = new Set(['фывфыв', '123123', 'привет', 'test', 'asdf', 'тест']);
    const candidates = db
      .prepare(
        `SELECT id, title, body
         FROM items
         WHERE is_pinned = 0
           AND dna != 'secret'
           AND image_path IS NULL
           AND media_path IS NULL`
      )
      .all() as Array<{ id: string; title: string | null; body: string | null }>;
    const delFts = db.prepare('DELETE FROM items_fts WHERE id = ?');
    const delItem = db.prepare('DELETE FROM items WHERE id = ?');
    for (const row of candidates) {
      const titleNorm = (row.title ?? '').trim().toLowerCase();
      const bodyLen = (row.body ?? '').trim().length;
      if (clutterTitles.has(titleNorm) && bodyLen <= 24) {
        delFts.run(row.id);
        delItem.run(row.id);
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v5_studio_clean', '1')").run();
  }

  // v6 one-time migration: backfill timestamps, migrate default Ctrl+Space / 30s,
  // decode HTML entities & strip Instagram engagement soup, soft-delete phantom drafts, map Phosphor icons
  const v6Migrated = db.prepare("SELECT value FROM settings WHERE key = 'v6_schema_migrated'").get() as
    | { value: string }
    | undefined;
  if (!v6Migrated) {
    const now = Date.now();
    db.exec(`
      UPDATE items SET content_updated_at = COALESCE(content_updated_at, updated_at, created_at)
      WHERE content_updated_at IS NULL;
      UPDATE orbits SET created_at = COALESCE(created_at, ${now}), updated_at = COALESCE(updated_at, ${now})
      WHERE created_at IS NULL OR updated_at IS NULL;
      UPDATE focus_boards SET updated_at = COALESCE(updated_at, created_at, ${now})
      WHERE updated_at IS NULL;
    `);

    const wipeRow = db.prepare("SELECT value FROM settings WHERE key = 'clipboard_wipe_sec'").get() as
      | { value: string }
      | undefined;
    if (wipeRow?.value === '25') {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('clipboard_wipe_sec', '30')").run();
    }

    const iconMap: Record<string, string> = {
      FolderKanban: 'Folder',
      Wallet: 'Receipt',
      Users: 'ChatCircleText',
      Code2: 'Code',
      Mic: 'MusicNotes',
      FileText: 'BookOpen',
      ShoppingBag: 'Briefcase',
      Plane: 'Compass',
      HeartPulse: 'Heart',
    };
    const orbitRows = db.prepare('SELECT id, icon FROM orbits').all() as Array<{ id: string; icon: string }>;
    const updOrbitIcon = db.prepare('UPDATE orbits SET icon = ?, updated_at = ? WHERE id = ?');
    for (const o of orbitRows) {
      const mapped = iconMap[o.icon];
      if (mapped) {
        updOrbitIcon.run(mapped, now, o.id);
      }
    }

    // Soft-delete empty untouched phantom drafts so feed starts clean
    const emptyDrafts = db
      .prepare(
        `SELECT id FROM items
         WHERE deleted_at IS NULL
           AND dna = 'note'
           AND title IN ('Новая заметка', 'Заметка', 'image')
           AND trim(COALESCE(body, '')) = ''
           AND image_path IS NULL
           AND media_path IS NULL
           AND url IS NULL
           AND encrypted_payload IS NULL`
      )
      .all() as Array<{ id: string }>;
    const markDraftDeleted = db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?');
    const delFtsDraft = db.prepare('DELETE FROM items_fts WHERE id = ?');
    for (const d of emptyDrafts) {
      markDraftDeleted.run(now, now, d.id);
      delFtsDraft.run(d.id);
    }

    // Retroactively decode HTML entities (`&#x2019;`, etc.) and clean Instagram engagement prefixes
    const dirtyRows = db
      .prepare(
        `SELECT id, title, summary, body, platform, domain
         FROM items
         WHERE deleted_at IS NULL AND dna != 'secret'`
      )
      .all() as Array<{
      id: string;
      title: string;
      summary: string;
      body: string;
      platform: string | null;
      domain: string | null;
    }>;
    const updItemClean = db.prepare('UPDATE items SET title = ?, summary = ?, body = ? WHERE id = ?');
    const updFtsClean = db.prepare('UPDATE items_fts SET title = ?, summary = ?, body = ? WHERE id = ?');
    for (const r of dirtyRows) {
      let nextTitle = decodeHtmlEntities(r.title || '');
      let nextSummary = decodeHtmlEntities(r.summary || '');
      let nextBody = decodeHtmlEntities(r.body || '');

      const isIg =
        r.platform === 'instagram' || (r.domain || '').toLowerCase().includes('instagram.com');
      if (isIg) {
        const cleaned = cleanInstagramText(nextTitle, nextSummary || nextBody);
        if (cleaned.cleanTitle) nextTitle = cleaned.cleanTitle;
        if (cleaned.caption) {
          if (/^\s*[\d.,]+[KMkmтыс]*\s+(?:likes?|отмет)/i.test(nextSummary)) {
            nextSummary = cleaned.caption.slice(0, 220);
          }
          if (!nextBody || /^\s*[\d.,]+[KMkmтыс]*\s+(?:likes?|отмет)/i.test(nextBody)) {
            nextBody = cleaned.caption;
          }
        }
      }

      if (nextTitle !== r.title || nextSummary !== r.summary || nextBody !== r.body) {
        updItemClean.run(nextTitle, nextSummary, nextBody, r.id);
        updFtsClean.run(nextTitle, nextSummary, nextBody, r.id);
      }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v6_schema_migrated', '1')").run();
  }

  // v6.1 live polish migration: restore Alt+Space default & heal broken hyphenated/markdown artifacts
  const v61Done = db.prepare("SELECT value FROM settings WHERE key = 'v6_1_live_polish_migrated'").get() as
    | { value: string }
    | undefined;
  if (!v61Done) {
    const hudRow = db.prepare("SELECT value FROM settings WHERE key = 'hud_shortcut'").get() as
      | { value: string }
      | undefined;
    if (hudRow && (hudRow.value === 'CommandOrControl+Space' || hudRow.value === 'Ctrl+Space')) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('hud_shortcut', 'Alt+Space')").run();
    }

    const cleanRows = db
      .prepare(
        `SELECT id, title, summary, body
         FROM items
         WHERE deleted_at IS NULL AND dna != 'secret'`
      )
      .all() as Array<{
      id: string;
      title: string;
      summary: string;
      body: string;
    }>;
    const updItem = db.prepare('UPDATE items SET title = ?, summary = ?, body = ? WHERE id = ?');
    const updFts = db.prepare('UPDATE items_fts SET title = ?, summary = ?, body = ? WHERE id = ?');
    for (const r of cleanRows) {
      const nextTitle = cleanBrokenTextArtifacts(r.title || '', true);
      const nextSummary = cleanBrokenTextArtifacts(r.summary || '', true);
      const nextBody = cleanBrokenTextArtifacts(r.body || '', false);
      if (nextTitle !== r.title || nextSummary !== r.summary || nextBody !== r.body) {
        updItem.run(nextTitle, nextSummary, nextBody, r.id);
        updFts.run(nextTitle, nextSummary, nextBody, r.id);
      }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v6_1_live_polish_migrated', '1')").run();
  }

  // v6.2 deep vault heal: fix mid-word truncated titles/summaries, rescue game notes from Финансы,
  // rescue Telegram posts from Документы & strip promo subscribe footers
  const v62Done = db.prepare("SELECT value FROM settings WHERE key = 'v6_2_deep_vault_heal_v2'").get() as
    | { value: string }
    | undefined;
  if (!v62Done) {
    const orbitRows = db
      .prepare('SELECT id, name FROM orbits WHERE deleted_at IS NULL')
      .all() as Array<{ id: string; name: string }>;
    const gameOrbit = orbitRows.find((o) =>
      /(?:^|[^\p{L}])(?:the\s*)?(?:game|игр\p{L}*|гейм\p{L}*|gamedev|геймдев)(?=$|[^\p{L}])/iu.test(
        o.name.trim()
      )
    );
    const financeOrbit = orbitRows.find((o) => o.name.toLowerCase().includes('финанс'));
    const docsOrbit = orbitRows.find((o) => o.name.toLowerCase().includes('документ'));
    const readingOrbit = orbitRows.find((o) => o.name.toLowerCase().includes('чтен'));

    const healRows = db
      .prepare(
        `SELECT id, dna, orbit, title, summary, body, url, domain, platform, tags_json, extracted_actions_json, ai_status
         FROM items
         WHERE deleted_at IS NULL AND dna != 'secret'`
      )
      .all() as Array<{
      id: string;
      dna: string;
      orbit: string;
      title: string;
      summary: string;
      body: string;
      url: string | null;
      domain: string | null;
      platform: string | null;
      tags_json: string;
      extracted_actions_json: string;
      ai_status: string;
    }>;

    const updItem = db.prepare(
      'UPDATE items SET title = ?, summary = ?, body = ?, orbit = ?, tags_json = ?, extracted_actions_json = ? WHERE id = ?'
    );
    const updFts = db.prepare(
      'UPDATE items_fts SET title = ?, summary = ?, body = ?, tags_text = ? WHERE id = ?'
    );

    for (const r of healRows) {
      let nextTitle = r.title || '';
      let nextSummary = r.summary || '';
      let nextBody = r.body || '';
      let nextOrbit = r.orbit || '';
      let tags: string[] = [];
      try {
        const parsedTags = JSON.parse(r.tags_json || '[]') as unknown;
        if (Array.isArray(parsedTags)) tags = parsedTags.map(String);
      } catch {
        tags = [];
      }
      let actions: Array<{ type: string; value: string; label?: string }> = [];
      try {
        const parsedActions = JSON.parse(r.extracted_actions_json || '[]') as unknown;
        if (Array.isArray(parsedActions)) {
          actions = parsedActions.filter(
            (x): x is { type: string; value: string; label?: string } =>
              Boolean(x && typeof x === 'object')
          );
        }
      } catch {
        actions = [];
      }

      let changed = false;

      // 1) Heal mid-word chopped titles whose remainder sits in body (even with leading markdown markers)
      const titleBase = nextTitle.replace(/(?:…|\.\.\.)\s*$/, '').trim();
      const firstCleanLine = nextBody
        .split(/\r?\n/)
        .map((l) =>
          l
            .trim()
            .replace(/^(?:[-*•]\s*(?:\[[ xX]\]\s*)?|#+\s*|>\s*)+/, '')
            .replace(/^[*_`~]+|[*_`~]+$/g, '')
            .trim()
        )
        .find(Boolean);
      if (
        titleBase.length >= 12 &&
        firstCleanLine &&
        firstCleanLine.toLowerCase().startsWith(titleBase.toLowerCase()) &&
        firstCleanLine.length > titleBase.length &&
        /^[\p{L}\d]/u.test(firstCleanLine.slice(titleBase.length))
      ) {
        const healedTitle = truncateAtWordBoundary(firstCleanLine, 96);
        if (healedTitle !== nextTitle) {
          nextTitle = healedTitle;
          changed = true;
        }
      }

      // Also clear stale summary when it looks like a mid-word chopped slice of body
      const summaryBase = nextSummary.replace(/(?:…|\.\.\.)\s*$/, '').trim();
      if (
        summaryBase.length >= 12 &&
        firstCleanLine &&
        firstCleanLine.toLowerCase().startsWith(summaryBase.toLowerCase()) &&
        firstCleanLine.length > summaryBase.length &&
        /^[\p{L}\d]/u.test(firstCleanLine.slice(summaryBase.length))
      ) {
        const cleanBodyFlat = nextBody.replace(/\s+/g, ' ').trim();
        nextSummary = cleanBodyFlat.length > 320 ? truncateAtWordBoundary(cleanBodyFlat, 148) : '';
        changed = true;
      }

      // 2) Rescue game/UI notes misrouted into Финансы
      const fullText = `${nextTitle}\n${nextBody}\n${nextSummary}`;
      if (
        r.dna === 'note' &&
        financeOrbit &&
        nextOrbit === financeOrbit.id &&
        ['local', 'pending', 'raw_buffer'].includes(r.ai_status) &&
        /(?:колод\p{L}*|интерфейс\p{L}*|квест\p{L}*|рывок|босс\p{L}*|персонаж\p{L}*|шейдер\p{L}*|график\p{L}*|\bvfx\b|\bfps\b)/iu.test(
          fullText
        ) &&
        !/(?:сбер|тинькофф|т-банк|оплат|инвойс|налог|cvv|\bмир\b|\bvisa\b|\bmastercard\b|\d{12,19})/iu.test(
          fullText
        )
      ) {
        nextOrbit = gameOrbit?.id ?? '';
        tags = tags.filter((t) => t.toLowerCase() !== 'финансы');
        changed = true;
      }

      // 3) Rescue Telegram posts misrouted into Документы & strip promo subscribe footers
      const domainLow = (r.domain || '').toLowerCase();
      const isTg = r.platform === 'telegram' || domainLow === 't.me' || domainLow === 'telegram.me';
      if (isTg) {
        if (
          docsOrbit &&
          nextOrbit === docsOrbit.id &&
          ['local', 'pending', 'raw_buffer', 'enriched'].includes(r.ai_status)
        ) {
          nextOrbit = readingOrbit?.id ?? '';
          tags = tags.filter((t) => t.toLowerCase() !== 'документы');
          changed = true;
        }

        const bodyLines = nextBody.split(/\r?\n/);
        while (bodyLines.length > 0) {
          const tail = bodyLines[bodyLines.length - 1]!.trim();
          if (!tail) {
            bodyLines.pop();
            continue;
          }
          if (
            tail.length <= 140 &&
            /(?:^|[^\p{L}])(?:подписаться|subscribe|прислать новость|наш канал|бот обратной)(?=$|[^\p{L}])/iu.test(
              tail
            )
          ) {
            bodyLines.pop();
            continue;
          }
          break;
        }
        const strippedBody = bodyLines.join('\n').trim();
        if (strippedBody !== nextBody) {
          nextBody = strippedBody;
          const plainNext = nextBody
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_`>#]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          nextSummary = plainNext ? truncateAtWordBoundary(plainNext, 220) : '';
          changed = true;
        } else if (
          /(?:^|[^\p{L}])(?:подписаться|subscribe|прислать новость|наш канал|бот обратной)(?=$|[^\p{L}])/iu.test(
            nextSummary
          )
        ) {
          const plainNext = nextBody
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_`>#]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          nextSummary = plainNext ? truncateAtWordBoundary(plainNext, 220) : '';
          changed = true;
        }

        const itemChanMatch = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})/i.exec(
          r.url || ''
        );
        const itemChan = itemChanMatch?.[1]?.toLowerCase() ?? null;
        const filteredActions = actions.filter((a) => {
          if (a.type !== 'url') return true;
          const lbl = (a.label || '').toLowerCase();
          if (/подписаться|subscribe|прислать новость|наш канал|бот обратной/i.test(lbl)) return false;
          if (a.value.includes('t.me/+')) return false;
          if (itemChan && /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(a.value)) {
            const sub = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})(?:\/(\d+))?/i.exec(
              a.value
            );
            if (sub && sub[1]?.toLowerCase() === itemChan && !sub[2]) return false;
          }
          return true;
        });
        if (filteredActions.length !== actions.length) {
          actions = filteredActions;
          changed = true;
        }
      }

      if (changed) {
        updItem.run(
          nextTitle,
          nextSummary,
          nextBody,
          nextOrbit,
          JSON.stringify(tags),
          JSON.stringify(actions),
          r.id
        );
        updFts.run(nextTitle, nextSummary, nextBody, tags.join(' '), r.id);
      }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v6_2_deep_vault_heal_v2', '1')").run();
  }

  // v7 cross-platform E2EE cloud sync tables (strictly additive)
  ensureColumn(db, 'items', 'last_device_id', 'TEXT');
  ensureColumn(db, 'orbits', 'last_device_id', 'TEXT');
  ensureColumn(db, 'focus_boards', 'last_device_id', 'TEXT');
  ensureColumn(db, 'calendar_events', 'last_device_id', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_dirty (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      dirty_at INTEGER NOT NULL,
      dirty_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_dirty_at
      ON sync_dirty(dirty_at ASC);

    CREATE TABLE IF NOT EXISTS sync_blob_cache (
      local_name TEXT PRIMARY KEY,
      blob_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL DEFAULT 0,
      uploaded_for_user TEXT
    );
  `);

  ensureColumn(db, 'sync_dirty', 'dirty_seq', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'sync_blob_cache', 'mtime_ms', 'REAL NOT NULL DEFAULT 0');

  // v8 Pro sync-ready permanent-delete tombstones, syncable item_revisions, dead-letter sync_dirty,
  // and soft-delete-aware unique external_id index (strictly additive & idempotent)
  ensureColumn(db, 'items', 'purged_at', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_purged_at
      ON items(purged_at);
  `);

  const sourceExtIdx = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_source_ext'")
    .get() as { sql: string | null } | undefined;
  if (!sourceExtIdx?.sql || !/deleted_at\s+is\s+null/i.test(sourceExtIdx.sql)) {
    db.exec(`
      DROP INDEX IF EXISTS idx_items_source_ext;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_ext
        ON items(source, external_id)
        WHERE external_id IS NOT NULL AND deleted_at IS NULL;
    `);
  }

  ensureColumn(db, 'item_revisions', 'content_hash', 'TEXT');
  ensureColumn(db, 'item_revisions', 'device_name', 'TEXT');
  ensureColumn(db, 'item_revisions', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'item_revisions', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'item_revisions', 'sync_version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'item_revisions', 'last_device_id', 'TEXT');

  db.exec(`
    UPDATE item_revisions SET updated_at = created_at WHERE updated_at = 0;
    CREATE INDEX IF NOT EXISTS idx_item_revisions_updated
      ON item_revisions(updated_at DESC);
  `);

  ensureColumn(db, 'sync_dirty', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'sync_dirty', 'last_error', 'TEXT');
  ensureColumn(db, 'sync_dirty', 'next_retry_at', 'INTEGER NOT NULL DEFAULT 0');

  // Wave 3 (PERF-02 / PERF-03): additive composite, partial & normalized title indexes for 10k+ vaults
  ensureColumn(db, 'items', 'title_norm', 'TEXT');
  try {
    db.exec(`UPDATE items SET title_norm = lower_utf(trim(title)) WHERE title_norm IS NULL;`);
  } catch {
    db.exec(`UPDATE items SET title_norm = lower(trim(title)) WHERE title_norm IS NULL;`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_active_feed
      ON items(is_archived, is_pinned DESC, created_at DESC)
      WHERE deleted_at IS NULL AND purged_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_visibility_feed
      ON items(deleted_at, purged_at, is_archived, is_pinned DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_focus_board_active
      ON items(focus_board_id, is_archived, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_item
      ON calendar_events(linked_item_id)
      WHERE linked_item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_items_is_demo
      ON items(is_demo)
      WHERE is_demo = 1;
    CREATE INDEX IF NOT EXISTS idx_items_title_norm
      ON items(title_norm, created_at DESC)
      WHERE deleted_at IS NULL AND purged_at IS NULL AND dna != 'secret';
    CREATE INDEX IF NOT EXISTS idx_items_dna_active
      ON items(dna, is_archived, is_pinned DESC, created_at DESC)
      WHERE deleted_at IS NULL AND purged_at IS NULL;
  `);
}
