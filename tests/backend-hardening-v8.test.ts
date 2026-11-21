import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SyncBlobRow,
  SyncKeyEnvelopeRow,
  SyncRecordRow,
  SyncedItemPayload,
} from '@shared/sync-contract';
import type { SettingsState } from '@shared/types';
import { NOTE_TEMPLATES, ONBOARDING_PRESETS } from '@shared/note-templates';
import {
  isStandaloneTaskSource,
  parseMarkdownTasks,
  stripInlineMarkdownImages,
  toggleMarkdownTaskInBody,
} from '@shared/task-helpers';
import { answerVaultLocally } from '@main/ai/local-heuristic';
import { previewSmartTriageWithAi, synthesizeNotesWithAi } from '@main/ai/enricher';
import { GoogleCalendarBridge } from '@main/bridges/google-calendar';
import {
  importJsonBackup,
  importMarkdownFolder,
  importNotionZip,
} from '@main/bridges/markdown-importer';
import { VaultRepository } from '@main/db/repository';
import { defaultLocalOcrAdapter } from '@main/platform/platform-adapters';
import { transcribeAudioFile } from '@main/pipeline/audio-pipeline';
import {
  CapturePipeline,
  detectImageExtFromMagic,
  resolveSafeMediaFilePath,
} from '@main/pipeline/capture-pipeline';
import { processDocumentIntelligence } from '@main/pipeline/document-pipeline';
import { VaultCrypto, type DpapiBridge } from '@main/security/vault-crypto';
import { decryptRecordPayload } from '@main/sync/sync-crypto';
import { SyncEngine } from '@main/sync/sync-engine';
import { createZipBuffer } from '@main/utils/zip';

const SAMPLE_PNG_BUF = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];
const activeEngines: SyncEngine[] = [];
const activeCryptos: VaultCrypto[] = [];

function makeTempDir(prefix = 'kapsula-hardening-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMockDpapi(): DpapiBridge {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`dpapi:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const s = encrypted.toString('utf8');
      if (!s.startsWith('dpapi:')) throw new Error('Bad DPAPI blob');
      return s.slice('dpapi:'.length);
    },
  };
}

