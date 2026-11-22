import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import type { SyncKeyEnvelopeRow, SyncRecordRow } from '@shared/sync-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importArchiveFromPath } from '@main/bridges/archive-importer';
import { ClipperServer } from '@main/bridges/clipper-server';
import { GoogleCalendarBridge } from '@main/bridges/google-calendar';
import { VaultRepository } from '@main/db/repository';
import { CapturePipeline } from '@main/pipeline/capture-pipeline';
import { saveDocumentAsset } from '@main/pipeline/document-pipeline';
import { redactSecrets, sanitizeForCloudAi } from '@main/security/secret-shield';
import { VaultCrypto } from '@main/security/vault-crypto';
import { SyncEngine } from '@main/sync/sync-engine';
import { evaluateBiometricToggleGuard } from '@mobile/lib/mobile-helpers';
import { MobileVaultStore } from '@mobile/storage/mobile-store';
import { MobileSyncMediaManager } from '@mobile/sync/mobile-media';
import { MobileSyncEngine } from '@mobile/sync/mobile-sync-engine';
import { isPrivateOrLocalHostname } from '@shared/url-safety';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix = 'kapsula-w1-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()!();
    } catch {
      // ignore cleanup error
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
});

interface MockCloud {
  envelopes: Map<string, SyncKeyEnvelopeRow>;
  records: Map<string, SyncRecordRow>;
  blobsMeta: Map<string, { user_id: string; blob_id: string; byte_size: number; ext: string }>;
  storage: Map<string, Uint8Array>;
  devices: Map<string, Record<string, unknown>>;
  seq: number;
  failNextBlobMetaUpsert?: boolean;
}

function createMockCloud(): MockCloud {
  return {
    envelopes: new Map(),
    records: new Map(),
    blobsMeta: new Map(),
    storage: new Map(),
    devices: new Map(),
    seq: 0,
  };
}

