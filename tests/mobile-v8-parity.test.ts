import { describe, expect, it } from 'vitest';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import type { SyncKeyEnvelopeRow, SyncRecordRow } from '@shared/sync-contract';
import { generateTotp } from '@shared/totp';
import { MOBILE_IDB_VERSION, MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';
import { createKeyEnvelope, unwrapDekWithPassphrase } from '@mobile/sync/mobile-crypto';

interface MockCloudOptions {
  rejectOptionalEntityTypes?: boolean;
  failOnceForEntityId?: string;
}

interface MockCloudState {
  envelopes: Map<string, SyncKeyEnvelopeRow>;
  records: Map<string, SyncRecordRow>;
  blobsMeta: Map<string, { user_id: string; blob_id: string; byte_size: number; ext: string }>;
  storage: Map<string, Uint8Array>;
  devices: Map<string, Record<string, unknown>>;
  seq: number;
  failedOnceIds: Set<string>;
  upsertCountByEntity: Map<string, number>;
}

function createMockCloud(): MockCloudState {
  return {
    envelopes: new Map(),
    records: new Map(),
    blobsMeta: new Map(),
    storage: new Map(),
    devices: new Map(),
    seq: 0,
    failedOnceIds: new Set(),
    upsertCountByEntity: new Map(),
  };
}

function createMockSupabaseClient(
  cloud: MockCloudState,
  userId: string,
  email: string,
  options: MockCloudOptions = {}
): SupabaseClient {
  let signedIn = false;

  const makeQuery = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let maxRows = 1000;

    const getRows = (): Array<Record<string, unknown>> => {
      if (table === 'sync_key_envelopes') {
        return Array.from(cloud.envelopes.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_records') {
        return Array.from(cloud.records.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_blobs') {
        return Array.from(cloud.blobsMeta.values()) as unknown as Array<Record<string, unknown>>;
      }
      if (table === 'sync_devices') {
        return Array.from(cloud.devices.values());
      }
      return [];
    };

    const runSelect = () => {
      let rows = getRows().filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (typeof av === 'number' && typeof bv === 'number') {
            return orderAsc ? av - bv : bv - av;
          }
          return orderAsc
            ? String(av ?? '').localeCompare(String(bv ?? ''))
            : String(bv ?? '').localeCompare(String(av ?? ''));
        });
      }
      return rows.slice(0, maxRows);
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      gt: (col: string, val: number) => {
        filters.push((r) => Number(r[col] ?? 0) > val);
        return chain;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return chain;
      },
      limit: (n: number) => {
        maxRows = n;
        return Promise.resolve({ data: runSelect(), error: null });
      },
      maybeSingle: () => {
        const rows = runSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      insert: (payload: Record<string, unknown>) => {
        if (table === 'sync_key_envelopes') {
          const row = payload as unknown as SyncKeyEnvelopeRow;
          if (cloud.envelopes.has(row.user_id)) {
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint 23505' },
            });
          }
          cloud.envelopes.set(row.user_id, row);
        }
        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => {
          if (table === 'sync_key_envelopes' && col === 'user_id') {
            const prev = cloud.envelopes.get(String(val));
            if (prev) {
              cloud.envelopes.set(String(val), { ...prev, ...patch } as SyncKeyEnvelopeRow);
            }
          }
          return Promise.resolve({ error: null });
        },
      }),
      upsert: (payload: Record<string, unknown>) => {
        if (table === 'sync_records') {
          const row = payload as unknown as SyncRecordRow;
          cloud.upsertCountByEntity.set(
            row.entity_id,
            (cloud.upsertCountByEntity.get(row.entity_id) ?? 0) + 1
          );

          if (
            options.rejectOptionalEntityTypes &&
            (row.entity_type === 'item_revision' || row.entity_type === 'workspace_prefs')
          ) {
            const errResult = {
              data: null,
              error: {
                code: '23514',
                message:
                  'new row for relation "sync_records" violates check constraint "sync_records_entity_type_check"',
              },
            };
            return {
              select: () => Promise.resolve(errResult),
              then: (resolve: (v: unknown) => void) => resolve(errResult),
            };
          }

          if (
            options.failOnceForEntityId &&
            row.entity_id === options.failOnceForEntityId &&
            !cloud.failedOnceIds.has(row.entity_id)
          ) {
            cloud.failedOnceIds.add(row.entity_id);
            const errResult = {
              data: null,
              error: { code: '500', message: 'simulated transient server failure' },
            };
            return {
              select: () => Promise.resolve(errResult),
              then: (resolve: (v: unknown) => void) => resolve(errResult),
            };
          }

          const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
          const prev = cloud.records.get(key);
          // Mirror Postgres server-side LWW trigger returning the winning row via .select(...)
          let winning: SyncRecordRow;
          if (
            prev &&
            (row.updated_at < prev.updated_at ||
              (row.updated_at === prev.updated_at && row.sync_version < prev.sync_version))
          ) {
            winning = prev;
          } else {
            cloud.seq += 1;
            winning = { ...row, server_seq: cloud.seq };
            cloud.records.set(key, winning);
          }

          const okResult = { data: [winning], error: null };
          return {
            select: () => Promise.resolve(okResult),
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
        }

        if (table === 'sync_blobs') {
          const b = payload as { user_id: string; blob_id: string; byte_size: number; ext: string };
          cloud.blobsMeta.set(`${b.user_id}:${b.blob_id}`, b);
        } else if (table === 'sync_devices') {
          const key = `${String(payload.user_id)}:${String(payload.device_id)}`;
          cloud.devices.set(key, payload);
        }
        const ok = { data: [payload], error: null };
        return {
          select: () => Promise.resolve(ok),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        };
      },
    };
    return chain;
  };

  return {
    auth: {
      getSession: async () => ({
        data: { session: signedIn ? { user: { id: userId, email } } : null },
        error: null,
      }),
      signUp: async () => {
        signedIn = true;
        return {
          data: { session: { user: { id: userId, email } }, user: { id: userId, email } },
          error: null,
        };
      },
      signInWithPassword: async () => {
        signedIn = true;
        return { data: { session: { user: { id: userId, email } } }, error: null };
      },
      signOut: async () => {
        signedIn = false;
        return { error: null };
      },
    },
    from: (table: string) => makeQuery(table),
    storage: {
      from: () => ({
        upload: async (pathKey: string, bytes: Uint8Array) => {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          cloud.storage.set(pathKey, copy);
          return { error: null };
        },
        download: async (pathKey: string) => {
          const bytes = cloud.storage.get(pathKey);
          if (!bytes) return { data: null, error: { message: 'Object not found (404)' } };
          return {
            data: {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

async function setupSyncedPair(options: MockCloudOptions = {}) {
  const cloud = createMockCloud();
  const userId = 'u-v8-parity';
  const email = 'v8@kapsula.app';

  const storeA = new MobileVaultStore({ memoryOnly: true });
  const engineA = new MobileSyncEngine({
    store: storeA,
    deviceName: 'Galaxy Z Fold 6',
    platform: 'android',
    kdfIterationsOverride: 100_000,
    disableTimers: true,
    disableRealtime: true,
    clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
      createMockSupabaseClient(cloud, userId, email, options),
  });
  await engineA.init();
  await engineA.signUp(email, 'secret-account-pass');
  const setup = await engineA.setupPassphrase('StrongPassphraseV8!');
  expect(setup.ok).toBe(true);

  const storeB = new MobileVaultStore({ memoryOnly: true });
  const engineB = new MobileSyncEngine({
    store: storeB,
    deviceName: 'Windows Desktop',
    platform: 'win32',
    kdfIterationsOverride: 100_000,
    disableTimers: true,
    disableRealtime: true,
    clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
      createMockSupabaseClient(cloud, userId, email, options),
  });
  await engineB.init();
  await engineB.signIn(email, 'secret-account-pass');
  const unlock = await engineB.unlockWithPassphrase('StrongPassphraseV8!');
  expect(unlock.ok).toBe(true);

  return { cloud, userId, storeA, engineA, storeB, engineB };
}

describe('Mobile V8 Full Parity — Sync, Trash/Purge, Inline Media, Revisions, Kanban & Vault 2FA', () => {
  it('detects server-dropped deletes under clock skew via .select() and retries so delete-wins', async () => {
    const { cloud, userId, storeA, engineA, storeB, engineB } = await setupSyncedPair();

    const note = await storeA.createItem({
      dna: 'note',
      title: 'Будущая запись',
      body: 'Создано на Fold',
    });
    await engineA.syncNow();
    await engineB.syncNow();
    expect(storeB.getItemById(note.id)).not.toBeNull();

    // Simulate clock skew: server row has updated_at 10 minutes in the future!
    const key = `${userId}:item:${note.id}`;
    const existing = cloud.records.get(key)!;
    const futureTs = Date.now() + 600_000;
    cloud.records.set(key, {
      ...existing,
      updated_at: futureTs,
      sync_version: existing.sync_version + 3,
      deleted_at: null,
    });

    // Device A deletes locally (its local clock is behind server's futureTs)
    await storeA.deleteItem(note.id);
    const push = await engineA.syncNow();
    expect(push.ok).toBe(true);

    // Server MUST have received the retry with bumped updated_at > futureTs and non-null deleted_at!
    const serverRow = cloud.records.get(key)!;
    expect(serverRow.deleted_at).not.toBeNull();
    expect(serverRow.updated_at).toBeGreaterThan(futureTs);

    // Device B pulls and deletes it too — never resurrected!
    await engineB.syncNow();
    expect(storeB.getItemById(note.id)).toBeNull();
    expect(storeB.listTrashedItems().map((i) => i.id)).toContain(note.id);
  });

  it('supports reversible Trash -> Restore and permanent Purge syncing scrubbed tombstone across devices', async () => {
    const { storeA, engineA, storeB, engineB } = await setupSyncedPair();

    const imgBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
    await storeA.putMedia('secret-pic.png', 'image/png', imgBytes);

    const card = await storeA.upsertSecret({
      kind: 'bank_card',
      title: 'Банковская карта',
      service: 'Банковская карта',
      secretValue: '4276380011223344',
      expiry: '09/30',
      cvv: '812',
      notes: 'Личная резервная карта',
    });
    const note = await storeA.createItem({
      dna: 'note',
      title: 'Удалить навсегда',
      body: 'Конфиденциальный текст ![Фото](kapsula-media://local/secret-pic.png)',
    });

    await engineA.syncNow();
    await engineB.syncNow();
    expect(storeB.getMediaFile('secret-pic.png')).not.toBeNull();
    expect((await storeB.revealSecret(card.id))?.cvv).toBe('812');

    // Soft-delete card -> appears in Trash -> restoreItem recovers encrypted payload intact!
    await storeA.deleteItem(card.id);
    expect(storeA.listTrashedItems().map((i) => i.id)).toContain(card.id);
    expect(storeA.getRawItem(card.id)?.encryptedSecretPayload).toBeTruthy();

    await storeA.restoreItem(card.id);
    expect(storeA.listTrashedItems().find((i) => i.id === card.id)).toBeUndefined();
    expect((await storeA.revealSecret(card.id))?.secretValue).toBe('4276380011223344');

    // Soft-delete both, then emptyTrash() permanently purges & syncs scrubbed tombstones
    await storeA.deleteItem(card.id);
    await storeA.deleteItem(note.id);
    const emptied = await storeA.emptyTrash();
    expect(emptied.purgedCount).toBe(2);
    expect(storeA.listTrashedItems()).toHaveLength(0);
    expect(storeA.getRawItem(card.id)?.encryptedSecretPayload).toBeNull();
    expect(storeA.getRawItem(card.id)?.purgedAt).not.toBeNull();
    expect(storeA.getMediaFile('secret-pic.png')).toBeNull();

    await engineA.syncNow();
    await engineB.syncNow();

    // Device B also scrubbed secret payload, text, and unreferenced inline media!
    expect(storeB.listItems({ includeSecrets: true })).toHaveLength(0);
    expect(storeB.listTrashedItems()).toHaveLength(0);
    expect(storeB.getRawItem(card.id)?.encryptedSecretPayload).toBeNull();
    expect(storeB.getRawItem(card.id)?.purgedAt).not.toBeNull();
    expect(storeB.getRawItem(note.id)?.body).toBe('');
    expect(storeB.getMediaFile('secret-pic.png')).toBeNull();
  });

  it('uploads inline note images via extractInlineMediaFilenames into KAPS1 blobs and downloads on Device B', async () => {
    const { storeA, engineA, storeB, engineB } = await setupSyncedPair();

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42, 43, 44, 45]);
    await storeA.putMedia('inline-note-123.png', 'image/png', png);

    const archNote = await storeA.createItem({
      dna: 'note',
      title: 'Архитектура',
      body: 'Базовый документ архитектуры',
    });

    const note = await storeA.createItem({
      dna: 'note',
      title: 'Заметка с фото внутри',
      body: 'Смотри схему:\n\n![Схема](kapsula-media://local/inline-note-123.png)\n\nСвязь с [[Архитектура]]',
    });
    expect(note.linksOut).toEqual([archNote.id]);

    const push = await engineA.syncNow();
    expect(push.ok).toBe(true);
    expect(push.blobsUploaded).toBe(1);

    const pull = await engineB.syncNow();
    expect(pull.ok).toBe(true);
    expect(pull.blobsDownloaded).toBe(1);

    const fetched = storeB.getMediaFile('inline-note-123.png');
    expect(fetched).not.toBeNull();
    expect(Array.from(fetched!.bytes)).toEqual(Array.from(png));
    expect(storeB.getItemById(note.id)?.linksOut).toEqual([archNote.id]);
  });

  it('supports DB v3 item_revisions, sync_conflict preservation, revert, and graceful Postgres 23514 fallback', async () => {
    expect(MOBILE_IDB_VERSION).toBe(3);

    // Server rejects optional entity types (item_revision & workspace_prefs) with Postgres 23514
    const { storeA, engineA, storeB, engineB } = await setupSyncedPair({
      rejectOptionalEntityTypes: true,
    });

    const note = await storeA.createItem({
      dna: 'note',
      title: 'История версий',
      body: 'Первая версия документа',
    });
    // Trigger revision checkpoint (large delta > 120 chars)
    await storeA.updateItem(note.id, {
      body: 'Вторая версия документа: ' + 'подробное описание новых функций '.repeat(6),
    });
    const revs = storeA.listItemRevisions(note.id);
    expect(revs.length).toBeGreaterThanOrEqual(1);
    expect(revs[0]!.content).toBe('Первая версия документа');

    // Revert back to first revision (creates 'restore' checkpoint of second version!)
    const reverted = await storeA.revertItemToRevision(note.id, revs[0]!.id);
    expect(reverted?.body).toBe('Первая версия документа');
    expect(storeA.listItemRevisions(note.id).some((r) => r.source === 'restore')).toBe(true);

    // Also modify workspace_prefs (Kanban columns)
    await storeA.saveTaskBoardColumns([
      { id: 'inbox', title: 'Входящие', color: '#888888', order: 0 },
      { id: 'review', title: 'Ревью', color: '#4F86F7', order: 1 },
      { id: 'done', title: 'Готово', color: '#2EA06B', order: 2, isDone: true },
    ]);

    // Sync MUST succeed even though server returns 23514 for item_revision & workspace_prefs!
    const push = await engineA.syncNow();
    expect(push.ok).toBe(true);

    await engineB.syncNow();
    expect(storeB.getItemById(note.id)?.body).toBe('Первая версия документа');

    // Simulate concurrent edit conflict on Device B vs Device A -> losing text saved as 'sync_conflict'
    await storeB.updateItem(note.id, { body: 'Локальная правка на Device B' });
    await new Promise((r) => setTimeout(r, 10));
    await storeA.updateItem(note.id, { body: 'Более новая правка на Device A' });
    await engineA.syncNow();
    await engineB.syncNow();

    expect(storeB.getItemById(note.id)?.body).toBe('Более новая правка на Device A');
    const bRevs = storeB.listItemRevisions(note.id);
    expect(bRevs.some((r) => r.source === 'sync_conflict' && r.content === 'Локальная правка на Device B')).toBe(
      true
    );
  });

  it('recovers missed seq via reconcileFull() and isolates per-record failures via dead-letter retry', async () => {
    const cloud = createMockCloud();
    const userId = 'u-v8-deadletter';
    const email = 'dl@kapsula.app';

    const storeA = new MobileVaultStore({ memoryOnly: true });
    let failId = '';
    const engineA = new MobileSyncEngine({
      store: storeA,
      deviceName: 'Galaxy Fold',
      platform: 'android',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email, {
          get failOnceForEntityId() {
            return failId;
          },
        }),
    });
    await engineA.init();
    await engineA.signUp(email, 'account-pass');
    await engineA.setupPassphrase('StrongPassphraseV8!');

    const badNote = await storeA.createItem({ dna: 'note', title: 'Сбойная запись', body: 'A' });
    const goodNote = await storeA.createItem({ dna: 'note', title: 'Хорошая запись', body: 'B' });
    failId = badNote.id;

    // First sync: badNote fails once (dead-lettered), goodNote MUST STILL push cleanly!
    await engineA.syncNow();
    expect(cloud.records.has(`${userId}:item:${goodNote.id}`)).toBe(true);
    expect(cloud.records.has(`${userId}:item:${badNote.id}`)).toBe(false);
    expect(engineA.getStatus().failedDirtyCount).toBe(1);

    // reconcileFull() resets backoff/cursor, pushes previously failed record, and stamps lastReconcileAt
    const rec = await engineA.reconcileFull();
    expect(rec.ok).toBe(true);
    expect(cloud.records.has(`${userId}:item:${badNote.id}`)).toBe(true);
    expect(engineA.getStatus().lastReconcileAt).not.toBeNull();
    expect(engineA.getStatus().failedDirtyCount).toBe(0);
  });

  it('runs shared task-helpers Kanban engine (md:0/va:0 keys, moveTaskOnBoard Done invariant, per-task dueAt, synced columns)', async () => {
    const { storeA, engineA, storeB, engineB } = await setupSyncedPair();

    const note = await storeA.createItem({
      dna: 'note',
      title: 'Спринт v8',
      body: '- [ ] Первая задача\n- [ ] Вторая задача',
      mediaMeta: { actionItems: ['Позвонить дизайнеру'] },
    });

    const tasks = storeA.listVaultTasks();
    expect(tasks.map((t) => t.taskKey)).toEqual(['md:0', 'md:1', 'va:0']);
    expect(tasks[2]!.id).toBe(`${note.id}:va:0`); // canonical va: key, NOT legacy :voice:

    // Per-task dueAt & priority do NOT collide across tasks in the same note!
    const due1 = Date.now() + 86_400_000;
    const due2 = Date.now() + 172_800_000;
    await storeA.updateTaskMeta({
      itemId: note.id,
      taskKey: 'md:0',
      priority: 'high',
      dueAt: due1,
    });
    await storeA.updateTaskMeta({
      itemId: note.id,
      taskKey: 'md:1',
      priority: 'low',
      dueAt: due2,
    });
    const afterMeta = storeA.listVaultTasks();
    expect(afterMeta.find((t) => t.taskKey === 'md:0')?.dueAt).toBe(due1);
    expect(afterMeta.find((t) => t.taskKey === 'md:0')?.priority).toBe('high');
    expect(afterMeta.find((t) => t.taskKey === 'md:1')?.dueAt).toBe(due2);
    expect(afterMeta.find((t) => t.taskKey === 'md:1')?.priority).toBe('low');

    // Move task to 'in_progress', then to 'done' (auto-checks markdown!), then uncheck (restores 'in_progress'!)
    await storeA.moveTaskOnBoard({
      itemId: note.id,
      taskKey: 'md:0',
      columnId: 'in_progress',
      boardOrder: 10,
    });
    await storeA.moveTaskOnBoard({
      itemId: note.id,
      taskKey: 'md:0',
      columnId: 'done',
      boardOrder: 5,
    });
    let t0 = storeA.listVaultTasks().find((t) => t.taskKey === 'md:0')!;
    expect(t0.done).toBe(true);
    expect(t0.columnId).toBe('done');
    expect(storeA.getItemById(note.id)?.body).toContain('- [x] Первая задача');

    await storeA.toggleVaultTask(t0);
    t0 = storeA.listVaultTasks().find((t) => t.taskKey === 'md:0')!;
    expect(t0.done).toBe(false);
    expect(t0.columnId).toBe('in_progress');

    // Custom Kanban columns sync via workspace_prefs
    await storeA.saveTaskBoardColumns([
      { id: 'inbox', title: 'Бэклог', color: '#888888', order: 0 },
      { id: 'in_progress', title: 'В работе', color: '#E86A33', order: 1 },
      { id: 'qa', title: 'Проверка', color: '#9A75F5', order: 2 },
      { id: 'done', title: 'Готово', color: '#2EA06B', order: 3, isDone: true },
    ]);

    await engineA.syncNow();
    await engineB.syncNow();

    expect(storeB.listTaskBoardColumns().map((c) => c.id)).toEqual([
      'inbox',
      'in_progress',
      'qa',
      'done',
    ]);
    expect(storeB.listVaultTasks().find((t) => t.taskKey === 'md:0')?.columnId).toBe('in_progress');
  });

  it('supports Vault 2FA TOTP, Master PIN PBKDF2 backoff, encrypted AI key, and 10+ char E2EE passphrase', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    // 2FA TOTP with RFC 6238 test secret
    const secret = await store.upsertSecret({
      kind: 'password',
      title: 'GitHub',
      service: 'GitHub',
      login: 'dev@example.com',
      secretValue: 'super-secret-password',
      totpUriOrSecret: 'otpauth://totp/GitHub:dev@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      notes: 'Резервные коды в папке',
    });

    // SecretMeta indicates hasTotp without leaking raw totpSecret
    expect(secret.secretMeta?.hasTotp).toBe(true);
    expect(secret.secretMeta?.totpDigits).toBe(6);
    expect(secret.secretMeta?.totpPeriod).toBe(30);
    expect(JSON.stringify(secret.secretMeta)).not.toContain('JBSWY3DPEHPK3PXP');

    const nowMs = 1_700_000_000_000;
    const expected = generateTotp({ secret: 'JBSWY3DPEHPK3PXP', nowMs });
    const snap = await store.getTotpCode(secret.id, nowMs);
    expect(snap?.code).toBe(expected.code);
    expect(await store.getSecretFieldValue(secret.id, 'totp')).toMatch(/^\d{6}$/);
    expect(await store.getSecretFieldValue(secret.id, 'notes')).toBe('Резервные коды в папке');

    // Master PIN PBKDF2-SHA256 + persisted exponential backoff lockout after 5 wrong attempts
    expect(store.hasMasterPin()).toBe(false);
    await store.setMasterPin('4829');
    expect(store.hasMasterPin()).toBe(true);

    expect((await store.verifyMasterPinWithBackoff('4829')).ok).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      const fail = await store.verifyMasterPinWithBackoff('0000');
      expect(fail.ok).toBe(false);
    }
    const fifth = await store.verifyMasterPinWithBackoff('0000');
    expect(fifth.ok).toBe(false);
    expect(fifth.lockoutRemainingSec).toBeGreaterThan(0);

    // Even right PIN is rejected while lockout is active!
    const lockedAttempt = await store.verifyMasterPinWithBackoff('4829');
    expect(lockedAttempt.ok).toBe(false);
    expect(lockedAttempt.lockoutRemainingSec).toBeGreaterThan(0);

    // Encrypted Mobile AI key storage
    await store.setMobileAiConfig({ provider: 'google_ai_studio', googleKey: 'AIzaTestKey123' });
    expect(store.getMobileAiConfig()).toEqual({
      provider: 'google_ai_studio',
      hasGoogleKey: true,
      hasOpenRouterKey: false,
    });
    expect(await store.getMobileAiApiKey()).toEqual({
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey123',
    });

    // E2EE passphrase setup requires >= 10 chars while unlock preserves legacy 6+ char compat
    await expect(createKeyEnvelope('u1', 'short7', 100_000)).rejects.toThrow(/10/);
    const env = await createKeyEnvelope('u1', 'ValidPassphrase10!', 100_000);
    const dek = await unwrapDekWithPassphrase('u1', 'ValidPassphrase10!', env.envelope, 100_000);
    expect(dek.byteLength).toBe(32);
  });
});