class TriggerAccurateCloud {
  public seq = 0;
  public users = new Map<string, { id: string; email: string; password: string }>();
  public envelopes = new Map<string, SyncKeyEnvelopeRow>();
  public records = new Map<string, SyncRecordRow>();
  public blobs = new Map<string, SyncBlobRow>();
  public devices = new Map<string, Record<string, unknown>>();
  public storageObjects = new Map<string, Buffer>();

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
        if (table === 'sync_key_envelopes') {
          cloud.envelopes.set(row.user_id, {
            ...row,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          resultData = [cloud.envelopes.get(row.user_id)];
        } else if (table === 'sync_records') {
          const key = `${row.user_id}:${row.entity_type}:${row.entity_id}`;
          const existing = cloud.records.get(key);
          if (existing && Number(row.updated_at ?? 0) < Number(existing.updated_at ?? 0)) {
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
        } else if (table === 'sync_blobs') {
          const saved = { ...row, created_at: new Date().toISOString() };
          cloud.blobs.set(`${row.user_id}:${row.blob_id}`, saved);
          resultData = [saved];
        } else if (table === 'sync_devices') {
          cloud.devices.set(`${row.user_id}:${row.device_id}`, { ...row });
          resultData = [{ ...row }];
        }

        const response = { data: resultData, error: null };
        return {
          select: () => Promise.resolve(response),
          then(resolve: (val: unknown) => void, reject?: (err: unknown) => void) {
            return Promise.resolve({ error: null }).then(resolve, reject);
          },
        };
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

function makeSyncDevice(name: string, cloud: TriggerAccurateCloud) {
  const dir = makeTempDir(`kapsula-sync-${name}-`);
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
  openRepos.push(repo);
  const vaultCrypto = new VaultCrypto(dir, makeMockDpapi());
  activeCryptos.push(vaultCrypto);
  const sync = new SyncEngine({
    repo,
    vaultCrypto,
    dataDir: dir,
    mediaDir,
    deviceName: name,
    kdfIterationsOverride: 5_000,
    disableTimers: true,
    disableRealtime: true,
    callbacks: {},
  });
  const client = cloud.createClientForDevice();
  (sync as unknown as { client: SupabaseClient }).client = client;
  (sync as unknown as { ensureClient: () => SupabaseClient }).ensureClient = () => client;
  activeEngines.push(sync);
  return { dir, mediaDir, repo, vaultCrypto, sync };
}

afterEach(() => {
  vi.restoreAllMocks();
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

describe('Kapsula V8 Backend Hardening, Security, Sync, Migration & Cross-Platform Fixes', () => {
  it('#7 P0-1: locked Desktop reconcileFull never re-deletes or wipes remotely restored Vault secrets and defers locked soft-delete push', async () => {
    const cloud = new TriggerAccurateCloud();
    const devA = makeSyncDevice('A', cloud);
    const devB = makeSyncDevice('B', cloud);

    expect((await devA.sync.signUp('sync-p01@kapsula.app', 'StrongPass!2026')).ok).toBe(true);
    expect((await devA.sync.setupPassphrase('vault-passphrase-123')).ok).toBe(true);
    expect((await devB.sync.signIn('sync-p01@kapsula.app', 'StrongPass!2026')).ok).toBe(true);
    expect((await devB.sync.unlockWithPassphrase('vault-passphrase-123')).ok).toBe(true);

    // Device A creates a Vault secret and syncs it
    const secretItem = devA.repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'GitHub Prod Token',
      body: '',
      summary: 'Ключ доступа · скрыт в Сейфе',
      encryptedPayload: devA.vaultCrypto.encryptSecret({
        service: 'GitHub',
        login: 'ops@kapsula.app',
        secretValue: 'ghp_LiveProductionSecret1234567890',
        notes: 'Keep intact',
      }),
      secretMeta: { kind: 'api_key', service: 'GitHub', loginHint: '••••7890' },
      source: 'vault_ui',
      contentHash: crypto.randomUUID(),
      aiStatus: 'skipped_secret',
    });
    await devA.sync.syncNow();
    await devB.sync.syncNow();

    // Device B enables Master PIN, soft-deletes the secret (Trash), and pushes deletion
    devB.vaultCrypto.setPinProtection('4829');
    expect(devB.repo.deleteItem(secretItem.id)).toBe(true);
    await devB.sync.syncNow();

    // Device A pulls deletion, then RESTORES the secret on Device A and pushes restored live secret
    await devA.sync.syncNow();
    expect(devA.repo.getItemById(secretItem.id)).toBeNull();
    const restoredOnA = devA.repo.restoreItem(secretItem.id);
    expect(restoredOnA).not.toBeNull();
    await devA.sync.syncNow();

    // Verify cloud currently holds live restored secret (deleted_at === null)
    const userId = devA.sync.getStatus().userId!;
    const cloudKey = `${userId}:item:${secretItem.id}`;
    const cloudBefore = cloud.records.get(cloudKey)!;
    expect(cloudBefore.deleted_at).toBeNull();

    // Device B LOCKS its Vault and runs reconcileFull()!
    devB.vaultCrypto.lock();
    expect(devB.vaultCrypto.isLocked()).toBe(true);
    const recRes = await devB.sync.reconcileFull();
    expect(recRes.error).toBeNull();

    // Cloud secret MUST STILL be live and MUST STILL carry its intact encrypted secretPayload!
    const cloudAfter = cloud.records.get(cloudKey)!;
    expect(cloudAfter.deleted_at).toBeNull();
    const dekA = (devA.sync as unknown as { dek: Buffer }).dek;
    const decryptedCloudPayload = decryptRecordPayload<SyncedItemPayload>(
      dekA,
      userId,
      'item',
      secretItem.id,
      {
        payload_ciphertext: cloudAfter.payload_ciphertext,
        payload_iv: cloudAfter.payload_iv,
        payload_tag: cloudAfter.payload_tag,
      }
    );
    expect(decryptedCloudPayload.deletedAt).toBeNull();
    expect(decryptedCloudPayload.secretPayload?.secretValue).toBe(
      'ghp_LiveProductionSecret1234567890'
    );
    expect(devB.repo.getSyncState('pending_secret_reconcile')).toBe('1');

    // Even if Device B explicitly marks its local soft-deleted secret dirty while locked,
    // push MUST defer it rather than overwriting cloud with secretPayload: null!
    devB.repo.markDirty('item', secretItem.id);
    await devB.sync.syncNow();
    const cloudAfterDirtyPush = cloud.records.get(cloudKey)!;
    expect(cloudAfterDirtyPush.deleted_at).toBeNull();
    expect(devB.repo.countDirtyEntities()).toBeGreaterThanOrEqual(1);

    // Once Device B unlocks with PIN, reconcileFull cleanly pulls Device A's restored secret
    expect(devB.vaultCrypto.unlockWithPin('4829')).toBe(true);
    await devB.sync.reconcileFull();
    const liveOnB = devB.repo.getItemById(secretItem.id);
    expect(liveOnB).not.toBeNull();
    const rawOnB = devB.repo.getRawRowById(secretItem.id)!;
    expect(devB.vaultCrypto.decryptSecret(rawOnB.encrypted_payload!).secretValue).toBe(
      'ghp_LiveProductionSecret1234567890'
    );
  });

  it('#7 P1-5: v7 -> v8 live DB/DPAPI/GoogleCalendarBridge migration stays connected when Master PIN Vault is locked', () => {
    const dir = makeTempDir('kapsula-v7-gcal-');
    const dpapi = makeMockDpapi();
    const dbPath = path.join(dir, 'vault.sqlite');

    // Simulate authentic v7 vault (master.key.dpapi + legacy gcal_tokens_enc encrypted with VDK)
    const v7Repo = new VaultRepository(dbPath);
    openRepos.push(v7Repo);
    const v7Crypto = new VaultCrypto(dir, dpapi);
    activeCryptos.push(v7Crypto);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(true);

    const legacyVdkGcalBlob = v7Crypto.encryptJson({
      accessToken: 'ya29.legacy-access',
      refreshToken: '1//legacy-refresh-token',
      expiresAt: Date.now() + 3600_000,
      email: 'v7user@gmail.com',
    });
    v7Repo.setSetting('gcal_client_id', '12345.apps.googleusercontent.com');
    v7Repo.setSetting('gcal_tokens_enc', legacyVdkGcalBlob);
    v7Repo.setSetting('master_pin_hash', VaultCrypto.hashPin('7391'));

    const legacySecretBlob = v7Crypto.encryptSecret({
      service: 'Bank',
      login: 'v7',
      secretValue: 'v7-secret-card',
      notes: '',
    });

    // Launch #1 on v8: user unlocks PIN -> upgrades to 2-tier PIN-KEK and reads GCal status
    const gcalLaunch1 = new GoogleCalendarBridge(v7Repo, v7Crypto);
    const statusBeforePin = gcalLaunch1.getStatus();
    expect(statusBeforePin.connected).toBe(true);
    expect(statusBeforePin.email).toBe('v7user@gmail.com');
    expect(statusBeforePin.hasCredentials).toBe(true);
    // Lazy migration re-wrapped gcal_tokens_enc under configKey
    expect(v7Repo.getSetting('gcal_tokens_enc')).not.toBe(legacyVdkGcalBlob);

    v7Crypto.setPinProtection('7391');
    expect(fs.existsSync(path.join(dir, 'vault.vdk.pin.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(false);

    // Launch #2 on v8: fresh VaultCrypto starts LOCKED (masterKey === null)
    const v8CryptoRestart = new VaultCrypto(dir, dpapi);
    activeCryptos.push(v8CryptoRestart);
    expect(v8CryptoRestart.isLocked()).toBe(true);
    expect(() => v8CryptoRestart.decryptSecret(legacySecretBlob)).toThrow(/Сейф заблокирован/i);

    // Google Calendar remains connected & readable even while Master PIN Vault is locked!
    const gcalLaunch2 = new GoogleCalendarBridge(v7Repo, v8CryptoRestart);
    const lockedStatus = gcalLaunch2.getStatus();
    expect(lockedStatus.connected).toBe(true);
    expect(lockedStatus.email).toBe('v7user@gmail.com');
    expect(lockedStatus.hasCredentials).toBe(true);

    // Unlocking restores full access to legacy v7 secret too
    expect(v8CryptoRestart.unlockWithPin('7391')).toBe(true);
    expect(v8CryptoRestart.decryptSecret(legacySecretBlob).secretValue).toBe('v7-secret-card');
  });

  it('#7 P0-3 & P2-11: blocks secret documents from cloud AI and redacts secrets in audio contextHint & synthesis instruction', async () => {
    const docFetchSpy = vi.fn<typeof fetch>();

    // Secret-bearing document must NEVER hit cloud AI (0 fetch calls)
    const secretDocText =
      'Рабочая выгрузка ключей доступа для продакшена:\n' +
      'OPENROUTER_API_KEY=sk-or-v1-99887766554433221100aabbccddeeff0011223344\n' +
      'Резервная карта МИР 2202 2006 1234 5676 09/29 CVV 384\n' +
      'Дополнительные заметки по доступу к стенду разработки и админ-панели.';

    const docRes = await processDocumentIntelligence({
      buffer: Buffer.from(secretDocText, 'utf8'),
      fileName: 'prod-secrets.txt',
      aiProvider: 'google_ai_studio',
      googleAiKey: 'AIzaTestKey',
      fetchFn: docFetchSpy,
    });
    expect(docFetchSpy).not.toHaveBeenCalled();
    expect(docRes.costUsd).toBe(0);

    // Non-secret document DOES call cloud AI cleanly
    const cleanDocFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'План квартала',
                      summary: 'Краткий план запуска продукта на квартал.',
                      keyPoints: ['Запуск в срок'],
                      actionItems: ['Согласовать макет'],
                      tags: ['план'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const cleanDocRes = await processDocumentIntelligence({
      buffer: Buffer.from(
        'План квартальной работы команды дизайна и разработки над новым интерфейсом приложения для заметок.',
        'utf8'
      ),
      fileName: 'q3-plan.txt',
      aiProvider: 'google_ai_studio',
      googleAiKey: 'AIzaTestKey',
      fetchFn: cleanDocFetch,
    });
    expect(cleanDocFetch).toHaveBeenCalledTimes(1);
    expect(cleanDocRes.title).toBe('План квартала');

    // Audio contextHint secret redaction (P2-11)
    let capturedAudioBody = '';
    const audioFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedAudioBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'Созвон по релизу',
                      summary: 'Обсудили сроки',
                      transcript: 'Нужно закрыть задачи до пятницы.',
                      keyPoints: [],
                      actionItems: [],
                      tags: ['голос'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    await transcribeAudioFile({
      buffer: Buffer.from('RIFF....WAVEfmt ', 'ascii'),
      mime: 'audio/wav',
      fileName: 'memo.wav',
      contextHint: 'Ключ от стенда: sk-or-v1-audiosecret1234567890abcdef123456',
      aiProvider: 'google_ai_studio',
      googleAiKey: 'AIzaTestKey',
      fetchFn: audioFetch,
    });
    expect(audioFetch).toHaveBeenCalledTimes(1);
    expect(capturedAudioBody).not.toContain('sk-or-v1-audiosecret1234567890abcdef123456');

    // Synthesis instruction secret redaction (P2-11)
    const dir = makeTempDir('kapsula-synth-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const n1 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Идея 1',
      body: 'Сделать быструю панель',
      source: 'vault_ui',
      contentHash: 'synth-1',
    });
    const n2 = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Идея 2',
      body: 'Добавить фильтры',
      source: 'vault_ui',
      contentHash: 'synth-2',
    });

    let capturedSynthBody = '';
    const synthFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedSynthBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'Сводка идей',
                      summary: 'Объединили идеи',
                      body: '## План\n- Быстрая панель\n- Фильтры',
                      tags: ['идеи'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    await synthesizeNotesWithAi({
      repo,
      items: [n1, n2],
      orbits: [],
      mode: 'spec',
      instruction: 'Используй токен sk-or-v1-synthsecret9876543210fedcba9876 для сверки',
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
      fetchFn: synthFetch,
    });
    expect(synthFetch).toHaveBeenCalledTimes(1);
    expect(capturedSynthBody).not.toContain('sk-or-v1-synthsecret9876543210fedcba9876');

    // Verify Russian copy polish in previewSmartTriageWithAi
    const noKeyTriage = await previewSmartTriageWithAi({
      repo,
      items: [n1],
      orbits: [],
      boards: [],
      provider: 'local',
      apiKey: null,
    });
    expect(noKeyTriage.message).not.toContain('регулярками');

    const emptyTriage = await previewSmartTriageWithAi({
      repo,
      items: [],
      orbits: [],
      boards: [],
      provider: 'google_ai_studio',
      apiKey: 'AIzaTestKey',
    });
    expect(emptyTriage.message).toBe(
      'Во «Всех записях» сейчас нет неразобранных записей — везде уже порядок.'
    );
  });

  it('#7 P0-4 & P1-9: fails closed on PIN-locked secret capture/pre-OCR/background-OCR and uses UUID contentHash', async () => {
    const dir = makeTempDir('kapsula-p04-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, makeMockDpapi());
    activeCryptos.push(cryptoVault);

    const deletedIds: string[] = [];
    const notices: Array<{ title: string; body: string }> = [];

    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
      dataDir: dir,
      getConfig: () => ({
        activeMode: 'autopilot',
        activeFocusBoardId: null,
        aiProvider: 'local',
        apiKey: null,
        monthlyCapUsd: 1.5,
        enableAutoOcr: true,
        enableUrlUnfurl: false,
      }),
      onItemDeleted: (id) => deletedIds.push(id),
      onSecurityNotice: (n) => notices.push(n),
    });

    // 1. P1-9: Unlocked secret capture uses random UUID contentHash (NOT unsalted SHA-256) and spawns zero orbits
    const rawSecretText = 'OpenRouter API key: sk-or-v1-uuidhashcheck1234567890abcdef';
    const unsaltedSha = crypto.createHash('sha256').update(`${rawSecretText}||`).digest('hex');
    const secretCreated = await pipeline.capture({ text: rawSecretText, source: 'vault_ui' });
    expect(secretCreated.dna).toBe('secret');
    expect(secretCreated.orbit).toBe('');
    expect(repo.listOrbits()).toHaveLength(0);
    expect(secretCreated.contentHash).not.toBe(unsaltedSha);
    expect(secretCreated.contentHash).toMatch(/^[0-9a-f-]{36}$/i);

    // Enable Master PIN and lock Vault
    cryptoVault.setPinProtection('5511');
    cryptoVault.lock();
    expect(cryptoVault.isLocked()).toBe(true);

    // 2. P0-4a: Text secret capture while locked fails closed cleanly
    await expect(
      pipeline.capture({
        text: 'МИР 2202 2006 1234 5676 09/29 CVV 384',
        source: 'clipboard_snatch',
      })
    ).rejects.toThrow(/Сейф заблокирован/i);
    expect(repo.queryItems({ includeSecrets: true, limit: 50 })).toHaveLength(1);

    // 3. P0-4b: Pre-persist OCR secret hit while locked removes temp media copy, preserves source file, persists nothing
    const externalShotPath = path.join(dir, 'user-original-card.png');
    fs.writeFileSync(externalShotPath, SAMPLE_PNG_BUF);
    const ocrSpy = vi
      .spyOn(defaultLocalOcrAdapter, 'extractText')
      .mockResolvedValue({ text: 'МИР 2202 2006 1234 5676 09/29 CVV 384', engine: 'mock' } as any);

    await expect(
      pipeline.capture({
        imageFilePath: externalShotPath,
        source: 'clipboard_snatch',
      })
    ).rejects.toThrow(/Сейф заблокирован/i);
    // Original file outside mediaDir must NOT be deleted, and mediaDir must hold zero plaintext copy!
    expect(fs.existsSync(externalShotPath)).toBe(true);
    expect(fs.readdirSync(pipeline.getMediaDir())).toHaveLength(0);
    expect(repo.queryItems({ includeSecrets: true, limit: 50 })).toHaveLength(1);

    // 4. P0-4c: Background OCR secret hit while locked purges persisted shot, unlinks plaintext PNG & notifies user!
    ocrSpy.mockResolvedValueOnce({ text: '', engine: 'mock' } as any);
    const shotItem = await pipeline.capture({
      imageBase64: `data:image/png;base64,${SAMPLE_PNG_BUF.toString('base64')}`,
      source: 'vault_ui',
    });
    await pipeline.waitForIdle();
    expect(shotItem.dna).toBe('shot');
    expect(shotItem.imagePath).toBeTruthy();
    const shotFileOnDisk = path.join(pipeline.getMediaDir(), shotItem.imagePath!);
    expect(fs.existsSync(shotFileOnDisk)).toBe(true);

    // Now background OCR discovers a bank card while Vault is still locked
    ocrSpy.mockResolvedValueOnce({
      text: 'МИР 2202 2006 1234 5676 09/29 CVV 384',
      engine: 'mock',
    } as any);
    await pipeline.reprocessItem(shotItem.id);

    expect(repo.getItemById(shotItem.id)).toBeNull();
    const purgedRow = repo.getItemById(shotItem.id, { includeDeleted: true, includePurged: true });
    expect(purgedRow?.purgedAt).not.toBeNull();
    expect(fs.existsSync(shotFileOnDisk)).toBe(false);
    expect(deletedIds).toContain(shotItem.id);
    expect(notices.some((n) => n.body.includes('Сейф'))).toBe(true);
  });

  it('#7 P1-7 & P2-15: restoreItem resolves (source, external_id) unique collisions and purgeItemPermanently clears external_id', () => {
    const dir = makeTempDir('kapsula-restore-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);

    const original = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Импортированная заметка v1',
      body: 'Старый текст',
      source: 'markdown_import',
      externalId: 'md:same-ext-id',
      contentHash: 'hash-ext-1',
    });
    expect(repo.deleteItem(original.id)).toBe(true);

    // Re-import creates a new live row with the exact same (source, external_id)
    const reimported = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Импортированная заметка v2',
      body: 'Новый текст',
      source: 'markdown_import',
      externalId: 'md:same-ext-id',
      contentHash: 'hash-ext-2',
    });
    expect(reimported.externalId).toBe('md:same-ext-id');

    // Restoring original must NOT throw SQLITE_CONSTRAINT_UNIQUE and clears external_id on restored row
    const restored = repo.restoreItem(original.id);
    expect(restored).not.toBeNull();
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.externalId).toBeNull();
    expect(repo.getItemById(reimported.id)?.externalId).toBe('md:same-ext-id');

    // P2-15: purgeItemPermanently clears external_id in local SQLite
    const toPurge = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Удалить навсегда',
      body: 'Временные данные',
      source: 'email_import',
      externalId: 'eml:purge-me-123',
      contentHash: 'hash-purge-ext',
    });
    const purgeRes = repo.purgeItemPermanently(toPurge.id);
    expect(purgeRes.purged).toBe(true);
    const rawPurged = repo.getRawRowById(toPurge.id);
    expect(rawPurged?.external_id).toBeNull();

    // #6 Russian copy check for FocusBoard ("Холст")
    expect(() => repo.createFocusBoard('   ')).toThrow('Название холста не может быть пустым');
    const board = repo.createFocusBoard('Референсы');
    expect(() => repo.updateFocusBoard(board.id, { name: '  ' })).toThrow(
      'Название холста не может быть пустым'
    );
  });

  it('#7 P1-10, P2-12, P2-15: blocks path prefix bypass, JSON backup secret overwrite, and nested Notion ZIP bomb budget bypass', async () => {
    const dir = makeTempDir('kapsula-import-sec-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    activeCryptos.push(cryptoVault);
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
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

    // 1. P1-10: Sibling folder sharing exact string prefix (`vault` vs `vault-sibling`)
    const vaultDir = path.join(dir, 'vault');
    const siblingDir = path.join(dir, 'vault-sibling');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'leak.png'), SAMPLE_PNG_BUF);
    fs.writeFileSync(
      path.join(vaultDir, 'probe.md'),
      '# Заметка\n\n![Утечка](../vault-sibling/leak.png)\n',
      'utf8'
    );

    const mdRes = await importMarkdownFolder(vaultDir, { repo, pipeline });
    expect(mdRes.importedCount).toBe(1);
    const importedNote = repo.queryItems({ limit: 10 }).find((it) => it.title === 'Заметка');
    expect(importedNote).toBeDefined();
    expect(importedNote?.body).not.toContain('kapsula-media://local/');
    expect(fs.readdirSync(pipeline.getMediaDir())).toHaveLength(0);

    // 2. P2-12: JSON backup restore MUST NOT overwrite an existing Vault secret via forged non-secret DNA + newer updatedAt
    const secret = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'Главный пароль',
      body: '',
      summary: 'Скрыто в Сейфе',
      encryptedPayload: cryptoVault.encryptSecret({
        service: 'Core',
        login: 'root',
        secretValue: 'DoNotOverwriteMe!',
        notes: '',
      }),
      secretMeta: { kind: 'password', service: 'Core', loginHint: 'r***' },
      source: 'vault_ui',
      contentHash: crypto.randomUUID(),
      aiStatus: 'skipped_secret',
    });

