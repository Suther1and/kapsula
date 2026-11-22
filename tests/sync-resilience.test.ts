import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SyncBlobRow,
  SyncKeyEnvelopeRow,
  SyncRecordRow,
} from '@shared/sync-contract';
import { VaultRepository } from '@main/db/repository';
import { VaultCrypto } from '@main/security/vault-crypto';
import { SyncEngine } from '@main/sync/sync-engine';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];
const activeEngines: SyncEngine[] = [];
const activeCryptos: VaultCrypto[] = [];

function makeTempDir(prefix = 'kapsula-sync-resilience-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (activeEngines.length > 0) {
    try {
      activeEngines.pop()!.dispose();
    } catch {
      // ignore
    }
  }
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
});

class FaultInjectableSupabaseCloud {
  public seq = 0;
  public users = new Map<string, { id: string; email: string; password: string }>();
  public envelopes = new Map<string, SyncKeyEnvelopeRow>();
  public records = new Map<string, SyncRecordRow>(); // `${user_id}:${entity_type}:${entity_id}`
  public blobs = new Map<string, SyncBlobRow>();
  public devices = new Map<string, Record<string, unknown>>();
  public storageObjects = new Map<string, Buffer>();

  // Fault injection hooks
  public failPullOnGtSeq: number | null = null;
  public failAllPulls = false;
  public returnEmptyOnNextSyncRecordUpsert = false;
  public onNextStorageDownload: (() => Promise<void>) | null = null;
  public onNextRecordsPull: (() => Promise<void>) | null = null;

  public createClientForDevice(): SupabaseClient {
    let currentUser: { id: string; email: string } | null = null;
    const cloud = this;

    const auth = {
      async getSession() {
        return {
          data: { session: currentUser ? { user: currentUser, access_token: 'tok' } : null },
          error: null,
        };
      },
      async signUp({ email, password }: { email: string; password: string }) {
        const clean = email.toLowerCase();
        if (cloud.users.has(clean)) {
          return { data: { user: null, session: null }, error: { message: 'User already registered' } };
        }
        const id = `11111111-2222-3333-4444-${String(cloud.users.size + 1).padStart(12, '0')}`;
        const user = { id, email: clean, password };
        cloud.users.set(clean, user);
        currentUser = { id: user.id, email: user.email };
        return { data: { user: currentUser, session: { user: currentUser } }, error: null };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const user = cloud.users.get(email.toLowerCase());
        if (!user || user.password !== password) {
          return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
        }
        currentUser = { id: user.id, email: user.email };
        return { data: { user: currentUser, session: { user: currentUser } }, error: null };
      },
      async signOut() {
        currentUser = null;
        return { error: null };
      },
    };

    const from = (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      let gtSeqVal: number | null = null;
      let orderCol: string | null = null;
      let orderAsc = true;
      let lim: number | null = null;

      const getSource = (): any[] => {
        if (table === 'sync_key_envelopes') return Array.from(cloud.envelopes.values());
        if (table === 'sync_records') return Array.from(cloud.records.values());
        if (table === 'sync_blobs') return Array.from(cloud.blobs.values());
        if (table === 'sync_devices') return Array.from(cloud.devices.values());
        return [];
      };

      const runSelect = async () => {
        if (table === 'sync_records') {
          if (cloud.failAllPulls) {
            return { data: null, error: { message: 'fetch failed: ECONNRESET' } };
          }
          if (
            cloud.failPullOnGtSeq !== null &&
            gtSeqVal !== null &&
            gtSeqVal >= cloud.failPullOnGtSeq
          ) {
            return { data: null, error: { message: 'fetch failed: ETIMEDOUT on page 2' } };
          }
          if (cloud.onNextRecordsPull) {
            const hook = cloud.onNextRecordsPull;
            cloud.onNextRecordsPull = null;
            await hook();
          }
        }
        let out = getSource().filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          out.sort((a, b) => {
            const va = a[col];
            const vb = b[col];
            if (va === vb) return 0;
            return (va > vb ? 1 : -1) * (orderAsc ? 1 : -1);
          });
        }
        if (lim !== null) out = out.slice(0, lim);
        return { data: out, error: null };
      };

      const selectBuilder: any = {
        select: () => selectBuilder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return selectBuilder;
        },
        gt: (col: string, val: number) => {
          if (col === 'server_seq') gtSeqVal = val;
          filters.push((r) => Number(r[col] ?? 0) > val);
          return selectBuilder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return selectBuilder;
        },
        limit: (n: number) => {
          lim = n;
          return selectBuilder;
        },
        async maybeSingle() {
          const res = await runSelect();
          return { data: res.data?.[0] ?? null, error: res.error };
        },
        then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
          return runSelect().then(resolve, reject);
        },
      };

      const upsert = (row: any) => {
        let resultData: any[] | null = null;
        let resultError: any = null;

        if (table === 'sync_key_envelopes') {
          cloud.envelopes.set(row.user_id, {
            ...row,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          resultData = [cloud.envelopes.get(row.user_id)];
        } else if (table === 'sync_records') {
          if (cloud.returnEmptyOnNextSyncRecordUpsert) {
            cloud.returnEmptyOnNextSyncRecordUpsert = false;
            resultData = [];
          } else {
            const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
            cloud.seq += 1;
            const next: SyncRecordRow = {
              ...row,
              server_seq: cloud.seq,
              server_updated_at: new Date().toISOString(),
            };
            cloud.records.set(key, next);
            resultData = [{ ...next }];
          }
        } else if (table === 'sync_blobs') {
          const saved = { ...row, created_at: new Date().toISOString() };
          cloud.blobs.set(`${row.user_id}:${row.blob_id}`, saved);
          resultData = [saved];
        } else if (table === 'sync_devices') {
          cloud.devices.set(`${row.user_id}:${row.device_id}`, { ...row });
          resultData = [{ ...row }];
        }

        const response = { data: resultData, error: resultError };
        const upsertBuilder: any = {
          select: () => Promise.resolve(response),
          then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
            return Promise.resolve({ error: resultError }).then(resolve, reject);
          },
        };
        return upsertBuilder;
      };

      const insert = async (row: any) => {
        if (table === 'sync_key_envelopes') {
          cloud.envelopes.set(row.user_id, {
            ...row,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          return { data: [cloud.envelopes.get(row.user_id)], error: null };
        }
        return upsert(row);
      };

      return { select: () => selectBuilder, insert, upsert };
    };

    const storage = {
      from: (bucket: string) => ({
        async upload(objectPath: string, body: Buffer | Uint8Array) {
          cloud.storageObjects.set(`${bucket}/${objectPath}`, Buffer.from(body));
          return { data: { path: objectPath }, error: null };
        },
        async download(objectPath: string) {
          if (cloud.onNextStorageDownload) {
            const hook = cloud.onNextStorageDownload;
            cloud.onNextStorageDownload = null;
            await hook();
          }
          const buf = cloud.storageObjects.get(`${bucket}/${objectPath}`);
          if (!buf) return { data: null, error: { message: 'Object not found' } };
          return {
            data: {
              async arrayBuffer() {
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
              },
            },
            error: null,
          };
        },
      }),
    };

    return { auth, from, storage } as unknown as SupabaseClient;
  }
}

