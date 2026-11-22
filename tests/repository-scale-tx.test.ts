import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncEntityType } from '@shared/sync-contract';
import { VaultRepository } from '@main/db/repository';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function createFileRepo(prefix = 'kapsula-scale-tx-'): { repo: VaultRepository; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'vault.sqlite');
  const repo = new VaultRepository(dbPath);
  openRepos.push(repo);
  return { repo, dir, dbPath };
}

function createMemoryRepo(): VaultRepository {
  const repo = new VaultRepository(':memory:');
  openRepos.push(repo);
  return repo;
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
      // ignore cleanup lock
    }
  }
});

describe('Wave 0 Backend Safety: VaultRepository Scale, Atomicity & Boundary Cases', () => {
  it('handles 650+ seeded items cleanly for stats, pagination, and recent queries', () => {
    const { repo } = createFileRepo();
    const orbit = repo.createOrbit({ name: 'Масштаб', description: 'Нагрузочный раздел' });
    const baseTs = 1_700_000_000_000;

    runInRepoTx(repo, () => {
      for (let i = 0; i < 650; i += 1) {
        repo.createItem({
          id: `scale-item-${i}`,
          dna: 'note',
          orbit: i % 2 === 0 ? orbit.id : '',
          modeCaptured: 'autopilot',
          title: `Заметка №${i}`,
          body: i === 0 ? '- [ ] Самая первая задача' : `Тело заметки номер ${i}`,
          tags: i % 5 === 0 ? ['масштаб'] : [],
          isPinned: i >= 645,
          source: 'vault_ui',
          contentHash: `scale-hash-${i}`,
          createdAt: baseTs + i * 1000,
        });
      }
    });

    const stats = repo.getStats();
    expect(stats.total).toBe(650);
    expect(stats.pinnedCount).toBe(5);
    expect(stats.byOrbit[orbit.id]).toBe(325);

    const page1 = repo.queryItems({ limit: 50, offset: 0 });
    const page2 = repo.queryItems({ limit: 50, offset: 50 });
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(50);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  it('rolls back inner SQLite writes when an exception is thrown inside inTx', () => {
    const repo = createMemoryRepo();
    const initialCount = repo.getStats().total;

    expect(() =>
      runInRepoTx(repo, () => {
        repo.createItem({
          id: 'tx-rollback-item',
          dna: 'note',
          orbit: '',
          modeCaptured: 'autopilot',
          title: 'Не должно сохраниться',
          body: 'Откат транзакции',
          source: 'vault_ui',
          contentHash: 'tx-rollback-hash',
        });
        throw new Error('Abort inside inTx');
      })
    ).toThrow(/Abort inside inTx/);

    expect(repo.getStats().total).toBe(initialCount);
    expect(repo.getItemById('tx-rollback-item')).toBeNull();
  });

  it('restores core fields and FTS5 index via restoreRawRow', () => {
    const repo = createMemoryRepo();
    const orbit = repo.createOrbit({ name: 'Восстановление', description: 'Тест' });
    const created = repo.createItem({
      id: 'raw-restore-1',
      dna: 'note',
      orbit: orbit.id,
      modeCaptured: 'autopilot',
      title: 'УникальныйЗаголовокДляВосстановления',
      body: 'Важное содержимое для FTS',
      tags: ['бэкап'],
      source: 'vault_ui',
      contentHash: 'raw-restore-hash',
    });

    const raw = repo.getRawRowById(created.id)!;
    expect(raw).not.toBeNull();

    repo.purgeItemPermanently(created.id);
    expect(repo.getItemById(created.id)).toBeNull();
    expect(repo.queryItems({ search: 'УникальныйЗаголовокДляВосстановления' })).toHaveLength(0);

    // Clear purged tombstone row directly to simulate raw snapshot restore of missing row
    repo.db.prepare('DELETE FROM items WHERE id = ?').run(created.id);
    const restored = repo.restoreRawRow(raw);
    expect(restored.id).toBe(created.id);
    expect(restored.title).toBe('УникальныйЗаголовокДляВосстановления');
    expect(restored.orbit).toBe(orbit.id);
    expect(repo.queryItems({ search: 'УникальныйЗаголовокДляВосстановления' })).toHaveLength(1);
  });

  it('upserts live external calendar events idempotently on (externalSource, externalId)', () => {
    const repo = createMemoryRepo();
    const start = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();

    const first = repo.upsertCalendarEvent({
      title: 'Событие из Google v1',
      startAt: start,
      endAt: start + 3_600_000,
      externalSource: 'google',
      externalId: 'gcal-ev-100',
      etag: '"etag-1"',
    });

    const second = repo.upsertCalendarEvent({
      title: 'Событие из Google v2',
      startAt: start,
      endAt: start + 7_200_000,
      externalSource: 'google',
      externalId: 'gcal-ev-100',
      etag: '"etag-2"',
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Событие из Google v2');
    expect(repo.listCalendarEvents()).toHaveLength(1);
  });

  it('updates and deletes normal markdown tasks while preserving non-empty parent notes', () => {
    const repo = createMemoryRepo();
    const note = repo.createItem({
      id: 'task-parent-keep',
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Список дел',
      body: 'Контекст проекта\n\n- [ ] Первая задача\n- [ ] Вторая задача',
      source: 'vault_ui',
      contentHash: 'task-parent-keep-hash',
    });

    const renamed = repo.updateVaultTaskText({
      itemId: note.id,
      taskKey: 'md:0',
      text: 'Обновлённая первая задача',
    });
    expect(renamed?.body).toContain('- [ ] Обновлённая первая задача');
    expect(renamed?.body).toContain('- [ ] Вторая задача');

    const delRes = repo.deleteVaultTask({
      itemId: note.id,
      taskKey: 'md:0',
    });
    expect(delRes?.item).not.toBeNull();
    expect(delRes?.item?.body).toContain('Контекст проекта');
    expect(delRes?.item?.body).toContain('- [ ] Вторая задача');
  });

  it(
    '[Wave 2: BUG-06] finds matching oldest item in queryItems and listVaultTasks beyond 400/500 item ceilings',
    () => {
      const { repo } = createFileRepo();
      const baseTs = 1_700_000_000_000;

      runInRepoTx(repo, () => {
        // Oldest item (#0): matches both shared term "проект" and unique term "иголка_в_стоге" + has a task
        repo.createItem({
          id: 'oldest-needle-item',
          dna: 'note',
          orbit: '',
          modeCaptured: 'autopilot',
          title: 'проект иголка_в_стоге',
          body: '- [ ] Самая старая задача из архива',
          source: 'vault_ui',
          contentHash: 'oldest-needle-hash',
          createdAt: baseTs,
        });

        // 560 newer items that also contain "проект" so FTS/LIKE LIMIT 400 and listVaultTasks LIMIT 500 fill up first
        for (let i = 1; i <= 560; i += 1) {
          repo.createItem({
            id: `filler-${i}`,
            dna: 'note',
            orbit: '',
            modeCaptured: 'autopilot',
            title: `проект свежий документ ${i}`,
            body: `Обычный текст проект ${i}`,
            source: 'vault_ui',
            contentHash: `filler-hash-${i}`,
            createdAt: baseTs + i * 1000,
          });
        }
      });

      const foundSearch = repo.queryItems({ search: 'проект иголка_в_стоге' });
      expect(foundSearch.some((it) => it.id === 'oldest-needle-item')).toBe(true);

      const tasks = repo.listVaultTasks();
      expect(tasks.some((t) => t.itemId === 'oldest-needle-item')).toBe(true);
    }
  );

  it(
    '[Wave 2: BUG-06] escapes SQL LIKE wildcards "_" and "%" in queryItems tag filtering',
    () => {
      const repo = createMemoryRepo();
      repo.createItem({
        id: 'tag-exact',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'С точным тегом',
        body: 'Тест экранирования',
        tags: ['a_b'],
        source: 'vault_ui',
        contentHash: 'tag-exact-hash',
      });
      repo.createItem({
        id: 'tag-wildcard-collision',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Ложное совпадение по _',
        body: 'Не должен совпадать',
        tags: ['axb'],
        source: 'vault_ui',
        contentHash: 'tag-collision-hash',
      });

      const results = repo.queryItems({ tag: 'a_b' });
      expect(results.map((r) => r.id)).toEqual(['tag-exact']);
    }
  );

  it(
    '[Wave 2: BUG-05] preserves all 7 v8 canvas, annotation, and linksOut columns in restoreRawRow',
    () => {
      const repo = createMemoryRepo();
      const created = repo.createItem({
        id: 'v8-cols-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Карточка на доске',
        body: 'Текст с [[Ссылкой]]',
        canvasX: 120,
        canvasY: 240,
        canvasW: 360,
        canvasH: 220,
        canvasFrame: 'frame-alpha',
        annotations: [{ id: 'ann-1', xPct: 25, yPct: 50, text: 'Метка', color: '#E86A33' }],
        linksOut: ['target-note-1'],
        source: 'vault_ui',
        contentHash: 'v8-cols-hash',
      });

      const raw = repo.getRawRowById(created.id)!;
      repo.db.prepare('DELETE FROM items WHERE id = ?').run(created.id);
      repo.db.prepare('DELETE FROM items_fts WHERE id = ?').run(created.id);

      const restored = repo.restoreRawRow(raw);
      expect(restored.canvasX).toBe(120);
      expect(restored.canvasY).toBe(240);
      expect(restored.canvasW).toBe(360);
      expect(restored.canvasH).toBe(220);
      expect(restored.canvasFrame).toBe('frame-alpha');
      expect(restored.annotations).toEqual([
        { id: 'ann-1', xPct: 25, yPct: 50, text: 'Метка', color: '#E86A33' },
      ]);
      expect(restored.linksOut).toEqual(['target-note-1']);
    }
  );

  it(
    '[Wave 2: BUG-05] does not resurrect locally deleted external (.ics/Google) calendar events on re-sync upsert',
    () => {
      const repo = createMemoryRepo();
      const start = new Date(2026, 10, 25, 14, 0, 0, 0).getTime();

      const ev = repo.upsertCalendarEvent({
        title: 'Внешняя встреча',
        startAt: start,
        endAt: start + 3_600_000,
        externalSource: 'google',
        externalId: 'gcal-deleted-ext-1',
      });

      expect(repo.deleteCalendarEvent(ev.id)).toBe(true);
      expect(repo.listCalendarEvents()).toHaveLength(0);

      // Next Google/ICS sync sends the same externalSource + externalId without deletedAt
      repo.upsertCalendarEvent({
        title: 'Внешняя встреча (повторный синк)',
        startAt: start,
        endAt: start + 3_600_000,
        externalSource: 'google',
        externalId: 'gcal-deleted-ext-1',
      });

      expect(repo.listCalendarEvents()).toHaveLength(0);
    }
  );

  it(
    '[Wave 2: BUG-06] strips newlines in updateVaultTaskText so renaming cannot inject extra markdown checkboxes',
    () => {
      const repo = createMemoryRepo();
      const note = repo.createItem({
        id: 'task-nl-inject',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Задачи',
        body: '- [ ] Обычная задача',
        source: 'vault_ui',
        contentHash: 'task-nl-hash',
      });

      const updated = repo.updateVaultTaskText({
        itemId: note.id,
        taskKey: 'md:0',
        text: 'Задача 1\n- [ ] Внедрённая задача',
      });

      expect(updated).not.toBeNull();
      const tasksAfter = repo.listVaultTasks().filter((t) => t.itemId === note.id);
      expect(tasksAfter).toHaveLength(1);
    }
  );

  it(
    '[Wave 2: BUG-06] preserves parent note in deleteVaultTask when it has custom title, tags, or reminder',
    () => {
      const repo = createMemoryRepo();
      const note = repo.createItem({
        id: 'task-preserve-meta',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Важный проект с тегами',
        body: '- [ ] Единственная задача',
        tags: ['проект', 'важное'],
        remindAt: Date.now() + 86_400_000,
        source: 'vault_ui',
        contentHash: 'task-preserve-hash',
      });

      const res = repo.deleteVaultTask({
        itemId: note.id,
        taskKey: 'md:0',
      });

      expect(res).not.toBeNull();
      expect(res?.deletedItemId).toBeUndefined();
      expect(repo.getItemById(note.id)).not.toBeNull();
    }
  );

  it(
    '[Wave 2: BUG-04] executes markDirty inside SQLite transactions and rolls back revisions/prefs atomically on failure',
    () => {
      const { repo } = createFileRepo();
      const dirtyTxStates: Array<{ entityType: SyncEntityType; inTx: boolean }> = [];
      repo.setMutationListener((entityType) => {
        dirtyTxStates.push({ entityType, inTx: repo.db.isTransaction });
      });

      const created = repo.createItem({
        id: 'tx-atomic-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Атомарность',
        body: 'Достаточно длинный текст заметки ' + 'x'.repeat(160),
        source: 'vault_ui',
        contentHash: 'tx-atomic-hash',
      });

      // 1. markDirty during createItem should happen inside the SQLite transaction
      expect(dirtyTxStates.some((e) => e.entityType === 'item' && e.inTx)).toBe(true);

      // 2. If items UPDATE aborts inside updateItem, auto-saved item_revisions must also roll back
      repo.db.exec(`
        CREATE TRIGGER fail_items_update BEFORE UPDATE ON items
        BEGIN
          SELECT RAISE(ABORT, 'simulated_update_abort');
        END;
      `);

      expect(() =>
        repo.updateItem(created.id, {
          body: 'Новое тело заметки ' + 'y'.repeat(200),
        })
      ).toThrow(/simulated_update_abort/);

      expect(repo.listItemRevisions(created.id)).toHaveLength(0);

      // 3. saveAppearanceConfig must wrap config + workspace_prefs metadata in a single transaction
      repo.db.exec(`
        CREATE TRIGGER fail_prefs_meta BEFORE INSERT ON settings
        WHEN NEW.key = 'workspace_prefs_updated_at'
        BEGIN
          SELECT RAISE(ABORT, 'simulated_prefs_abort');
        END;
      `);

      expect(() => repo.saveAppearanceConfig({ bgHue: 215 })).toThrow(/simulated_prefs_abort/);
      expect(repo.getSetting('appearance_config_json')).toBeNull();
    }
  );

  it(
    '[Wave 2: BUG-05] clearDemoItems removes orphaned item_revisions, sync_dirty, and calendar_events links',
    () => {
      const repo = createMemoryRepo();
      const demo = repo.createItem({
        id: 'demo-clean-1',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Демо с историей',
        body: 'Текст демо',
        isDemo: true,
        source: 'demo',
        contentHash: 'demo-clean-hash',
      });
      repo.saveItemRevision({
        itemId: demo.id,
        title: demo.title,
        content: demo.body,
        source: 'manual',
      });
      repo.markDirty('item', demo.id);
      const ev = repo.upsertCalendarEvent({
        title: 'Демо-событие',
        startAt: Date.now() + 3_600_000,
        endAt: Date.now() + 7_200_000,
        linkedItemId: demo.id,
      });

      const removed = repo.clearDemoItems();
      expect(removed).toBe(1);
      expect(repo.listItemRevisions(demo.id)).toHaveLength(0);
      expect(repo.listDirtyEntities().some((d) => d.entityId === demo.id)).toBe(false);
      expect(repo.getCalendarEventById(ev.id)?.linkedItemId).toBeNull();
    }
  );

  it(
    '[Wave 2: BUG-05] updateItem does not bump contentUpdatedAt on unchanged empty body and treats EN "New Note" symmetrically',
    () => {
      const repo = createMemoryRepo();
      const item = repo.createItem({
        id: 'noop-body-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'New Note',
        body: '',
        source: 'vault_ui',
        contentHash: 'noop-body-hash',
        createdAt: 1_700_000_000_000,
      });
      const initialContentUpdatedAt = item.contentUpdatedAt;

      const afterNoop = repo.updateItem(item.id, { body: '' });
      expect(afterNoop?.contentUpdatedAt).toBe(initialContentUpdatedAt);
    }
  );
});
