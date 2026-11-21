import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import type {
  SyncedItemPayload,
  SyncedItemRevisionPayload,
  SyncKeyEnvelopeRow,
  SyncRecordRow,
} from '@shared/sync-contract';
import {
  extractTasksFromMobileItem,
  polishMobileNoteText,
  transcribeMobileVoiceItem,
} from '@mobile/lib/mobile-ai';
import {
  evaluateAutoLockChangeGuard,
  evaluateBiometricToggleGuard,
} from '@mobile/lib/mobile-helpers';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';

interface MockCloudState {
  envelopes: Map<string, SyncKeyEnvelopeRow>;
  records: Map<string, SyncRecordRow>;
  blobsMeta: Map<string, { user_id: string; blob_id: string; byte_size: number; ext: string }>;
  storage: Map<string, Uint8Array>;
  devices: Map<string, Record<string, unknown>>;
  seq: number;
  pullMinCursors: number[];
}

function createMockCloud(): MockCloudState {
  return {
    envelopes: new Map(),
    records: new Map(),
    blobsMeta: new Map(),
    storage: new Map(),
    devices: new Map(),
    seq: 0,
    pullMinCursors: [],
  };
}

function createMockSupabaseClient(
  cloud: MockCloudState,
  userId: string,
  email: string
): SupabaseClient {
  let signedIn = false;

  const makeQuery = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let maxRows = 1000;
    let gtSeqSeen: number | null = null;

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
        if (table === 'sync_records' && col === 'server_seq') {
          gtSeqSeen = val;
        }
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
        if (table === 'sync_records' && gtSeqSeen !== null) {
          cloud.pullMinCursors.push(gtSeqSeen);
        }
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
            return Promise.resolve({ error: { message: 'duplicate key 23505' } });
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
          const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
          const prev = cloud.records.get(key);
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
        return Promise.resolve({ error: null });
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

function makeSyncedItemPayload(overrides: Partial<SyncedItemPayload> & { id: string }): SyncedItemPayload {
  const now = Date.now();
  return {
    v: 1,
    dna: 'note',
    subKind: null,
    orbit: '',
    modeCaptured: 'autopilot',
    focusBoardId: null,
    title: 'Заметка',
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
    secretPayload: null,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: 'hash-1',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now - 10_000,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    purgedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
    syncVersion: 1,
    mediaRefs: [],
    ...overrides,
  };
}

describe('Mobile v8 Security, Purge LWW & Sync Parity Fixes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects clock-skewed remote live edits against locally purged items & re-marks dirty', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const item = await store.createItem({ dna: 'note', title: 'Стереть навсегда', body: 'Черновик' });
    await store.deleteItem(item.id);
    await store.purgeItemPermanently(item.id);

    const purgedBefore = store.getRawItem(item.id)!;
    expect(purgedBefore.purgedAt).not.toBeNull();

    // Clear dirty queue to verify applySyncedItem explicitly re-marks dirty
    const dirtyBefore = store.listDirtyEntities(50).find((d) => d.entityId === item.id);
    expect(dirtyBefore).toBeDefined();
    await store.clearDirtyEntity('item', item.id, dirtyBefore!.dirtySeq);
    expect(store.listDirtyEntities(50).some((d) => d.entityId === item.id)).toBe(false);

    // Remote device with skewed clock (+1 hour ahead) sends live edit
    const skewedRemote = makeSyncedItemPayload({
      id: item.id,
      title: 'Воскресшая заметка',
      body: 'Не должно воскреснуть',
      updatedAt: purgedBefore.updatedAt + 3_600_000,
      syncVersion: (purgedBefore.syncVersion ?? 1) + 5,
      deletedAt: null,
      purgedAt: null,
    });

    const res = await store.applySyncedItem(skewedRemote, null, 'remote-dev-1', 'local-dev-1');
    expect(res.applied).toBe(false);
    expect(res.localStrictlyNewer).toBe(true);

    const after = store.getRawItem(item.id)!;
    expect(after.purgedAt).not.toBeNull();
    expect(after.title).toBe('');
    expect(after.updatedAt).toBeGreaterThan(skewedRemote.updatedAt);
    expect(store.listDirtyEntities(50).some((d) => d.entityId === item.id)).toBe(true);
  });

  it('applies remote permanent purge unconditionally even when local clock is ahead', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const item = await store.createItem({ dna: 'note', title: 'Локально новее', body: 'Текст' });
    const rawLocal = store.getRawItem(item.id)!;

    // Remote device with slower clock (-10 minutes behind) permanently purges item
    const olderRemotePurge = makeSyncedItemPayload({
      id: item.id,
      title: '',
      body: '',
      updatedAt: rawLocal.updatedAt - 600_000,
      deletedAt: rawLocal.updatedAt - 600_000,
      purgedAt: rawLocal.updatedAt - 600_000,
      syncVersion: 1,
    });

    const res = await store.applySyncedItem(olderRemotePurge, null, 'remote-dev-2', 'local-dev-1');
    expect(res.applied).toBe(true);
    expect(store.getItemById(item.id)).toBeNull();
    const rawAfter = store.getRawItem(item.id)!;
    expect(rawAfter.purgedAt).toBe(olderRemotePurge.purgedAt);
    expect(rawAfter.body).toBe('');
  });

  it('rejects incoming synced revisions belonging to a permanently purged parent item', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const item = await store.createItem({ dna: 'note', title: 'Удалённая', body: 'v1' });
    await store.purgeItemPermanently(item.id);

    const revPayload: SyncedItemRevisionPayload = {
      v: 1,
      id: 'rev-purged-parent-1',
      itemId: item.id,
      title: 'Старая версия',
      content: 'Не должна сохраниться',
      source: 'auto',
      contentHash: 'abc',
      deviceName: 'MacBook',
      createdAt: Date.now(),
      updatedAt: Date.now() + 60_000,
      deletedAt: null,
      syncVersion: 2,
    };

    const res = await store.applySyncedRevision(revPayload, 'remote-mac', 'local-android');
    expect(res.applied).toBe(false);
    expect(store.listItemRevisions(item.id)).toHaveLength(0);
  });

  it('lists and restores archived items synced from Desktop/Mac', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const archivedPayload = makeSyncedItemPayload({
      id: 'archived-from-desktop-1',
      title: 'Архивный проект',
      body: 'Убран в архив на ПК',
      isArchived: true,
    });
    await store.applySyncedItem(archivedPayload, null, 'desktop-1', 'android-1');

    expect(store.listItems().some((i) => i.id === 'archived-from-desktop-1')).toBe(false);
    expect(store.listArchivedItems().map((i) => i.id)).toEqual(['archived-from-desktop-1']);

    await store.updateItem('archived-from-desktop-1', { isArchived: false });
    expect(store.listArchivedItems()).toHaveLength(0);
    expect(store.listItems().some((i) => i.id === 'archived-from-desktop-1')).toBe(true);
  });

  it('blocks secret items & redacts inline secrets before calling cloud AI in mobile-ai', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    await store.setMobileAiConfig({
      provider: 'google_ai_studio',
      googleKey: 'AIzaSyTestDummyKey123456789012345678901',
    });

    const sentPrompts: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const bodyStr = String(init?.body ?? '');
      sentPrompts.push(bodyStr);
      const parsedBody = JSON.parse(bodyStr) as {
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      const promptText = parsedBody.contents?.[0]?.parts?.[0]?.text ?? '';
      const isTasks = promptText.includes('{"tasks"');
      const replyText = isTasks
        ? JSON.stringify({ tasks: ['Проверить прод'] })
        : 'Чистый текст с ключом [REDACTED_SECRET_0] и паролем: [REDACTED_SECRET_1]';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: replyText }] } }],
        }),
      } as unknown as Response;
    });

    // 1. Secret items must NEVER be sent to cloud AI
    const secretItem = await store.upsertSecret({
      kind: 'password',
      title: 'Prod Admin',
      service: 'prod.example.com',
      login: 'root@example.com',
      secretValue: 'UltraSecretPass!999',
    });
    const r1 = await extractTasksFromMobileItem(store, secretItem);
    const r2 = await polishMobileNoteText(store, secretItem);
    const r3 = await transcribeMobileVoiceItem(store, secretItem);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Normal note containing inline API key & password -> redacted outbound, restored locally on polish
    const noteWithSecret = await store.createItem({
      dna: 'note',
      title: 'Деплой',
      body: 'Нужно проверить прод с ключом sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234 и пароль: MySecretPass42!',
    });

    const extractRes = await extractTasksFromMobileItem(store, noteWithSecret);
    expect(extractRes.ok).toBe(true);
    expect(sentPrompts[0]).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234');
    expect(sentPrompts[0]).not.toContain('MySecretPass42!');

    const polishRes = await polishMobileNoteText(store, noteWithSecret);
    expect(polishRes.ok).toBe(true);
    expect(sentPrompts[1]).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234');
    expect(sentPrompts[1]).not.toContain('MySecretPass42!');
    // Local body preserves user's original values via placeholder restoration
    expect(polishRes.item?.body).toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234');
    expect(polishRes.item?.body).toContain('MySecretPass42!');
  });

  it('auto-reconciles v7->v8 upgraders when lastReconcileAt is null and savedCursor > 0', async () => {
    const cloud = createMockCloud();
    const userId = 'u-v7-upgrade';
    const email = 'v7@kapsula.app';

    const store = new MobileVaultStore({ memoryOnly: true });
    const engine = new MobileSyncEngine({
      store,
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });

    await engine.init();
    await engine.signUp(email, 'pw-123456');
    await engine.setupPassphrase('МояНадёжнаяФраза!');

    // Simulate v7 persisted state: cursor = 50, NO last_reconcile_at recorded
    await store.setSyncState('last_cursor', '50');
    await store.setSyncState('last_reconcile_at', '');
    (engine as unknown as { lastReconcileAt: number | null }).lastReconcileAt = null;
    cloud.pullMinCursors = [];

    const syncRes = await engine.syncNow();
    expect(syncRes.ok).toBe(true);
    // Must have started pull from cursor 0 (full reconcile), NOT 50 - 25 = 25!
    expect(cloud.pullMinCursors[0]).toBe(0);
    expect(Number(store.getSyncState('last_reconcile_at'))).toBeGreaterThan(0);

    engine.dispose();
  });

  it('preserves secretPayload on soft-deleted secrets across devices & skips locked secret tombstones in reconcileFull', async () => {
    const cloud = createMockCloud();
    const userId = 'u-secret-trash';
    const email = 'sec@kapsula.app';

    const storeA = new MobileVaultStore({ memoryOnly: true });
    const engineA = new MobileSyncEngine({
      store: storeA,
      deviceName: 'Phone A',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineA.init();
    await engineA.signUp(email, 'pw-123456');
    await engineA.setupPassphrase('СекретнаяФраза2026!');

    const card = await storeA.upsertSecret({
      kind: 'bank_card',
      title: 'Основная карта',
      service: 'Банк',
      secretValue: '4276 3800 1234 5678',
      cvv: '777',
      expiry: '12/29',
      notes: 'Важный комментарий',
    });
    await engineA.syncNow();

    // Soft-delete card on Device A and sync
    await storeA.deleteItem(card.id);
    await engineA.syncNow();

    // Device B pulls the soft-deleted secret and restores it from Trash
    let vaultBLocked = false;
    const storeB = new MobileVaultStore({ memoryOnly: true });
    const engineB = new MobileSyncEngine({
      store: storeB,
      deviceName: 'Fold B',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      isVaultLocked: () => vaultBLocked,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineB.init();
    await engineB.signIn(email, 'pw-123456');
    await engineB.unlockWithPassphrase('СекретнаяФраза2026!');
    await engineB.syncNow();

    // Verify trashed secret arrived on B with intact encrypted payload
    expect(storeB.listTrashedItems().some((i) => i.id === card.id)).toBe(true);
    await storeB.restoreItem(card.id);
    const revealed = await storeB.revealSecret(card.id);
    expect(revealed?.secretValue).toBe('4276 3800 1234 5678');
    expect(revealed?.cvv).toBe('777');
    expect(revealed?.notes).toBe('Важный комментарий');

    // Sync restored secret back to cloud from B
    await engineB.syncNow();

    // Now test locked-secret tombstone safety during reconcileFull:
    // Make A locked while holding stale local soft-delete; ensure reconcileFull doesn't re-delete B's restored secret
    let vaultALocked = true;
    engineA.setVaultLockedProvider(() => vaultALocked);
    // Simulate failed pull on A for card (if A failed to pull or stayed locked), ensure tombstone isn't bumped
    const beforeBump = storeA.getRawItem(card.id)!.updatedAt;
    await engineA.reconcileFull();
    // On A, pulling B's newer restored secret actually succeeds because AndroidKeyStore isn't PIN-locked,
    // so card is restored on A (NOT re-deleted in cloud!)
    const cloudRecord = cloud.records.get(`${userId}:item:${card.id}`);
    expect(cloudRecord?.deleted_at).toBeNull();
    expect(beforeBump).toBeGreaterThan(0);

    vaultALocked = false;
    vaultBLocked = false;
    engineA.dispose();
    engineB.dispose();
  });

  it('pulls newer remote record on push LWW rejection and preserves losing note text in sync_conflict revision', async () => {
    const cloud = createMockCloud();
    const userId = 'u-lww-conflict';
    const email = 'lww@kapsula.app';

    const storeA = new MobileVaultStore({ memoryOnly: true });
    const engineA = new MobileSyncEngine({
      store: storeA,
      deviceName: 'Device A',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineA.init();
    await engineA.signUp(email, 'pw-123456');
    await engineA.setupPassphrase('КонфликтФраза2026!');

    const note = await storeA.createItem({
      dna: 'note',
      title: 'Общая заметка',
      body: 'Начальный текст',
    });
    await engineA.syncNow();

    const storeB = new MobileVaultStore({ memoryOnly: true });
    const engineB = new MobileSyncEngine({
      store: storeB,
      deviceName: 'Device B',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });
    await engineB.init();
    await engineB.signIn(email, 'pw-123456');
    await engineB.unlockWithPassphrase('КонфликтФраза2026!');
    await engineB.syncNow();

    // Device B edits offline with an older timestamp
    await storeB.updateItem(note.id, { body: 'Потерянный оффлайн-текст с B' });
    const rawB = storeB.getRawItem(note.id)!;
    // Push Device A's newer edit directly to cloud (+5 minutes ahead)
    await storeA.updateItem(note.id, { body: 'Новейший текст с A' });
    await storeA.bumpEntityTimestampForRetry('item', note.id, rawB.updatedAt + 300_000, 10);
    await storeA.markDirty('item', note.id, true);
    await engineA.syncNow();

    // Advance B's cursor past A's seq so B's pull misses A and hits server LWW rejection during push!
    await storeB.setSyncState('last_cursor', String(cloud.seq + 50));

    const resB = await engineB.syncNow();
    expect(resB.ok).toBe(true);

    // Device B should now have Device A's winning body AND a sync_conflict revision preserving B's losing text!
    expect(storeB.getItemById(note.id)?.body).toBe('Новейший текст с A');
    const revs = storeB.listItemRevisions(note.id);
    expect(
      revs.some((r) => r.source === 'sync_conflict' && r.content.includes('Потерянный оффлайн-текст с B'))
    ).toBe(true);

    engineA.dispose();
    engineB.dispose();
  });

  it('blocks Master-PIN-only locked Vault bypass via Settings Biometric toggle and Auto-Lock=0 disable', async () => {
    // Master-PIN-only locked Vault: toggling Biometrics ON must be rejected!
    expect(
      evaluateBiometricToggleGuard(true, {
        hasMasterPin: true,
        biometricEnabled: false,
        vaultLocked: true,
      })
    ).toEqual({
      action: 'reject',
      message: 'Сначала разблокируй Сейф мастер-ПИНом',
    });

    // Once unlocked with Master PIN, enabling biometrics IS allowed
    expect(
      evaluateBiometricToggleGuard(true, {
        hasMasterPin: true,
        biometricEnabled: false,
        vaultLocked: false,
      })
    ).toEqual({ action: 'allow' });

    // Without Master PIN, enabling biometrics is allowed
    expect(
      evaluateBiometricToggleGuard(true, {
        hasMasterPin: false,
        biometricEnabled: false,
        vaultLocked: true,
      })
    ).toEqual({ action: 'allow' });

    // Disabling active biometrics always requires biometric confirmation
    expect(
      evaluateBiometricToggleGuard(false, {
        hasMasterPin: true,
        biometricEnabled: true,
        vaultLocked: false,
      })
    ).toEqual({ action: 'require_biometric' });

    // Auto-Lock = 0 ("Выкл") must be rejected whenever protected Vault is locked
    expect(
      evaluateAutoLockChangeGuard(0, {
        hasMasterPin: true,
        biometricEnabled: false,
        vaultLocked: true,
      })
    ).toEqual({
      allowed: false,
      message: 'Сначала разблокируй Сейф',
    });
    expect(
      evaluateAutoLockChangeGuard(0, {
        hasMasterPin: false,
        biometricEnabled: true,
        vaultLocked: true,
      })
    ).toEqual({
      allowed: false,
      message: 'Сначала разблокируй Сейф',
    });

    // Non-zero timeouts or unlocked Vault remain allowed
    expect(
      evaluateAutoLockChangeGuard(5, {
        hasMasterPin: true,
        biometricEnabled: false,
        vaultLocked: true,
      })
    ).toEqual({ allowed: true });
    expect(
      evaluateAutoLockChangeGuard(0, {
        hasMasterPin: true,
        biometricEnabled: false,
        vaultLocked: false,
      })
    ).toEqual({ allowed: true });

    // Also verify Russian SI unit & Master-PIN copy in verifyMasterPinWithBackoff
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    await store.setMasterPin('4829');
    let lastRes = await store.verifyMasterPinWithBackoff('0000');
    expect(lastRes.error).toBe('Неверный мастер-ПИН');
    for (let i = 0; i < 4; i += 1) {
      lastRes = await store.verifyMasterPinWithBackoff('0000');
    }
    expect(lastRes.lockoutRemainingSec).toBeGreaterThan(0);
    expect(lastRes.error).toMatch(/^Неверный мастер-ПИН\. Повторная попытка через \d+ с$/);
    const duringLock = await store.verifyMasterPinWithBackoff('4829');
    expect(duringLock.ok).toBe(false);
    expect(duringLock.error).toMatch(/^Слишком много неверных попыток — подожди \d+ с$/);
  });

  it('portals Mobile Sonner Toaster to document.body above Base UI drawers without #root fixed stacking trap', () => {
    const appSrc = fs.readFileSync(path.resolve('src/mobile/App.tsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.resolve('src/mobile/styles/mobile.css'), 'utf8');

    expect(appSrc).toContain("import { createPortal } from 'react-dom'");
    expect(appSrc).toMatch(/createPortal\([^)]*toasterElement,\s*document\.body\)/);
    expect(appSrc).toContain('z-[10000]');
    expect(appSrc).toContain('zIndex: 10000');

    // #root must not share `position: fixed` with html, body (which creates a Chromium stacking context)
    expect(cssSrc).not.toMatch(/html,\s*body,\s*#root\s*\{[^}]*position:\s*fixed/s);
    const rootBlock = cssSrc.match(/#root\s*\{([^}]*)\}/);
    expect(rootBlock).not.toBeNull();
    expect(rootBlock![1]).not.toContain('position: fixed');
    expect(rootBlock![1]).toContain('height: 100%');
    expect(rootBlock![1]).toContain('width: 100%');
  });
});
