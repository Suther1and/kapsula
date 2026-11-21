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

function makeTempDir(prefix: string): string {
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

/**
 * Postgres-trigger-accurate in-memory Supabase cloud simulator:
 * - Implements live `bump_sync_record_seq` LWW silent-drop semantics (when NEW.updated_at < OLD.updated_at,
 *   returns OLD unchanged with HTTP 200 `{ data: [OLD], error: null }` and does NOT bump `server_seq`!)
 * - Chains `.upsert(row).select('server_seq, updated_at, sync_version, deleted_at, device_id')`
 * - Supports simulating Postgres `23514` (`sync_records_entity_type_check`) on optional entity types
 * - Supports injecting out-of-order MVCC `server_seq` gaps
 */
class TriggerAccurateSupabaseCloud {
  public seq = 0;
  public users = new Map<string, { id: string; email: string; password: string }>();
  public envelopes = new Map<string, SyncKeyEnvelopeRow>();
  public records = new Map<string, SyncRecordRow>(); // `${user_id}:${entity_type}:${entity_id}`
  public blobs = new Map<string, SyncBlobRow>();
  public devices = new Map<string, Record<string, unknown>>();
  public storageObjects = new Map<string, Buffer>();
  public rejectEntityTypesWith23514 = new Set<string>();
  public silentDropCount = 0;
  public upsertCalls: Array<{ entity_type: string; entity_id: string; updated_at: number; deleted_at: number | null }> = [];

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
        const user = { id: `u_${cloud.users.size + 1}`, email: clean, password };
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

      const runSelect = () => {
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
        return out;
      };

      const selectBuilder: any = {
        select: () => selectBuilder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return selectBuilder;
        },
        gt: (col: string, val: number) => {
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
          const rows = runSelect();
          return { data: rows[0] ?? null, error: null };
        },
        then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
          return Promise.resolve({ data: runSelect(), error: null }).then(resolve, reject);
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
          cloud.upsertCalls.push({
            entity_type: row.entity_type,
            entity_id: row.entity_id,
            updated_at: Number(row.updated_at ?? 0),
            deleted_at: row.deleted_at ?? null,
          });
          if (cloud.rejectEntityTypesWith23514.has(row.entity_type)) {
            resultError = {
              code: '23514',
              message:
                'new row for relation "sync_records" violates check constraint "sync_records_entity_type_check"',
            };
          } else {
            const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
            const existing = cloud.records.get(key);
            // Exact live Supabase Postgres `bump_sync_record_seq` BEFORE UPDATE trigger semantics:
            // If incoming updated_at < existing.updated_at, silently return OLD unchanged!
            if (existing && Number(row.updated_at ?? 0) < Number(existing.updated_at ?? 0)) {
              cloud.silentDropCount += 1;
              resultData = [{ ...existing }];
            } else {
              cloud.seq += 1;
              const next: SyncRecordRow = {
                ...row,
                server_seq: cloud.seq,
                server_updated_at: new Date().toISOString(),
              };
              cloud.records.set(key, next);
              resultData = [{ ...next }];
            }
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
          if (cloud.envelopes.has(row.user_id)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          cloud.envelopes.set(row.user_id, {
            ...row,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          return { data: [cloud.envelopes.get(row.user_id)], error: null };
        }
        return upsert(row);
      };

      return {
        select: () => selectBuilder,
        insert,
        upsert,
      };
    };

    const storage = {
      from: (bucket: string) => ({
        async upload(objectPath: string, body: Buffer | Uint8Array) {
          cloud.storageObjects.set(`${bucket}/${objectPath}`, Buffer.from(body));
          return { data: { path: objectPath }, error: null };
        },
        async download(objectPath: string) {
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

function attachCloud(engine: SyncEngine, cloud: TriggerAccurateSupabaseCloud): void {
  const client = cloud.createClientForDevice();
  (engine as unknown as { client: SupabaseClient }).client = client;
  (engine as unknown as { ensureClient: () => SupabaseClient }).ensureClient = () => client;
}

interface TestDevice {
  dir: string;
  mediaDir: string;
  repo: VaultRepository;
  vaultCrypto: VaultCrypto;
  sync: SyncEngine;
  deletedEvents: string[];
  cleanedMedia: string[];
}

function createDevice(
  name: string,
  cloud: TriggerAccurateSupabaseCloud,
  opts?: { onBatchSynced?: () => void }
): TestDevice {
  const dir = makeTempDir(`kapsula-v8-${name}-`);
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  openRepos.push(repo);
  const vaultCrypto = new VaultCrypto(dir, null);
  const deletedEvents: string[] = [];
  const cleanedMedia: string[] = [];
  const sync = new SyncEngine({
    dataDir: dir,
    mediaDir,
    repo,
    vaultCrypto,
    deviceName: name,
    kdfIterationsOverride: 5_000,
    disableTimers: true,
    disableRealtime: true,
    callbacks: {
      onItemDeleted: (id) => deletedEvents.push(id),
      onMediaCleanup: (files) => cleanedMedia.push(...files),
      onBatchSynced: opts?.onBatchSynced,
    },
  });
  activeEngines.push(sync);
  attachCloud(sync, cloud);
  return { dir, mediaDir, repo, vaultCrypto, sync, deletedEvents, cleanedMedia };
}

async function pairTwoDevices(cloud: TriggerAccurateSupabaseCloud) {
  const pc = createDevice('Windows-PC', cloud);
  const mac = createDevice('MacBook-Pro', cloud);

  const up = await pc.sync.signUp('sync-v8@kapsula.app', 'account-pass-2026');
  expect(up.ok).toBe(true);
  const setup = await pc.sync.setupPassphrase('сильная-фраза-синхронизации-2026');
  expect(setup.ok).toBe(true);

  const signInMac = await mac.sync.signIn('sync-v8@kapsula.app', 'account-pass-2026');
  expect(signInMac.ok).toBe(true);
  const unlockMac = await mac.sync.unlockWithPassphrase('сильная-фраза-синхронизации-2026');
  expect(unlockMac.ok).toBe(true);

  return { pc, mac, recoveryKey: setup.recoveryKey! };
}

describe('Kapsula V8 Sync Deletion, Conflict, Inline Media & Kanban', () => {
  it('separates Trash vs Archive, syncs soft-delete and permanent purge tombstones across PC & Mac, and never resurrects purged items', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const imgName = 'note-shot.png';
    fs.writeFileSync(path.join(pc.mediaDir, imgName), Buffer.from('PNG-BYTES-1234'));

    const note = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Важная заметка для удаления',
      body: 'Текст заметки перед удалением',
      summary: 'Кратко',
      imagePath: imgName,
      source: 'vault_ui',
      contentHash: 'v8-del-note-1',
    });

    const archived = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Архивная заметка',
      body: 'Должна остаться в архиве',
      summary: 'Архив',
      source: 'vault_ui',
      contentHash: 'v8-del-arch-1',
    });
    pc.repo.updateItem(archived.id, { isArchived: true });

    const trashBatch1 = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Лишний черновик 1',
      body: 'Будет очищен через emptyTrash',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-trash-batch-1',
    });

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    expect(mac.repo.getItemById(note.id)?.title).toBe('Важная заметка для удаления');
    expect(mac.repo.queryItems({ archivedOnly: true }).map((i) => i.id)).toContain(archived.id);

    // 1) PC soft-deletes note -> Mac pulls -> Trash ONLY, NOT Archive, NOT default feed
    await new Promise((r) => setTimeout(r, 10));
    expect(pc.repo.deleteItem(note.id)).toBe(true);
    expect(pc.repo.getItemById(note.id)).toBeNull();
    expect(pc.repo.getItemById(note.id, { includeDeleted: true })?.deletedAt).toBeTruthy();

    expect((await pc.sync.syncNow()).ok).toBe(true);
    mac.deletedEvents.length = 0;
    expect((await mac.sync.syncNow()).ok).toBe(true);

    expect(mac.deletedEvents).toContain(note.id);
    expect(mac.repo.queryItems({}).map((i) => i.id)).not.toContain(note.id);
    expect(mac.repo.queryItems({ archivedOnly: true }).map((i) => i.id)).not.toContain(note.id);
    expect(mac.repo.queryItems({ onlyDeleted: true }).map((i) => i.id)).toEqual([note.id]);
    expect(mac.repo.getStats().trashedCount).toBe(1);

    // 2) Calling deleteItem on an ALREADY soft-deleted row redirects cleanly to permanent purge!
    await new Promise((r) => setTimeout(r, 10));
    expect(mac.repo.deleteItem(note.id)).toBe(true);
    expect(mac.repo.queryItems({ onlyDeleted: true })).toHaveLength(0);
    expect(mac.repo.restoreItem(note.id)).toBeNull();

    const macPurgedRow = mac.repo.getRawRowById(note.id);
    expect(macPurgedRow?.purged_at).toBeTruthy();
    expect(macPurgedRow?.title).toBe('');
    expect(macPurgedRow?.body).toBe('');
    expect(macPurgedRow?.image_path).toBeNull();

    // Push purge tombstone from Mac -> PC pulls and scrubs local row + emits onItemDeleted & onMediaCleanup
    expect((await mac.sync.syncNow()).ok).toBe(true);
    pc.deletedEvents.length = 0;
    pc.cleanedMedia.length = 0;
    expect((await pc.sync.syncNow()).ok).toBe(true);

    expect(pc.deletedEvents).toContain(note.id);
    expect(pc.cleanedMedia).toContain(imgName);
    expect(pc.repo.queryItems({ onlyDeleted: true })).toHaveLength(0);
    expect(pc.repo.getRawRowById(note.id)?.purged_at).toBeTruthy();
    expect(pc.repo.getRawRowById(note.id)?.body).toBe('');

    // 3) Stale or clock-skewed live record from another device MUST NEVER resurrect a permanently purged row!
    const resurrectRes = pc.repo.applySyncedItem(
      {
        v: 1,
        id: note.id,
        dna: 'note',
        subKind: null,
        orbit: '',
        modeCaptured: 'autopilot',
        focusBoardId: null,
        title: 'Попытка воскрешения',
        body: 'Старый текст',
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
        secretPayload: null,
        secretMeta: null,
        tags: [],
        source: 'vault_ui',
        externalId: null,
        contentHash: 'v8-del-note-1',
        aiStatus: 'local',
        aiConfidence: null,
        isPinned: false,
        isArchived: false,
        remindAt: null,
        remindedAt: null,
        createdAt: note.createdAt,
        updatedAt: Date.now() + 999_999,
        contentUpdatedAt: Date.now() + 999_999,
        deletedAt: null,
        purgedAt: null,
        canvasX: null,
        canvasY: null,
        canvasW: null,
        canvasH: null,
        canvasFrame: null,
        annotations: [],
        linksOut: [],
        syncVersion: 99,
        mediaRefs: [],
      },
      null,
      'stale-device',
      pc.repo.getLocalDeviceId()!
    );
    expect(resurrectRes.applied).toBe(false);
    expect(resurrectRes.localStrictlyNewer).toBe(true);
    expect(pc.repo.getItemById(note.id)).toBeNull();
    expect(pc.repo.getRawRowById(note.id)?.purged_at).toBeTruthy();

    // 4) emptyTrash permanently purges trashed rows and syncs purge to Mac
    expect(pc.repo.deleteItem(trashBatch1.id)).toBe(true);
    const emptied = pc.repo.emptyTrash();
    expect(emptied.purgedIds).toContain(trashBatch1.id);
    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(trashBatch1.id)).toBeNull();
    expect(mac.repo.getRawRowById(trashBatch1.id)?.purged_at).toBeTruthy();
  });

  it('detects Postgres LWW trigger silent drop on clock skew and retries delete so deletion always wins', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const note = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Заметка с рассинхроном часов',
      body: 'Исходный текст',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-clock-skew-1',
    });

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // Simulate Mac's clock being +60s ahead of PC's wall clock when Mac edits and pushes
    const skewedFutureTs = Date.now() + 60_000;
    mac.repo.db
      .prepare('UPDATE items SET title = ?, updated_at = ?, sync_version = sync_version + 1, last_device_id = ? WHERE id = ?')
      .run('Правка с Mac (часы +60с)', skewedFutureTs, mac.repo.getLocalDeviceId(), note.id);
    mac.repo.markDirty('item', note.id);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // Simulate pull/push race or PC cursor past overlap window so PC pushes delete directly against server's future row
    cloud.seq = Math.max(cloud.seq + 40, 100);
    pc.repo.setSyncState('last_cursor', String(cloud.seq));
    pc.repo.setSyncState('last_reconcile_at', String(Date.now()));
    expect(pc.repo.deleteItem(note.id)).toBe(true);
    expect(pc.repo.getRawRowById(note.id)!.updated_at).toBeLessThan(skewedFutureTs);

    const dropsBefore = cloud.silentDropCount;
    const pcSync = await pc.sync.syncNow();
    expect(pcSync.ok).toBe(true);

    // Postgres trigger MUST have silently dropped the first upsert, and SyncEngine detected + retried with bumped timestamp!
    expect(cloud.silentDropCount).toBeGreaterThan(dropsBefore);

    const cloudKey = `${pc.sync.getStatus().userId}:item:${note.id}`;
    const finalCloudRow = cloud.records.get(cloudKey)!;
    expect(finalCloudRow.deleted_at).not.toBeNull();
    expect(finalCloudRow.updated_at).toBeGreaterThan(skewedFutureTs);

    // Mac pulls and sees the note deleted cleanly!
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(note.id)).toBeNull();
    expect(mac.repo.queryItems({ onlyDeleted: true }).map((i) => i.id)).toContain(note.id);
  });

  it('catches out-of-order MVCC server_seq deletes via -25 overlap rewind and heals deep gaps via reconcileFull', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const noteA = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'MVCC окно -25',
      body: 'Проверка overlap rewind',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-mvcc-a',
    });
    const noteB = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Глубокий пропуск reconcileFull',
      body: 'Проверка full reconcile',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-mvcc-b',
    });
    const noteC = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Локальный tombstone отсутствует в облаке',
      body: 'Будет допушен reconcileFull',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-mvcc-c',
    });

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // Advance cloud.seq and Mac's cursor to 20
    cloud.seq = 20;
    mac.repo.setSyncState('last_cursor', '20');

    // PC deletes noteA and pushes, then rewrite cloud row's server_seq to 15 (strictly < Mac's cursor 20, inside -25 window!)
    await new Promise((r) => setTimeout(r, 10));
    expect(pc.repo.deleteItem(noteA.id)).toBe(true);
    expect((await pc.sync.syncNow()).ok).toBe(true);
    const keyA = `${pc.sync.getStatus().userId}:item:${noteA.id}`;
    cloud.records.get(keyA)!.server_seq = 15;

    // Mac incremental pull (gt server_seq = max(0, 20 - 25) = 0) MUST catch server_seq = 15!
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(noteA.id)).toBeNull();

    // Now test a deep gap > 25: Mac cursor = 80, delayed delete for noteB sits at server_seq = 5
    cloud.seq = 80;
    mac.repo.setSyncState('last_cursor', '80');
    mac.repo.setSyncState('last_reconcile_at', String(Date.now()));
    await new Promise((r) => setTimeout(r, 10));
    expect(pc.repo.deleteItem(noteB.id)).toBe(true);
    expect((await pc.sync.syncNow()).ok).toBe(true);
    const keyB = `${pc.sync.getStatus().userId}:item:${noteB.id}`;
    cloud.records.get(keyB)!.server_seq = 5;

    // Also delete noteC on Mac locally, clear its dirty flag & delete its cloud row so it is a missing tombstone
    expect(mac.repo.deleteItem(noteC.id)).toBe(true);
    mac.repo.db.prepare("DELETE FROM sync_dirty WHERE entity_id = ?").run(noteC.id);
    cloud.records.delete(`${pc.sync.getStatus().userId}:item:${noteC.id}`);

    // Normal incremental sync from 80 - 25 = 55 misses seq 5
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(noteB.id)).not.toBeNull();

    // reconcileFull pulls from cursor = 0, applies seq 5, pushes missing local tombstone noteC, and stamps lastReconcileAt!
    const statusAfter = await mac.sync.reconcileFull();
    expect(statusAfter.lastReconcileAt).toBeGreaterThan(0);
    expect(mac.repo.getItemById(noteB.id)).toBeNull();
    expect(cloud.records.get(`${pc.sync.getStatus().userId}:item:${noteC.id}`)?.deleted_at).not.toBeNull();
  });

  it('preserves losing note text in sync_conflict revisions, auto-checkpoints edits, and reconciles [[wiki-links]]', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const targetMap = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Карта уровней',
      body: 'Целевая заметка 1',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-wiki-target-1',
    });
    const targetEcon = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Экономика',
      body: 'Целевая заметка 2',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-wiki-target-2',
    });

    const note = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Документ архитектуры',
      body: 'Базовый текст заметки с [[Геймдизайн]] и [[Баланс|Балансом]]',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-conflict-1',
    });

    // Update body by >= 120 chars to verify auto-checkpoint & wiki-link ID reconciliation
    const longBody =
      'Подробное описание системы со ссылкой на [[Карта уровней]] и [[Экономика]] — ' +
      'это достаточно длинное обновление текста чтобы сработало автосохранение контрольной точки версии без участия пользователя.';
    const updated = pc.repo.updateItem(note.id, { body: longBody });
    expect(updated?.linksOut).toContain(targetMap.id);
    expect(updated?.linksOut).toContain(targetEcon.id);
    const autoRevs = pc.repo.listItemRevisions(note.id);
    expect(autoRevs.some((r) => r.source === 'auto' && r.deviceName)).toBe(true);

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // Concurrent edits: PC edits offline first, Mac edits later and pushes winner
    pc.repo.updateItem(note.id, { body: 'Оффлайн правка с Windows-PC, которую нельзя потерять!' });
    await new Promise((r) => setTimeout(r, 25));
    mac.repo.updateItem(note.id, { body: 'Победившая правка с MacBook-Pro!' });
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // PC syncs: Mac wins LWW, PC's losing text MUST be preserved as `sync_conflict` revision!
    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect(pc.repo.getItemById(note.id)?.body).toBe('Победившая правка с MacBook-Pro!');
    const pcRevs = pc.repo.listItemRevisions(note.id);
    const conflictRev = pcRevs.find((r) => r.source === 'sync_conflict');
    expect(conflictRev).toBeDefined();
    expect(conflictRev?.content).toBe('Оффлайн правка с Windows-PC, которую нельзя потерять!');

    // Even after 35 new manual revisions, `sync_conflict` revision MUST stay protected from pruning!
    for (let i = 1; i <= 35; i += 1) {
      pc.repo.saveItemRevision({
        itemId: note.id,
        title: note.title,
        content: `Ручной снапшот #${i}`,
        source: 'manual',
      });
    }
    const afterPrune = pc.repo.listItemRevisions(note.id);
    expect(afterPrune.some((r) => r.id === conflictRev!.id && r.source === 'sync_conflict')).toBe(true);
  });

  it('uploads inline body media (kapsula-media://local/...) to E2EE storage and protects it from media GC until purge', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const inlineFile = 'inline_diagram_42.png';
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    fs.writeFileSync(path.join(pc.mediaDir, inlineFile), pngBytes);

    const note = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Заметка с встроенным фото',
      body: `Смотри схему ниже:\n\n![Архитектура](kapsula-media://local/${inlineFile})\n\nИ выводы.`,
      summary: 'Схема',
      source: 'vault_ui',
      contentHash: 'v8-inline-media-1',
    });

    // Protected from GC while live AND while in Trash
    expect(pc.repo.countItemsByMediaRef(inlineFile)).toBe(1);

    const pushPc = await pc.sync.syncNow();
    expect(pushPc.ok).toBe(true);
    expect(pushPc.blobsUploaded).toBeGreaterThanOrEqual(1);

    const pullMac = await mac.sync.syncNow();
    expect(pullMac.ok).toBe(true);
    expect(pullMac.blobsDownloaded).toBeGreaterThanOrEqual(1);

    const macFile = path.join(mac.mediaDir, inlineFile);
    expect(fs.existsSync(macFile)).toBe(true);
    expect(fs.readFileSync(macFile).equals(pngBytes)).toBe(true);

    // Still protected in Trash (for restore), freed ONLY after permanent purge!
    pc.repo.deleteItem(note.id);
    expect(pc.repo.countItemsByMediaRef(inlineFile)).toBe(1);
    const purged = pc.repo.purgeItemPermanently(note.id);
    expect(purged.purged).toBe(true);
    expect(purged.freedMedia).toContain(inlineFile);
    expect(pc.repo.countItemsByMediaRef(inlineFile)).toBe(0);
  });

  it('isolates corrupt dirty records via dead-letter backoff without blocking deletes and flushes pending deletes via flushNow', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const badSecret = pc.repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Битый секрет',
      body: '🔒 Зашифровано',
      summary: '',
      encryptedPayload: pc.vaultCrypto.encryptSecret({
        service: 'Broken',
        login: '',
        secretValue: '1234',
        notes: '',
      }),
      secretMeta: { kind: 'password', service: 'Broken', loginHint: '' },
      source: 'vault_ui',
      contentHash: 'v8-corrupt-secret-1',
    });
    const goodNote = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Хорошая заметка',
      body: 'Будет удалена несмотря на битый секрет',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-good-note-1',
    });

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);

    // Corrupt secret ciphertext AND delete goodNote in the same push cycle
    pc.repo.db.prepare('UPDATE items SET encrypted_payload = ? WHERE id = ?').run('{"broken":true}', badSecret.id);
    pc.repo.markDirty('item', badSecret.id);
    await new Promise((r) => setTimeout(r, 10));
    pc.repo.deleteItem(goodNote.id);

    const pushRes = await pc.sync.syncNow();
    expect(pushRes.ok).toBe(false);
    expect(pc.sync.getStatus().failedDirtyCount).toBe(1);

    // Good note's delete STILL synced to cloud and reached Mac!
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(goodNote.id)).toBeNull();

    // Test flushNow() drains pending delete cleanly before quit/dispose
    const quitNote = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Перед выходом',
      body: 'Удалим и сразу flushNow',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-flush-quit-1',
    });
    await pc.sync.flushNow(2500);
    await mac.sync.syncNow();
    expect(mac.repo.getItemById(quitNote.id)?.title).toBe('Перед выходом');

    await new Promise((r) => setTimeout(r, 10));
    pc.repo.deleteItem(quitNote.id);
    await pc.sync.flushNow(2500);

    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(quitNote.id)).toBeNull();
  });

  it('gracefully disables optional item_revision & workspace_prefs on Postgres 23514 without blocking core item sync', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    cloud.rejectEntityTypesWith23514.add('item_revision');
    cloud.rejectEntityTypesWith23514.add('workspace_prefs');

    const { pc, mac } = await pairTwoDevices(cloud);

    // Trigger workspace_prefs + item_revision + core item mutations
    pc.repo.saveTaskBoardColumns([
      { id: 'todo', title: 'Сделать', color: '#3B82F6', order: 0, isDone: false },
      { id: 'in_progress', title: 'В работе', color: '#F59E0B', order: 1, isDone: false },
      { id: 'done', title: 'Готово', color: '#22C55E', order: 2, isDone: true },
    ]);

    const note = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Основная заметка',
      body: 'Короткий текст',
      summary: '',
      source: 'vault_ui',
      contentHash: 'v8-23514-note',
    });
    pc.repo.updateItem(note.id, { title: 'Основная заметка (обновлена)' }); // spawns auto revision

    const pushRes = await pc.sync.syncNow();
    expect(pushRes.ok).toBe(true);
    expect(pc.sync.getStatus().failedDirtyCount).toBe(0);
    expect(pc.sync.getStatus().pendingCount).toBe(0);

    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.getItemById(note.id)?.title).toBe('Основная заметка (обновлена)');
  });

  it('supports Kanban task board CRUD, Done <-> Done-column invariant, per-task meta without remindAt collision, and workspace_prefs sync', async () => {
    const cloud = new TriggerAccurateSupabaseCloud();
    const { pc, mac } = await pairTwoDevices(cloud);

    const remindAt = Date.now() + 86_400_000;
    const item = pc.repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Спринт v8',
      body: '- [ ] Первая задача\n- [ ] Вторая задача',
      summary: '',
      remindAt,
      source: 'vault_ui',
      contentHash: 'v8-kanban-1',
    });

    const initialTasks = pc.repo.listVaultTasks();
    expect(initialTasks).toHaveLength(2);
    const t0 = initialTasks[0]!;
    const t1 = initialTasks[1]!;
    const key0 = t0.taskKey!;
    const key1 = t1.taskKey!;

    // Update per-task dueAt & priority on task 0: MUST NOT overwrite item.remindAt or task 1!
    const customDue = Date.now() + 172_800_000;
    expect(
      pc.repo.updateTaskMeta({ itemId: item.id, taskKey: key0, priority: 'high', dueAt: customDue })
    ).not.toBeNull();
    expect(pc.repo.getItemById(item.id)?.remindAt).toBe(remindAt);
    const afterMeta = pc.repo.listVaultTasks();
    expect(afterMeta.find((t) => t.taskKey === key0)?.priority).toBe('high');
    expect(afterMeta.find((t) => t.taskKey === key0)?.dueAt).toBe(customDue);
    expect(afterMeta.find((t) => t.taskKey === key1)?.priority).toBe('none');

    // Done <-> Done-column invariant
    expect(
      pc.repo.moveTaskOnBoard({ itemId: item.id, taskKey: key0, columnId: 'done', boardOrder: 0 })
    ).not.toBeNull();
    expect(pc.repo.getItemById(item.id)?.body).toContain('- [x] Первая задача');
    expect(pc.repo.listVaultTasks().find((t) => t.taskKey === key0)?.done).toBe(true);

    expect(
      pc.repo.moveTaskOnBoard({ itemId: item.id, taskKey: key0, columnId: 'in_progress', boardOrder: 0 })
    ).not.toBeNull();
    expect(pc.repo.getItemById(item.id)?.body).toContain('- [ ] Первая задача');
    expect(pc.repo.listVaultTasks().find((t) => t.taskKey === key0)?.columnId).toBe('in_progress');

    // Rename & delete task
    expect(
      pc.repo.updateVaultTaskText({ itemId: item.id, taskKey: key0, text: 'Обновлённая первая задача' })
    ).not.toBeNull();
    expect(pc.repo.getItemById(item.id)?.body).toContain('- [ ] Обновлённая первая задача');
    expect(pc.repo.deleteVaultTask({ itemId: item.id, taskKey: key1 })).not.toBeNull();
    expect(pc.repo.listVaultTasks()).toHaveLength(1);

    // Custom Kanban columns sync via workspace_prefs
    const customCols = pc.repo.saveTaskBoardColumns([
      { id: 'todo', title: 'Бэклог', color: '#3B82F6', order: 0, isDone: false },
      { id: 'review', title: 'Ревью', color: '#A855F7', order: 1, isDone: false },
      { id: 'done', title: 'Закрыто', color: '#22C55E', order: 2, isDone: true },
    ]);
    expect(customCols.map((c) => c.id)).toEqual(['todo', 'review', 'done']);

    expect((await pc.sync.syncNow()).ok).toBe(true);
    expect((await mac.sync.syncNow()).ok).toBe(true);
    expect(mac.repo.listTaskBoardColumns().map((c) => c.title)).toEqual(['Бэклог', 'Ревью', 'Закрыто']);
  });
});