    const forgedBackupPath = path.join(dir, 'forged-backup.json');
    fs.writeFileSync(
      forgedBackupPath,
      JSON.stringify({
        version: 1,
        items: [
          {
            id: secret.id,
            dna: 'note',
            title: 'HIJACKED TITLE',
            body: 'HIJACKED BODY',
            summary: 'HIJACKED',
            updatedAt: Date.now() + 10_000_000,
          },
        ],
      }),
      'utf8'
    );

    const backupRes = await importJsonBackup(forgedBackupPath, { repo, pipeline });
    expect(backupRes.importedCount).toBe(0);
    expect(backupRes.skippedCount).toBe(1);
    const stillSecret = repo.getItemById(secret.id, { includeDeleted: true });
    expect(stillSecret?.dna).toBe('secret');
    expect(stillSecret?.title).toBe('Главный пароль');
    const rawSecret = repo.getRawRowById(secret.id)!;
    expect(cryptoVault.decryptSecret(rawSecret.encrypted_payload!).secretValue).toBe(
      'DoNotOverwriteMe!'
    );

    // 3. P2-15: Notion nested inner ZIPs share a single total decompression budget
    const bigTextA = '# Заметка A\n\n' + 'A'.repeat(8192);
    const bigTextB = '# Заметка B\n\n' + 'B'.repeat(8192);
    const innerZipA = createZipBuffer([{ name: 'PageA 11112222333344445555666677778888.md', data: Buffer.from(bigTextA, 'utf8') }]);
    const innerZipB = createZipBuffer([{ name: 'PageB aabbccddeeff00112233445566778899.md', data: Buffer.from(bigTextB, 'utf8') }]);
    const outerZip = createZipBuffer([
      { name: 'Export-Part-1.zip', data: innerZipA },
      { name: 'Export-Part-2.zip', data: innerZipB },
    ]);
    const notionZipPath = path.join(dir, 'notion-nested.zip');
    fs.writeFileSync(notionZipPath, outerZip);

