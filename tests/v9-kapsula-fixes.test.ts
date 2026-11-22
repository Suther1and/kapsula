import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatNoteLocally, transformNoteText } from '@main/ai/text-studio';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { VaultCrypto } from '@main/security/vault-crypto';
import { isAnyTextNote, isDedicatedNote } from '@shared/item-helpers';
import { parseRussianEvent } from '@shared/russian-event-parser';
import type { VaultItem } from '@shared/types';

const repos: VaultRepository[] = [];
const tempDirs: string[] = [];

const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeTempDir(prefix = 'kapsula-v9-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMemoryRepo(): VaultRepository {
  const repo = new VaultRepository(':memory:');
  repos.push(repo);
  return repo;
}

function makeBaseItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'item-1',
    dna: 'note',
    subKind: null,
    orbit: '',
    modeCaptured: 'autopilot',
    focusBoardId: null,
    title: 'Тестовая запись',
    body: 'Текст заметки',
    summary: '',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: null,
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    hasEncryptedPayload: false,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: 'hash-1',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    isDemo: false,
    remindAt: null,
    remindedAt: null,
    createdAt: 1,
    updatedAt: 1,
    contentUpdatedAt: 1,
    deletedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
    ...overrides,
  };
}

afterEach(() => {
  while (repos.length > 0) {
    try {
      repos.pop()?.close();
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

describe('Kapsula v9 UX, parser, AI studio, revisions & capture fixes', () => {
  it('parses natural Russian date/weekday captures accurately while rejecting historical & news captures', () => {
    const refNow = new Date(2026, 10, 17, 10, 0, 0, 0).getTime(); // Tue 2026-11-17

    const novTypo = parseRussianEvent('23 ноябра много работать', refNow);
    expect(novTypo).not.toBeNull();
    expect(novTypo?.isEventIntent).toBe(true);
    expect(novTypo?.allDay).toBe(true);
    expect(new Date(novTypo!.startAt).getMonth()).toBe(10);
    expect(new Date(novTypo!.startAt).getDate()).toBe(23);
    expect(novTypo?.title).toBe('Много работать');

    const droppedLetter = parseRussianEvent('23 ноябя много работать', refNow);
    expect(droppedLetter?.isEventIntent).toBe(true);
    expect(new Date(droppedLetter!.startAt).getMonth()).toBe(10);
    expect(new Date(droppedLetter!.startAt).getDate()).toBe(23);

    const weekdaySport = parseRussianEvent('в пятницу спорт', refNow);
    expect(weekdaySport).not.toBeNull();
    expect(weekdaySport?.isEventIntent).toBe(true);
    expect(weekdaySport?.allDay).toBe(true);
    expect(new Date(weekdaySport!.startAt).getDay()).toBe(5);
    expect(weekdaySport?.title).toBe('Спорт');

    const historical = parseRussianEvent('15 марта 1998 вышла игра', refNow);
    expect(historical?.isEventIntent ?? false).toBe(false);

    const historicalNoNewsVerb = parseRussianEvent('15 марта 1998 релиз первой игры', refNow);
    expect(historicalNoNewsVerb?.isEventIntent ?? false).toBe(false);

    const bareDate = parseRussianEvent('23 ноября', refNow);
    expect(bareDate?.isEventIntent ?? false).toBe(false);

    const longNews = parseRussianEvent(
      `16 ноября вышла новая версия движка. ${'Подробное описание всех изменений в статье по разработке игр и графических пайплайнов. '.repeat(6)}`,
      refNow
    );
    expect(longNews?.isEventIntent ?? false).toBe(false);

    const decimalVersion = parseRussianEvent('версия 1.2 готова к проверке', refNow);
    expect(decimalVersion?.isEventIntent ?? false).toBe(false);
  });

  it('strictly scopes isDedicatedNote to curated mediaMeta.inNotesHub === true', () => {
    const plainQuick = makeBaseItem({ source: 'vault_ui', body: 'Короткая мысль' });
    expect(isDedicatedNote(plainQuick)).toBe(false);
    expect(isAnyTextNote(plainQuick)).toBe(true);

    const curatedVault = makeBaseItem({
      source: 'vault_ui',
      body: 'Структурированная заметка',
      mediaMeta: { inNotesHub: true },
    });
    expect(isDedicatedNote(curatedVault)).toBe(true);

    const curatedTg = makeBaseItem({
      source: 'telegram_saved',
      body: 'Импорт перенесён вручную',
      mediaMeta: { inNotesHub: true },
    });
    expect(isDedicatedNote(curatedTg)).toBe(true);

    const hiddenFromHub = makeBaseItem({
      source: 'vault_ui',
      body: 'Убрано из Заметок',
      mediaMeta: { inNotesHub: false },
    });
    expect(isDedicatedNote(hiddenFromHub)).toBe(false);
  });

  it('supports multi-preset formatting, preserves media & wiki-links, keeps plain bullets intact, and detects no-op changes', async () => {
    const withAssets = [
      'тест "проверка" - заметка для [[My Note]]',
      '',
      '![photo](kapsula-media://local/abc123.png)',
      '',
      '- Идея для игры',
      '- Вариант интерфейса',
    ].join('\n');

    const structured = formatNoteLocally(withAssets, 'structure');
    expect(structured.formattedText).toContain('![photo](kapsula-media://local/abc123.png)');
    expect(structured.formattedText).toContain('[[My Note]]');
    expect(structured.formattedText).not.toContain('## Задачи');
    expect(structured.formattedText).toContain('- Идея для игры');

    const polishAndTasks = formatNoteLocally(
      'тест "проверка" - для [[My Note]]\n![photo](kapsula-media://local/abc123.png)\nнадо купить микрофон\n- [x] проверить звук',
      ['polish', 'tasks']
    );
    expect(polishAndTasks.formattedText).toContain('«проверка» — для [[My Note]]');
    expect(polishAndTasks.formattedText).toContain('![photo](kapsula-media://local/abc123.png)');
    expect(polishAndTasks.formattedText).toContain('- [ ] Купить микрофон');
    expect(polishAndTasks.formattedText).toContain('- [x] Проверить звук');

    const structAndSummary = formatNoteLocally(
      'Первая важная мысль по проекту. Вторая мысль о сроках запуска. Купить домен до пятницы.',
      ['structure', 'summary']
    );
    expect(structAndSummary.formattedText).toContain('> **Главное:**');
    expect(structAndSummary.formattedText).toContain('Первая важная мысль по проекту.');
    expect(structAndSummary.formattedText).toContain('- [ ] Купить домен до пятницы');

    const alreadyClean = 'Аккуратная заметка без лишних изменений.';
    const noopLocal = formatNoteLocally(alreadyClean, 'polish');
    expect(noopLocal.changed).toBe(false);

    const noopTransform = await transformNoteText({
      text: alreadyClean,
      presets: ['polish'],
      provider: 'local',
    });
    expect(noopTransform.changed).toBe(false);
    expect(noopTransform.fallbackReason).toBe('no_ai_key');
  });

  it('preserves exact pre-beautify revision through long updates and reverts cleanly', () => {
    const repo = makeMemoryRepo();
    const originalTitle = 'Черновик до ИИ';
    const originalBody = 'Короткий исходник заметки.';
    const item = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: originalTitle,
      body: originalBody,
      summary: originalTitle,
      source: 'vault_ui',
      contentHash: 'rev-cycle-1',
    });

    const preRev = repo.saveItemRevision({
      itemId: item.id,
      title: item.title,
      content: originalBody,
      source: 'beautify',
    });

    const longBeautifiedBody = `## Расширенная структура\n\n${'Подробно расписанный текст заметки после обработки с ИИ. '.repeat(6)}`;
    expect(longBeautifiedBody.length - originalBody.length).toBeGreaterThan(200);

    // 1. Explicit skipAutoRevision never appends a competing auto-revision
    repo.updateItem(
      item.id,
      { title: 'Новый заголовок', body: longBeautifiedBody },
      { skipAutoRevision: true }
    );
    expect(repo.listItemRevisions(item.id)[0]?.id).toBe(preRev.id);
    expect(repo.listItemRevisions(item.id)[0]?.content).toBe(originalBody);

    const reverted = repo.revertItemToRevision(item.id, preRev.id);
    expect(reverted?.title).toBe(originalTitle);
    expect(reverted?.body).toBe(originalBody);

    // 2. Safety net: even without skipAutoRevision, updating immediately after 'beautify'
    //    does NOT overwrite revs[0] via the nextHash checkpoint branch
    const item2 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: originalTitle,
      body: originalBody,
      summary: originalTitle,
      source: 'vault_ui',
      contentHash: 'rev-cycle-2',
    });
    const preRev2 = repo.saveItemRevision({
      itemId: item2.id,
      title: item2.title,
      content: originalBody,
      source: 'beautify',
    });
    repo.updateItem(item2.id, { body: longBeautifiedBody });
    expect(repo.listItemRevisions(item2.id)[0]?.id).toBe(preRev2.id);
    expect(repo.listItemRevisions(item2.id)[0]?.content).toBe(originalBody);
  });

  it('deduplicates repeated words across title and body in listRelatedItems', () => {
    const repo = makeMemoryRepo();
    const a = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Работать над движком',
      body: 'Работать каждый день над рендером сцены и оптимизацией памяти',
      source: 'vault_ui',
      contentHash: 'rel-1',
    });
    const b = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Работать вечером',
      body: 'Нужно работать над задачей без отвлечений и наладить график оптимизацией памяти',
      source: 'vault_ui',
      contentHash: 'rel-2',
    });
    const onlySingleWordMatch = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Работать',
      body: 'Работать спокойно',
      source: 'vault_ui',
      contentHash: 'rel-3',
    });

    const related = repo.listRelatedItems(a.id, 5);
    const matchB = related.find((r) => r.item.id === b.id);
    expect(matchB).toBeDefined();
    expect(matchB?.reason).not.toMatch(/работать,\s*работать/i);

    const matchSingle = related.find((r) => r.item.id === onlySingleWordMatch.id);
    expect(matchSingle).toBeUndefined();
  });

  it('captures combined text + image cleanly with mediaMeta, calendar sync, and Vision title protection', async () => {
    const dir = makeTempDir('kapsula-v9-pipe-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    repos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);

    let visionCalls = 0;
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'google_ai_studio',
        apiKey: 'fake-vision-key',
        monthlyCapUsd: 3,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
      prepareVisionImage: () => ({ base64: TINY_PNG_BASE64.split(',')[1]!, mimeType: 'image/png' }),
      fetchFn: async () => {
        visionCalls++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: 'Случайный заголовок от Vision AI',
                        summary: 'Снимок макета интерфейса с планом работ.',
                        tags: ['интерфейс', 'дизайн'],
                        links: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const created = await pipeline.capture({
      text: '23 ноябра макеты интерфейса для релиза',
      imageBase64: TINY_PNG_BASE64,
      mediaMeta: {
        galleryPaths: ['extra-shot.png'],
        inNotesHub: true,
      },
      source: 'vault_ui',
    });

    expect(created.dna).toBe('shot');
    expect(created.body).toBe('23 ноябра макеты интерфейса для релиза');
    expect(created.title).toBe('23 ноябра макеты интерфейса для релиза');
    expect(created.mediaMeta?.galleryPaths).toEqual(['extra-shot.png']);
    expect(created.mediaMeta?.inNotesHub).toBe(true);

    const calEvents = repo.listCalendarEvents();
    expect(calEvents.some((ev) => ev.linkedItemId === created.id)).toBe(true);

    await pipeline.waitForIdle();
    expect(visionCalls).toBeGreaterThan(0);

    const afterBg = repo.getItemById(created.id);
    expect(afterBg?.title).toBe('23 ноябра макеты интерфейса для релиза');
    expect(afterBg?.summary).toContain('Снимок макета интерфейса');
    expect(afterBg?.tags.length).toBeGreaterThan(0);
  });

  it('wires ai:transform-text and vault:update-item skipAutoRevision + mediaMeta.inNotesHub over IPC cleanly', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.doMock('electron', () => ({
      app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '1.0.2' },
      clipboard: { writeText: vi.fn(), readText: vi.fn(() => ''), write: vi.fn() },
      ClipboardItem: class {},
      desktopCapturer: { getSources: vi.fn() },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      ipcMain: {
        handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => {
          handlers.set(ch, fn);
        }),
      },
      nativeImage: { createFromPath: vi.fn() },
      shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
      systemPreferences: { canPromptTouchID: vi.fn(() => false), promptTouchID: vi.fn() },
    }));

    try {
      const dir = makeTempDir('kapsula-v9-ipc-');
      const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
      repos.push(repo);
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
          monthlyCapUsd: 1,
          enableAutoOcr: false,
          enableUrlUnfurl: false,
        }),
      });

      const { registerIpcHandlers } = await import('@main/ipc');
      registerIpcHandlers({
        dataDir: dir,
        repo,
        cryptoVault,
        pipeline,
        windows: {
          vault: null,
          isOwnWebContents: () => true,
          isAllowedSurfaceUrl: () => true,
          broadcast: vi.fn(),
        } as unknown as Parameters<typeof registerIpcHandlers>[0]['windows'],
        clipper: {} as unknown as Parameters<typeof registerIpcHandlers>[0]['clipper'],
        getSettingsState: () =>
          ({
            theme: 'dark',
            locale: 'ru',
            activeMode: 'autopilot',
            activeFocusBoardId: null,
            aiProvider: 'local',
            monthlyCapUsd: 1,
            enableAutoOcr: false,
            enableUrlUnfurl: false,
            clipboardAutoWipeSeconds: 30,
            hasOpenRouterKey: false,
            hasGoogleAiKey: false,
            hasMasterPin: false,
            vaultUnlocked: true,
            clipperPort: 48721,
            clipperToken: 'tok',
            viewLayout: 'grid',
            launchAtLogin: false,
            soundTickEnabled: true,
            hudShortcut: 'Alt+Space',
            snatchShortcut: 'Alt+Shift+S',
          }) as ReturnType<Parameters<typeof registerIpcHandlers>[0]['getSettingsState']>,
        getApiKeyForProvider: () => null,
        setApiKeyForProvider: vi.fn(),
        setVaultUnlocked: vi.fn(),
      });

      const fakeEvt = {
        sender: { id: 1, getURL: () => 'http://localhost:5173' },
        senderFrame: null,
      };

      const item = repo.createItem({
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Чистая заметка',
        body: 'Аккуратный текст без изменений.',
        summary: 'Чистая заметка',
        source: 'vault_ui',
        contentHash: 'ipc-v9-1',
      });

      const transformHandler = handlers.get('ai:transform-text')!;
      const updateHandler = handlers.get('vault:update-item')!;
      const revertHandler = handlers.get('vault:revert-revision')!;

      const noopRes = (await transformHandler(fakeEvt, {
        itemId: item.id,
        text: item.body,
        presets: ['polish'],
      })) as { changed?: boolean; preRevisionId?: string | null; fallbackReason?: string | null };
      expect(noopRes.changed).toBe(false);
      expect(noopRes.preRevisionId).toBeNull();
      expect(noopRes.fallbackReason).toBe('no_ai_key');
      expect(repo.listItemRevisions(item.id)).toHaveLength(0);

      const messyBody = 'тест "кавычки" - текст\nнадо купить билеты\nнадо проверить список и собрать документы';
      repo.updateItem(item.id, { body: messyBody }, { skipAutoRevision: true });

      const changedRes = (await transformHandler(fakeEvt, {
        itemId: item.id,
        text: messyBody,
        presets: ['polish', 'tasks'],
      })) as { changed?: boolean; formattedText: string; preRevisionId?: string | null };
      expect(changedRes.changed).toBe(true);
      expect(changedRes.preRevisionId).toBeTruthy();

      const updated = (await updateHandler(fakeEvt, item.id, {
        title: 'Обновлённый заголовок',
        body: `${changedRes.formattedText}\n${'Дополнительный контекст. '.repeat(12)}`,
        mediaMeta: { inNotesHub: true },
        skipAutoRevision: true,
      })) as VaultItem;
      expect(updated.mediaMeta?.inNotesHub).toBe(true);
      expect(repo.listItemRevisions(item.id)[0]?.id).toBe(changedRes.preRevisionId);

      const reverted = (await revertHandler(fakeEvt, item.id, changedRes.preRevisionId!)) as VaultItem;
      expect(reverted.title).toBe('Чистая заметка');
      expect(reverted.body).toBe(messyBody);
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});