function createDevice(
  cloud: FaultInjectableSupabaseCloud,
  name: string,
  callbacks?: ConstructorParameters<typeof SyncEngine>[0]['callbacks']
) {
  const dir = makeTempDir(`kapsula-dev-${name}-`);
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  openRepos.push(repo);
  const vaultCrypto = new VaultCrypto(dir, null);
  activeCryptos.push(vaultCrypto);
  const engine = new SyncEngine({
    dataDir: dir,
    mediaDir,
    repo,
    vaultCrypto,
    deviceName: name,
    kdfIterationsOverride: 5_000,
    disableTimers: true,
    disableRealtime: true,
    callbacks,
  });
  activeEngines.push(engine);
  (engine as unknown as { client: SupabaseClient }).client = cloud.createClientForDevice();
  return { dir, mediaDir, repo, vaultCrypto, engine };
}

describe('Wave 0 Sync Resilience & Fault-Injection Suite', () => {
  it('syncs records between two devices and handles offline pull failures without corrupting local state', async () => {
    const cloud = new FaultInjectableSupabaseCloud();
    const devA = createDevice(cloud, 'PC-A');
    const devB = createDevice(cloud, 'PC-B');

    await devA.engine.signUp('sync-happy@kapsula.app', 'Password123!');
    await devA.engine.setupPassphrase('passphrase-alpha-9');

    devA.repo.createItem({
      id: 'sync-note-1',
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Синхронная заметка',
      body: 'Тело заметки',
      source: 'vault_ui',
      contentHash: 'sync-note-1-hash',
    });
    const pushRes = await devA.engine.syncNow();
    expect(pushRes.ok).toBe(true);

    await devB.engine.signIn('sync-happy@kapsula.app', 'Password123!');
    await devB.engine.unlockWithPassphrase('passphrase-alpha-9');
    expect(devB.repo.getItemById('sync-note-1')?.title).toBe('Синхронная заметка');

    // Network failure during pull transitions safely to offline without wiping existing items
    cloud.failAllPulls = true;
    const offlineRes = await devB.engine.syncNow();
    expect(offlineRes.ok).toBe(false);
    expect(offlineRes.status.state).toBe('offline');
    expect(devB.repo.getItemById('sync-note-1')?.title).toBe('Синхронная заметка');
  });

  it('isolates a single corrupt ciphertext row during pull so valid records on the same page still apply', async () => {
    const cloud = new FaultInjectableSupabaseCloud();
    const devA = createDevice(cloud, 'PC-A');
    const devB = createDevice(cloud, 'PC-B');

    await devA.engine.signUp('corrupt-row@kapsula.app', 'Password123!');
    await devA.engine.setupPassphrase('passphrase-beta-9');

    devA.repo.createItem({
      id: 'valid-sync-item',
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Валидная заметка',
      body: 'Целая запись',
      source: 'vault_ui',
      contentHash: 'valid-hash',
    });
    await devA.engine.syncNow();

    // Inject one corrupt row alongside valid record for user
    const userId = devA.engine.getStatus().userId!;
    cloud.seq += 1;
    cloud.records.set(`${userId}:item:corrupt-item-id`, {
      user_id: userId,
      entity_type: 'item',
      entity_id: 'corrupt-item-id',
      updated_at: Date.now(),
      deleted_at: null,
      sync_version: 1,
      device_id: 'remote-bad-dev',
      schema_version: 1,
      payload_ciphertext: 'not-valid-base64-cipher',
      payload_iv: '0000',
      payload_tag: '0000',
      server_seq: cloud.seq,
    });

    await devB.engine.signIn('corrupt-row@kapsula.app', 'Password123!');
    const unlockRes = await devB.engine.unlockWithPassphrase('passphrase-beta-9');
    expect(unlockRes.ok).toBe(false); // reports recordError
    expect(devB.repo.getItemById('valid-sync-item')?.title).toBe('Валидная заметка');
  });

  it('cooperates when reconcileFull() is invoked during an active syncNow()', async () => {
    const cloud = new FaultInjectableSupabaseCloud();
    const devA = createDevice(cloud, 'PC-A');
    const devB = createDevice(cloud, 'PC-B');

    await devA.engine.signUp('reconcile@kapsula.app', 'Password123!');
    await devA.engine.setupPassphrase('passphrase-gamma-9');
    await devB.engine.signIn('reconcile@kapsula.app', 'Password123!');
    await devB.engine.unlockWithPassphrase('passphrase-gamma-9');

    devA.repo.createItem({
      id: 'late-reconcile-note',
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'После полного реконсила',
      body: 'Данные',
      source: 'vault_ui',
      contentHash: 'late-reconcile-hash',
    });
    await devA.engine.syncNow();

    let releaseFirstPull!: () => void;
    const firstPullGate = new Promise<void>((res) => {
      releaseFirstPull = res;
    });
    cloud.onNextRecordsPull = () => firstPullGate;

    const inFlightSync = devB.engine.syncNow();
    const reconcilePromise = devB.engine.reconcileFull();

    // Release first pull; reconcileFull should wait for full reconcile completion
    releaseFirstPull();
    await inFlightSync;
    const finalStatus = await reconcilePromise;

    expect(finalStatus.lastReconcileAt).toBeTypeOf('number');
    expect(devB.repo.getItemById('late-reconcile-note')?.title).toBe('После полного реконсила');
  });

  it(
    '[Wave 1: SYNC-01 / Decision #2] wipes local user data on signOut() and never leaks/uploads Account A items into Account B',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const dev = createDevice(cloud, 'Shared-PC');

      // Account A signs in, creates note + secret + orbit + calendar event, syncs
      await dev.engine.signUp('account-a@kapsula.app', 'PasswordA123!');
      await dev.engine.setupPassphrase('passphrase-a-99');
      const userAId = dev.engine.getStatus().userId!;

      const orbitA = dev.repo.createOrbit({ name: 'Секция А', description: 'Личное А' });
      dev.repo.createItem({
        id: 'acct-a-note',
        dna: 'note',
        orbit: orbitA.id,
        modeCaptured: 'autopilot',
        title: 'Секретная заметка А',
        body: 'Приватный текст А',
        source: 'vault_ui',
        contentHash: 'acct-a-note-hash',
      });
      dev.repo.createItem({
        id: 'acct-a-secret',
        dna: 'secret',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Пароль А',
        body: '🔒 Зашифровано в Сейфе',
        encryptedPayload: dev.vaultCrypto.encryptSecret({
          service: 'BankA',
          login: 'a@bank.com',
          secretValue: 'secret-a',
          notes: '',
        }),
        secretMeta: { kind: 'password', service: 'BankA', loginHint: 'a***', hasLogin: true },
        source: 'vault_ui',
        contentHash: 'acct-a-secret-hash',
      });
      await dev.engine.syncNow();

      // Account A signs out -> Locked Decision #2 requires wiping local user data
      await dev.engine.signOut();
      expect(dev.repo.getItemById('acct-a-note')).toBeNull();
      expect(dev.repo.getItemById('acct-a-secret')).toBeNull();

      // Account B signs up and syncs on the same device
      await dev.engine.signUp('account-b@kapsula.app', 'PasswordB123!');
      await dev.engine.setupPassphrase('passphrase-b-99');
      const userBId = dev.engine.getStatus().userId!;
      expect(userBId).not.toBe(userAId);
      await dev.engine.syncNow();

      const accountBCloudRecords = Array.from(cloud.records.values()).filter(
        (r) => r.user_id === userBId
      );
      expect(accountBCloudRecords.some((r) => r.entity_id === 'acct-a-note')).toBe(false);
      expect(accountBCloudRecords.some((r) => r.entity_id === 'acct-a-secret')).toBe(false);
    }
  );

  it(
    '[Wave 2: SYNC-04] emits UI batch/upsert callbacks even when pull page 2 throws a network error after page 1 committed to SQLite',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const devA = createDevice(cloud, 'PC-A');
      const onBatchSynced = vi.fn();
      const onItemUpserted = vi.fn();
      const devB = createDevice(cloud, 'PC-B', { onBatchSynced, onItemUpserted });

      await devA.engine.signUp('multipage@kapsula.app', 'Password123!');
      await devA.engine.setupPassphrase('passphrase-mp-9');

      // Seed 205 items so pull requires page 1 (200 rows) + page 2 (5 rows)
      (devA.repo as unknown as { inTx: <T>(fn: () => T) => T }).inTx(() => {
        for (let i = 0; i < 205; i += 1) {
          devA.repo.createItem({
            id: `mp-item-${i}`,
            dna: 'note',
            orbit: '',
            modeCaptured: 'autopilot',
            title: `Страница ${i}`,
            body: `Текст ${i}`,
            source: 'vault_ui',
            contentHash: `mp-hash-${i}`,
          });
        }
      });
      await devA.engine.syncNow();

      // Connect Device B without triggering initial pull yet, then inject page-2 failure
      await devB.engine.signIn('multipage@kapsula.app', 'Password123!');
      cloud.failPullOnGtSeq = 200;

      const res = await devB.engine.unlockWithPassphrase('passphrase-mp-9');
      expect(res.ok).toBe(false);

      // Page 1 rows were committed to SQLite, so UI notification must still fire
      expect(devB.repo.getStats().total).toBeGreaterThanOrEqual(200);
      expect(onBatchSynced.mock.calls.length + onItemUpserted.mock.calls.length).toBeGreaterThan(0);
    }
  );

  it(
    '[Wave 2: SYNC-04] aborts stale SQLite write if signOut() happens mid-pull while media download is awaiting',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const devA = createDevice(cloud, 'PC-A');
      const devB = createDevice(cloud, 'PC-B');

      await devA.engine.signUp('midpull@kapsula.app', 'Password123!');
      await devA.engine.setupPassphrase('passphrase-mid-9');
      await devB.engine.signIn('midpull@kapsula.app', 'Password123!');
      await devB.engine.unlockWithPassphrase('passphrase-mid-9');

      fs.writeFileSync(path.join(devA.mediaDir, 'slow.png'), Buffer.from('FAKE-PNG-SLOW'));
      devA.repo.createItem({
        id: 'slow-media-item',
        dna: 'shot',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Медленное фото',
        imagePath: 'slow.png',
        source: 'vault_ui',
        contentHash: 'slow-media-hash',
      });
      await devA.engine.syncNow();

      let releaseDownload!: () => void;
      const downloadEntered = new Promise<void>((resEntered) => {
        cloud.onNextStorageDownload = () => {
          resEntered();
          return new Promise<void>((resDone) => {
            releaseDownload = resDone;
          });
        };
      });

      const pullPromise = devB.engine.syncNow();
      await downloadEntered;

      // User signs out while media blob download is still pending
      await devB.engine.signOut();
      releaseDownload();
      await pullPromise;

      expect(devB.repo.getItemById('slow-media-item')).toBeNull();
    }
  );

  it(
    '[Wave 2: SYNC-M03] preserves sync_dirty when sync_records upsert().select() returns an empty/null row',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const dev = createDevice(cloud, 'PC-NullReturn');

      await dev.engine.signUp('nullret@kapsula.app', 'Password123!');
      await dev.engine.setupPassphrase('passphrase-nr-9');

      dev.repo.createItem({
        id: 'null-upsert-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Не подтверждено сервером',
        body: 'Должно остаться в dirty',
        source: 'vault_ui',
        contentHash: 'null-upsert-hash',
      });

      cloud.returnEmptyOnNextSyncRecordUpsert = true;
      await dev.engine.syncNow();

      expect(
        dev.repo.listDirtyEntities().some((d) => d.entityId === 'null-upsert-item')
      ).toBe(true);
    }
  );

  it(
    '[Wave 2: SYNC-M01] pulls newer cloud updates even when row.device_id matches local deviceId (backup restore scenario)',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const devA = createDevice(cloud, 'PC-Backup');

      await devA.engine.signUp('backup@kapsula.app', 'Password123!');
      await devA.engine.setupPassphrase('passphrase-bk-9');

      // Snapshot local DB before item exists, or push newer item from same deviceId
      const item = devA.repo.createItem({
        id: 'same-dev-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Восстановленная заметка',
        body: 'Более новая облачная версия',
        source: 'vault_ui',
        contentHash: 'same-dev-hash',
      });
      await devA.engine.syncNow();

      // Simulate restoring an older local DB backup that still has the exact same deviceId and older cursor=0
      devA.repo.db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
      devA.repo.db.prepare('DELETE FROM items_fts WHERE id = ?').run(item.id);
      devA.repo.setSyncState('last_cursor', '0');

      await devA.engine.syncNow({ forceFullReconcile: true });
      expect(devA.repo.getItemById('same-dev-item')?.title).toBe('Восстановленная заметка');
    }
  );

  it(
    '[Wave 2: SYNC-03] creates sync_conflict revision when concurrent remote edit updates title/tags with identical body',
    async () => {
      const cloud = new FaultInjectableSupabaseCloud();
      const devA = createDevice(cloud, 'PC-A');
      const devB = createDevice(cloud, 'PC-B');

      await devA.engine.signUp('conflict@kapsula.app', 'Password123!');
      await devA.engine.setupPassphrase('passphrase-cf-9');

      devA.repo.createItem({
        id: 'conflict-title-item',
        dna: 'note',
        orbit: '',
        modeCaptured: 'autopilot',
        title: 'Исходный заголовок',
        body: 'Одинаковое тело',
        tags: ['тег1'],
        source: 'vault_ui',
        contentHash: 'conflict-title-hash',
      });
      await devA.engine.syncNow();

      await devB.engine.signIn('conflict@kapsula.app', 'Password123!');
      await devB.engine.unlockWithPassphrase('passphrase-cf-9');

      // Device A edits ONLY title/tags (keeping identical body) locally
      devA.repo.updateItem('conflict-title-item', {
        title: 'Локальный заголовок А (потеряется без снимка)',
        tags: ['локальный'],
      });

      // Device B edits ONLY title/tags later and pushes first (wins LWW)
      await new Promise((r) => setTimeout(r, 10));
      devB.repo.updateItem('conflict-title-item', {
        title: 'Победивший заголовок Б',
        tags: ['удалённый'],
      });
      await devB.engine.syncNow();

      // Device A pulls -> loses LWW on title/tags; losing local title must be saved in sync_conflict revision!
      await devA.engine.syncNow();
      expect(devA.repo.getItemById('conflict-title-item')?.title).toBe('Победивший заголовок Б');
      const revisions = devA.repo.listItemRevisions('conflict-title-item');
      expect(
        revisions.some(
          (r) =>
            r.source === 'sync_conflict' &&
            r.title === 'Локальный заголовок А (потеряется без снимка)'
        )
      ).toBe(true);
    }
  );
});
