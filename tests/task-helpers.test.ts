import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '@main/db/schema';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import {
  DEFAULT_TASK_BOARD_COLUMNS,
  extractWikiLinkTitles,
  normalizeTaskTextHash,
  parseMarkdownTasks,
  reconcileTaskMeta,
  toggleMarkdownTaskInBody,
} from '@shared/task-helpers';
import type { TaskBoardColumn, TaskBoardItemMeta } from '@shared/types';

describe('Task helpers, inline media extraction, wiki-links & v8 SQLite schema', () => {
  it('parses Markdown tasks across bullets, escaped brackets, and ignores fenced code blocks', () => {
    const md = [
      '# План',
      '- [ ] Первая задача',
      '* [x] Выполненная задача',
      '  • [X] Вложенная с точкой',
      '- \\[ \\] Экранированный чекбокс',
      '```markdown',
      '- [ ] Не должна попасть из блока кода',
      '```',
      '~~~',
      '- [x] И из тильд тоже',
      '~~~',
      '- [ ]   ',
      '- [ ] Финальная задача',
    ].join('\n');

    const tasks = parseMarkdownTasks(md);
    expect(tasks).toHaveLength(5);
    expect(tasks.map((t) => ({ index: t.index, taskKey: t.taskKey, done: t.done, text: t.text }))).toEqual([
      { index: 0, taskKey: 'md:0', done: false, text: 'Первая задача' },
      { index: 1, taskKey: 'md:1', done: true, text: 'Выполненная задача' },
      { index: 2, taskKey: 'md:2', done: true, text: 'Вложенная с точкой' },
      { index: 3, taskKey: 'md:3', done: false, text: 'Экранированный чекбокс' },
      { index: 4, taskKey: 'md:4', done: false, text: 'Финальная задача' },
    ]);

    expect(tasks[0]!.textHash).toBe(normalizeTaskTextHash('  первая   ЗАДАЧА '));

    const toggled = toggleMarkdownTaskInBody(md, 0, true);
    expect(toggled?.done).toBe(true);
    expect(toggled?.body).toContain('- [x] Первая задача');
    expect(toggled?.body).toContain('- [ ] Не должна попасть из блока кода');
  });

  it('reconciles taskMeta via textHash when lines are inserted or reordered without losing columns/priority/dueAt', () => {
    const initialTasks = parseMarkdownTasks([
      '- [ ] Подготовить макет',
      '- [ ] Отправить отчёт',
    ].join('\n'));

    const existingMeta: Record<string, TaskBoardItemMeta> = {
      'md:0': {
        columnId: 'in_progress',
        boardOrder: 100,
        priority: 'high',
        dueAt: 1790000000000,
        textHash: initialTasks[0]!.textHash,
      },
      'md:1': {
        columnId: 'waiting',
        boardOrder: 200,
        priority: 'medium',
        dueAt: null,
        textHash: initialTasks[1]!.textHash,
      },
    };

    // Insert a brand-new task at line 0 AND swap the two existing tasks
    const editedTasks = parseMarkdownTasks([
      '- [ ] Новая срочная задача',
      '- [ ] Отправить отчёт',
      '- [ ] Подготовить макет',
    ].join('\n'));

    const reconciled = reconcileTaskMeta(editedTasks, existingMeta, DEFAULT_TASK_BOARD_COLUMNS);

    expect(reconciled['md:0']?.columnId).toBe('inbox');
    expect(reconciled['md:0']?.priority).toBe('none');

    expect(reconciled['md:1']?.columnId).toBe('waiting');
    expect(reconciled['md:1']?.priority).toBe('medium');
    expect(reconciled['md:1']?.boardOrder).toBe(200);

    expect(reconciled['md:2']?.columnId).toBe('in_progress');
    expect(reconciled['md:2']?.priority).toBe('high');
    expect(reconciled['md:2']?.dueAt).toBe(1790000000000);
  });

  it('enforces the Done <-> Done-Column invariant and safely handles deleted custom columns', () => {
    const baseTasks = parseMarkdownTasks('- [ ] Проверить релиз');
    const inProgressMeta: Record<string, TaskBoardItemMeta> = {
      'md:0': {
        columnId: 'in_progress',
        boardOrder: 50,
        priority: 'urgent',
        dueAt: null,
        textHash: baseTasks[0]!.textHash,
      },
    };

    // Marking done automatically moves to 'done' and remembers prevColumnId = 'in_progress'
    const checkedTasks = parseMarkdownTasks('- [x] Проверить релиз');
    const afterCheck = reconcileTaskMeta(checkedTasks, inProgressMeta, DEFAULT_TASK_BOARD_COLUMNS);
    expect(afterCheck['md:0']?.columnId).toBe('done');
    expect(afterCheck['md:0']?.prevColumnId).toBe('in_progress');
    expect(afterCheck['md:0']?.priority).toBe('urgent');

    // Unchecking restores back to prevColumnId ('in_progress')
    const uncheckedTasks = parseMarkdownTasks('- [ ] Проверить релиз');
    const afterUncheck = reconcileTaskMeta(uncheckedTasks, afterCheck, DEFAULT_TASK_BOARD_COLUMNS);
    expect(afterUncheck['md:0']?.columnId).toBe('in_progress');

    // Custom column removed -> falls back to inbox cleanly
    const orphanMeta: Record<string, TaskBoardItemMeta> = {
      'md:0': {
        columnId: 'deleted_col',
        boardOrder: 10,
        priority: 'low',
        dueAt: null,
        textHash: baseTasks[0]!.textHash,
      },
    };
    const customCols: TaskBoardColumn[] = [
      { id: 'backlog', title: 'Бэклог', color: '#94A3B8', order: 0 },
      { id: 'finished', title: 'Закрыто', color: '#2EA06B', order: 1, isDone: true },
    ];
    const reassigned = reconcileTaskMeta(uncheckedTasks, orphanMeta, customCols);
    expect(reassigned['md:0']?.columnId).toBe('backlog');
  });

  it('extracts sanitized inline media filenames and blocks path traversal attempts', () => {
    const body = [
      'Скриншот интерфейса:',
      '![UI](kapsula-media://local/shot-1234.png)',
      'Дубликат: ![Again](kapsula-media://local/shot-1234.png?v=2#top)',
      'HTML: <img src="kapsula-media://local/diagram_01.webp" />',
      'Атаки traversal:',
      '![](kapsula-media://local/../../etc/passwd)',
      '![](kapsula-media://local/%2e%2e%2fsecret.key)',
      '![](kapsula-media://local/sub/nested.png)',
      '![](kapsula-media://local/.env)',
      '![](kapsula-media://local/photo%20name.jpg)',
    ].join('\n');

    expect(extractInlineMediaFilenames(body)).toEqual([
      'shot-1234.png',
      'diagram_01.webp',
      'photo name.jpg',
    ]);
    expect(extractInlineMediaFilenames('')).toEqual([]);
    expect(extractInlineMediaFilenames(null)).toEqual([]);
  });

  it('extracts [[WikiLink]] titles cleanly while ignoring code blocks, inline code, and escapes', () => {
    const body = [
      'Связано с [[План запуска]] и [[Архитектура|Схема системы]].',
      'Повтор в другом регистре: [[план запуска]].',
      'Экранировано: \\[[Не ссылка]] и в инлайн-коде `[[Тоже не ссылка]]`.',
      '```ts',
      'const x = "[[Внутри код-блока]]";',
      '```',
      '~~~',
      '[[Внутри тильд]]',
      '~~~',
      'Пустая [[]] и финальная [[Бюджет 2026]].',
    ].join('\n');

    expect(extractWikiLinkTitles(body)).toEqual([
      'План запуска',
      'Архитектура',
      'Бюджет 2026',
    ]);
    expect(extractWikiLinkTitles(undefined)).toEqual([]);
  });

  it('applies v8 SQLite schema migrations idempotently and allows re-capturing soft-deleted external_id', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    // Running initSchema a second time must be 100% idempotent
    initSchema(db);

    const itemCols = (db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(itemCols).toContain('purged_at');

    const revCols = (
      db.prepare('PRAGMA table_info(item_revisions)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(revCols).toEqual(
      expect.arrayContaining([
        'content_hash',
        'device_name',
        'updated_at',
        'deleted_at',
        'sync_version',
        'last_device_id',
      ])
    );

    const dirtyCols = (
      db.prepare('PRAGMA table_info(sync_dirty)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(dirtyCols).toEqual(
      expect.arrayContaining(['fail_count', 'last_error', 'next_retry_at'])
    );

    // Soft-deleted tombstone with external_id must NOT collide with a new live item of the same (source, external_id)
    const now = Date.now();
    db.prepare(
      `INSERT INTO items (id, dna, orbit, mode_captured, title, source, external_id, content_hash, created_at, updated_at, deleted_at)
       VALUES ('dead-1', 'link', '', 'autopilot', 'Old', 'browser_ext', 'ext-42', 'h1', ?, ?, ?)`
    ).run(now, now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO items (id, dna, orbit, mode_captured, title, source, external_id, content_hash, created_at, updated_at, deleted_at)
           VALUES ('live-1', 'link', '', 'autopilot', 'New', 'browser_ext', 'ext-42', 'h2', ?, ?, NULL)`
        )
        .run(now + 1, now + 1)
    ).not.toThrow();

    db.close();
  });
});
