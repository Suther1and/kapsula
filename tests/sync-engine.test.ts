import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SyncBlobRow,
  SyncKeyEnvelopeRow,
  SyncRecordRow,
} from '../src/shared/sync-contract';
import { VaultRepository } from '../src/main/db/repository';
import { VaultCrypto } from '../src/main/security/vault-crypto';
import { SyncEngine } from '../src/main/sync/sync-engine';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup lock
    }
  }
});

/**
 * In-memory Supabase simulator enforcing per-user isolation, monotonic server_seq,
 * storage bucket blob storage, and email/password auth for deterministic dual-device E2E tests.
 */
class InMemorySupabaseCloud {
  public seq = 0;
  public users = new Map<string, { id: string; email: string; password: string }>();
  public envelopes = new Map<string, SyncKeyEnvelopeRow>();
  public records = new Map<string, SyncRecordRow>(); // key: `${user_id}:${entity_type}:${entity_id}`
  public blobs = new Map<string, SyncBlobRow>(); // key: `${user_id}:${blob_id}`
  public devices = new Map<string, Record<string, unknown>>();
  public storageObjects = new Map<string, Buffer>(); // key: `${bucket}/${path}`

  public createClientForDevice(): SupabaseClient {
    let currentUser: { id: string; email: string } | null = null;
    const cloud = this;

    const auth = {
      async getSession() {
        return {
          data: {
            session: currentUser
              ? { access_token: 'mock-jwt', user: { id: currentUser.id, email: currentUser.email } }
              : null,
          },
          error: null,
        };
      },
      async signUp({ email, password }: { email: string; password: string }) {
        const key = email.toLowerCase();
        if (cloud.users.has(key)) {
          return { data: { user: null, session: null }, error: { message: 'User already registered' } };
        }
        const id = `11111111-2222-3333-4444-${String(cloud.users.size + 1).padStart(12, '0')}`;
        cloud.users.set(key, { id, email: key, password });
        currentUser = { id, email: key };
        return {
          data: {
            user: { id, email: key },
            session: { access_token: 'mock-jwt', user: { id, email: key } },
          },
          error: null,
        };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const u = cloud.users.get(email.toLowerCase());
        if (!u || u.password !== password) {
          return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
        }
        currentUser = { id: u.id, email: u.email };
        return {
          data: {
            user: { id: u.id, email: u.email },
            session: { access_token: 'mock-jwt', user: { id: u.id, email: u.email } },
          },
          error: null,
        };
      },
      async signOut() {
        currentUser = null;
        return { error: null };
      },
    };

    const from = (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitVal: number | null = null;

      const getRows = (): Array<Record<string, unknown>> => {
        if (!currentUser) return [];
        let arr: Array<Record<string, unknown>> = [];
        if (table === 'sync_key_envelopes') {
          const env = cloud.envelopes.get(currentUser.id);
          arr = env ? [env as unknown as Record<string, unknown>] : [];
        } else if (table === 'sync_records') {
          arr = Array.from(cloud.records.values())
            .filter((r) => r.user_id === currentUser!.id)
            .map((r) => ({ ...r }));
        } else if (table === 'sync_blobs') {
          arr = Array.from(cloud.blobs.values())
            .filter((r) => r.user_id === currentUser!.id)
            .map((r) => ({ ...r }));
        } else if (table === 'sync_devices') {
          arr = Array.from(cloud.devices.values()).filter((r) => r.user_id === currentUser!.id);
        }
        for (const f of filters) arr = arr.filter(f);
        if (orderCol) {
          const col = orderCol;
          arr.sort((a, b) => {
            const av = a[col] as number | string;
            const bv = b[col] as number | string;
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
          });
        }
        if (limitVal !== null) arr = arr.slice(0, limitVal);
        return arr;
      };

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        gt(col: string, val: number) {
          filters.push((r) => Number(r[col]) > val);
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit(n: number) {
          limitVal = n;
          return builder;
        },
        async maybeSingle() {
          const rows = getRows();
          return { data: rows[0] ?? null, error: null };
        },
        async insert(row: Record<string, unknown>) {
          if (!currentUser) return { error: { message: 'Not authenticated' } };
          if (table === 'sync_key_envelopes') {
            cloud.envelopes.set(currentUser.id, row as unknown as SyncKeyEnvelopeRow);
          }
          return { error: null };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, _val: unknown) {
              if (!currentUser) return { error: { message: 'Not authenticated' } };
              if (table === 'sync_key_envelopes') {
                const cur = cloud.envelopes.get(currentUser.id);
                if (cur) {
                  cloud.envelopes.set(currentUser.id, { ...cur, ...patch } as SyncKeyEnvelopeRow);
                }
              }
              return { error: null };
            },
          };
        },
        async upsert(row: Record<string, unknown>) {
          if (!currentUser) return { error: { message: 'Not authenticated' } };
          if (table === 'sync_records') {
            cloud.seq += 1;
            const full = {
              ...(row as unknown as SyncRecordRow),
              server_seq: cloud.seq,
            };
            const k = `${full.user_id}:${full.entity_type}:${full.entity_id}`;
            cloud.records.set(k, full);
          } else if (table === 'sync_blobs') {
            const b = row as unknown as SyncBlobRow;
            cloud.blobs.set(`${b.user_id}:${b.blob_id}`, b);
          } else if (table === 'sync_devices') {
            cloud.devices.set(`${row.user_id}:${row.device_id}`, row);
          }
          return { error: null };
        },
        then(resolve: (val: { data: unknown[]; error: null }) => void) {
          resolve({ data: getRows(), error: null });
        },
      };

