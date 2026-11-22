import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturePipeline } from '@main/pipeline/capture-pipeline';
import type { VaultRepository } from '@main/db/repository';
import type { VaultCrypto } from '@main/security/vault-crypto';
import type { SettingsState, VaultItem } from '@shared/types';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];
const activeCryptos: VaultCrypto[] = [];

function makeTempDir(prefix = 'kapsula-ipc-contract-'): string {
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
  vi.restoreAllMocks();
});

async function setupIpcHarness(opts?: { ownWebContents?: boolean; allowedSurface?: boolean }) {
  const dir = makeTempDir();
  const handlers = new Map<string, (evt: unknown, ...args: unknown[]) => unknown>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  let clipText = '';
  let saveDialogResult: { canceled: boolean; filePath?: string } = {
    canceled: false,
    filePath: path.join(dir, 'exported-backup.json'),
  };
  let openDialogResult: { canceled: boolean; filePaths: string[] } = {
    canceled: true,
    filePaths: [],
  };

  let isOwn = opts?.ownWebContents ?? true;
  let isAllowed = opts?.allowedSurface ?? true;

  vi.resetModules();
  vi.doMock('electron', () => {
    class MockClipboardItem {
      constructor(public entries: Record<string, unknown>) {}
    }
    return {
      ipcMain: {
        removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
        handle: vi.fn((ch: string, fn: (evt: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(ch, fn);
        }),
      },
      clipboard: {
        write: vi.fn(async (items: MockClipboardItem[]) => {
          const first = items[0]?.entries?.['text/plain'];
          if (typeof first === 'string') clipText = first;
        }),
        writeText: vi.fn((t: string) => {
          clipText = t;
        }),
        readText: vi.fn(() => clipText),
        clear: vi.fn(() => {
          clipText = '';
        }),
      },
      ClipboardItem: MockClipboardItem,
      shell: { openExternal: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
      dialog: {
        showOpenDialog: vi.fn(async () => openDialogResult),
        showSaveDialog: vi.fn(async () => saveDialogResult),
      },
      app: {
        getPath: (name: string) => (name === 'documents' ? dir : dir),
        getName: () => 'Kapsula',
        getAppPath: () => dir,
        isPackaged: false,
        setLoginItemSettings: vi.fn(),
      },
      nativeImage: { createFromPath: vi.fn() },
      desktopCapturer: { getSources: vi.fn(async () => []) },
      systemPreferences: {
        canPromptTouchID: vi.fn(() => false),
        promptTouchID: vi.fn(),
        getMediaAccessStatus: vi.fn(() => 'granted'),
      },
    };
  });

  const { VaultRepository: RepoCtor } = await import('@main/db/repository');
  const { VaultCrypto: CryptoCtor } = await import('@main/security/vault-crypto');
  const { CapturePipeline: PipelineCtor } = await import('@main/pipeline/capture-pipeline');
  const { registerIpcHandlers } = await import('@main/ipc');

  const repo = new RepoCtor(path.join(dir, 'vault.sqlite'));
  openRepos.push(repo);
  const cryptoVault = new CryptoCtor(dir, null);
  activeCryptos.push(cryptoVault);

  let unlocked = true;
  let screenProtected = true;

  const getSettingsState = (): SettingsState => ({
    theme: (repo.getSetting('theme') as 'dark' | 'light') || 'dark',
    locale: repo.getLocale(),
    activeMode: 'autopilot',
    activeFocusBoardId: null,
    aiProvider: 'local',
    monthlyCapUsd: Number(repo.getSetting('monthly_cap_usd') || '5') || 5,
    enableAutoOcr: false,
    enableUrlUnfurl: false,
    clipboardAutoWipeSeconds: Number(repo.getSetting('clipboard_wipe_sec') || '30') || 30,
    hasOpenRouterKey: false,
    hasGoogleAiKey: false,
    hasMasterPin: Boolean(repo.getSetting('master_pin_hash')) || cryptoVault.isPinProtected(),
    vaultUnlocked: unlocked,
    clipperPort: 47831,
    clipperToken: 'tok',
    viewLayout: 'grid',
    launchAtLogin: false,
    soundTickEnabled: false,
    hudShortcut: repo.getSetting('hud_shortcut') || 'Alt+Space',
    snatchShortcut: repo.getSetting('snatch_shortcut') || 'CommandOrControl+Shift+V',
    enableScreenProtection: screenProtected,
  });

  const pipeline: CapturePipeline = new PipelineCtor({
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
    sender: { id: 1, getURL: () => 'http://localhost:5173', mainFrame },
    senderFrame: mainFrame,
  };

  registerIpcHandlers({
    dataDir: dir,
    repo,
    cryptoVault,
    pipeline,
    windows: {
      vault: null,
      hud: null,
      isOwnWebContents: () => isOwn,
      isAllowedSurfaceUrl: () => isAllowed,
      broadcast: vi.fn((channel: string, payload: unknown) => {
        broadcasts.push({ channel, payload });
      }),
      persistOrbPosition: vi.fn(),
      setCaptureMode: vi.fn(),
      setContentProtection: vi.fn((enabled: boolean) => {
        screenProtected = enabled;
      }),
      setVaultBackgroundColor: vi.fn(),
      hideHud: vi.fn(),
      hideHudAndPaste: vi.fn(async () => true),
    } as unknown as Parameters<typeof registerIpcHandlers>[0]['windows'],
    clipper: {} as unknown as Parameters<typeof registerIpcHandlers>[0]['clipper'],
    getSettingsState,
    getApiKeyForProvider: () => null,
    setApiKeyForProvider: vi.fn(),
    setVaultUnlocked: (v: boolean) => {
      unlocked = v;
      if (!v && cryptoVault.isPinProtected()) {
        cryptoVault.lock();
      }
    },
  });

  const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`Missing IPC handler for ${channel}`);
    return (await fn(trustedEvt, ...args)) as T;
  };

  const invokeWithEvent = async <T = unknown>(
    evt: unknown,
    channel: string,
    ...args: unknown[]
  ): Promise<T> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`Missing IPC handler for ${channel}`);
    return (await fn(evt, ...args)) as T;
  };

  return {
    dir,
    repo,
    cryptoVault,
    handlers,
    broadcasts,
    trustedEvt,
    mainFrame,
    getClipText: () => clipText,
    setSaveDialog: (next: { canceled: boolean; filePath?: string }) => {
      saveDialogResult = next;
    },
    setOpenDialog: (next: { canceled: boolean; filePaths: string[] }) => {
      openDialogResult = next;
    },
    setOwnWebContents: (v: boolean) => {
      isOwn = v;
    },
    setAllowedSurface: (v: boolean) => {
      isAllowed = v;
    },
    invoke,
    invokeWithEvent,
  };
}

