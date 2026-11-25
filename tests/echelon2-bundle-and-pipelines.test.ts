import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { defaultLocalOcrAdapter } from '@main/platform/platform-adapters';
import {
  MAX_VIDEO_FILE_BYTES,
  MIN_VIDEO_FILE_BYTES,
  VideoCacheManager,
} from '@main/pipeline/video-cache';
import { streamResponseToTempFile } from '@main/pipeline/video-extractor';
import { VaultCrypto } from '@main/security/vault-crypto';
import {
  compileBilingualSearchQuery,
  scoreBilingualFields,
  scoreBilingualFieldsCompiled,
} from '@shared/bilingual-search';
import type { SettingsState } from '@shared/types';

const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const SAMPLE_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];
const activeCryptos: VaultCrypto[] = [];

function makeTempDir(prefix = 'kapsula-e2-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (activeCryptos.length > 0) {
    try {
      activeCryptos.pop()!.dispose();
    } catch {
      // ignore
    }
  }
  while (openRepos.length > 0) {
    try {
      openRepos.pop()!.close();
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  vi.doUnmock('electron');
  vi.restoreAllMocks();
});

describe('Echelon 2 (#9): Packaging, Minification & Locales Allowlist Guards', () => {
  it('enables minify: true for both main and preload bundles in scripts/build-main.mjs', () => {
    const buildMainSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-main.mjs'), 'utf8');
    const minifyMatches = buildMainSrc.match(/minify:\s*true/g) ?? [];
    expect(minifyMatches.length).toBeGreaterThanOrEqual(2);
    expect(buildMainSrc).toContain("'unpdf'");
    expect(buildMainSrc).toContain("'linkedom'");
    expect(buildMainSrc).toContain("'@mozilla/readability'");
  });

  it('prunes unused deps while keeping @capacitor/android, electron-updater, valid semver, electronLanguages & strict build.files allowlist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
      build: {
        electronLanguages?: string[];
        files: string[];
      };
    };

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@capacitor/android']).toBeTruthy();
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
    expect(pkg.dependencies['unpdf']).toBeTruthy();
    expect(pkg.dependencies['linkedom']).toBeTruthy();
    expect(pkg.dependencies['@mozilla/readability']).toBeTruthy();

    expect(pkg.dependencies['@fontsource-variable/inter']).toBeUndefined();
    expect(pkg.dependencies['@fontsource-variable/onest']).toBeUndefined();
    expect(pkg.dependencies['@paper-design/shaders-react']).toBeUndefined();

    expect(pkg.build.electronLanguages).toEqual(['ru', 'en-US', 'en-GB']);
    expect(pkg.build.files).toEqual(
      expect.arrayContaining([
        'dist/**/*',
        '!dist/mobile/**',
        '!dist/main/*.swift',
        '!node_modules/@capacitor{,/**/*}',
        '!node_modules/@types{,/**/*}',
        '!**/node_modules/**/*.map',
        '!**/node_modules/**/*.d.ts',
        '!**/node_modules/**/*.ts',
        'LICENSE',
      ])
    );
    const hasAllowlistNegation = pkg.build.files.some(
      (pat) =>
        pat.startsWith('!node_modules/!(') &&
        pat.includes('unpdf') &&
        pat.includes('linkedom') &&
        pat.includes('@mozilla') &&
        pat.includes('htmlparser2')
    );
    expect(hasAllowlistNegation).toBe(true);
  });

  it('after-pack-win verifies pruned locales/ when appOutDir exists and rejects unexpected .pak files', async () => {
    const afterPackWin = require(path.join(ROOT, 'scripts', 'after-pack-win.cjs')) as (ctx: {
      electronPlatformName: string;
      appOutDir: string;
      packager?: { appInfo?: { productFilename?: string } };
    }) => Promise<void>;

    const dir = makeTempDir('kapsula-afterpack-');
    const exePath = path.join(dir, 'Kapsula.exe');
    // Missing rcedit skips embed when rcedit isn't run? Actually rcedit IS installed in node_modules;
    // test missing exe -> embedWindowsMetadata returns { applied: false } cleanly, and extra locales check!
    const localesDir = path.join(dir, 'locales');
    fs.mkdirSync(localesDir, { recursive: true });
    fs.writeFileSync(path.join(localesDir, 'ru.pak'), 'ru');
    fs.writeFileSync(path.join(localesDir, 'en-US.pak'), 'en-us');
    fs.writeFileSync(path.join(localesDir, 'en-GB.pak'), 'en-gb');

    // Missing Kapsula.exe returns early before locales check
    await expect(
      afterPackWin({
        electronPlatformName: 'win32',
        appOutDir: path.join(dir, 'nonexistent'),
      })
    ).resolves.toBeUndefined();
    expect(fs.existsSync(exePath)).toBe(false);

    // When Kapsula.exe exists and locales/ contains an unexpected .pak file, afterPackWin throws
    const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(electronExe)) {
      fs.copyFileSync(electronExe, exePath);
      await expect(
        afterPackWin({
          electronPlatformName: 'win32',
          appOutDir: dir,
        })
      ).resolves.toBeUndefined();

      fs.writeFileSync(path.join(localesDir, 'fr.pak'), 'fr');
      await expect(
        afterPackWin({
          electronPlatformName: 'win32',
          appOutDir: dir,
        })
      ).rejects.toThrow(/Unexpected locales/);
    }

    const afterPackSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-win.cjs'), 'utf8');
    expect(afterPackSrc).toContain("['en-GB.pak', 'en-US.pak', 'ru.pak']");
  });
});