    // Combined nested output is > 16KB -> must fail cleanly under a 12KB shared total budget!
    const blockedNotion = await importNotionZip(
      notionZipPath,
      { repo, pipeline },
      { maxTotalUncompressedBytes: 12 * 1024 }
    );
    expect(blockedNotion.importedCount).toBe(0);
    expect((blockedNotion.errors ?? []).length).toBeGreaterThan(0);

    // With sufficient shared budget (64KB), both nested notes import cleanly
    const okNotion = await importNotionZip(
      notionZipPath,
      { repo, pipeline },
      { maxTotalUncompressedBytes: 64 * 1024 }
    );
    expect(okNotion.importedCount).toBe(2);
    expect(okNotion.errors ?? []).toEqual([]);
  });

  it('#7 P2-13: hardens saveNoteImageAsset (magic bytes, ext allowlist, 25MB cap) and resolveSafeMediaFilePath realpath containment', async () => {
    const dir = makeTempDir('kapsula-media-sec-');
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const cryptoVault = new VaultCrypto(dir, null);
    activeCryptos.push(cryptoVault);
    const pipeline = new CapturePipeline({
      repo,
      cryptoVault,
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

    expect(detectImageExtFromMagic(SAMPLE_PNG_BUF)).toBe('.png');
    expect(detectImageExtFromMagic(Buffer.from('<svg></svg>', 'utf8'))).toBeNull();

    // Fake PNG containing HTML/script bytes must be rejected
    const fakePng = path.join(dir, 'disguised.png');
    fs.writeFileSync(fakePng, '<script>alert(1)</script>', 'utf8');
    await expect(pipeline.saveNoteImageAsset({ filePath: fakePng })).rejects.toThrow(
      /поддерживаемым изображением/i
    );

    // Disallowed extension (.svg) must be rejected
    const svgPath = path.join(dir, 'vector.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
    await expect(pipeline.saveNoteImageAsset({ filePath: svgPath })).rejects.toThrow(
      /Неподдерживаемый формат/i
    );

    // Oversized base64 (> 25MB) must be rejected without writing to disk
    const hugeBase64 = 'A'.repeat(35 * 1024 * 1024);
    await expect(pipeline.saveNoteImageAsset({ base64: hugeBase64 })).rejects.toThrow(
      /слишком большое/i
    );

    // Valid PNG succeeds and resolves strictly inside mediaDir
    const saved = await pipeline.saveNoteImageAsset({
      base64: `data:image/png;base64,${SAMPLE_PNG_BUF.toString('base64')}`,
    });
    const okResolved = resolveSafeMediaFilePath(pipeline.getMediaDir(), saved.filename);
    expect(okResolved.ok).toBe(true);

    // Realpath escape (symlink pointing outside mediaDir) must return 403 Forbidden
    const outsideFile = path.join(dir, 'outside-secret.txt');
    fs.writeFileSync(outsideFile, 'top-secret', 'utf8');
    const origRealpath = fs.realpathSync;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('escaped.png')) {
        return origRealpath(outsideFile);
      }
      return origRealpath(p);
    });
    const escapedRes = resolveSafeMediaFilePath(pipeline.getMediaDir(), 'escaped.png');
    expect(escapedRes).toEqual({ ok: false, status: 403 });
    realpathSpy.mockRestore();

    // #26 P2-4: reject Windows NTFS ADS colons (:) and NUL (\0) bytes with 400 Bad Request
    expect(resolveSafeMediaFilePath(pipeline.getMediaDir(), `${saved.filename}:Zone.Identifier`)).toEqual({
      ok: false,
      status: 400,
    });
    expect(resolveSafeMediaFilePath(pipeline.getMediaDir(), 'shot.png%3Astream')).toEqual({
      ok: false,
      status: 400,
    });
    expect(resolveSafeMediaFilePath(pipeline.getMediaDir(), 'shot.png%00.jpg')).toEqual({
      ok: false,
      status: 400,
    });
  });

  it('#9 P0-1, #8 Part B & #6 copy: Vault secrets skip auto-orbits, Touch ID & macOS clipboard/HUD behave cleanly', async () => {
    const dir = makeTempDir('kapsula-ipc-mac-');
    const handlers = new Map<string, (...args: any[]) => any>();
    const writtenItems: any[] = [];
    const appHideMock = vi.fn();

    vi.resetModules();
    vi.doMock('electron', () => ({
      ipcMain: {
        handle: vi.fn((ch: string, fn: (...args: any[]) => any) => {
          handlers.set(ch, fn);
        }),
      },
      clipboard: {
        write: vi.fn(async (items: any[]) => {
          writtenItems.push(...items);
        }),
        writeText: vi.fn(),
        readText: vi.fn(() => ''),
        clear: vi.fn(),
      },
      ClipboardItem: class MockClipboardItem {
        constructor(public readonly entries: Record<string, unknown>) {}
      },
      shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      app: { getPath: () => dir, getName: () => 'Kapsula', hide: appHideMock, show: vi.fn() },
      nativeImage: { createFromPath: vi.fn() },
      BrowserWindow: vi.fn(),
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      },
      desktopCapturer: { getSources: vi.fn() },
      systemPreferences: {
        canPromptTouchID: vi.fn(() => false),
        promptTouchID: vi.fn(),
        isTrustedAccessibilityClient: vi.fn(() => true),
      },
    }));

    try {
      const { VaultRepository: RepoCtor } = await import('@main/db/repository');
      const { VaultCrypto: CryptoCtor } = await import('@main/security/vault-crypto');
      const { registerIpcHandlers, writeConcealedClipboardText } = await import('@main/ipc');
      const { WindowManager } = await import('@main/windows');

      const repo = new RepoCtor(path.join(dir, 'vault.sqlite'));
      openRepos.push(repo);
      const cryptoVault = new CryptoCtor(dir, null);
      activeCryptos.push(cryptoVault);

      const fakeEvt = {
        sender: { id: 1, getURL: () => 'http://localhost:5173' },
        senderFrame: null,
      } as any;

      const getSettingsState = (): SettingsState =>
        ({
          aiProvider: 'local',
          hasGoogleAiKey: false,
          hasOpenRouterKey: false,
          hasActiveApiKey: false,
          monthlyCapUsd: 1.5,
          enableAutoOcr: true,
          enableUrlUnfurl: true,
          hasMasterPin: false,
          vaultUnlocked: true,
          clipboardAutoWipeSeconds: 30,
          hudShortcut: 'Alt+Space',
          snatchShortcut: 'CommandOrControl+Shift+V',
          activeMode: 'autopilot',
          activeFocusBoardId: null,
          enableScreenProtection: true,
        }) as unknown as SettingsState;

      registerIpcHandlers({
        repo,
        cryptoVault,
        pipeline: {
          cleanupUnreferencedMedia: vi.fn(),
          getMediaDir: () => dir,
        } as any,
        windows: {
          isOwnWebContents: () => true,
          isAllowedSurfaceUrl: () => true,
          broadcast: vi.fn(),
          setContentProtection: vi.fn(),
          setVaultBackgroundColor: vi.fn(),
        } as any,
        clipper: {} as any,
        getSettingsState,
        getApiKeyForProvider: () => null,
        setApiKeyForProvider: vi.fn(),
        setVaultUnlocked: vi.fn(),
      });

      // #9 P0-1: Creating bank card & password in Сейф does NOT spawn Финансы / Доступы sidebar orbits
      const card = await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'bank_card',
        service: 'Тинькофф Black',
        secretValue: '2200700712345676',
        expiry: '08/29',
        cvv: '321',
      });
      const pass = await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'password',
        service: 'GitHub Work',
        login: 'dev@work.io',
        secretValue: 'SecretPass!99',
      });
      expect(card.orbit).toBe('');
      expect(pass.orbit).toBe('');
      expect(repo.listOrbits()).toHaveLength(0);

      // Explicit orbit IS respected if caller explicitly picks one
      const workOrbit = repo.createOrbit({ name: 'Работа', description: '' });
      const explicitSecret = await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'api_key',
        service: 'Cloud API',
        secretValue: 'sk-live-12345678',
        orbit: workOrbit.id,
      });
      expect(explicitSecret.orbit).toBe(workOrbit.id);

      // #6 copy: invalid 2FA key message has human Russian without Base32/otpauth jargon
      expect(() =>
        handlers.get('secret:save-structured')!(fakeEvt, {
          kind: 'password',
          service: 'Bad 2FA',
          secretValue: 'pass',
          totpUriOrSecret: 'not-valid-!!!',
        })
      ).toThrow(
        'Не удалось распознать ключ 2FA — вставь секретный ключ целиком или ссылку из приложения-аутентификатора'
      );

      // #6 copy: webhook error message uses human Russian "Адрес обработчика"
      expect(() =>
        handlers.get('settings:update')!(fakeEvt, { emailInboundWebhookUrl: 'http://insecure.local' })
      ).toThrow('Адрес обработчика должен начинаться с https://');

      // #8 Part B: Touch ID guard rejects enabling biometricUnlockEnabled when unsupported
      expect(() =>
        handlers.get('settings:update')!(fakeEvt, { biometricUnlockEnabled: true })
      ).toThrow(/Touch ID/i);

      // #8 Part B: macOS concealed clipboard sets TransientType, ConcealedType & AutoGeneratedType
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        await writeConcealedClipboardText('MyMacSecret123');
        expect(writtenItems.length).toBeGreaterThan(0);
        const lastEntries = writtenItems[writtenItems.length - 1]!.entries;
        expect(
          lastEntries['electron application/osclipboard;format="org.nspasteboard.TransientType"']
        ).toBeDefined();
        expect(
          lastEntries['electron application/osclipboard;format="org.nspasteboard.ConcealedType"']
        ).toBeDefined();
        expect(
          lastEntries['electron application/osclipboard;format="org.nspasteboard.AutoGeneratedType"']
        ).toBeDefined();

        // #8 Part B: WindowManager.hideHud() / toggleHud() calls app.hide() on darwin when Vault is hidden
        const wm = new WindowManager('preload.js', { htmlPath: 'index.html' });
        const fakeHud = { isDestroyed: () => false, isVisible: () => true, hide: vi.fn() };
        const fakeVaultHidden = { isDestroyed: () => false, isVisible: () => false };
        (wm as any).hud = fakeHud;
        (wm as any).vault = fakeVaultHidden;
        wm.toggleHud();
        expect(fakeHud.hide).toHaveBeenCalledTimes(1);
        expect(appHideMock).toHaveBeenCalledTimes(1);

        // When Vault window IS visible, hiding HUD must NOT call app.hide()
        appHideMock.mockClear();
        (wm as any).vault = { isDestroyed: () => false, isVisible: () => true };
        wm.hideHud();
        expect(appHideMock).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      }
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });

  it('#6, #8 & #9 shared helpers + macOS installer/ZIP packager: strips inline images from tasks, fixes templates & verifies POSIX Mac ZIP', async () => {
    // 1. task-helpers strips inline kapsula-media:// & generic markdown images from task titles
    const md = [
      '- [ ] привет жизнь подход![Фото](kapsula-media://local/shot-abcdef123456.png)',
      '- [x] Проверить ![Схема](https://example.com/diagram.webp) макет',
      '- [ ] ![Фото](kapsula-media://local/only-image.png)',
      '- [ ] Чистая задача',
    ].join('\n');

    expect(stripInlineMarkdownImages('привет![Фото](kapsula-media://local/a.png) мир')).toBe(
      'привет мир'
    );

    const parsed = parseMarkdownTasks(md);
    expect(parsed.map((t) => t.text)).toEqual([
      'привет жизнь подход',
      'Проверить макет',
      'Чистая задача',
    ]);
    for (const t of parsed) {
      expect(t.text).not.toContain('kapsula-media://');
      expect(t.text).not.toContain('![');
    }

    // Toggling preserves the inline image in the underlying markdown body!
    const toggled = toggleMarkdownTaskInBody(md, 0, true);
    expect(toggled?.body).toContain(
      '- [x] привет жизнь подход![Фото](kapsula-media://local/shot-abcdef123456.png)'
    );

    // Standalone comparison also ignores inline image syntax
    expect(
      isStandaloneTaskSource(
        {
          itemTitle: 'Купить кофе',
          text: 'Купить кофе ![Фото](kapsula-media://local/cup.png)',
          sourceType: 'markdown',
        },
        1
      )
    ).toBe(true);

    // 2. note-templates: zero 'чеклист', zero empty '- ' / '- [ ] ' lines, zero Windows-hardcoded Ctrl+V / Alt+Пробел
    for (const tpl of NOTE_TEMPLATES) {
      const lines = tpl.body.split('\n');
      for (const line of lines) {
        expect(line, `Template "${tpl.id}" has bare empty bullet line`).not.toMatch(/^-\s*$/);
        expect(line, `Template "${tpl.id}" has bare empty task line`).not.toMatch(/^-\s*\[\s\]\s*$/);
      }
    }
    expect(ONBOARDING_PRESETS.welcomeNote.summary).toContain('чек-лист');
    expect(ONBOARDING_PRESETS.welcomeNote.summary).not.toContain('чеклист');
    expect(ONBOARDING_PRESETS.welcomeNote.body).not.toContain('Ctrl+V');
    expect(ONBOARDING_PRESETS.welcomeNote.body).not.toContain('Alt+Пробел');

    // 3. macOS installer script: strict LF + Vite 8 Node version guard + nvm PATH precedence + root mirror verbatim
    const repoRoot = path.resolve(__dirname, '..');
    const installerPath = path.join(
      repoRoot,
      'scripts',
      'mac-installer',
      'Установить Kapsula на Mac.command'
    );
    const rootInstallerPath = path.join(repoRoot, 'Установить Kapsula на Mac.command');
    if (fs.existsSync(installerPath) && fs.existsSync(rootInstallerPath)) {
      const installerBuf = fs.readFileSync(installerPath);
      const rootInstallerBuf = fs.readFileSync(rootInstallerPath);
      expect(installerBuf.includes(0x0d)).toBe(false); // ZERO CR (\r) bytes!
      expect(rootInstallerBuf.includes(0x0d)).toBe(false); // ZERO CR (\r) bytes!
      expect(rootInstallerBuf.equals(installerBuf)).toBe(true); // Exact verbatim sync!
      const installerText = installerBuf.toString('utf8');
      expect(installerText).toContain('NODE_MAJOR" -eq 20');
      expect(installerText).toContain('NODE_MINOR" -ge 19');
      expect(installerText).toContain('NODE_MAJOR" -eq 22');
      expect(installerText).toContain('NODE_MINOR" -ge 12');
      expect(installerText).toContain('NODE_MAJOR" -ge 23');
      expect(installerText).toContain('pgrep -x Kapsula');
      // After Homebrew installs/upgrades Node, re-prepend Homebrew bins ahead of nvm
      const brewIdx = installerText.indexOf('brew install node || brew upgrade node');
      const pathAfterBrewIdx = installerText.indexOf(
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
        brewIdx
      );
      expect(brewIdx).toBeGreaterThan(0);
      expect(pathAfterBrewIdx).toBeGreaterThan(brewIdx);
    }

    // 3b. Local assistant 3-form Russian pluralizer ("1 запись / 2 записи / 5 записей / 21 запись")
    const makeStatsInv = (totalItems: number, secretCount: number, orbCount: number) => ({
      totalItems,
      unassignedCount: 0,
      dueReminderCount: 0,
      bankCardCount: 0,
      passwordCount: secretCount,
      apiKeyCount: 0,
      byDna: { note: totalItems, link: 0, shot: 0, voice: 0, doc: 0, secret: secretCount, snippet: 0 },
      byOrbit: [{ id: 'orb-1', name: 'Работа', count: orbCount }],
      bankCards: [],
      secretServices: [{ id: 's-1', title: 'GitHub', kind: 'password' as const, orbit: '' }],
    });
    const fakeNoteItem = {
      id: 'n-1',
      dna: 'note',
      orbit: 'orb-1',
      title: 'Заметка',
      body: 'Текст',
      summary: '',
      tags: [],
    } as any;
    expect(answerVaultLocally('сколько всего записей', [], makeStatsInv(1, 1, 1)).answer).toContain('1 запись');
    expect(answerVaultLocally('сколько всего записей', [], makeStatsInv(2, 2, 2)).answer).toContain('2 записи');
    expect(answerVaultLocally('сколько всего записей', [], makeStatsInv(5, 5, 5)).answer).toContain('5 записей');
    expect(answerVaultLocally('сколько всего записей', [], makeStatsInv(21, 21, 21)).answer).toContain('21 запись');
    expect(answerVaultLocally('что в сейфе', [], makeStatsInv(1, 1, 1)).answer).toContain('1 запись');
    expect(answerVaultLocally('что в сейфе', [], makeStatsInv(3, 3, 3)).answer).toContain('3 записи');
    expect(
      answerVaultLocally('что в разделе Работа', [fakeNoteItem], makeStatsInv(1, 0, 1)).answer
    ).toContain('всего 1 запись.');
    expect(
      answerVaultLocally('что в разделе Работа', [fakeNoteItem], makeStatsInv(4, 0, 4)).answer
    ).toContain('всего 4 записи.');

    // 4. scripts/pack-mac-zip.mjs builds valid ZIP with UNIX create_system=3 & 0o100755<<16 on .command
    const packScriptFile = path.join(repoRoot, 'scripts', 'pack-mac-zip.mjs');
    if (fs.existsSync(packScriptFile)) {
      const outZip = path.join(makeTempDir('kapsula-mac-zip-'), 'Kapsula-for-Mac.zip');
      const packScriptUrl = pathToFileURL(packScriptFile).href;
      const { buildMacZip } = (await import(packScriptUrl)) as {
        buildMacZip: (opts?: { rootDir?: string; outPath?: string }) => {
          outPath: string;
          entryCount: number;
          byteSize: number;
        };
      };
      const res = buildMacZip({ rootDir: repoRoot, outPath: outZip });
      expect(res.entryCount).toBeGreaterThan(50);

      // Inspect raw Central Directory Header for UNIX create_system & 0o100755 << 16 external_attr
      const zipBuf = fs.readFileSync(outZip);
      const targetNameBytes = Buffer.from(
        'Kapsula-Mac/Установить Kapsula на Mac.command',
        'utf8'
      );
      let foundCdEntry = false;
      let cursor = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(cursor).toBeGreaterThan(0);
      const cdOffset = zipBuf.readUInt32LE(cursor + 16);
      const totalEntries = zipBuf.readUInt16LE(cursor + 10);
      let cdPos = cdOffset;
      for (let i = 0; i < totalEntries; i += 1) {
        expect(zipBuf.readUInt32LE(cdPos)).toBe(0x02014b50);
        const versionMadeBy = zipBuf.readUInt16LE(cdPos + 4);
        const nameLen = zipBuf.readUInt16LE(cdPos + 28);
        const extraLen = zipBuf.readUInt16LE(cdPos + 30);
        const commentLen = zipBuf.readUInt16LE(cdPos + 32);
        const extAttr = zipBuf.readUInt32LE(cdPos + 38);
        const entryName = zipBuf.subarray(cdPos + 46, cdPos + 46 + nameLen);
        if (entryName.equals(targetNameBytes)) {
          foundCdEntry = true;
          expect(versionMadeBy >> 8).toBe(3); // UNIX create_system
          expect(extAttr).toBe((0o100755 << 16) >>> 0); // rwxr-xr-x
          break;
        }
        cdPos += 46 + nameLen + extraLen + commentLen;
      }
      expect(foundCdEntry).toBe(true);
    }
  });

  it('v7 legacy SQLite schema opens cleanly in v8 VaultRepository without losing notes, orbits, or secrets', () => {
    const dir = makeTempDir('kapsula-v7-schema-');
    const dbPath = path.join(dir, 'v7-live.sqlite');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE orbits (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        icon TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER,
        deleted_at INTEGER, sync_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE focus_boards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER, deleted_at INTEGER, sync_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE items (
        id TEXT PRIMARY KEY, dna TEXT NOT NULL, sub_kind TEXT, orbit TEXT NOT NULL DEFAULT '',
        mode_captured TEXT NOT NULL, focus_board_id TEXT, title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
        url TEXT, domain TEXT, platform TEXT, image_path TEXT, thumb_path TEXT,
        media_path TEXT, media_type TEXT, media_duration_sec REAL, media_meta_json TEXT,
        og_image_url TEXT, ocr_text TEXT NOT NULL DEFAULT '',
        extracted_actions_json TEXT NOT NULL DEFAULT '[]',
        color_palette_json TEXT NOT NULL DEFAULT '[]',
        encrypted_payload TEXT, secret_meta_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
        annotations_json TEXT NOT NULL DEFAULT '[]', links_out_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'manual', external_id TEXT, content_hash TEXT NOT NULL,
        ai_status TEXT NOT NULL DEFAULT 'local', ai_confidence REAL,
        is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0, remind_at INTEGER, reminded_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, content_updated_at INTEGER,
        deleted_at INTEGER, sync_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const now = Date.now();
    rawDb
      .prepare(
        `INSERT INTO orbits (id, name, description, icon, color, sort_order, is_builtin, created_at, updated_at)
         VALUES ('orb-1', 'Работа', 'Рабочие заметки', 'Briefcase', '#3B82F6', 1, 0, ?, ?)`
      )
      .run(now, now);
    rawDb
      .prepare(
        `INSERT INTO items (id, dna, orbit, mode_captured, title, body, source, content_hash, created_at, updated_at)
         VALUES ('note-v7-1', 'note', 'orb-1', 'autopilot', 'Живая заметка v7', 'Текст пользователя из v7', 'vault_ui', 'v7-h1', ?, ?)`
      )
      .run(now, now);
    rawDb.close();

    const upgradedRepo = new VaultRepository(dbPath);
    openRepos.push(upgradedRepo);
    expect(upgradedRepo.listOrbits().map((o) => o.name)).toContain('Работа');
    const migratedNote = upgradedRepo.getItemById('note-v7-1');
    expect(migratedNote?.title).toBe('Живая заметка v7');
    expect(migratedNote?.body).toBe('Текст пользователя из v7');
    expect(migratedNote?.purgedAt).toBeNull();
  });
});
