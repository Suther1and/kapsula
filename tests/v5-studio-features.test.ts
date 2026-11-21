import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { askVaultWithAi } from '@main/ai/enricher';
import { formatNoteLocally, transformNoteText } from '@main/ai/text-studio';
import { VaultRepository } from '@main/db/repository';
import { initSchema } from '@main/db/schema';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function makeTempDbPath(name = 'vault.sqlite'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-v5-test-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (openRepos.length > 0) {
    try {
      openRepos.pop()?.close();
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

describe('Kapsula v5 Studio & backend features', () => {
  it('cleans trivial test-clutter items via v5_studio_clean while keeping settings & real records', () => {
    const dbPath = makeTempDbPath();
    const rawDb = new DatabaseSync(dbPath);
    initSchema(rawDb);
    // Simulate legacy DB before v5 migration existed
    rawDb.prepare("DELETE FROM settings WHERE key = 'v5_studio_clean'").run();
    rawDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key_openrouter_enc', 'enc-secret-value')").run();
    rawDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_provider', 'openrouter')").run();

    const now = Date.now();
    const insert = rawDb.prepare(`
      INSERT INTO items (id, dna, orbit, mode_captured, title, body, summary, source, content_hash, ai_status, is_pinned, is_archived, is_demo, created_at, updated_at)
      VALUES (?, ?, 'unsorted', 'autopilot', ?, ?, ?, 'manual', ?, 'local', ?, 0, 0, ?, ?)
    `);
    insert.run('clutter-1', 'note', 'фывфыв', '', 'фывфыв', 'h1', 0, now, now);
    insert.run('clutter-2', 'note', '123123', '123', '123123', 'h2', 0, now, now);
    insert.run('clutter-3', 'note', 'Привет', 'привет', 'Привет', 'h3', 0, now, now);
    insert.run('keep-pinned', 'note', 'Привет', 'Важный пин', 'Важный пин', 'h4', 1, now, now);
    insert.run('keep-real', 'note', 'План релиза v5', 'Проверить голос и редактор Markdown без багов', 'План релиза v5', 'h5', 0, now, now);
    insert.run('keep-secret', 'secret', 'Основная карта', '', 'Карта', 'h6', 0, now, now);
    rawDb.close();

    const repo = new VaultRepository(dbPath);
    openRepos.push(repo);

    expect(repo.getItemById('clutter-1')).toBeNull();
    expect(repo.getItemById('clutter-2')).toBeNull();
    expect(repo.getItemById('clutter-3')).toBeNull();
    expect(repo.getItemById('keep-pinned')).not.toBeNull();
    expect(repo.getItemById('keep-real')).not.toBeNull();
    expect(repo.getItemById('keep-secret')).not.toBeNull();
    expect(repo.getSetting('api_key_openrouter_enc')).toBe('enc-secret-value');
    expect(repo.getSetting('ai_provider')).toBe('openrouter');
  });

  it('formats notes with all 4 presets while preserving code blocks & URLs', async () => {
    const messy = [
      'встреча по дизайну "новая капсула" - обсудили главные вещи.',
      'проверить https://example.com/docs?v=2 обязательно!',
      '```ts\nconst x = "keep_me" - 1;\n```',
      'надо купить микрофон и отправить билд команде',
    ].join('\n');

    const polished = formatNoteLocally(messy, 'polish');
    expect(polished.formattedText).toContain('«новая капсула» — обсудили');
    expect(polished.formattedText).toContain('https://example.com/docs?v=2');
    expect(polished.formattedText).toContain('const x = "keep_me" - 1;');

    const tasks = formatNoteLocally('купить молоко\nотправить отчет директору\n- [ ] созвон в 15:00', 'tasks');
    expect(tasks.extractedTasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.formattedText).toContain('- [ ]');

    const summary = formatNoteLocally(
      'Первая важная мысль по проекту. Вторая мысль о сроках запуска. Купить домен до пятницы.',
      'summary'
    );
    expect(summary.formattedText).toContain('> **Главное:**');

    const repo = new VaultRepository(makeTempDbPath());
    openRepos.push(repo);
    const cloudRes = await transformNoteText({
      text: 'сырой текст заметки',
      preset: 'structure',
      provider: 'google_ai_studio',
      apiKey: 'fake-key',
      repo,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        titleSuggestion: 'Готовый заголовок',
                        formattedText: '## Итоги\n\n- [ ] Проверить релиз',
                        extractedTasks: ['Проверить релиз'],
                        summary: 'Итоги по заметке',
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    expect(cloudRes.usedCloud).toBe(true);
    expect(cloudRes.titleSuggestion).toBe('Готовый заголовок');
    expect(cloudRes.formattedText).toBe('## Итоги\n\n- [ ] Проверить релиз');
  });

  it('tracks bounded item revisions, supports revert, and cleans up on delete', () => {
    const repo = new VaultRepository(makeTempDbPath());
    openRepos.push(repo);

    const item = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Черновик',
      body: 'Версия 0',
      summary: 'Черновик',
      source: 'vault_ui',
      contentHash: 'rev-test-0',
    });

    for (let i = 1; i <= 35; i += 1) {
      repo.saveItemRevision({
        itemId: item.id,
        title: item.title,
        content: `Версия ${i}`,
        source: i === 35 ? 'beautify' : 'manual',
      });
    }

    const revs = repo.listItemRevisions(item.id);
    expect(revs.length).toBe(30);
    expect(revs[0]?.content).toBe('Версия 35');

    repo.updateItem(item.id, { body: 'Изменённый текст' });
    const targetRev = revs[5]!;
    const reverted = repo.revertItemToRevision(item.id, targetRev.id);
    expect(reverted?.body).toBe(targetRev.content);

    const afterRevs = repo.listItemRevisions(item.id);
    expect(afterRevs[0]?.source).toBe('restore');
    expect(afterRevs[0]?.content).toBe('Изменённый текст');

    repo.deleteItem(item.id);
    expect(repo.getItemById(item.id)).toBeNull();
    const restored = repo.restoreItem(item.id);
    expect(restored).not.toBeNull();
    expect(repo.listItemRevisions(item.id).length).toBeGreaterThan(0);
  });

  it('aggregates and toggles markdown & voice action tasks without touching code fences', () => {
    const repo = new VaultRepository(makeTempDbPath());
    openRepos.push(repo);

    const mdItem = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Список дел',
      body: [
        'Контекст заметки',
        '- [ ] Купить адаптер',
        '```md',
        '- [ ] Задача внутри блока кода не должна парситься',
        '```',
        '- [x] Залить билд',
      ].join('\n'),
      summary: 'Список дел',
      source: 'vault_ui',
      contentHash: 'task-test-1',
    });

    const voiceItem = repo.createItem({
      dna: 'voice',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Созвон',
      body: 'Обсудили релиз',
      summary: 'Обсудили релиз',
      source: 'vault_ui',
      contentHash: 'task-test-2',
      mediaMeta: {
        actionItems: ['Написать Саше', 'Обновить иконку'],
      },
    });

    const initialTasks = repo.listVaultTasks();
    expect(initialTasks).toHaveLength(4);
    expect(initialTasks.slice(0, 3).map((t) => t.text)).toEqual(
      expect.arrayContaining(['Купить адаптер', 'Написать Саше', 'Обновить иконку'])
    );
    expect(initialTasks[3]?.text).toBe('Залить билд');
    expect(initialTasks[3]?.done).toBe(true);

    const baseContentUpdated = mdItem.contentUpdatedAt;
    const beforeIds = repo.queryItems({ limit: 10 }).map((i) => i.id);
    expect(beforeIds[0]).toBe(voiceItem.id);
    expect(beforeIds[1]).toBe(mdItem.id);

    const mdToggle = repo.toggleVaultTask({
      itemId: mdItem.id,
      sourceType: 'markdown',
      taskIndex: 0,
      done: true,
    });
    expect(mdToggle?.item.body).toContain('- [x] Купить адаптер');
    expect(mdToggle?.item.body).toContain('- [ ] Задача внутри блока кода');
    expect(mdToggle?.item.contentUpdatedAt).toBe(baseContentUpdated);

    // Toggling a checklist item on card #2 must NEVER teleport it above card #1
    const afterIds = repo.queryItems({ limit: 10 }).map((i) => i.id);
    expect(afterIds[0]).toBe(voiceItem.id);
    expect(afterIds[1]).toBe(mdItem.id);

    const voiceToggle = repo.toggleVaultTask({
      itemId: voiceItem.id,
      sourceType: 'voice_action',
      taskIndex: 1,
      done: true,
    });
    expect(voiceToggle?.item.mediaMeta?.checkedActionIndices).toEqual([1]);
  });

  it('strips [#n] reference artifacts from AI vault assistant answers', async () => {
    const repo = new VaultRepository(makeTempDbPath());
    openRepos.push(repo);
    const note = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Билеты в Стамбул',
      body: 'Вылет 18 мая в 09:40, терминал B',
      summary: 'Вылет 18 мая',
      source: 'vault_ui',
      contentHash: 'ask-test-1',
    });

    const res = await askVaultWithAi({
      question: 'Когда вылет?',
      repo,
      provider: 'google_ai_studio',
      apiKey: 'fake-key',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        answer: 'Вылет запланирован на 18 мая в 09:40 из терминала B [#1].',
                        cited_ids: [note.id],
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    expect(res.answer).toBe('Вылет запланирован на 18 мая в 09:40 из терминала B.');
    expect(res.citations.map((c) => c.id)).toEqual([note.id]);
  });

  it('preserves multiline markdown bullet & escaped checkbox lists plus code blocks under structure preset', () => {
    const raw = [
      'Короткий контекст по релизу — без потери переносов.',
      '',
      '- [ ] Проверить плавающий виджет',
      '- \\[ \\] Проверить голосовой плеер',
      '- Подготовить сборку',
      '',
      '```ts',
      "const status = 'ready';",
      '```',
    ].join('\n');

    const res = formatNoteLocally(raw, 'structure');
    expect(res.formattedText).toContain('Короткий контекст по релизу — без потери переносов.');
    expect(res.formattedText).toContain('## Задачи\n- [ ] Проверить плавающий виджет\n- [ ] Проверить голосовой плеер\n- [ ] Подготовить сборку');
    expect(res.formattedText).not.toContain('\\[');
    expect(res.formattedText).not.toContain('— Проверить');
    expect(res.formattedText.endsWith("```ts\nconst status = 'ready';\n```")).toBe(true);
    expect(res.extractedTasks).toEqual([
      'Проверить плавающий виджет',
      'Проверить голосовой плеер',
      'Подготовить сборку',
    ]);
  });
});