describe('Echelon 2 (#10): Batch IPCs, Async Video Cache/Streaming, Non-blocking OCR, Blob Cleanup & Fast Search', () => {
  it('bulkUpdateItems, bulkDeleteItems, bulkRestoreItems & multi-task-per-note bulkDeleteTasks work transactionally without index shift', () => {
    const dir = makeTempDir('kapsula-bulk-repo-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    const workOrbit = repo.createOrbit({
      name: 'Работа',
      description: 'Рабочие материалы',
      color: '#E86A33',
      icon: 'Briefcase',
    });

    const a = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Заметка А',
      body: 'Тело А',
      source: 'vault_ui',
      contentHash: 'bulk-a',
    });
    const b = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Заметка Б',
      body: 'Тело Б',
      source: 'vault_ui',
      contentHash: 'bulk-b',
    });

    const upd = repo.bulkUpdateItems([a.id, b.id, 'missing-id'], { isMuted: true, orbit: workOrbit.id }, { projection: 'card' });
    expect(upd.count).toBe(2);
    expect(upd.failedIds).toEqual(['missing-id']);
    expect(upd.items.every((it) => it.isMuted && it.orbit === workOrbit.id && it.isCardProjection)).toBe(true);

    const del = repo.bulkDeleteItems([a.id, b.id]);
    expect(del.deletedIds).toEqual([a.id, b.id]);
    expect(del.purgedIds).toEqual([]);
    expect(repo.getItemById(a.id)).toBeNull();

    const rest = repo.bulkRestoreItems([a.id, b.id], { projection: 'card' });
    expect(rest.count).toBe(2);
    expect(repo.getItemById(a.id)?.orbit).toBe(workOrbit.id);

    // Multi-task-per-note deletion: deleting md:0 and md:2 simultaneously preserves md:1 and its metadata!
    const multiTaskNote = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Список задач',
      body: '- [ ] Первая задача\n- [ ] Вторая выжившая\n- [ ] Третья задача',
      mediaMeta: {
        taskMeta: {
          'md:1': { columnId: 'in_progress', boardOrder: 2000, priority: 'high', dueAt: null },
        },
      },
      source: 'vault_ui',
      contentHash: 'multi-task-note',
    });
    const standalone = repo.createStandaloneTask({ text: 'Отдельная задача' })!;
    expect(standalone).not.toBeNull();

    const toggled = repo.bulkToggleTasks([
      { itemId: multiTaskNote.id, sourceType: 'markdown', taskIndex: 1, done: true },
      { itemId: standalone.id, sourceType: 'markdown', taskIndex: 0, done: true },
    ]);
    expect(toggled.updatedItems).toHaveLength(2);
    expect(toggled.tasks.find((t) => t.itemId === standalone.id)?.done).toBe(true);

    const metaUpdated = repo.bulkUpdateTasksMeta({
      tasks: [{ itemId: multiTaskNote.id, taskKey: 'md:1' }],
      priority: 'urgent',
      orbit: 'dev',
    });
    expect(metaUpdated.updatedItems[0]?.orbit).toBe('dev');

    const deletedTasks = repo.bulkDeleteTasks([
      { itemId: multiTaskNote.id, taskKey: 'md:0' },
      { itemId: multiTaskNote.id, taskKey: 'md:2' },
      { itemId: standalone.id, taskKey: 'md:0' },
    ]);
    expect(deletedTasks.deletedItemIds).toEqual([standalone.id]);
    const survivingNote = repo.getItemById(multiTaskNote.id)!;
    expect(survivingNote.body).toBe('- [x] Вторая выжившая');
    expect(deletedTasks.tasks.some((t) => t.itemId === multiTaskNote.id && t.text === 'Вторая выжившая')).toBe(true);
    expect(deletedTasks.tasks.find((t) => t.itemId === multiTaskNote.id)?.priority).toBe('urgent');
  });

  it('IPC batch handlers enforce PIN lock on secrets and broadcastExcept without vault:batch-synced', async () => {
    const dir = makeTempDir('kapsula-bulk-ipc-');
    const handlers = new Map<string, (evt: unknown, ...args: unknown[]) => unknown>();
    const broadcasts: Array<{ channel: string; payload: unknown }> = [];
    const broadcastExcepts: Array<{ excludeId: number | undefined; channel: string; payload: unknown }> = [];

    vi.resetModules();
    vi.doMock('electron', () => ({
      ipcMain: {
        removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
        handle: vi.fn((ch: string, fn: (evt: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(ch, fn);
        }),
      },
      clipboard: { write: vi.fn(), writeText: vi.fn(), readText: vi.fn(() => ''), clear: vi.fn() },
      ClipboardItem: class {},
      shell: { openExternal: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
      dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
      nativeImage: { createFromBuffer: vi.fn() },
      desktopCapturer: { getSources: vi.fn(async () => []) },
      app: { getPath: vi.fn(() => dir), getVersion: () => '1.1.2', isPackaged: false },
      systemPreferences: { canPromptTouchID: vi.fn(() => false) },
    }));

    const [{ VaultRepository: RepoCtor }, { VaultCrypto: CryptoCtor }, { CapturePipeline: PipelineCtor }, { registerIpcHandlers }] =
      await Promise.all([
        import('@main/db/repository'),
        import('@main/security/vault-crypto'),
        import('@main/pipeline/capture-pipeline'),
        import('@main/ipc'),
      ]);

    const repo = new RepoCtor(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new CryptoCtor(dir, null);
    activeCryptos.push(cryptoVault);
    cryptoVault.setPinProtection('1234');
    cryptoVault.lock();

    const pipeline = new PipelineCtor({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });

    const mainFrame = { url: 'http://localhost:5173' };
    const trustedEvt = {
      sender: { id: 77, getURL: () => 'http://localhost:5173', mainFrame },
      senderFrame: mainFrame,
    };

    const settingsState: SettingsState = {
      theme: 'dark',
      locale: 'ru',
      activeMode: 'autopilot',
      activeFocusBoardId: null,
      aiProvider: 'local',
      monthlyCapUsd: 5,
      enableAutoOcr: false,
      enableUrlUnfurl: false,
      clipboardAutoWipeSeconds: 30,
      hasOpenRouterKey: false,
      hasGoogleAiKey: false,
      hasMasterPin: true,
      vaultUnlocked: false,
      clipperPort: 47831,
      clipperToken: 'tok',
      viewLayout: 'grid',
      launchAtLogin: false,
      soundTickEnabled: false,
      hudShortcut: 'Alt+Space',
      snatchShortcut: 'CommandOrControl+Shift+V',
      enableScreenProtection: true,
    };

    registerIpcHandlers({
      dataDir: dir,
      repo,
      cryptoVault,
      pipeline,
      windows: {
        vault: null,
        hud: null,
        isOwnWebContents: () => true,
        isAllowedSurfaceUrl: () => true,
        broadcast: vi.fn((channel: string, payload: unknown) => {
          broadcasts.push({ channel, payload });
        }),
        broadcastExcept: vi.fn((excludeId: number | undefined, channel: string, payload: unknown) => {
          broadcastExcepts.push({ excludeId, channel, payload });
        }),
        persistOrbPosition: vi.fn(),
        setCaptureMode: vi.fn(),
        setContentProtection: vi.fn(),
        setVaultBackgroundColor: vi.fn(),
        hideHud: vi.fn(),
        hideHudAndPaste: vi.fn(async () => true),
      } as unknown as Parameters<typeof registerIpcHandlers>[0]['windows'],
      clipper: {} as unknown as Parameters<typeof registerIpcHandlers>[0]['clipper'],
      getSettingsState: () => settingsState,
      getApiKeyForProvider: () => null,
      setApiKeyForProvider: vi.fn(),
      setVaultUnlocked: vi.fn(),
    });

    const note1 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Обычная 1',
      body: 'Текст 1',
      source: 'vault_ui',
      contentHash: 'ipc-n1',
    });
    const note2 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Обычная 2',
      body: 'Текст 2',
      source: 'vault_ui',
      contentHash: 'ipc-n2',
    });
    const secret = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'Секрет',
      body: '',
      encryptedPayload: 'enc',
      source: 'vault_ui',
      contentHash: 'ipc-sec',
    });

    const invoke = async <T>(ch: string, ...args: unknown[]): Promise<T> =>
      (await handlers.get(ch)!(trustedEvt, ...args)) as T;

    await expect(
      invoke('vault:bulk-update-items', [note1.id, secret.id], { isMuted: true })
    ).rejects.toThrow(/Сейф заблокирован/i);
    await expect(invoke('vault:bulk-delete-items', [note1.id, secret.id])).rejects.toThrow(
      /Сейф заблокирован/i
    );

    const resUpd = await invoke<{ count: number }>(
      'vault:bulk-update-items',
      [note1.id, note2.id],
      { isMuted: true },
      { projection: 'card' }
    );
    expect(resUpd.count).toBe(2);
    expect(broadcasts.some((b) => b.channel === 'vault:batch-synced')).toBe(false);
    expect(broadcastExcepts).toHaveLength(1);
    expect(broadcastExcepts[0]).toMatchObject({
      excludeId: 77,
      channel: 'vault:items-batch-upserted',
    });
  });

  it('VideoCacheManager async methods and streamResponseToTempFile handle >60MB abort and <1KB reject with zero leftover .tmp-* files', async () => {
    const dir = makeTempDir('kapsula-vid-stream-');
    const cache = new VideoCacheManager(dir, 250);

    // Valid multi-chunk stream
    const payloadA = Buffer.alloc(1500, 0x41);
    const payloadB = Buffer.alloc(1500, 0x42);
    const fullPayload = Buffer.concat([payloadA, payloadB]);
    const expectedSha = crypto.createHash('sha256').update(fullPayload).digest('hex');

    const validResp = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(payloadA);
          controller.enqueue(payloadB);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'video/mp4' } }
    );

    const tmpValid = cache.createTempFilePath('.mp4');
    const streamed = await streamResponseToTempFile(validResp, tmpValid, MAX_VIDEO_FILE_BYTES);
    expect(streamed).toEqual({
      byteLength: fullPayload.length,
      sha256Hex: expectedSha,
    });
    const committed = await cache.putFileFromTemp(
      tmpValid,
      streamed!.sha256Hex,
      streamed!.byteLength,
      'demo',
      '.mp4'
    );
    expect(committed).not.toBeNull();
    expect(committed!.filename).toMatch(/^vc_demo_/);
    expect((await cache.getStatsAsync()).fileCount).toBe(1);
    expect((await cache.resolveSafePathAsync(committed!.filename)).ok).toBe(true);
    await cache.touchAsync(committed!.filename);

    // Oversized stream abort (> cap) -> returns null and cleans up .tmp-* immediately
    let canceled = false;
    const overResp = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(4096));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { 'content-type': 'video/mp4' } }
    );
    const tmpOver = cache.createTempFilePath('.mp4');
    const overRes = await streamResponseToTempFile(overResp, tmpOver, 8192);
    expect(overRes).toBeNull();
    expect(canceled).toBe(true);

    // Undersized stream (< MIN_VIDEO_FILE_BYTES)
    const tinyResp = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MIN_VIDEO_FILE_BYTES - 10));
          controller.close();
        },
      }),
      { status: 200 }
    );
    const tmpTiny = cache.createTempFilePath('.mp4');
    const tinyRes = await streamResponseToTempFile(tinyResp, tmpTiny, MAX_VIDEO_FILE_BYTES);
    expect(tinyRes).toBeNull();

    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith('.tmp-'))).toBe(false);

    const cleared = await cache.clearAsync();
    expect(cleared.fileCount).toBe(0);
  });

  it('non-blocking WinRT OCR defers sync_dirty until OCR completes without blocking capture()', async () => {
    const dir = makeTempDir('kapsula-ocr-nonblock-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    activeCryptos.push(cryptoVault);

    let releaseOcr!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOcr = r;
    });
    vi.spyOn(defaultLocalOcrAdapter, 'extractText').mockImplementation(async () => {
      await gate;
      return { text: 'Обычный текст без секретов', lines: ['Обычный текст без секретов'] };
    });

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 5,
        enableAutoOcr: true,
        enableUrlUnfurl: false,
      }),
    });

    const startedAt = performance.now();
    const item = await pipeline.capture({
      imageBase64: SAMPLE_PNG_BASE64,
      mode: 'autopilot',
      source: 'vault_ui',
    });
    const elapsedMs = performance.now() - startedAt;

    // Must not block waiting on OCR!
    expect(elapsedMs).toBeLessThan(500);
    expect(
      repo.db.prepare("SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?").get(item.id)
    ).toEqual({ c: 0 });

    releaseOcr();
    await pipeline.waitForIdle();

    const after = repo.getItemById(item.id)!;
    expect(after.ocrText).toContain('Обычный текст');
    expect(after.aiStatus).not.toBe('pending');
    expect(
      repo.db.prepare("SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?").get(item.id)
    ).toEqual({ c: 1 });
  });

  it('prunes sync_blob_cache on purgeItemPermanently & emptyTrash while preserving shared-media blobs', () => {
    const dir = makeTempDir('kapsula-blob-cache-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    const uniqueItem = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Уникальный скрин',
      imagePath: 'unique_shot.png',
      thumbPath: 'thumb_unique_shot.webp',
      source: 'vault_ui',
      contentHash: 'blob-u1',
    });
    const shared1 = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Общий 1',
      imagePath: 'shared_shot.png',
      source: 'vault_ui',
      contentHash: 'blob-s1',
    });
    const shared2 = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Общий 2',
      imagePath: 'shared_shot.png',
      source: 'vault_ui',
      contentHash: 'blob-s2',
    });

    repo.upsertBlobCache({
      localName: 'unique_shot.png',
      blobId: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      byteSize: 100,
      mtimeMs: Date.now(),
      uploadedForUser: null,
    });
    repo.upsertBlobCache({
      localName: 'thumb_unique_shot.webp',
      blobId: 'b'.repeat(64),
      sha256: 'b'.repeat(64),
      byteSize: 50,
      mtimeMs: Date.now(),
      uploadedForUser: null,
    });
    repo.upsertBlobCache({
      localName: 'shared_shot.png',
      blobId: 'c'.repeat(64),
      sha256: 'c'.repeat(64),
      byteSize: 200,
      mtimeMs: Date.now(),
      uploadedForUser: null,
    });

    repo.deleteItem(uniqueItem.id);
    repo.deleteItem(shared1.id);
    const emptied = repo.emptyTrash();
    expect(emptied.purgedCount).toBe(2);

    // Unique files pruned; shared file preserved because shared2 still references it
    expect(repo.getBlobCache('unique_shot.png')).toBeNull();
    expect(repo.getBlobCache('thumb_unique_shot.webp')).toBeNull();
    expect(repo.getBlobCache('shared_shot.png')).not.toBeNull();

    // Purge final holder -> shared_shot.png is pruned
    repo.purgeItemPermanently(shared2.id);
    expect(repo.getBlobCache('shared_shot.png')).toBeNull();
  });

  it('Ghost mode capture with image and enableAutoOcr returns < 50 ms without blocking and encrypts OCR asynchronously (failing closed if locked)', async () => {
    const dir = makeTempDir('kapsula-ghost-ocr-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    activeCryptos.push(cryptoVault);
    cryptoVault.setPinProtection('1234');

    let releaseOcr!: () => void;
    let ocrGate = new Promise<void>((r) => {
      releaseOcr = r;
    });
    vi.spyOn(defaultLocalOcrAdapter, 'extractText').mockImplementation(async () => {
      await ocrGate;
      return { text: 'Секрет на экране 4242', lines: ['Секрет на экране 4242'] };
    });

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 5,
        enableAutoOcr: true,
        enableUrlUnfurl: false,
      }),
    });

    const t0 = performance.now();
    const created = await pipeline.capture({
      imageBase64: SAMPLE_PNG_BASE64,
      mode: 'ghost',
      source: 'vault_ui',
    });
    const wallMs = performance.now() - t0;

    expect(wallMs).toBeLessThan(50);
    expect(created.dna).toBe('secret');
    expect(created.ocrText).toBe('');
    expect(
      repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?').get(created.id)
    ).toEqual({ c: 0 });

    releaseOcr();
    await pipeline.waitForIdle();

    const after = repo.getItemById(created.id)!;
    expect(after.ocrText).toBe('');
    expect(
      repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?').get(created.id)
    ).toEqual({ c: 1 });
    const dec = cryptoVault.decryptSecret(repo.getRawEncryptedPayload(created.id)!);
    expect(dec.secretValue).toBe('Секрет на экране 4242');
    expect(fs.readdirSync(path.join(dir, 'media'))).toEqual([]);

    // Mid-flight Vault lock while Ghost OCR is running must fail closed
    ocrGate = new Promise<void>((r) => {
      releaseOcr = r;
    });
    const png2 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const created2 = await pipeline.capture({
      imageBase64: png2,
      mode: 'ghost',
      source: 'vault_ui',
    });
    cryptoVault.lock();
    releaseOcr();
    await pipeline.waitForIdle();

    expect(
      repo.db.prepare('SELECT COUNT(*) AS c FROM sync_dirty WHERE entity_id = ?').get(created2.id)
    ).toEqual({ c: 0 });
    const lockedItem = repo.getItemById(created2.id)!;
    expect(lockedItem.ocrText).toBe('');
    expect(lockedItem.body).toBe('');
    expect(fs.readdirSync(path.join(dir, 'media'))).toEqual([]);
    expect(cryptoVault.unlockWithPin('1234')).toBe(true);
    const dec2 = cryptoVault.decryptSecret(repo.getRawEncryptedPayload(created2.id)!);
    expect(dec2.secretValue).toBe('[Скриншот в Сейфе]');
  });

  it('queryItems fallback search runs < 15 ms on 1,500 items with ё/е, URL-substring & orbitName recall parity', () => {
    const dir = makeTempDir('kapsula-search-1500-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    const workOrbit = repo.createOrbit({
      name: 'Работа',
      description: 'Рабочие проекты',
      color: '#E86A33',
      icon: 'Briefcase',
    });

    repo.runInTransaction(() => {
      for (let i = 0; i < 1495; i += 1) {
        repo.createItem({
          dna: i % 3 === 0 ? 'link' : 'note',
          orbit: i % 2 === 0 ? workOrbit.id : '',
          modeCaptured: 'autopilot',
          title: `${i % 5 === 0 ? 'Привет! ' : ''}Заметка номер ${i} — рабочий конспект и референсы`,
          body: `Подробное описание задачи №${i} про интерфейс, архитектуру и приёмку. /learn-taste`,
          url: i % 50 === 0 ? `https://www.figma.com/file/kapsulaDesignSystem/${i}` : undefined,
          tags: i % 5 === 0 ? ['работа', 'идеи'] : ['поток'],
          source: 'vault_ui',
          contentHash: `perf-${i}`,
        });
      }
    });
    const edgePromo = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'ПРОМОКОД )(',
      body: 'Скидка для Тинькофф и Photoshop +7 (999) 888-77-66',
      source: 'vault_ui',
      contentHash: 'perf-edge-1',
    });
    const edgeYo = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Ёжик и ёлка в приёмной',
      body: 'Ежегодный отчёт и съёмка макета',
      tags: ['ёлка', 'отчёт'],
      source: 'vault_ui',
      contentHash: 'perf-edge-yo',
    });
    const edgeOrbitOnly = repo.createItem({
      dna: 'note',
      orbit: workOrbit.id,
      modeCaptured: 'autopilot',
      title: 'План на пятницу',
      body: 'Короткая черновая запись без тегов',
      tags: [],
      source: 'vault_ui',
      contentHash: 'perf-edge-orbit',
    });

    // Warmup once, then measure median miss query across 5 runs for single-token, multi-group & repeated-char misses
    repo.queryItems({ search: 'zzzzнесуществующий', limit: 2000 });
    repo.queryItems({ search: 'qwerty!@#asdfg', limit: 2000 });
    for (const missQuery of [
      'zzzzнесуществующий',
      'небывалаястрока12345',
      'фюывлджэ',
      'qwerty!@#asdfg',
      'asdfg!@#qwerty',
      'ghbdtn!@#rfnfstr',
      'ghbdtn rfnfstr',
      'работа nonexistentword',
      'ёёёёёёёёёё',
      'aaaaaaaaaa',
    ]) {
      const samples: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const t0 = performance.now();
        const hits = repo.queryItems({ search: missQuery, limit: 2000 });
        samples.push(performance.now() - t0);
        expect(hits).toHaveLength(0);
      }
      samples.sort((a, b) => a - b);
      expect(samples[2]!).toBeLessThan(process.env.CI ? 40 : 15);
    }

    // Verify 100% recall parity on edge queries, ё/е folding, URL camelCase substrings, and orbitName
    expect(repo.queryItems({ search: 'промокод', limit: 50 }).map((i) => i.id)).toContain(edgePromo.id);
    expect(repo.queryItems({ search: '999888', limit: 50 }).map((i) => i.id)).toContain(edgePromo.id);
    expect(repo.queryItems({ search: '/learn-taste', limit: 50 }).length).toBeGreaterThanOrEqual(1);
    expect(repo.searchNonSecretForAsk('тинькофф', 10).length).toBeGreaterThanOrEqual(1);

    // ё/е bidirectional recall across queryItems & searchNonSecretForAsk
    expect(repo.queryItems({ search: 'еж', limit: 2000 }).map((i) => i.id)).toContain(edgeYo.id);
    expect(repo.queryItems({ search: 'ёж', limit: 2000 }).length).toBe(
      repo.queryItems({ search: 'еж', limit: 2000 }).length
    );
    expect(repo.queryItems({ search: 'ПРИЕМ', limit: 2000 }).map((i) => i.id)).toContain(edgeYo.id);
    for (const askYo of ['ЕЛКА', 'Ежик', 'ОТЧЕТ', 'СЪЕМКА']) {
      expect(repo.searchNonSecretForAsk(askYo, 20).map((i) => i.id)).toContain(edgeYo.id);
    }

    // URL-substring synonym hits must not be dropped when >= 15 FTS5 hits exist
    const designHits = repo.queryItems({ search: 'дизайн', limit: 2000 });
    expect(designHits.some((i) => i.url?.includes('kapsulaDesignSystem'))).toBe(true);
    const uiHits = repo.queryItems({ search: 'ui', limit: 2000 });
    expect(uiHits.some((i) => i.url?.includes('kapsulaDesignSystem'))).toBe(true);

    // orbitName synonym matching in Step 3 (`проект` -> `Работа`)
    const projectHits = repo.queryItems({ search: 'проект', limit: 2000 });
    expect(projectHits.map((i) => i.id)).toContain(edgeOrbitOnly.id);

    // Compiled vs uncompiled parity across tricky queries (incl. swapped layout punctuation)
    const testFields = [
      { title: 'Капсула заметки', tags: ['идея'], body: 'Быстрый поиск Тинькофф, и Figma', isPinned: true },
      { title: 'Ёжик и ёлка', tags: ['отчёт'], body: 'Приёмная съёмка', isPinned: false },
      { title: 'Просто текст', tags: [], body: 'Ничего общего с запросом, запятая внутри', isPinned: false },
    ];
    for (const q of ['капусла', 'прототипирование', 'ghbdtn', '#идея фигма', 'zzzzнесуществующий', 'небывалаястрока12345', 'еж']) {
      const compiled = compileBilingualSearchQuery(q);
      for (const f of testFields) {
        const a = scoreBilingualFields(f, q, { allowFuzzy: true });
        const b = scoreBilingualFieldsCompiled(f, compiled, { allowFuzzy: true });
        expect(Math.round(b)).toBe(Math.round(a));
      }
    }
  });

  it('single-token orbit recall is not truncated at LIMIT 250 when matching orbits exceed 250 items', () => {
    const dir = makeTempDir('kapsula-orbit-recall-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    const workOrbit = repo.createOrbit({
      name: 'Работа',
      description: '',
      color: '#E86A33',
      icon: 'Briefcase',
    });
    const devOrbit = repo.createOrbit({
      name: 'Разработка',
      description: '',
      color: '#3B82F6',
      icon: 'Code',
    });

    const expectedIds: string[] = [];
    repo.runInTransaction(() => {
      for (let i = 0; i < 320; i += 1) {
        const created = repo.createItem({
          dna: 'note',
          orbit: i % 2 === 0 ? workOrbit.id : devOrbit.id,
          modeCaptured: 'autopilot',
          title: `Нейтральный черновик №${i}`,
          body: `Короткая заметка без ключевых слов ${i}`,
          tags: [],
          source: 'vault_ui',
          contentHash: `orbit-recall-${i}`,
        });
        expectedIds.push(created.id);
      }
      // Also add items whose text matches 'работа' so FTS5 returns > 0 rows and exercises the single-token SQL branch
      for (let i = 0; i < 20; i += 1) {
        const created = repo.createItem({
          dna: 'note',
          orbit: '',
          modeCaptured: 'autopilot',
          title: `Работа над задачей ${i}`,
          body: 'Текстовое совпадение',
          tags: [],
          source: 'vault_ui',
          contentHash: `orbit-text-${i}`,
        });
        expectedIds.push(created.id);
      }
    });

    const workResults = repo.queryItems({ search: 'работа', limit: 2000 });
    const workResultIds = new Set(workResults.map((item) => item.id));
    for (const id of expectedIds) {
      expect(workResultIds.has(id)).toBe(true);
    }
  });

  it('preserves Unicode delimiter fuzzy recall, tag nonWordCount parity, prefix multiplicity bounds, #tag boundaries, and raw SQL total_changes() cache invalidation', () => {
    const dir = makeTempDir('kapsula-search-edge-r4-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    // 1. #tag boundary parsing parity
    const c1 = compileBilingualSearchQuery('qwerty!@#asdfg');
    expect(c1.rawTagMatches).toEqual([]);
    expect(c1.groups.map((g) => g.primaryNorm)).toEqual(['qwerty', 'asdfg']);

    const c2 = compileBilingualSearchQuery('ghbdtn!@#rfnfstr');
    expect(c2.rawTagMatches).toEqual([]);
    expect(c2.groups.map((g) => g.primaryNorm)).toEqual(['ghbdtn', 'rfnfstr']);

    const c3 = compileBilingualSearchQuery('#идея фигма');
    expect(c3.rawTagMatches).toEqual(['идея']);
    expect(c3.groups.map((g) => g.primaryNorm)).toEqual(['фигма']);

    const c4 = compileBilingualSearchQuery('фигма #идея');
    expect(c4.rawTagMatches).toEqual(['идея']);
    expect(c4.groups.map((g) => g.primaryNorm)).toEqual(['фигма']);

    const c5 = compileBilingualSearchQuery('Длинная заметка: проект и чек-лист #1');
    expect(c5.rawTagMatches).toEqual([]);
    const numberedNote = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Длинная заметка: проект и чек-лист #1',
      body: 'Проверка нумерованного заголовка без тега #1',
      source: 'vault_ui',
      contentHash: 'numbered-title-1',
    });
    expect(repo.queryItems({ search: 'Длинная заметка: проект и чек-лист #1', limit: 50 }).map((x) => x.id)).toContain(numberedNote.id);

    // 2. Unicode punctuation/emojis adjacent to 1-char index-0 typos
    const unicodeCases: Array<{ title: string; query: string }> = [
      { title: '📌Дизайн', query: 'дизяйн' },
      { title: '“Дизайн”', query: 'визайн' },
      { title: 'Мир…Капусла', query: 'капсула' },
      { title: '•Идея', query: 'одея' },
      { title: '🚀Дизайн', query: 'дизяйн' },
      { title: '•парта для письма', query: 'карта' },
      { title: '→парта для письма', query: 'карта' },
      { title: '“парта” для письма', query: 'карта' },
      { title: '₽парта для письма', query: 'карта' },
      { title: 'тест•парта', query: 'карта' },
    ];
    for (let idx = 0; idx < unicodeCases.length; idx += 1) {
      const tc = unicodeCases[idx]!;
      const created = repo.createItem({
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: tc.title,
        body: '',
        source: 'vault_ui',
        contentHash: `uni-edge-${idx}`,
      });
      const compiled = compileBilingualSearchQuery(tc.query);
      expect(scoreBilingualFields({ title: tc.title }, tc.query, { allowFuzzy: true })).toBeGreaterThan(0);
      expect(scoreBilingualFieldsCompiled({ title: tc.title }, compiled, { allowFuzzy: true })).toBeGreaterThan(0);
      expect(repo.queryItems({ search: tc.query, limit: 200 }).map((x) => x.id)).toContain(created.id);
    }

    // 3. tags_json parity when nonWordCount > maxDist (';;x;\'' tag for query 'жжжэ' -> swapped ';;;\'')
    const tagEdge = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Нейтральный заголовок тега',
      body: 'Без совпадения в тексте',
      source: 'vault_ui',
      contentHash: 'tag-nonword-1',
    });
    repo.db.prepare('UPDATE items SET tags_json = ? WHERE id = ?').run(JSON.stringify([";;x;'"]), tagEdge.id);
    expect(scoreBilingualFields({ title: 'Нейтральный заголовок тега', tags: [";;x;'"] }, 'жжжэ', { allowFuzzy: true })).toBeGreaterThan(0);
    expect(repo.queryItems({ search: 'жжжэ', limit: 50 }).map((x) => x.id)).toContain(tagEdge.id);
    expect(repo.queryItems({ search: 'жжжэ', includePurged: true, limit: 50 }).map((x) => x.id)).toContain(tagEdge.id);

    // 4. Repeated-char & damerauDistanceWithinPrefix boundary checks
    const pHitExact = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'ееееееabcdef',
      body: '',
      source: 'vault_ui',
      contentHash: 'prefix-rep-1',
    });
    const pHitOneEdit = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'ееаеееabcdef',
      body: '',
      source: 'vault_ui',
      contentHash: 'prefix-rep-2',
    });
    const pMissTwoEdits = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'ееаеbеееabе',
      body: '',
      source: 'vault_ui',
      contentHash: 'prefix-rep-3',
    });
    const pMissRepeated = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'ежегодные референсы и перенесение',
      body: '',
      source: 'vault_ui',
      contentHash: 'prefix-rep-4',
    });

    const sixYoHits = repo.queryItems({ search: 'ёёёёёё', limit: 50 }).map((x) => x.id);
    expect(sixYoHits).toContain(pHitExact.id);
    expect(sixYoHits).toContain(pHitOneEdit.id);
    expect(sixYoHits).not.toContain(pMissTwoEdits.id);
    expect(scoreBilingualFields({ title: 'ееаеbеееabе' }, 'ёёёёёё', { allowFuzzy: true })).toBe(0);

    expect(scoreBilingualFields({ title: pMissRepeated.title }, 'ёёёёёёёёёё', { allowFuzzy: true })).toBe(0);
    expect(scoreBilingualFieldsCompiled({ title: pMissRepeated.title }, compileBilingualSearchQuery('ёёёёёёёёёё'), { allowFuzzy: true })).toBe(0);
    expect(repo.queryItems({ search: 'ёёёёёёёёёё', limit: 50 })).toHaveLength(0);

    // 5. Raw SQL INSERT/DELETE cache invalidation via total_changes()
    repo.warmupSearchIndex();
    const rawId = 'raw-sql-item-1';
    const now = Date.now();
    repo.db
      .prepare(
        `INSERT INTO items (id, dna, orbit, mode_captured, title, body, summary, ocr_text, tags_json, source, content_hash, created_at, updated_at)
         VALUES (?, 'note', '', 'autopilot', 'УникальныйСыройSQLТокен', 'Текст', '', '', '[]', 'vault_ui', 'raw-hash-1', ?, ?)`
      )
      .run(rawId, now, now);
    expect(repo.queryItems({ search: 'уникальныйсыройsqlтокен', limit: 50 }).map((x) => x.id)).toContain(rawId);

    repo.db.prepare('DELETE FROM items WHERE id = ?').run(rawId);
    expect(repo.queryItems({ search: 'уникальныйсыройsqlтокен', limit: 50 })).toHaveLength(0);
  });
});
