import { describe, expect, it } from 'vitest';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import type { SyncKeyEnvelopeRow, SyncRecordRow } from '@shared/sync-contract';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';

interface MockCloudState {
  envelopes: Map<string, SyncKeyEnvelopeRow>;
  records: Map<string, SyncRecordRow>;
  blobsMeta: Map<string, { user_id: string; blob_id: string; byte_size: number; ext: string }>;
  storage: Map<string, Uint8Array>;
  devices: Map<string, Record<string, unknown>>;
  seq: number;
}

function createMockCloud(): MockCloudState {
  return {
    envelopes: new Map(),
    records: new Map(),
    blobsMeta: new Map(),
    storage: new Map(),
    devices: new Map(),
    seq: 0,
  };
}

function createMockSupabaseClient(cloud: MockCloudState, userId: string, email: string): SupabaseClient {
  let signedIn = false;

  const makeQuery = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let maxRows = 1000;

    const getRows = (): Array<Record<string, unknown>> => {
      if (table === 'sync_key_envelopes') return Array.from(cloud.envelopes.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_records') return Array.from(cloud.records.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_blobs') return Array.from(cloud.blobsMeta.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_devices') return Array.from(cloud.devices.values());
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
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint 23505' } });
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
          // Mirror Postgres server-side LWW trigger
          if (
            prev &&
            (row.updated_at < prev.updated_at ||
              (row.updated_at === prev.updated_at && row.sync_version < prev.sync_version))
          ) {
            return Promise.resolve({ error: null });
          }
          cloud.seq += 1;
          cloud.records.set(key, { ...row, server_seq: cloud.seq });
        } else if (table === 'sync_blobs') {
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
        return { data: { session: { user: { id: userId, email } }, user: { id: userId, email } }, error: null };
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
              arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

describe('MobileSyncEngine E2EE end-to-end sync (Android <-> Second Device)', () => {
  it('syncs orbits, boards, bank cards with notes, markdown tasks, calendar events, and KAPS1 blobs zero-knowledge', async () => {
    const cloud = createMockCloud();
    const userId = 'u-fold-001';
    const email = 'user@kapsula.app';

    const storeA = new MobileVaultStore({ memoryOnly: true });
    const engineA = new MobileSyncEngine({
      store: storeA,
      deviceName: 'Samsung Galaxy Z Fold 6',
      platform: 'android',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });

    await engineA.init();
    const signUpA = await engineA.signUp(email, 'strong-password');
    expect(signUpA.ok).toBe(true);
    expect(signUpA.needsPassphraseSetup).toBe(true);

    const setupA = await engineA.setupPassphrase('МояСекретнаяФраза!');
    expect(setupA.ok).toBe(true);
    expect(setupA.recoveryKey).toMatch(/^KAPS-/);

    // Create full entity suite on Android Fold
    const orbit = await storeA.createOrbit({ name: 'Геймдев', color: '#E86A33', icon: 'GameController' });
    const board = await storeA.createBoard({ name: 'Идеи для Fold', color: '#2EA06B', icon: 'Sparkle' });

    const photoBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]);
    await storeA.saveMediaFile('fold-shot.png', 'image/png', photoBytes);
    const note = await storeA.createItem({
      dna: 'note',
      title: 'План релиза Android',
      body: '## Чеклист\n- [ ] Проверить сложенный экран\n- [x] Подключить облако',
      orbit: orbit.id,
      focusBoardId: board.id,
      imagePath: 'fold-shot.png',
    });

    const card = await storeA.upsertSecret({
      kind: 'bank_card',
      title: 'Альфа Travel',
      service: 'Альфа Travel',
      secretValue: '4276380012349876',
      expiry: '11/28',
      cvv: '905',
      cardHolder: 'ALEXEY PETROV',
      notes: 'Карта для авиабилетов и отелей, лимит 250к',
      orbit: orbit.id,
    });

    const cal = await storeA.upsertCalendarEvent({
      title: 'Тест на реальном Fold',
      notes: 'Проверить Share из Telegram',
      startAt: 1732100000000,
      endAt: 1732103600000,
      kind: 'event',
      recurrence: 'weekly',
      checklist: [{ id: 'ch1', text: 'Установить APK', done: false }],
    });

    const pushRes = await engineA.syncNow();
    expect(pushRes.ok).toBe(true);
    expect(pushRes.pushed).toBeGreaterThanOrEqual(5);
    expect(pushRes.blobsUploaded).toBe(1);

    // Zero-knowledge assertion: cloud contains NO plaintext secret, card number, comment, or image magic
    const allCipherDump = Array.from(cloud.records.values())
      .map((r) => `${r.payload_ciphertext}|${r.payload_iv}|${r.payload_tag}`)
      .join('\n');
    expect(allCipherDump).not.toContain('4276380012349876');
    expect(allCipherDump).not.toContain('авиабилетов');
    expect(allCipherDump).not.toContain('"cvv":"905"');
    expect(allCipherDump).not.toContain('ALEXEY PETROV');
    expect(allCipherDump).not.toContain('План релиза Android');

    const storedEncBlob = Array.from(cloud.storage.values())[0]!;
    expect(Buffer.from(storedEncBlob.subarray(0, 5)).toString('ascii')).toBe('KAPS1');
    expect(Buffer.from(storedEncBlob).includes(Buffer.from(photoBytes))).toBe(false);

    // Device roster records Android platform
    const devices = Array.from(cloud.devices.values());
    expect(devices[0]?.platform).toBe('android');

    // Device B logs in and unlocks with Recovery Key
    const storeB = new MobileVaultStore({ memoryOnly: true });
    const engineB = new MobileSyncEngine({
      store: storeB,
      deviceName: 'Windows Studio',
      platform: 'win32',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: (_u: string, _k: string, _s: SupportedStorage) =>
        createMockSupabaseClient(cloud, userId, email),
    });

    await engineB.init();
    const signInB = await engineB.signIn(email, 'strong-password');
    expect(signInB.ok).toBe(true);
    expect(signInB.needsPassphraseUnlock).toBe(true);

    const unlockB = await engineB.unlockWithRecoveryKey(setupA.recoveryKey!);
    expect(unlockB.ok).toBe(true);
    expect(unlockB.pulled).toBeGreaterThanOrEqual(5);
    expect(unlockB.blobsDownloaded).toBe(1);

    // Verify all entities arrived intact on Device B
    expect(storeB.listOrbits().map((o) => o.name)).toContain('Геймдев');
    expect(storeB.listBoards().map((b) => b.name)).toContain('Идеи для Fold');
    expect(storeB.listCalendarEvents().find((e) => e.id === cal.id)?.title).toBe('Тест на реальном Fold');

    const cardOnB = await storeB.revealSecret(card.id);
    expect(cardOnB?.secretValue).toBe('4276380012349876');
    expect(cardOnB?.cvv).toBe('905');
    expect(cardOnB?.expiry).toBe('11/28');
    expect(cardOnB?.notes).toBe('Карта для авиабилетов и отелей, лимит 250к');

    const blobOnB = storeB.getMediaFile('fold-shot.png');
    expect(blobOnB).not.toBeNull();
    expect(Array.from(blobOnB!.bytes)).toEqual(Array.from(photoBytes));

    // Toggle markdown task on Device B -> sync -> verify on Device A (Pull-Before-Push LWW)
    const tasksB = storeB.listVaultTasks();
    const firstTask = tasksB.find((t) => t.itemId === note.id && !t.done)!;
    expect(firstTask.text).toBe('Проверить сложенный экран');
    await storeB.toggleVaultTask(firstTask);
    await engineB.syncNow();

    const pullA = await engineA.syncNow();
    expect(pullA.ok).toBe(true);
    expect(pullA.pulled).toBeGreaterThanOrEqual(1);
    const updatedNoteA = storeA.getItemById(note.id)!;
    expect(updatedNoteA.body).toContain('- [x] Проверить сложенный экран');

    engineA.dispose();
    engineB.dispose();
  });
});