describe('Wave 0 IPC Contract Suite (Desktop Electron Boundaries)', () => {
  it('rejects untrusted senders and subframes across sensitive handleTrusted channels', async () => {
    const h = await setupIpcHarness();
    const subframeEvt = {
      sender: { id: 1, getURL: () => 'http://localhost:5173', mainFrame: h.mainFrame },
      senderFrame: { url: 'http://localhost:5173/iframe' },
    };

    await expect(h.invokeWithEvent(subframeEvt, 'secret:reveal', 'any')).rejects.toThrow(
      /Недоверенный|Untrusted/i
    );
    await expect(h.invokeWithEvent(subframeEvt, 'vault:capture', { text: 'hi' })).rejects.toThrow(
      /Недоверенный|Untrusted/i
    );

    h.setOwnWebContents(false);
    await expect(h.invoke('settings:update', { theme: 'light' })).rejects.toThrow(
      /Недоверенный|Untrusted/i
    );
    await expect(h.invoke('vault:export-backup')).rejects.toThrow(/Недоверенный|Untrusted/i);

    h.setOwnWebContents(true);
    h.setAllowedSurface(false);
    await expect(h.invoke('vault:purge-item', 'id-1')).rejects.toThrow(/Недоверенный|Untrusted/i);
  });

  it('exercises full Vault item lifecycle and JSON backup export (cancelled + saved)', async () => {
    const h = await setupIpcHarness();

    const captured = await h.invoke<VaultItem>('vault:capture', {
      text: 'Заметка через IPC\n- [ ] Сделать задачу',
      title: 'IPC Заметка',
      source: 'vault_ui',
    });
    expect(captured.title).toBe('IPC Заметка');

    const queried = await h.invoke<VaultItem[]>('vault:query', { search: 'IPC Заметка' });
    expect(queried.some((it) => it.id === captured.id)).toBe(true);

    const updated = await h.invoke<VaultItem | null>('vault:update-item', captured.id, {
      title: 'IPC Заметка v2',
      isPinned: true,
    });
    expect(updated?.title).toBe('IPC Заметка v2');
    expect(updated?.isPinned).toBe(true);

    // Export backup cancelled -> canceled: true
    h.setSaveDialog({ canceled: true });
    const cancelledExport = await h.invoke<{ canceled: boolean; itemCount: number }>(
      'vault:export-backup'
    );
    expect(cancelledExport.canceled).toBe(true);

    // Export backup saved -> excludes secrets, writes valid kapsula-backup JSON
    const backupFile = path.join(h.dir, 'kapsula-backup-test.json');
    h.setSaveDialog({ canceled: false, filePath: backupFile });
    const savedExport = await h.invoke<{ canceled: boolean; itemCount: number; filePath: string }>(
      'vault:export-backup'
    );
    expect(savedExport.canceled).toBe(false);
    expect(savedExport.itemCount).toBe(1);
    const parsedBackup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    expect(parsedBackup.format).toBe('kapsula-backup');
    expect(parsedBackup.items).toHaveLength(1);

    // Soft-delete -> restore -> soft-delete -> empty trash / purge
    expect(await h.invoke<boolean>('vault:delete-item', captured.id)).toBe(true);
    const restored = await h.invoke<VaultItem | null>('vault:restore-item', captured.id);
    expect(restored?.deletedAt).toBeNull();

    expect(await h.invoke<boolean>('vault:delete-item', captured.id)).toBe(true);
    const emptied = await h.invoke<{ purgedCount: number }>('vault:empty-trash');
    expect(emptied.purgedCount).toBe(1);

    // Direct purge on another item
    const second = await h.invoke<VaultItem>('vault:capture', {
      text: 'На полное удаление',
      title: 'Удалить сразу',
      source: 'vault_ui',
    });
    expect(await h.invoke<boolean>('vault:purge-item', second.id)).toBe(true);
    expect(h.repo.getItemById(second.id, { includeDeleted: true })).toBeNull();
  });

  it('enforces secret PIN lock gates across reveal, update-structured, copy-field, and empty-trash', async () => {
    const h = await setupIpcHarness();

    const secret = await h.invoke<VaultItem>('secret:save-structured', {
      kind: 'password',
      title: 'AWS Console',
      service: 'AWS',
      login: 'ops@kapsula.app',
      secretValue: 'SecretPass!2026',
      totpUriOrSecret: 'JBSWY3DPEHPK3PXP',
    });
    expect(secret.dna).toBe('secret');

    const revealed = await h.invoke<{ secretValue: string; login: string } | null>(
      'secret:reveal',
      secret.id
    );
    expect(revealed?.secretValue).toBe('SecretPass!2026');

    const updatedSecret = await h.invoke<VaultItem>('secret:update-structured', {
      id: secret.id,
      kind: 'password',
      title: 'AWS Prod',
      service: 'AWS',
      login: 'prod@kapsula.app',
      secretValue: 'RotatedPass!2026',
      totpUriOrSecret: 'JBSWY3DPEHPK3PXP',
    });
    expect(updatedSecret.title).toBe('AWS Prod');

    // Copy password & valid TOTP while unlocked
    const copyPwd = await h.invoke<{ ok: boolean }>('secret:copy-field', secret.id, 'secretValue');
    expect(copyPwd.ok).toBe(true);
    expect(h.getClipText()).toBe('RotatedPass!2026');

    const copyTotp = await h.invoke<{ ok: boolean }>('secret:copy-field', secret.id, 'totp');
    expect(copyTotp.ok).toBe(true);
    expect(h.getClipText()).toMatch(/^\d{6}$/);

    // Missing ID on update-structured must fail cleanly
    await expect(
      h.invoke('secret:update-structured', {
        kind: 'password',
        service: 'X',
        secretValue: 'Y',
      })
    ).rejects.toThrow(/идентификатор|missing/i);

    // Enable Master PIN -> lock -> verify fail-closed gates
    expect(await h.invoke<boolean>('secret:set-pin', '9472')).toBe(true);
    expect(await h.invoke<boolean>('secret:lock')).toBe(true);

    await expect(h.invoke('secret:reveal', secret.id)).rejects.toThrow(/заблокирован|locked/i);
    await expect(
      h.invoke('secret:update-structured', {
        id: secret.id,
        kind: 'password',
        service: 'AWS',
        secretValue: 'Blocked',
      })
    ).rejects.toThrow(/заблокирован|locked/i);

    const lockedCopy = await h.invoke<{ ok: boolean; locked?: boolean }>(
      'secret:copy-field',
      secret.id,
      'secretValue'
    );
    expect(lockedCopy.ok).toBe(false);
    expect(lockedCopy.locked).toBe(true);

    // Unlock with valid PIN (including whitespace trimming on modern 2-tier PIN)
    expect(await h.invoke<boolean>('secret:unlock-pin', '0000')).toBe(false);
    expect(await h.invoke<boolean>('secret:unlock-pin', '  9472  ')).toBe(true);
    const revealedAfter = await h.invoke<{ secretValue: string } | null>('secret:reveal', secret.id);
    expect(revealedAfter?.secretValue).toBe('RotatedPass!2026');

    // Trashed secret blocks empty-trash while locked
    await h.invoke('vault:delete-item', secret.id);
    await h.invoke('secret:lock');
    await expect(h.invoke('vault:empty-trash')).rejects.toThrow(/мастер-кодом|master PIN/i);
  });

  it('wires orbits, focus boards, tasks (including sequential moves on shared note), calendar, and settings error handling', async () => {
    const h = await setupIpcHarness();

    // Orbits & Focus Boards
    const orb1 = await h.invoke<{ id: string; name: string }>('orbit:create', {
      name: 'Дизайн',
      description: 'Макеты',
    });
    const orb2 = await h.invoke<{ id: string; name: string }>('orbit:create', {
      name: 'Код',
      description: 'Архитектура',
    });
    await h.invoke('orbit:update', orb1.id, { name: 'UI Дизайн' });
    const reorderedOrbits = await h.invoke<Array<{ id: string }>>('orbit:reorder', [orb2.id, orb1.id]);
    expect(reorderedOrbits.map((o) => o.id).slice(0, 2)).toEqual([orb2.id, orb1.id]);
    expect(await h.invoke<boolean>('orbit:delete', orb2.id)).toBe(true);

    const board = await h.invoke<{ id: string }>('focus:create', 'Спринт');
    await h.invoke('focus:update', board.id, { name: 'Спринт 2' });
    await h.invoke('focus:set-active', board.id);
    await h.invoke('focus:reorder', [board.id]);
    expect(await h.invoke<boolean>('focus:delete', board.id)).toBe(true);

    // Tasks + sequential move-on-board preserving both tasks' mediaMeta
    const taskNote = await h.invoke<VaultItem>('vault:capture', {
      text: '- [ ] Задача А\n- [ ] Задача Б',
      title: 'План задач',
      source: 'vault_ui',
    });
    const tasks = await h.invoke<Array<{ id: string; taskKey: string }>>('vault:list-tasks');
    expect(tasks).toHaveLength(2);

    await h.invoke('tasks:move-on-board', {
      itemId: taskNote.id,
      taskKey: 'md:0',
      columnId: 'in_progress',
      boardOrder: 100,
    });
    const afterSecondMove = await h.invoke<VaultItem>('tasks:move-on-board', {
      itemId: taskNote.id,
      taskKey: 'md:1',
      columnId: 'in_progress',
      boardOrder: 200,
    });
    expect(afterSecondMove.mediaMeta?.taskMeta?.['md:0']?.columnId).toBe('in_progress');
    expect(afterSecondMove.mediaMeta?.taskMeta?.['md:1']?.columnId).toBe('in_progress');

    await h.invoke('tasks:update-text', {
      itemId: taskNote.id,
      taskKey: 'md:0',
      text: 'Задача А (обновлена)',
    });
    await h.invoke('tasks:update-meta', {
      itemId: taskNote.id,
      taskKey: 'md:0',
      priority: 'high',
    });
    await h.invoke('vault:toggle-task', {
      itemId: taskNote.id,
      sourceType: 'markdown',
      taskIndex: 0,
      done: true,
    });
    await h.invoke('tasks:delete', { itemId: taskNote.id, taskKey: 'md:0' });
    const cols = await h.invoke<Array<{ id: string; title: string }>>('tasks:list-columns');
    expect(cols.length).toBeGreaterThanOrEqual(2);

    // Calendar IPC + ICS import/export + natural date parse
    const start = new Date(2026, 10, 23, 12, 0, 0, 0).getTime();
    const ev = await h.invoke<{ id: string; title: string }>('calendar:upsert', {
      title: 'Созвон по релизу',
      startAt: start,
      endAt: start + 3_600_000,
    });
    expect((await h.invoke<Array<{ id: string }>>('calendar:list')).some((x) => x.id === ev.id)).toBe(
      true
    );
    const parsedDate = await h.invoke<{ label: string } | null>('calendar:parse-date', 'завтра в 10:00');
    expect(parsedDate).not.toBeNull();

    const icsOutPath = path.join(h.dir, 'cal-export.ics');
    h.setSaveDialog({ canceled: false, filePath: icsOutPath });
    const exportedIcs = await h.invoke<{ exported: number; path: string | null }>('calendar:export-ics');
    expect(exportedIcs.exported).toBe(1);
    expect(fs.existsSync(icsOutPath)).toBe(true);

    expect(await h.invoke<boolean>('calendar:delete', ev.id)).toBe(true);
    const importedIcs = await h.invoke<{ imported: number }>(
      'calendar:import-ics',
      fs.readFileSync(icsOutPath, 'utf8')
    );
    expect(importedIcs.imported).toBe(1);

    // Settings valid + validation errors
    const nextSettings = await h.invoke<SettingsState>('settings:update', {
      theme: 'light',
      monthlyCapUsd: 9,
      clipboardAutoWipeSeconds: 45,
    });
    expect(nextSettings.theme).toBe('light');
    expect(nextSettings.monthlyCapUsd).toBe(9);
    expect(nextSettings.clipboardAutoWipeSeconds).toBe(45);

    await expect(h.invoke('settings:update', { hudShortcut: 'Space' })).rejects.toThrow(
      /модификатором|modifier/i
    );
    await expect(
      h.invoke('settings:update', { hudShortcut: 'CommandOrControl+Shift+V' })
    ).rejects.toThrow(/совпадать|same/i);
    await expect(
      h.invoke('settings:update', { emailInboundWebhookUrl: 'http://insecure.local/hook' })
    ).rejects.toThrow(/https:\/\//i);
  });

  it(
    '[Wave 2: BUG-M01] secret:unlock-pin trims leading/trailing whitespace on legacy master_pin_hash verification path too',
    async () => {
      const h = await setupIpcHarness();
      const { VaultCrypto: CryptoCtor } = await import('@main/security/vault-crypto');
      // Simulate legacy DB-only PIN hash before 2-tier PIN-KEK migration
      h.repo.setSetting('master_pin_hash', CryptoCtor.hashPin('9472'));
      expect(h.cryptoVault.isPinProtected()).toBe(false);

      const unlocked = await h.invoke<boolean>('secret:unlock-pin', '  9472  ');
      expect(unlocked).toBe(true);
    }
  );

  it(
    '[Wave 2: BUG-M01] secret:copy-field returns { ok: false } gracefully when stored TOTP Base32 seed is malformed',
    async () => {
      const h = await setupIpcHarness();
      const badTotpSecret = h.repo.createItem({
        dna: 'secret',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Corrupt TOTP',
        body: '🔒 Зашифровано в Сейфе',
        encryptedPayload: h.cryptoVault.encryptSecret({
          service: 'Corrupt',
          login: 'u',
          secretValue: 'pw',
          notes: '',
          totpSecret: '!!!NOT_VALID_BASE32!!!',
        }),
        secretMeta: {
          kind: 'password',
          service: 'Corrupt',
          loginHint: 'u',
          hasLogin: true,
          hasTotp: true,
        },
        source: 'vault_ui',
        contentHash: 'corrupt-totp-hash',
      });

      const res = await h.invoke<{ ok: boolean }>('secret:copy-field', badTotpSecret.id, 'totp');
      expect(res.ok).toBe(false);
    }
  );
});
