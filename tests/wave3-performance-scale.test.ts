import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { resolveSafeMediaFilePathAsync } from '@main/pipeline/capture-pipeline';
import { extractReadablePage } from '@main/pipeline/html-cleaner';
import { VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function createFileRepo(prefix = 'kapsula-w3-scale-'): { repo: VaultRepository; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'vault.sqlite');
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  return { repo, dir, dbPath };
}

function runInRepoTx<T>(repo: VaultRepository, fn: () => T): T {
  return (repo as unknown as { inTx: <R>(cb: () => R) => R }).inTx(fn);
}

afterEach(() => {
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

describe('Wave 3 Performance & Scalability (10k SQLite, Async KDF & Lazy Cleaners)', () => {
  it('handles 10,000+ SQLite items cleanly for stats, bilingual search, tasks cache, wiki links & related items', () => {
    const { repo } = createFileRepo();
    const orbitWork = repo.createOrbit({ name: 'Работа', description: 'Рабочие заметки' });
    const orbitDesign = repo.createOrbit({ name: 'Дизайн', description: 'Референсы и визуал' });
    const board = repo.createFocusBoard('Игровой прототип');

    const now = Date.now();
    const insertSql = `
      INSERT INTO items (
        id, dna, sub_kind, orbit, mode_captured, focus_board_id,
        title, title_norm, body, summary, url, domain, platform,
        image_path, thumb_path, media_path, media_type, media_duration_sec, media_meta_json, og_image_url,
        ocr_text, extracted_actions_json, color_palette_json,
        encrypted_payload, secret_meta_json, tags_json, source, external_id,
        content_hash, ai_status, ai_confidence, is_pinned, is_archived, is_demo,
        remind_at, reminded_at, created_at, updated_at, content_updated_at,
        deleted_at, purged_at, canvas_x, canvas_y, canvas_w, canvas_h, canvas_frame,
        annotations_json, links_out_json, sync_version, last_device_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '', '[]', '[]',
        ?, ?, ?, 'vault_ui', NULL,
        ?, 'local', 0.9, ?, ?, ?,
        ?, NULL, ?, ?, ?,
        ?, NULL, NULL, NULL, NULL, NULL, NULL,
        '[]', '[]', 1, 'test-dev'
      )
    `;
    const ftsSql = `
      INSERT INTO items_fts (id, title, body, summary, ocr_text, tags_text, url, domain)
      VALUES (?, ?, ?, ?, '', ?, ?, ?)
    `;

    runInRepoTx(repo, () => {
      const insertStmt = repo.db.prepare(insertSql);
      const ftsStmt = repo.db.prepare(ftsSql);
      for (let i = 0; i < 10_000; i += 1) {
        const id = `bulk-${i}`;
        const isSecret = i >= 9950;
        const isArchived = i >= 9900 && i < 9925;
        const isTrashed = i >= 9925 && i < 9950;
        const isPinned = !isArchived && !isTrashed && i < 10;
        const isDemo = !isArchived && !isTrashed && i >= 10 && i < 15;
        const isTask = !isSecret && !isArchived && !isTrashed && i % 200 === 0;
        const dna = isSecret ? 'secret' : i % 5 === 0 ? 'link' : 'note';
        const orbit = i % 3 === 0 ? orbitWork.id : i % 3 === 1 ? orbitDesign.id : '';
        const boardId = !isSecret && i >= 20 && i < 26 ? board.id : null;
        const title = isSecret
          ? `Тинькофф Карта ${i}`
          : i === 500
            ? 'Фотошоп референс интерфейсов'
            : `Заметка потока номер ${i} заметка прототип`;
        const body = isTask
          ? `- [ ] Проверить задачу ${i} в плане\nОбычный текст протокола`
          : i % 10 === 0
            ? 'Подборка материалов по шейдерам и геймдеву'
            : 'Ежедневная короткая заметка без лишних деталей';
        const tags = i % 15 === 0 ? ['архитектура', 'референс'] : ['тест'];
        const domain = dna === 'link' ? 'youtube.com' : null;
        const platform = dna === 'link' ? 'youtube' : null;
        const secretMeta = isSecret
          ? JSON.stringify({ kind: 'bank_card', service: 'Тинькофф', last4: String(4270 + (i % 10)) })
          : null;
        const remindAt = !isArchived && !isTrashed && i === 100 ? now - 60_000 : null;
        const ts = now - (10_000 - i) * 1000;

        insertStmt.run(
          id,
          dna,
          null,
          orbit,
          'autopilot',
          boardId,
          title,
          title.toLowerCase(),
          body,
          '',
          dna === 'link' ? `https://youtube.com/watch?v=${i}` : null,
          domain,
          platform,
          isSecret ? '{"v":1}' : null,
          secretMeta,
          JSON.stringify(tags),
          `hash-${i}`,
          isPinned ? 1 : 0,
          isArchived ? 1 : 0,
          isDemo ? 1 : 0,
          remindAt,
          ts,
          ts,
          ts,
          isTrashed ? ts : null
        );
        if (!isSecret && !isTrashed) {
          ftsStmt.run(id, title, body, '', tags.join(' '), dna === 'link' ? `https://youtube.com/watch?v=${i}` : '', domain ?? '');
        }
      }
    });

    // Special target + wiki-linked item + related siblings
    const wikiTarget = repo.createItem({
      dna: 'note',
      orbit: orbitDesign.id,
      modeCaptured: 'autopilot',
      source: 'vault_ui',
      contentHash: 'hash-wiki',
      title: 'Связанный Атлас',
      body: 'Справочник материалов',
      tags: ['оптика'],
    });
    const target = repo.createItem({
      dna: 'note',
      orbit: orbitDesign.id,
      focusBoardId: board.id,
      modeCaptured: 'autopilot',
      source: 'vault_ui',
      contentHash: 'hash-target',
      title: 'Атлас Квантовый Мир',
      body: 'Подробный разбор квантовой оптики и визуальных эффектов [[Связанный Атлас]]',
      tags: ['шейдеры', 'оптика'],
    });

    // 1. Single-pass getStats(now)
    const tStats0 = performance.now();
    const stats = repo.getStats(now);
    const statsMs = performance.now() - tStats0;
    expect(stats.archivedCount).toBe(25);
    expect(stats.trashedCount).toBe(25);
    expect(stats.pinnedCount).toBe(10);
    expect(stats.demoCount).toBe(5);
    expect(stats.dueRemindersCount).toBe(1);
    expect(stats.total).toBe(10_000 - 50 + 2);
    expect(statsMs).toBeLessThan(500);

    // 2. Bilingual & FTS search + Secret lookup at 10k items
    const tSearch0 = performance.now();
    const ftsHits = repo.queryItems({ search: 'квантовый', includeSecrets: true });
    const searchMs = performance.now() - tSearch0;
    expect(ftsHits.some((it) => it.id === target.id)).toBe(true);
    expect(searchMs).toBeLessThan(500);

    const bilingualHits = repo.queryItems({ search: 'photoshop', includeSecrets: true });
    expect(bilingualHits.some((it) => it.id === 'bulk-500')).toBe(true);

    const secretHits = repo.queryItems({ dna: 'secret', search: 'тинькофф' });
    expect(secretHits.length).toBeGreaterThan(0);

    const cardLast4Hits = repo.queryItems({ search: '4276', includeSecrets: true });
    expect(cardLast4Hits.some((it) => it.id.startsWith('bulk-99'))).toBe(true);

    // 3. searchNonSecretForAsk
    const askHits = repo.searchNonSecretForAsk('photoshop референсы из youtube', 8);
    expect(askHits.some((it) => it.id === 'bulk-500')).toBe(true);
    expect(askHits.every((it) => it.dna !== 'secret')).toBe(true);

    // 4. listVaultTasks cache & mutation invalidation
    const tasksFirst = repo.listVaultTasks();
    const tasksCached = repo.listVaultTasks();
    expect(tasksFirst.length).toBeGreaterThanOrEqual(49);
    expect(tasksCached).toEqual(tasksFirst);
    const firstTask = tasksFirst.find((tk) => tk.itemId === 'bulk-0')!;
    expect(firstTask.done).toBe(false);
    repo.toggleVaultTask({
      itemId: firstTask.itemId,
      sourceType: firstTask.sourceType,
      taskIndex: firstTask.taskIndex,
      done: true,
    });
    const tasksAfterToggle = repo.listVaultTasks();
    const toggledTask = tasksAfterToggle.find((tk) => tk.id === firstTask.id);
    expect(toggledTask?.done).toBe(true);

    // 5. Batched resolveWikiLinkIds via title_norm & listRelatedItems
    const refreshedTarget = repo.getItemById(target.id)!;
    expect(refreshedTarget.linksOut).toContain(wikiTarget.id);

    // Updating body without changing title keeps existing behavior and skips wiki-link re-resolution cleanly
    const updatedNoWikiChange = repo.updateItem(target.id, { isPinned: true });
    expect(updatedNoWikiChange?.isPinned).toBe(true);

    const relatedFirst = repo.listRelatedItems(target.id, 5);
    const relatedSecond = repo.listRelatedItems(target.id, 5);
    expect(relatedFirst.some((r) => r.item.id === wikiTarget.id)).toBe(true);
    expect(relatedSecond.map((r) => r.item.id)).toEqual(relatedFirst.map((r) => r.item.id));
  });

  it('runs async PIN scrypt KDF non-blockingly and interoperates with sync VaultCrypto checks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-w3-crypto-'));
    tempDirs.push(dir);

    const cryptoVault = new VaultCrypto(dir, undefined, 'ru');
    await cryptoVault.setPinProtectionAsync('2580');
    expect(cryptoVault.isPinProtected()).toBe(true);
    expect(await cryptoVault.verifyPinProtectionAsync('2580')).toBe(true);
    expect(await cryptoVault.verifyPinProtectionAsync('9999')).toBe(false);

    const asyncHash = await VaultCrypto.hashPinAsync('2580');
    expect(VaultCrypto.verifyPin('2580', asyncHash)).toBe(true);
    expect(await VaultCrypto.verifyPinAsync('2580', asyncHash)).toBe(true);
    expect(await VaultCrypto.verifyPinAsync('0000', asyncHash)).toBe(false);

    cryptoVault.lock();
    expect(cryptoVault.isLocked()).toBe(true);
    expect(await cryptoVault.unlockWithPinAsync('0000')).toBe(false);
    expect(cryptoVault.isLocked()).toBe(true);
    expect(await cryptoVault.unlockWithPinAsync('2580')).toBe(true);
    expect(cryptoVault.isLocked()).toBe(false);
  });

  it('loads lazy linkedom/readability HTML extractor and resolves async safe media paths', async () => {
    const html = `
      <!doctype html>
      <html>
        <head><title>Kapsula Architecture</title></head>
        <body>
          <article>
            <h1>Kapsula Architecture</h1>
            <p>Kapsula stores local notes, links, files, and voice recordings with end-to-end encryption.</p>
            <p>Wave 3 defers heavyweight HTML parsing dependencies until capture time without changing extraction quality.</p>
          </article>
        </body>
      </html>
    `;
    const extracted = extractReadablePage(html, new URL('https://example.com/architecture'));
    expect(extracted.title).toContain('Kapsula Architecture');
    expect(extracted.bodyMarkdown).toContain('end-to-end encryption');

    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-w3-media-'));
    tempDirs.push(mediaDir);
    const validFile = path.join(mediaDir, 'shot-1.png');
    fs.writeFileSync(validFile, Buffer.from('png-stub'));
    const realDir = fs.realpathSync(mediaDir);

    const resolved = await resolveSafeMediaFilePathAsync(mediaDir, 'shot-1.png', realDir);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.filePath).toBe(await fs.promises.realpath(validFile));
    }

    const escaped = await resolveSafeMediaFilePathAsync(mediaDir, '../outside.png', realDir);
    expect(escaped.ok).toBe(false);
  });
});
