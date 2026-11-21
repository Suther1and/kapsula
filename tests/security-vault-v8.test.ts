import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsState } from '@shared/types';
import { VaultCrypto } from '@main/security/vault-crypto';
import { analyzeForSecret, redactSecrets } from '@main/security/secret-shield';
import { createKeyEnvelope, rewrapEnvelopePassphrase, unwrapDekWithPassphrase } from '@main/sync/sync-crypto';
import { VaultRepository } from '@main/db/repository';
import { SyncEngine } from '@main/sync/sync-engine';

const tempDirs: string[] = [];
const openRepos: VaultRepository[] = [];

function makeTempDir(prefix = 'kapsula-sec-v8-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

describe('Kapsula V8 Commercial Vault Security & TOTP', () => {
  it('enforces 2-tier PIN-KEK wrapping (scrypt N=65536), zeroizes VDK on lock, prevents DB-flag bypass, and migrates legacy DPAPI vaults', () => {
    const dir = makeTempDir();
    const mockDpapi = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from(`dpapi:${plainText}`, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        const s = encrypted.toString('utf8');
        if (!s.startsWith('dpapi:')) throw new Error('Bad DPAPI blob');
        return s.slice('dpapi:'.length);
      },
    };

    // 1. Start with legacy DPAPI-backed vault and encrypt a secret + config key
    const v1 = new VaultCrypto(dir, mockDpapi);
    expect(v1.isPinProtected()).toBe(false);
    expect(v1.isLocked()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(true);

    const secretCipher = v1.encryptSecret({
      service: 'GitHub',
      login: 'dev@kapsula.app',
      secretValue: 'ghp_SuperSecretToken9876543210',
      notes: '',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    });
    const aiKeyCipher = v1.encryptConfigJson({ apiKey: 'AIzaSyFakeKeyForConfigTest' });

    // 2. Enable Master PIN -> creates vault.vdk.pin.json (scrypt N=65536) and DELETES master.key.dpapi!
    v1.setPinProtection('9472');
    expect(v1.isPinProtected()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'vault.vdk.pin.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(false);

    const pinFileRaw = JSON.parse(fs.readFileSync(path.join(dir, 'vault.vdk.pin.json'), 'utf8'));
    expect(pinFileRaw.v).toBe(2);
    expect(pinFileRaw.kdf).toBe('scrypt');
    expect(pinFileRaw.N).toBe(65536);

    // 3. Locking zeroizes the VDK buffer in RAM and blocks secret decryption, while config key stays readable!
    const internalBuf = (v1 as unknown as { masterKey: Buffer | null }).masterKey!;
    expect(internalBuf).toBeInstanceOf(Buffer);
    expect(internalBuf.some((b) => b !== 0)).toBe(true);

    v1.lock();
    expect(v1.isLocked()).toBe(true);
    expect(internalBuf.every((b) => b === 0)).toBe(true);
    expect(() => v1.decryptSecret(secretCipher)).toThrow(/Сейф заблокирован/i);
    expect(v1.decryptConfigJson<{ apiKey: string }>(aiKeyCipher).value.apiKey).toBe('AIzaSyFakeKeyForConfigTest');

    // 4. Fresh VaultCrypto restart starts LOCKED; even without SQLite master_pin_hash, wrong PIN cannot unlock!
    const v2 = new VaultCrypto(dir, mockDpapi);
    expect(v2.isPinProtected()).toBe(true);
    expect(v2.isLocked()).toBe(true);
    expect(() => v2.decryptSecret(secretCipher)).toThrow(/Сейф заблокирован/i);
    expect(v2.unlockWithPin('0000')).toBe(false);
    expect(v2.isLocked()).toBe(true);

    // 5. Correct PIN unwraps the exact same VDK and decrypts existing secret!
    expect(v2.unlockWithPin('9472')).toBe(true);
    expect(v2.isLocked()).toBe(false);
    const decrypted = v2.decryptSecret(secretCipher);
    expect(decrypted.secretValue).toBe('ghp_SuperSecretToken9876543210');
    expect(decrypted.totpSecret).toBe('JBSWY3DPEHPK3PXP');

    // 6. Biometric slot enable/unlock & removePinProtection roundtrip
    v2.setBiometricSlotEnabled(true);
    expect(v2.hasBiometricSlot()).toBe(true);
    v2.lock();
    expect(v2.unlockWithBiometric()).toBe(true);
    expect(v2.decryptSecret(secretCipher).service).toBe('GitHub');

    v2.removePinProtection();
    expect(v2.isPinProtected()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'vault.vdk.pin.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(true);

    v1.dispose();
    v2.dispose();
  });

  it('strictly enforces includeSecrets: false in repository.queryItems (both default feed and search queries)', () => {
    const dir = makeTempDir();
    const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
    openRepos.push(repo);
    const vc = new VaultCrypto(dir, null);

    const note = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Обычная заметка про Т-Банк',
      body: 'Просто заметка о тарифах Т-Банк',
      summary: 'Тарифы',
      source: 'vault_ui',
      contentHash: 'v8-inc-sec-note',
    });
    const secret = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Т-Банк карта •••• 5676',
      body: '🔒 Зашифровано в Сейфе',
      summary: 'Т-Банк',
      encryptedPayload: vc.encryptSecret({
        service: 'Т-Банк',
        login: '',
        secretValue: '2200700712345676',
        notes: '',
        cvv: '384',
      }),
      secretMeta: {
        kind: 'bank_card',
        service: 'Т-Банк',
        loginHint: '',
        cardBrand: 'МИР',
        last4: '5676',
        expiry: '09/29',
      },
      source: 'vault_ui',
      contentHash: 'v8-inc-sec-secret',
    });

    // Default feed with includeSecrets: false MUST exclude secret
    const noSecretsDefault = repo.queryItems({ includeSecrets: false });
    expect(noSecretsDefault.map((i) => i.id)).toContain(note.id);
    expect(noSecretsDefault.map((i) => i.id)).not.toContain(secret.id);

    // Search query with includeSecrets: false MUST exclude secret (even when keyword matches card/service/last4!)
    const noSecretsSearch = repo.queryItems({ search: 'Т-Банк', includeSecrets: false });
    expect(noSecretsSearch.map((i) => i.id)).toContain(note.id);
    expect(noSecretsSearch.map((i) => i.id)).not.toContain(secret.id);

    const noSecretsCardSearch = repo.queryItems({ search: 'карта 5676', includeSecrets: false });
    expect(noSecretsCardSearch.map((i) => i.id)).not.toContain(secret.id);

    // Explicitly passing includeSecrets: true includes it
    const withSecrets = repo.queryItems({ search: 'Т-Банк', includeSecrets: true });
    expect(withSecrets.map((i) => i.id)).toContain(secret.id);
    vc.dispose();
  });

  it('enforces >= 10 char sync passphrases on new/rotated envelopes, detects TOTP URIs in SecretShield, and blocks disk fb: fallback by default', async () => {
    // 1. SecretShield detects & redacts otpauth://totp/... URIs
    const uri = 'Мой 2FA ключ: otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';
    expect(analyzeForSecret(uri).isSecret).toBe(true);
    const redacted = redactSecrets(uri);
    expect(redacted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(redacted).toContain('[REDACTED_SECRET]');

    // 2. Sync passphrase >= 10 chars on setup & rotation
    await expect(createKeyEnvelope('u1', 'short9chr', 5_000)).rejects.toThrow(/10 символов/i);
    const valid = await createKeyEnvelope('u1', 'valid-passphrase-10', 5_000);
    await expect(
      rewrapEnvelopePassphrase('u1', valid.dek, 'tooShort9', valid.envelope, 5_000)
    ).rejects.toThrow(/10 символов/i);
    const rotated = await rewrapEnvelopePassphrase(
      'u1',
      valid.dek,
      'new-strong-pass-2026',
      valid.envelope,
      5_000
    );
    const unwrapped = await unwrapDekWithPassphrase('u1', 'new-strong-pass-2026', rotated, 5_000);
    expect(unwrapped.equals(valid.dek)).toBe(true);

    // 3. LocalSecureStore MUST NOT write weak `fb:` prefix to disk unless KAPSULA_ALLOW_FALLBACK_KEY === '1'
    const prevEnv = process.env.KAPSULA_ALLOW_FALLBACK_KEY;
    delete process.env.KAPSULA_ALLOW_FALLBACK_KEY;
    try {
      const dir = makeTempDir();
      const repo = new VaultRepository(path.join(dir, 'vault.sqlite'));
      openRepos.push(repo);
      const vc = new VaultCrypto(dir, null);
      const engine = new SyncEngine({
        dataDir: dir,
        mediaDir: path.join(dir, 'media'),
        repo,
        vaultCrypto: vc,
        deviceName: 'Test-No-Fallback',
        kdfIterationsOverride: 5_000,
        disableTimers: true,
        disableRealtime: true,
      });
      const secureStore = (engine as unknown as {
        secureStore: { set: (k: string, v: string) => void; get: (k: string) => string | null };
      }).secureStore;
      secureStore.set('dek.user1', Buffer.alloc(32, 7).toString('base64'));
      expect(fs.existsSync(path.join(dir, '.sync-secrets.json'))).toBe(false);
      // Session key stays alive in memory (ephemeralCache) without persisting weak fb: to disk
      secureStore.set('supabase.auth.token', 'session-json');
      expect(secureStore.get('supabase.auth.token')).toBe('session-json');
      expect(fs.existsSync(path.join(dir, '.sync-secrets.json'))).toBe(false);
      engine.dispose();
      vc.dispose();
    } finally {
      if (prevEnv !== undefined) process.env.KAPSULA_ALLOW_FALLBACK_KEY = prevEnv;
    }
  });

  it('wires TOTP 2FA IPC isolation, concealed clipboard + recovery-key copy, locked vault:query redaction, persisted exponential PIN lockout, and random secret contentHash', async () => {
    const dir = makeTempDir('kapsula-ipc-v8-');
    const handlers = new Map<string, (evt: unknown, ...args: unknown[]) => unknown>();
    let clipText = '';
    const clipboardWrites: string[] = [];

    vi.resetModules();
    vi.doMock('electron', () => ({
      ipcMain: {
        removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
        handle: vi.fn((ch: string, fn: (evt: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(ch, fn);
        }),
      },
      clipboard: {
        writeText: vi.fn((t: string) => {
          clipText = t;
          clipboardWrites.push(t);
        }),
        readText: vi.fn(() => clipText),
        clear: vi.fn(() => {
          clipText = '';
        }),
      },
      shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      app: { getPath: () => dir, getName: () => 'Kapsula' },
      nativeImage: { createFromPath: vi.fn() },
      systemPreferences: {
        canPromptTouchID: vi.fn(() => false),
        promptTouchID: vi.fn(),
      },
    }));

    try {
      const dbPath = path.join(dir, 'vault.sqlite');
      const { VaultRepository: RepoCtor } = await import('@main/db/repository');
      const { VaultCrypto: CryptoCtor } = await import('@main/security/vault-crypto');
      const { registerIpcHandlers } = await import('@main/ipc');

      const repo = new RepoCtor(dbPath);
      openRepos.push(repo);
      const cryptoVault = new CryptoCtor(dir, null);
      let unlocked = true;
      let screenProtected = true;

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
          googleAiKeyMasked: null,
          openRouterKeyMasked: null,
          monthlyCapUsd: 1.5,
          enableAutoOcr: true,
          enableUrlUnfurl: true,
          hasMasterPin: Boolean(repo.getSetting('master_pin_hash')) || cryptoVault.isPinProtected(),
          vaultUnlocked: unlocked,
          clipboardAutoWipeSeconds: 30,
          hudShortcut: 'Alt+Space',
          snatchShortcut: 'CommandOrControl+Shift+V',
          shortcutStatus: {
            hudRegistered: true,
            snatchRegistered: true,
            effectiveHudShortcut: 'Alt+Space',
            effectiveSnatchShortcut: 'CommandOrControl+Shift+V',
            error: null,
          },
          activeMode: 'autopilot',
          activeFocusBoardId: null,
          enableTactileSound: false,
          enableScreenProtection: screenProtected,
        }) as unknown as SettingsState;

      const setContentProtectionMock = vi.fn((enabled: boolean) => {
        screenProtected = enabled;
      });

      const registerOnRepo = (r: InstanceType<typeof RepoCtor>, vc: InstanceType<typeof CryptoCtor>) =>
        registerIpcHandlers({
          repo: r,
          cryptoVault: vc,
          pipeline: {
            cleanupUnreferencedMedia: vi.fn(),
            getMediaDir: () => dir,
          } as any,
          windows: {
            isOwnWebContents: () => true,
            isAllowedSurfaceUrl: () => true,
            broadcast: vi.fn(),
            persistOrbPosition: vi.fn(),
            setCaptureMode: vi.fn(),
            setContentProtection: setContentProtectionMock,
            setVaultBackgroundColor: vi.fn(),
            hideHudAndPaste: vi.fn().mockResolvedValue(true),
          } as any,
          clipper: {} as any,
          getSettingsState,
          getApiKeyForProvider: () => null,
          setApiKeyForProvider: vi.fn(),
          setVaultUnlocked: (v) => {
            unlocked = v;
            if (!v && vc.isPinProtected()) {
              vc.lock();
            }
          },
        });

      const hooks = registerOnRepo(repo, cryptoVault);

      // 1. Set Master PIN (2-tier wrapping!)
      await handlers.get('secret:set-pin')!(fakeEvt, '4829');
      expect(cryptoVault.isPinProtected()).toBe(true);

      // 2. Save structured secret WITH TOTP URI — verify totpSecret NEVER leaks to SecretMeta or FTS5!
      const totpRawSecret = 'JBSWY3DPEHPK3PXP';
      const savedTotp = (await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'password',
        service: 'GitHub Pro',
        login: 'alice@kapsula.app',
        secretValue: 'MyPass!2026',
        notes: 'Резервная заметка секрета',
        totpUriOrSecret: `otpauth://totp/GitHub:alice@kapsula.app?secret=${totpRawSecret}&issuer=GitHub&digits=6&period=30`,
      })) as any;

      expect(savedTotp.secretMeta?.hasTotp).toBe(true);
      expect(savedTotp.secretMeta?.totpDigits).toBe(6);
      expect(savedTotp.secretMeta?.totpPeriod).toBe(30);
      expect(JSON.stringify(savedTotp.secretMeta)).not.toContain(totpRawSecret);
      expect(savedTotp.body).not.toContain(totpRawSecret);

      // Verify FTS5 table NEVER stores totpSecret
      const ftsHit = repo.db
        .prepare('SELECT id FROM items_fts WHERE items_fts MATCH ?')
        .all(`"${totpRawSecret}"`);
      expect(ftsHit).toHaveLength(0);

      // Verify secret content_hash is a random UUID (not deterministic sha256)
      const secondIdentical = (await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'password',
        service: 'GitHub Pro',
        login: 'alice@kapsula.app',
        secretValue: 'MyPass!2026',
      })) as any;
      expect(savedTotp.contentHash).not.toBe(secondIdentical.contentHash);
      expect(savedTotp.contentHash).toMatch(/^[0-9a-f-]{36}$/i);

      // 3. secret:get-totp-code returns valid 6-digit code when unlocked
      const totpSnap = (await handlers.get('secret:get-totp-code')!(fakeEvt, savedTotp.id)) as any;
      expect(totpSnap).not.toBeNull();
      expect(totpSnap.code).toMatch(/^\d{6}$/);
      expect(totpSnap.period).toBe(30);

      // 4. secret:copy-field supports 'totp' and 'notes'
      const copyTotp = (await handlers.get('secret:copy-field')!(fakeEvt, savedTotp.id, 'totp')) as any;
      expect(copyTotp.ok).toBe(true);
      expect(copyTotp.wipeSeconds).toBe(30);
      expect(clipText).toMatch(/^\d{6}$/);

      const copyNotes = (await handlers.get('secret:copy-field')!(fakeEvt, savedTotp.id, 'notes')) as any;
      expect(copyNotes.ok).toBe(true);
      expect(clipText).toBe('Резервная заметка секрета');

      // 5. sync:copy-recovery-key ACTUALLY writes key to clipboard (regression fix!)
      const recKey = 'KAPS-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345';
      const recCopy = (await handlers.get('sync:copy-recovery-key')!(fakeEvt, recKey)) as any;
      expect(recCopy.ok).toBe(true);
      expect(clipText).toBe(recKey);

      // 6. vault:set-screen-protection updates setting & BrowserWindow content protection
      const spOff = (await handlers.get('vault:set-screen-protection')!(fakeEvt, false)) as boolean;
      expect(spOff).toBe(false);
      expect(repo.getSetting('enable_screen_protection')).toBe('false');
      expect(setContentProtectionMock).toHaveBeenCalledWith(false);

      // 7. Lock vault -> TOTP returns null, vault:query redacts loginHint/last4/expiry!
      const savedCard = (await handlers.get('secret:save-structured')!(fakeEvt, {
        kind: 'bank_card',
        service: 'Сбер МИР',
        secretValue: '2202 2006 1234 5676',
        expiry: '11/29',
        cvv: '777',
      })) as any;

      hooks.lockVaultIfProtected();
      expect(unlocked).toBe(false);
      expect(cryptoVault.isLocked()).toBe(true);
      expect(await handlers.get('secret:get-totp-code')!(fakeEvt, savedTotp.id)).toBeNull();

      const lockedList = (await handlers.get('vault:query')!(fakeEvt, { includeSecrets: true })) as any[];
      const lockedEntry = lockedList.find((i) => i.id === savedTotp.id);
      expect(lockedEntry).toBeDefined();
      expect(lockedEntry.secretMeta?.loginHint).toBe('');

      const lockedCard = lockedList.find((i) => i.id === savedCard.id);
      expect(lockedCard).toBeDefined();
      expect(lockedCard.secretMeta?.last4).toBeUndefined();
      expect(lockedCard.secretMeta?.expiry).toBeUndefined();
      expect(lockedCard.title).not.toContain('5676');

      // 8. Persisted exponential PIN lockout survives IPC re-registration (restart)!
      const unlockHandler = handlers.get('secret:unlock-pin')!;
      for (let i = 0; i < 4; i += 1) {
        expect(await unlockHandler(fakeEvt, '0000')).toBe(false);
      }
      await expect(Promise.resolve().then(() => unlockHandler(fakeEvt, '0000'))).rejects.toThrow(
        /Слишком много неверных попыток/i
      );
      expect(Number(repo.getSetting('pin_failed_attempts'))).toBe(5);
      expect(Number(repo.getSetting('pin_locked_until'))).toBeGreaterThan(Date.now());

      // Simulate app restart by re-registering handlers on the same SQLite DB & VaultCrypto
      const vcReloaded = new CryptoCtor(dir, null);
      registerOnRepo(repo, vcReloaded);
      const unlockAfterRestart = handlers.get('secret:unlock-pin')!;
      // Lockout MUST still be active after restart, even with the right PIN!
      await expect(Promise.resolve().then(() => unlockAfterRestart(fakeEvt, '4829'))).rejects.toThrow(
        /Подожди/i
      );

      // Expire lockout timestamp and verify valid PIN unlocks + resets counters!
      repo.setSetting('pin_locked_until', '0');
      expect(await unlockAfterRestart(fakeEvt, '4829')).toBe(true);
      expect(unlocked).toBe(true);
      expect(vcReloaded.isLocked()).toBe(false);
      expect(repo.getSetting('pin_failed_attempts')).toBe('0');

      // Delete master_pin_hash in SQLite, lock again -> VDK STILL protected by vault.vdk.pin.json and self-heals hash on valid PIN!
      repo.setSetting('master_pin_hash', '');
      vcReloaded.lock();
      unlocked = false;
      expect(await unlockAfterRestart(fakeEvt, '9999')).toBe(false);
      expect(vcReloaded.isLocked()).toBe(true);
      expect(await unlockAfterRestart(fakeEvt, '4829')).toBe(true);
      expect(vcReloaded.isLocked()).toBe(false);
      expect(repo.getSetting('master_pin_hash')).toMatch(/^scrypt2:/);

      vcReloaded.dispose();
      cryptoVault.dispose();
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});