      return builder;
    };

    const storage = {
      from(bucket: string) {
        return {
          async upload(objPath: string, body: Buffer) {
            cloud.storageObjects.set(`${bucket}/${objPath}`, Buffer.from(body));
            return { data: { path: objPath }, error: null };
          },
          async download(objPath: string) {
            const buf = cloud.storageObjects.get(`${bucket}/${objPath}`);
            if (!buf) return { data: null, error: { message: 'Not found' } };
            return {
              data: {
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              },
              error: null,
            };
          },
        };
      },
    };

    return { auth, from, storage } as unknown as SupabaseClient;
  }
}

function attachMockCloud(engine: SyncEngine, cloud: InMemorySupabaseCloud): void {
  (engine as unknown as { client: SupabaseClient }).client = cloud.createClientForDevice();
}

describe('Kapsula E2EE Sync Engine Dual-Device Integration (Story 1.3–1.6)', () => {
  it('syncs notes, orbits, boards, calendar, Vault secrets (cross-device re-wrap), media blobs, and tombstones with zero cloud plaintext', async () => {
    const cloud = new InMemorySupabaseCloud();

    // Device A (Windows)
    const dirA = makeTempDir('kapsula-dev-a-');
    const mediaDirA = path.join(dirA, 'media');
    fs.mkdirSync(mediaDirA, { recursive: true });
    const repoA = new VaultRepository(path.join(dirA, 'vault.sqlite'));
    const vaultCryptoA = new VaultCrypto(dirA);
    const syncA = new SyncEngine({
      dataDir: dirA,
      mediaDir: mediaDirA,
      repo: repoA,
      vaultCrypto: vaultCryptoA,
      deviceName: 'Windows-Studio',
      kdfIterationsOverride: 5_000,
      disableTimers: true,
      disableRealtime: true,
    });
    attachMockCloud(syncA, cloud);

    // Populate Device A BEFORE enabling sync (tests initial bulk enqueue + demo exclusion)
    const orbit = repoA.createOrbit({ name: 'Геймдев', description: 'Идеи для игры', color: '#E86A33', icon: 'GameController' });
    const board = repoA.createFocusBoard('Релиз v7', '#3B82F6', 'Rocket', 'План релиза');
    const imgBytes = Buffer.from('FAKE-PNG-BINARY-IMAGE-DATA-9876543210');
    fs.writeFileSync(path.join(mediaDirA, 'shot_1.png'), imgBytes);

    const noteItem = repoA.createItem({
      dna: 'note',
      orbit: orbit.id,
      focusBoardId: board.id,
      modeCaptured: 'autopilot',
      title: 'Архитектура боёвки',
      body: '- [ ] Сделать парирование\n- [x] Добавить хитстоп',
      imagePath: 'shot_1.png',
      tags: ['боёвка', 'дизайн'],
      source: 'vault_ui',
      contentHash: 'hash-note-1',
    });

    // Demo item MUST NOT sync
    repoA.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Демо-запись не должна улетать',
      body: 'demo',
      source: 'demo',
      contentHash: 'hash-demo-1',
      isDemo: true,
    });

    // Vault secret encrypted with Device A's local VaultCrypto
    const secretPlain = {
      service: 'Тинькофф Блэк',
      login: 'owner@example.com',
      secretValue: '5536 9138 1111 2222',
      notes: 'Основная карта',
      expiry: '08/29',
      cvv: '742',
    };
    const secretItem = repoA.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Карта Тинькофф',
      summary: 'Банковская карта · •••• 2222',
      encryptedPayload: vaultCryptoA.encryptSecret(secretPlain),
      secretMeta: {
        service: 'Тинькофф Блэк',
        loginHint: 'ow***@example.com',
        kind: 'bank_card',
        cardBrand: 'Mastercard',
        last4: '2222',
        hasCvv: true,
        expiry: '08/29',
        hasLogin: true,
      },
      source: 'vault_ui',
      contentHash: 'hash-secret-1',
    });

    const calEv = repoA.upsertCalendarEvent({
      title: 'Созвон с художником',
      notes: 'Обсудить шейдеры',
      startAt: Date.now() + 3_600_000,
      endAt: Date.now() + 7_200_000,
      kind: 'event',
    });

    // Sign up & setup E2EE on Device A
    const authA = await syncA.signUp('player@kapsula.app', 'super-account-pass');
    expect(authA.ok).toBe(true);
    expect(authA.needsPassphraseSetup).toBe(true);

    const setupA = await syncA.setupPassphrase('моя-фраза-шифрования');
    expect(setupA.ok).toBe(true);
    expect(setupA.recoveryKey).toMatch(/^KAPS-/);
    expect(syncA.getStatus().pendingCount).toBe(0);

    // ASSERT ZERO PLAINTEXT IN CLOUD POSTGRES & STORAGE!
    const allCloudJson = JSON.stringify(Array.from(cloud.records.values()));
    expect(allCloudJson).not.toContain('Архитектура боёвки');
    expect(allCloudJson).not.toContain('5536 9138');
    expect(allCloudJson).not.toContain('742');
    expect(allCloudJson).not.toContain('Созвон с художником');
    expect(allCloudJson).not.toContain('Демо-запись');
    // Demo item excluded -> exactly 1 orbit + 1 board + 2 items + 1 calendar event = 5 cloud records
    expect(cloud.records.size).toBe(5);
    expect(cloud.storageObjects.size).toBe(1);
    const storedBlob = Array.from(cloud.storageObjects.values())[0]!;
    expect(storedBlob.subarray(0, 5).toString('ascii')).toBe('KAPS1');
    expect(storedBlob.includes(imgBytes)).toBe(false);

    // Device B (Mac/Android simulation: fresh directory, separate VaultCrypto key!)
    const dirB = makeTempDir('kapsula-dev-b-');
    const mediaDirB = path.join(dirB, 'media');
    fs.mkdirSync(mediaDirB, { recursive: true });
    const repoB = new VaultRepository(path.join(dirB, 'vault.sqlite'));
    const vaultCryptoB = new VaultCrypto(dirB);
    const syncB = new SyncEngine({
      dataDir: dirB,
      mediaDir: mediaDirB,
      repo: repoB,
      vaultCrypto: vaultCryptoB,
      deviceName: 'MacBook-Pro',
      kdfIterationsOverride: 5_000,
      disableTimers: true,
      disableRealtime: true,
    });
    attachMockCloud(syncB, cloud);

    const authB = await syncB.signIn('player@kapsula.app', 'super-account-pass');
    expect(authB.ok).toBe(true);
    expect(authB.needsPassphraseUnlock).toBe(true);

    // Wrong passphrase rejected cleanly
    const badUnlock = await syncB.unlockWithPassphrase('неверная-фраза');
    expect(badUnlock.ok).toBe(false);

    // Correct passphrase unlocks & pulls EVERYTHING
    const goodUnlock = await syncB.unlockWithPassphrase('моя-фраза-шифрования');
    expect(goodUnlock.ok).toBe(true);
    expect(goodUnlock.pulled).toBe(5);
    expect(goodUnlock.blobsDownloaded).toBe(1);

    // Verify all entities arrived intact on Device B
    expect(repoB.listOrbits().some((o) => o.id === orbit.id && o.name === 'Геймдев')).toBe(true);
    expect(repoB.listFocusBoards().some((b) => b.id === board.id && b.name === 'Релиз v7')).toBe(true);
    const pulledNote = repoB.getItemById(noteItem.id);
    expect(pulledNote?.title).toBe('Архитектура боёвки');
    expect(pulledNote?.tags).toEqual(['боёвка', 'дизайн']);
    expect(repoB.listCalendarEvents().some((e) => e.id === calEv.id && e.title === 'Созвон с художником')).toBe(true);

    // Verify media file was decrypted bit-for-bit on Device B!
    const pulledImg = fs.readFileSync(path.join(mediaDirB, 'shot_1.png'));
    expect(pulledImg.equals(imgBytes)).toBe(true);

    // Verify Vault secret was re-wrapped with Device B's local VaultCrypto and decrypts cleanly!
    const rawSecretEncB = repoB.getRawEncryptedPayload(secretItem.id);
    expect(rawSecretEncB).toBeTruthy();
    const decryptedSecretOnB = vaultCryptoB.decryptSecret(rawSecretEncB!);
    expect(decryptedSecretOnB).toEqual(secretPlain);

    // Verify demo item never arrived
    expect(repoB.queryItems({ includeSecrets: true }).every((i) => !i.isDemo)).toBe(true);

    // Bidirectional update + soft-delete propagation (Device B edits note, deletes calendar event -> Device A receives)
    await new Promise((r) => setTimeout(r, 15));
    repoB.updateItem(noteItem.id, { title: 'Архитектура боёвки v2 (с Mac)' });
    repoB.deleteCalendarEvent(calEv.id);

    const pushB = await syncB.syncNow();
    expect(pushB.ok).toBe(true);
    // noteItem + auto-checkpointed item_revision + deleted calendar_event
    expect(pushB.pushed).toBe(3);

    const pullA = await syncA.syncNow();
    expect(pullA.ok).toBe(true);
    expect(pullA.pulled).toBe(3);
    expect(repoA.getItemById(noteItem.id)?.title).toBe('Архитектура боёвки v2 (с Mac)');
    expect(repoA.listCalendarEvents().some((e) => e.id === calEv.id)).toBe(false);

    // Device C unlocks using ONLY the printed Recovery Key + rotates passphrase
    const dirC = makeTempDir('kapsula-dev-c-');
    const mediaDirC = path.join(dirC, 'media');
    fs.mkdirSync(mediaDirC, { recursive: true });
    const repoC = new VaultRepository(path.join(dirC, 'vault.sqlite'));
    const vaultCryptoC = new VaultCrypto(dirC);
    const syncC = new SyncEngine({
      dataDir: dirC,
      mediaDir: mediaDirC,
      repo: repoC,
      vaultCrypto: vaultCryptoC,
      deviceName: 'Android-Phone',
      kdfIterationsOverride: 5_000,
      disableTimers: true,
      disableRealtime: true,
    });
    attachMockCloud(syncC, cloud);
    await syncC.signIn('player@kapsula.app', 'super-account-pass');
    const recRes = await syncC.unlockWithRecoveryKey(setupA.recoveryKey!, 'новая-фраза-2027');
    expect(recRes.ok).toBe(true);
    expect(repoC.getItemById(noteItem.id)?.title).toBe('Архитектура боёвки v2 (с Mac)');
    expect(vaultCryptoC.decryptSecret(repoC.getRawEncryptedPayload(secretItem.id)!)).toEqual(secretPlain);

    // Device roster reflects all 3 connected devices
    expect(syncC.getStatus().devices.length).toBe(3);

    // C1 regression: Pull-before-Push prevents stale offline edit from overwriting newer cloud edit
    // Device A edits offline (older timestamp) while Device B edits online (newer timestamp) and pushes first
    repoA.updateItem(noteItem.id, { title: 'Устаревшая правка с A' });
    await new Promise((r) => setTimeout(r, 25));
    repoB.updateItem(noteItem.id, { title: 'Свежая правка с B (победитель)' });
    const pushB2 = await syncB.syncNow();
    expect(pushB2.ok).toBe(true);

    const syncA2 = await syncA.syncNow();
    expect(syncA2.ok).toBe(true);
    // Device A pulled B's newer edit first, cleared its stale dirty entry, and converged cleanly!
    expect(repoA.getItemById(noteItem.id)?.title).toBe('Свежая правка с B (победитель)');
    expect(syncA.getStatus().pendingCount).toBe(0);

    // H6 regression: regenerateRecoveryKey works on active session and invalidates old key
    const regen = await syncC.regenerateRecoveryKey();
    expect(regen.ok).toBe(true);
    expect(regen.recoveryKey).toMatch(/^KAPS-/);
    expect(regen.recoveryKey).not.toBe(setupA.recoveryKey);

    // C3 regression: corrupted local VaultCrypto payload MUST abort push instead of wiping cloud secret
    repoA.db.prepare('UPDATE items SET encrypted_payload = ? WHERE id = ?').run('{"corrupt":true}', secretItem.id);
    repoA.markDirty('item', secretItem.id);
    const failPush = await syncA.syncNow();
    expect(failPush.ok).toBe(false);
    // Device B's secret in cloud & locally stays 100% intact!
    await syncB.syncNow();
    expect(vaultCryptoB.decryptSecret(repoB.getRawEncryptedPayload(secretItem.id)!)).toEqual(secretPlain);

    syncA.dispose();
    syncB.dispose();
    syncC.dispose();
    repoA.close();
    repoB.close();
    repoC.close();
  });
});