function createMockSupabase(
  cloud: MockCloud,
  users: Map<string, { id: string; email: string; password: string }>
): SupabaseClient {
  let currentUser: { id: string; email: string } | null = null;

  const makeTable = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let maxRows = 1000;

    const rowsFor = (): Array<Record<string, unknown>> => {
      if (table === 'sync_key_envelopes') return Array.from(cloud.envelopes.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_records') return Array.from(cloud.records.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_blobs') return Array.from(cloud.blobsMeta.values()) as unknown as Array<Record<string, unknown>>;
      if (table === 'sync_devices') return Array.from(cloud.devices.values());
      return [];
    };

    const runSelect = () => {
      let out = rowsFor().filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const col = orderCol;
        out = [...out].sort((a, b) => {
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
      return out.slice(0, maxRows);
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      gt: (col: string, val: number) => {
        filters.push((r) => Number(r[col] ?? 0) > val);
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      },
      limit: (n: number) => {
        maxRows = n;
        return Promise.resolve({ data: runSelect(), error: null });
      },
      maybeSingle: () => Promise.resolve({ data: runSelect()[0] ?? null, error: null }),
      insert: (payload: Record<string, unknown>) => {
        if (table === 'sync_key_envelopes') {
          const row = payload as unknown as SyncKeyEnvelopeRow;
          cloud.envelopes.set(row.user_id, row);
        }
        return Promise.resolve({ error: null });
      },
      delete: () => {
        const delFilters: Array<(row: Record<string, unknown>) => boolean> = [];
        const delChain: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            delFilters.push((r) => r[col] === val);
            return delChain;
          },
          in: (col: string, vals: unknown[]) => {
            const set = new Set(vals);
            delFilters.push((r) => set.has(r[col]));
            if (table === 'sync_blobs') {
              for (const [k, row] of Array.from(cloud.blobsMeta.entries())) {
                if (delFilters.every((f) => f(row as unknown as Record<string, unknown>))) {
                  cloud.blobsMeta.delete(k);
                }
              }
            }
            return Promise.resolve({ error: null });
          },
        };
        return delChain;
      },
      upsert: (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (table === 'sync_blobs') {
          if (cloud.failNextBlobMetaUpsert) {
            cloud.failNextBlobMetaUpsert = false;
            return Promise.resolve({ error: { message: 'simulated sync_blobs constraint failure' } });
          }
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) {
            const r = row as { user_id: string; blob_id: string; byte_size: number; ext: string };
            cloud.blobsMeta.set(`${r.user_id}:${r.blob_id}`, r);
          }
          return Promise.resolve({ error: null });
        }
        if (table === 'sync_devices') {
          const row = payload as Record<string, unknown>;
          cloud.devices.set(`${row.user_id}:${row.device_id}`, row);
          return Promise.resolve({ error: null });
        }
        if (table === 'sync_records') {
          const row = payload as unknown as SyncRecordRow;
          const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
          cloud.seq += 1;
          const stored: SyncRecordRow = {
            ...row,
            server_seq: cloud.seq,
            server_updated_at: new Date().toISOString(),
          };
          cloud.records.set(key, stored);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: stored, error: null }),
            }),
          };
        }
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  };

  return {
    auth: {
      getSession: async () => ({
        data: { session: currentUser ? { user: currentUser, access_token: 'tok' } : null },
        error: null,
      }),
      signUp: async ({ email, password }: { email: string; password: string }) => {
        const clean = email.toLowerCase();
        const id = `u-${clean}`;
        users.set(clean, { id, email: clean, password });
        currentUser = { id, email: clean };
        return { data: { user: currentUser, session: { user: currentUser, access_token: 'tok' } }, error: null };
      },
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const user = users.get(email.toLowerCase());
        if (!user || user.password !== password) {
          return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
        }
        currentUser = { id: user.id, email: user.email };
        return { data: { user: currentUser, session: { user: currentUser, access_token: 'tok' } }, error: null };
      },
      signOut: async () => {
        currentUser = null;
        return { error: null };
      },
    },
    from: (table: string) => makeTable(table),
    storage: {
      from: () => ({
        upload: async (storagePath: string, bytes: Uint8Array) => {
          cloud.storage.set(storagePath, new Uint8Array(bytes));
          return { error: null };
        },
        download: async (storagePath: string) => {
          const buf = cloud.storage.get(storagePath);
          if (!buf) return { data: null, error: { message: 'Object not found (404)' } };
          return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) cloud.storage.delete(p);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

describe('Wave 1 Security, Vault, Bridges & Isolation Hardening', () => {
  it('redacts multiline PEM keys + case-insensitive bearer tokens and fails closed on unredacted cloud AI secrets', () => {
    const pemAndBearer = [
      'Authorization: bearer SuperSecretTokenValue_123456',
      '-----BEGIN PRIVATE KEY-----',
      'SYNTHETIC-TEST-PEM-BODY-LINE-1',
      'line-2-secret-material',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    const redacted = redactSecrets(pemAndBearer);
    expect(redacted).not.toContain('SuperSecretTokenValue_123456');
    expect(redacted).not.toContain('line-2-secret-material');
    expect(redacted).toContain('[REDACTED_TOKEN]');
    expect(redacted).toContain('[REDACTED_SECRET]');

    // Clean prose with redacted tokens passes safely without leaking values
    const safeCheck = sanitizeForCloudAi(pemAndBearer, 'ru');
    expect(safeCheck.safe).toBe(true);
    expect(safeCheck.text).not.toContain('line-2-secret-material');

    // Residual pattern that analyzeForSecret detects even after redactSecrets must FAIL CLOSED
    const residual = sanitizeForCloudAi('dev@kapsula.app/MySuperSecret99!', 'ru');
    expect(residual.safe).toBe(false);
    expect(residual.text).toBe('');
    expect(residual.reason).toBeTruthy();
  });

  it('excludes Vault secrets from items_fts search index and wipes user data on wipeAllUserData while keeping device_id', () => {
    const dir = makeTempDir();
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    cleanups.push(() => repo.close());

    repo.setSyncState('device_id', 'dev-preserve-01');
    repo.createItem({
      id: 'sec-fts-1',
      dna: 'secret',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'UniqueSecretVaultTitleXYZ',
      body: 'UniqueSecretBodyToken9988',
      encryptedPayload: 'v1:enc:opaque',
      secretMeta: { kind: 'password', service: 'Bank', loginHint: 'u***', hasLogin: true },
      source: 'vault_ui',
      contentHash: 'sec-fts-hash',
    });
    repo.createItem({
      id: 'note-fts-1',
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Обычная рабочая заметка',
      body: 'Поиск по заметкам должен работать',
      source: 'vault_ui',
      contentHash: 'note-fts-hash',
    });

    // FTS & AI RAG must find normal note and must NEVER index secret items into items_fts
    expect(repo.queryItems({ search: 'заметкам' }).map((i) => i.id)).toContain('note-fts-1');
    const ftsMatch = repo.db
      .prepare("SELECT id FROM items_fts WHERE items_fts MATCH 'UniqueSecretBodyToken9988'")
      .all();
    expect(ftsMatch).toEqual([]);
    expect(repo.searchNonSecretForAsk('UniqueSecretBodyToken9988')).toEqual([]);
    const rawFtsCount = (
      repo.db.prepare("SELECT COUNT(*) AS c FROM items_fts WHERE id = 'sec-fts-1'").get() as { c: number }
    ).c;
    expect(rawFtsCount).toBe(0);

    repo.setSetting('api_key_openrouter', 'enc-secret-key');
    repo.wipeAllUserData();
    expect(repo.getItemById('note-fts-1')).toBeNull();
    expect(repo.getItemById('sec-fts-1')).toBeNull();
    expect(repo.getSetting('api_key_openrouter')).toBeNull();
    expect(repo.getSyncState('device_id')).toBe('dev-preserve-01');
  });

  it('enforces packaged fail-closed VaultCrypto, PIN verification, resetForAccountWipe, and neutralizes HTML assets as .txt', () => {
    const dir = makeTempDir();
    const lockedPackaged = new VaultCrypto(dir, null, 'ru', { isPackaged: true });
    expect(() =>
      lockedPackaged.encryptSecret({
        service: 'Mail',
        login: 'u@x.io',
        secretValue: 'pw',
        notes: '',
      })
    ).toThrow();
    expect(fs.existsSync(path.join(dir, '.vault.salt'))).toBe(false);

    // Non-packaged or DPAPI vault: test PIN setup -> verify -> remove -> resetForAccountWipe
    const dir2 = makeTempDir();
    const mockDpapi = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`dpapi:${s}`, 'utf8'),
      decryptString: (b: Buffer) => b.toString('utf8').replace(/^dpapi:/, ''),
    };
    const v = new VaultCrypto(dir2, mockDpapi, 'ru', { isPackaged: true });
    v.setPinProtection('2580');
    expect(v.isPinProtected()).toBe(true);
    expect(v.verifyPinProtection('0000')).toBe(false);
    expect(v.verifyPinProtection('2580')).toBe(true);
    v.removePinProtection();
    expect(v.isPinProtected()).toBe(false);

    v.setPinProtection('9630');
    v.lock();
    expect(v.isLocked()).toBe(true);
    v.resetForAccountWipe();
    expect(v.isPinProtected()).toBe(false);
    expect(fs.existsSync(path.join(dir2, 'vault.vdk.pin.json'))).toBe(false);

    // Neutralize active web files (.html / .htm) to .txt on disk
    const mediaDir = makeTempDir();
    const saved = saveDocumentAsset(
      mediaDir,
      'evil123',
      Buffer.from('<script>alert(1)</script>'),
      'payload.html',
      'text/html'
    );
    expect(saved.storedFileName.endsWith('.txt')).toBe(true);
    expect(saved.ext).toBe('html');
    expect(fs.existsSync(path.join(mediaDir, saved.storedFileName))).toBe(true);
  });

  it('refuses disk fallback secrets on packaged SyncEngine and validates Clipper pairing + ghost sanitization + archive traversal + iCal SSRF', async () => {
    const dir = makeTempDir();
    const mediaDir = path.join(dir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    const vaultCrypto = new VaultCrypto(dir, null);
    cleanups.push(() => repo.close());

    const prevAllow = process.env.KAPSULA_ALLOW_FALLBACK_KEY;
    process.env.KAPSULA_ALLOW_FALLBACK_KEY = '1';
    try {
      const engine = new SyncEngine({
        repo,
        vaultCrypto,
        dataDir: dir,
        mediaDir,
        isPackaged: true,
        disableTimers: true,
        disableRealtime: true,
      });
      await engine.setServerConfig({
        supabaseUrl: 'https://public-project.supabase.co',
        supabasePublishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz123456',
      });
      // Packaged build without safeStorage must NEVER persist `fb:` fallback secrets to disk
      const secretsFile = path.join(dir, '.sync-secrets.json');
      const diskDump = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, 'utf8') : '';
      expect(diskDump).not.toContain('fb:');
      engine.dispose();
    } finally {
      if (prevAllow === undefined) delete process.env.KAPSULA_ALLOW_FALLBACK_KEY;
      else process.env.KAPSULA_ALLOW_FALLBACK_KEY = prevAllow;
    }

    // Clipper pairing + ghost pixel block
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault: vaultCrypto,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 1.5,
        enableAutoOcr: false,
        enableUrlUnfurl: false,
      }),
    });
    const paired = new Set<string>();
    const srv = new ClipperServer(pipeline, () => 'clip-tok-123', undefined, undefined, () => 'ru', {
      getPairingCode: () => '482910',
      isOriginPaired: (o) => paired.has(o),
      onPairOrigin: (o) => paired.add(o),
    });
    const port = await srv.start();
    cleanups.push(() => srv.stop());

    const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const badPair = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        Origin: extOrigin,
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Pair-Code': '000000',
      },
    });
    expect(badPair.status).toBe(403);

    const goodPair = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      method: 'POST',
      headers: {
        Origin: extOrigin,
        'X-Kapsula-Client': 'ext-v1',
        'X-Kapsula-Pair-Code': '482910',
      },
    });
    expect(goodPair.status).toBe(200);
    expect(paired.has(extOrigin)).toBe(true);

    const ghostPixel = await fetch(
      `http://127.0.0.1:${port}/clip-pixel?token=clip-tok-123&mode=ghost&text=secret-val`
    );
    expect(ghostPixel.status).toBe(403);

    // Telegram archive traversal escape blocked
    const outsideDir = makeTempDir('kapsula-outside-');
    fs.writeFileSync(path.join(outsideDir, 'leak.png'), Buffer.from('PNG_OUTSIDE'));
    const archiveDir = makeTempDir('kapsula-arch-');
    const archiveJsonPath = path.join(archiveDir, 'result.json');
    fs.writeFileSync(
      archiveJsonPath,
      JSON.stringify({
        id: 'chat1',
        messages: [
          {
            id: 77,
            type: 'message',
            text: '',
            photo: `../${path.basename(outsideDir)}/leak.png`,
          },
        ],
      })
    );
    const imp = await importArchiveFromPath(archiveJsonPath, pipeline, repo);
    expect(imp.imported).toBe(0);

    // iCal SSRF blocked before touching loopback
    const gcalFetch = vi.fn(async () => new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 }));
    const gcal = new GoogleCalendarBridge(repo, vaultCrypto, {
      fetchFn: gcalFetch as unknown as typeof fetch,
    });
    repo.setSetting('gcal_ical_url', 'http://127.0.0.1:9999/private.ics');
    await gcal.syncNow();
    expect(gcalFetch).not.toHaveBeenCalled();
  });

  it('enforces mobile 2-tier PIN-KEK VDK lock, biometric toggle lock guard, and SSRF hostname checks', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    await store.setMasterPin('4729');
    const sec = await store.upsertSecret({
      kind: 'password',
      title: 'CloudPanel',
      service: 'CloudPanel',
      login: 'admin',
      secretValue: 'UltraSecret!77',
    });
    expect(sec.hasEncryptedPayload).toBe(true);
    expect(store.getRawItem(sec.id)?.encryptedSecretPayload?.startsWith('vdk:')).toBe(true);

    store.lockVault();
    expect(store.isVaultLocked()).toBe(true);
    await expect(store.revealSecret(sec.id)).rejects.toThrow();
    await expect(
      store.upsertSecret({
        kind: 'password',
        title: 'Blocked',
        service: 'Blocked',
        secretValue: 'NoWriteWhenLocked',
      })
    ).rejects.toThrow();

    const wrong = await store.unlockVaultWithPin('1111');
    expect(wrong.ok).toBe(false);
    expect(store.getSyncState('pin_failed_attempts')).toBeNull();
    expect(await store.getSecureValue('pin_failed_attempts')).toBe('1');

    const right = await store.unlockVaultWithPin('4729');
    expect(right.ok).toBe(true);
    expect(store.isVaultLocked()).toBe(false);
    const revealed = await store.revealSecret(sec.id);
    expect(revealed?.secretValue).toBe('UltraSecret!77');

    // Biometric toggle cannot disable or enable while vault is locked
    expect(
      evaluateBiometricToggleGuard(false, {
        vaultLocked: true,
        hasMasterPin: true,
        biometricEnabled: true,
      }).action
    ).toBe('reject');
    expect(
      evaluateBiometricToggleGuard(true, {
        vaultLocked: true,
        hasMasterPin: true,
        biometricEnabled: false,
      }).action
    ).toBe('reject');

    // SSRF guard
    expect(isPrivateOrLocalHostname('localhost')).toBe(true);
    expect(isPrivateOrLocalHostname('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('10.20.30.40')).toBe(true);
    expect(isPrivateOrLocalHostname('192.168.1.5')).toBe(true);
    expect(isPrivateOrLocalHostname('169.254.169.254')).toBe(true);
    expect(isPrivateOrLocalHostname('[::1]')).toBe(true);
    expect(isPrivateOrLocalHostname('printer.local')).toBe(true);
    expect(isPrivateOrLocalHostname('gxkvuwipzbqocbxgyqty.supabase.co')).toBe(false);
  });

  it('enforces Mobile SYNC-01 wipe/account isolation, SYNC-M02 cache owner check, and SYNC-02 blob rollback & remote cleanup', async () => {
    const cloud = createMockCloud();
    const users = new Map<string, { id: string; email: string; password: string }>();

    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const engine = new MobileSyncEngine({
      store,
      deviceName: 'Pixel Fold',
      platform: 'android',
      kdfIterationsOverride: 100_000,
      disableTimers: true,
      disableRealtime: true,
      clientFactory: () => createMockSupabase(cloud, users),
    });
    cleanups.push(() => engine.dispose());
    await engine.init();

    // Unowned offline configureServer preserves offline note
    const preNote = await store.createItem({
      dna: 'note',
      title: 'Offline draft before first login',
      body: 'Keep me safe',
    });
    await engine.configureServer({
      supabaseUrl: 'https://custom-sync.kapsula.example',
      supabasePublishableKey: 'sb_publishable_custom_key_value_123456',
    });
    expect(store.getItemById(preNote.id)).not.toBeNull();
    // Reset back to default server before signing up
    await engine.configureServer({ supabaseUrl: '', supabasePublishableKey: '' });

    // Sign up User A and save note + media + AI key + Master PIN
    await engine.signUp('alpha@kapsula.app', 'PasswordA123!');
    await engine.setupPassphrase('alpha-pass-999');
    await store.setMasterPin('4321');
    await store.setMobileAiConfig({ provider: 'google_ai_studio', googleKey: 'AIzaTestKey123456789012345678901234' });

    const photo = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);
    await store.saveMediaFile('alpha-shot.png', 'image/png', photo);
    const mediaNote = await store.createItem({
      dna: 'shot',
      title: 'Alpha photo note',
      body: 'Synced image',
      imagePath: 'alpha-shot.png',
    });
    await engine.syncNow();
    expect(cloud.storage.size).toBe(1);
    expect(cloud.blobsMeta.size).toBe(1);

    // SYNC-02: Permanent purge enqueues remote blob deletion and syncNow() removes both sync_blobs + storage object
    await store.deleteItem(mediaNote.id);
    await store.purgeItemPermanently(mediaNote.id);
    expect(store.getPendingBlobDeletes().length).toBe(1);
    await engine.syncNow();
    expect(store.getPendingBlobDeletes()).toEqual([]);
    expect(cloud.blobsMeta.size).toBe(0);
    expect(cloud.storage.size).toBe(0);

    // SYNC-01: signOut() wipes local notes, secrets, PIN, and AI keys
    await store.createItem({ dna: 'note', title: 'Alpha private note', body: 'Sensitive alpha text' });
    await engine.signOut();
    expect(store.listItems()).toEqual([]);
    expect(store.hasMasterPin()).toBe(false);
    expect(store.getMobileAiConfig().hasGoogleKey).toBe(false);

    // Cross-account switch guard: even if User A owner remains stamped, logging in as User B wipes User A items
    const leftoverA = await store.createItem({
      dna: 'note',
      title: 'Leftover A',
      body: 'Do not leak',
    });
    await store.setSyncState('last_data_owner_id', 'u-alpha@kapsula.app');
    await engine.signUp('beta@kapsula.app', 'PasswordB123!');
    expect(store.getItemById(leftoverA.id)).toBeNull();
    await engine.setupPassphrase('beta-pass-999');
    const betaRecords = Array.from(cloud.records.values()).filter(
      (r) => r.user_id === 'u-beta@kapsula.app'
    );
    expect(betaRecords.some((r) => r.entity_id === leftoverA.id)).toBe(false);

    // SYNC-02 upload rollback + SYNC-M02 cross-user blob cache guard
    const mediaMgr = new MobileSyncMediaManager(store);
    const rbClient = createMockSupabase(cloud, users);
    await store.saveMediaFile('rb-test.png', 'image/png', new Uint8Array([9, 8, 7, 6]));
    const fakeDek = new Uint8Array(32).fill(5);
    cloud.failNextBlobMetaUpsert = true;
    await expect(
      mediaMgr.ensureUploaded(rbClient, 'u-rb', fakeDek, ['rb-test.png'])
    ).rejects.toThrow();
    expect(
      Array.from(cloud.storage.keys()).some((k) => k.startsWith('u-rb/'))
    ).toBe(false);

    // SYNC-M02: cached entry from another user (`uploadedForUser !== userId`) must NOT skip download even if byte length matches!
    await store.saveMediaFile('shared-cache.png', 'image/png', new Uint8Array([1, 2, 3, 4]));
    const uploadedOk = await mediaMgr.ensureUploaded(rbClient, 'u-real-owner', fakeDek, [
      'shared-cache.png',
    ]);
    const ref = uploadedOk.refs[0]!;
    await store.saveMediaFile('shared-cache.png', 'image/png', new Uint8Array([9, 9, 9, 9]));
    await store.upsertBlobCache({
      localName: 'shared-cache.png',
      blobId: ref.blobId,
      sha256: 'poison',
      byteSize: 4,
      updatedAt: Date.now(),
      uploadedForUser: 'u-other-user',
    });
    const downloadedCount = await mediaMgr.ensureDownloaded(rbClient, 'u-real-owner', fakeDek, [ref]);
    expect(downloadedCount).toBe(1);
    expect(Array.from((await store.loadMediaFile('shared-cache.png'))!.bytes)).toEqual([1, 2, 3, 4]);
    expect(store.getBlobCache('shared-cache.png')?.uploadedForUser).toBe('u-real-owner');
  });
});
