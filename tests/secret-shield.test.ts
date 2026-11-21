import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsState } from '@shared/types';
import { analyzeForSecret, detectBankCard, passesLuhn, redactSecrets } from '@main/security/secret-shield';
import { ClipboardWiper, VaultCrypto } from '@main/security/vault-crypto';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapsula-sec-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Secret Shield & VaultCrypto', () => {
  it('detects API keys, JWTs, PEM blocks, seed phrases, and Russian credentials', () => {
    expect(analyzeForSecret('My key: sk-or-v1-1234567890abcdefghij1234').isSecret).toBe(true);
    expect(analyzeForSecret('ghp_1234567890abcdefghijklmnopqrstuv').isSecret).toBe(true);
    expect(analyzeForSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c').isSecret).toBe(true);
    expect(analyzeForSecret('-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----').isSecret).toBe(true);
    expect(analyzeForSecret('abandon ability able about above absent absorb abstract absurd abuse access accident').isSecret).toBe(true);
    expect(analyzeForSecret('admin@kapsula.ru:P@ssword991').isSecret).toBe(true);

    const ru = analyzeForSecret('Сервис: T-Bank\nЛогин: user@mail.ru\nПароль: MySecret!2026');
    expect(ru.isSecret).toBe(true);
    expect(ru.meta?.service).toBe('T-Bank');
    expect(ru.payload?.secretValue).toBe('MySecret!2026');

    expect(analyzeForSecret('https://habr.com/ru/articles/123456/ хорошая статья про UX').isSecret).toBe(false);
    expect(analyzeForSecret('Встреча в 14:30 по архитектуре дизайна').isSecret).toBe(false);

    // Standalone labeled secrets without login line
    const pinOnly = analyzeForSecret('PIN: 4829');
    expect(pinOnly.isSecret).toBe(true);
    expect(pinOnly.payload?.secretValue).toBe('4829');

    const tokOnly = analyzeForSecret('Token: tok_live_9988');
    expect(tokOnly.isSecret).toBe(true);
    expect(tokOnly.payload?.secretValue).toBe('tok_live_9988');

    const ruKeyOnly = analyzeForSecret('Ключ: my_key_7777');
    expect(ruKeyOnly.isSecret).toBe(true);
    expect(ruKeyOnly.payload?.secretValue).toBe('my_key_7777');
  });

  it('redacts sensitive secrets, seeds, and credential pairs before any external text handling', () => {
    const raw = [
      'Пароль: Secret999!',
      'Токен sk-or-v1-abcdef1234567890abcdef1234',
      'Почта ops@corp.ru:SuperPass!1',
      'ключ: hidden_val_99',
      'abandon ability able about above absent absorb abstract absurd abuse access accident',
    ].join('\n');
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain('Secret999!');
    expect(redacted).not.toContain('sk-or-v1-abcdef1234567890abcdef1234');
    expect(redacted).not.toContain('SuperPass!1');
    expect(redacted).not.toContain('hidden_val_99');
    expect(redacted).not.toContain('abandon ability able about');
    expect(redacted).toContain('[REDACTED_SECRET]');
    expect(redacted).toContain('[REDACTED_SEED_PHRASE]');
  });

  it('detects Luhn-valid bank cards, extracts expiry/CVV, and redacts card digits', () => {
    expect(passesLuhn('2202200612345676')).toBe(true);
    expect(passesLuhn('2202200612345675')).toBe(false);

    const card = detectBankCard('Т-Банк МИР 2202 2006 1234 5676 09/29 CVV 384 IVAN PETROV');
    expect(card).not.toBeNull();
    expect(card?.brand).toBe('МИР');
    expect(card?.last4).toBe('5676');
    expect(card?.expiry).toBe('09/29');
    expect(card?.cvv).toBe('384');

    const analysis = analyzeForSecret('Карта 2202 2006 1234 5676 09/29 CVV 384');
    expect(analysis.isSecret).toBe(true);
    expect(analysis.meta?.kind).toBe('bank_card');
    expect(analysis.meta?.cardBrand).toBe('МИР');
    expect(analysis.meta?.last4).toBe('5676');
    expect(analysis.payload?.expiry).toBe('09/29');
    expect(analysis.payload?.cvv).toBe('384');

    const masked = redactSecrets('Оплата с карты 2202 2006 1234 5676 до 09/29 CVV 384');
    expect(masked).not.toContain('2202 2006 1234 5676');
    expect(masked).toContain('[REDACTED_CARD]');
  });

  it('persists master.key.dpapi via DPAPI bridge and refuses missing DPAPI fallback', () => {
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

    const v1 = new VaultCrypto(dir, mockDpapi);
    expect(v1.isDpapiBacked()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'master.key.dpapi'))).toBe(true);

    const cipher = v1.encryptSecret({
      service: 'CorpVPN',
      login: 'alice',
      secretValue: 'VpnSecret#2026',
      notes: '',
    });

    const v2 = new VaultCrypto(dir, mockDpapi);
    expect(v2.isDpapiBacked()).toBe(true);
    expect(v2.decryptSecret(cipher).secretValue).toBe('VpnSecret#2026');

    expect(() => new VaultCrypto(dir, null)).toThrow(/Системное хранилище ключей/);
  });

  it('roundtrips AES-256-GCM encryption and scrypt PIN verification', () => {
    const cryptoVault = new VaultCrypto(makeTempDir(), null);
    const enc = cryptoVault.encryptSecret({
      service: 'GitHub',
      login: 'dev@example.com',
      secretValue: 'ghp_super_secret_token_999',
      notes: 'backup',
    });
    expect(enc).not.toContain('ghp_super_secret_token_999');

    const dec = cryptoVault.decryptSecret(enc);
    expect(dec.service).toBe('GitHub');
    expect(dec.secretValue).toBe('ghp_super_secret_token_999');

    const pinHash = VaultCrypto.hashPin('2580');
    expect(VaultCrypto.verifyPin('2580', pinHash)).toBe(true);
    expect(VaultCrypto.verifyPin('0000', pinHash)).toBe(false);
  });

  it('auto-wipes clipboard only when clipboard still matches the copied secret', async () => {
    const wiper = new ClipboardWiper();
    let clip = '';
    let wipedCount = 0;

    wiper.scheduleCopy('top-secret-1', (t) => { clip = t; }, () => clip, 40, () => { wipedCount++; });
    expect(clip).toBe('top-secret-1');
    await new Promise((r) => setTimeout(r, 80));
    expect(clip).toBe('');
    expect(wipedCount).toBe(1);

    // If user copied something else meanwhile, wiper must not erase user's new clipboard content
    wiper.scheduleCopy('top-secret-2', (t) => { clip = t; }, () => clip, 40, () => { wipedCount++; });
    clip = 'user-copied-normal-link';
    await new Promise((r) => setTimeout(r, 80));
    expect(clip).toBe('user-copied-normal-link');
    expect(wipedCount).toBe(1);

    // clearNow wipes immediately when matching secret, and leaves unrelated clipboard intact
    wiper.scheduleCopy('top-secret-3', (t) => { clip = t; }, () => clip, 5000);
    await wiper.clearNow((t) => { clip = t; }, () => clip);
    expect(clip).toBe('');

    wiper.scheduleCopy('top-secret-4', (t) => { clip = t; }, () => clip, 5000);
    clip = 'unrelated-text';
    await wiper.clearNow((t) => { clip = t; }, () => clip);
    expect(clip).toBe('unrelated-text');

    wiper.dispose();
  });

  it('ignores non-credential prose label:value pairs such as Subject, Server, Order, and Branch', () => {
    for (const prose of [
      'Subject: Contract renewal for Q3',
      'Server: production',
      'Order: #12345',
      'Branch: feature-1',
    ]) {
      expect(analyzeForSecret(prose).isSecret).toBe(false);
      expect(redactSecrets(prose)).toBe(prose);
    }
  });

  it('tracks hasCvv on bank cards, filters false-positive Russian prose/error codes, and redacts mid-sentence secrets', () => {
    const withCvv = analyzeForSecret('Т-Банк МИР 2200 7007 1234 5676 09/29 CVV 384');
    expect(withCvv.isSecret).toBe(true);
    expect(withCvv.meta?.hasCvv).toBe(true);

    const withoutCvv = analyzeForSecret('Т-Банк МИР 2200 7007 1234 5676 09/29');
    expect(withoutCvv.isSecret).toBe(true);
    expect(withoutCvv.meta?.hasCvv).toBe(false);

    for (const fp of [
      'Ключ: от домофона в верхнем ящике у охраны',
      'Код: HTTP_404',
      'Код: ERR_CONNECTION_REFUSED',
      'Код: 2026',
    ]) {
      expect(analyzeForSecret(fp).isSecret).toBe(false);
      expect(redactSecrets(fp)).toBe(fp);
    }

    const midSentence = 'Итог готов. Пароль: InlineSecret#77';
    expect(analyzeForSecret(midSentence).isSecret).toBe(true);
    const redacted = redactSecrets(midSentence);
    expect(redacted).not.toContain('InlineSecret#77');
    expect(redacted).toContain('Итог готов');
  });

  it('sanitizeUpdateItemPatch allows only user-editable fields and strips protected fields', async () => {
    vi.doMock('electron', () => ({
      app: {},
      clipboard: {},
      ClipboardItem: class {},
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      ipcMain: { handle: vi.fn() },
      nativeImage: {},
      shell: {},
    }));
    const { sanitizeUpdateItemPatch } = await import('../src/main/ipc');
    const sanitized = sanitizeUpdateItemPatch({
      title: 'Новый заголовок',
      orbit: 'work',
      focusBoardId: null,
      isPinned: true,
      isArchived: 'true',
      remindAt: 1790000000000,
      remindedAt: Number.NaN,
      tags: ['проект', 123, 'важное'],
      dna: 'note',
      encryptedPayload: 'tampered',
      secretMeta: { kind: 'password' },
      imagePath: '../../evil.png',
      thumbPath: 'x.webp',
      mediaPath: 'a.mp3',
      aiStatus: 'done',
    });

    expect(sanitized).toEqual({
      title: 'Новый заголовок',
      orbit: 'work',
      focusBoardId: null,
      isPinned: true,
      remindAt: 1790000000000,
      tags: ['проект', 'важное'],
    });
    expect('encryptedPayload' in sanitized).toBe(false);
    expect('secretMeta' in sanitized).toBe(false);
    expect('dna' in sanitized).toBe(false);
    expect('imagePath' in sanitized).toBe(false);
    expect('aiStatus' in sanitized).toBe(false);
    vi.doUnmock('electron');
  });

  it('enforces 5-attempt PIN lockout cooldown with wait seconds and syncs secret title edits to secretMeta and ciphertext', async () => {
    vi.resetModules();
    const handlers = new Map<string, (...args: any[]) => any>();
    vi.doMock('electron', () => ({
      app: {},
      clipboard: {
        writeText: vi.fn(),
        readText: vi.fn(() => ''),
      },
      ClipboardItem: class {},
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      ipcMain: {
        handle: vi.fn((ch: string, fn: (...args: any[]) => any) => {
          handlers.set(ch, fn);
        }),
      },
      nativeImage: {},
      shell: {},
    }));

    try {
      const dir = makeTempDir();
      const dbPath = path.join(dir, 'vault.sqlite');
      const { VaultRepository } = await import('@main/db/repository');
      const repo = new VaultRepository(dbPath);
      const cryptoVault = new VaultCrypto(dir, null);
      let unlocked = true;
      const { registerIpcHandlers } = await import('@main/ipc');

      const fakeEvt = {
        sender: { id: 1, getURL: () => 'http://localhost:5173' },
        senderFrame: null,
      } as any;
      const getSettingsState = (): SettingsState => {
        const rawWipe = repo.getSetting('clipboard_wipe_sec');
        const parsedWipe = rawWipe !== null && rawWipe !== '' ? Number(rawWipe) : 25;
        return {
          aiProvider: 'local' as const,
          hasGoogleAiKey: false,
          hasOpenRouterKey: false,
          hasActiveApiKey: false,
          googleAiKeyMasked: null,
          openRouterKeyMasked: null,
          monthlyCapUsd: 1.5,
          enableAutoOcr: true,
          enableUrlUnfurl: true,
          hasMasterPin: Boolean(repo.getSetting('master_pin_hash')),
          vaultUnlocked: unlocked,
          clipboardAutoWipeSeconds:
            Number.isFinite(parsedWipe) && (parsedWipe === 0 || parsedWipe >= 5) ? parsedWipe : 25,
          hudShortcut: 'Alt+Space',
          snatchShortcut: 'CommandOrControl+Shift+V',
          shortcutStatus: {
            hudRegistered: true,
            snatchRegistered: true,
            effectiveHudShortcut: 'Alt+Space',
            effectiveSnatchShortcut: 'CommandOrControl+Shift+V',
            error: null,
          },
          activeMode: 'autopilot' as const,
          activeFocusBoardId: null,
          enableTactileSound: false,
        } as unknown as SettingsState;
      };

      const ipcHooks = registerIpcHandlers({
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
          persistOrbPosition: vi.fn(),
          setCaptureMode: vi.fn(),
        } as any,
        clipper: {} as any,
        getSettingsState,
        getApiKeyForProvider: () => null,
        setApiKeyForProvider: vi.fn(),
        setVaultUnlocked: (v) => {
          unlocked = v;
        },
      });

      await handlers.get('secret:set-pin')!(fakeEvt, '2580');

      const saveSecret = handlers.get('secret:save-structured')!;
      const created = await saveSecret(fakeEvt, {
        kind: 'bank_card',
        service: 'Т-Банк',
        secretValue: '2200 7007 1234 5676',
        expiry: '09/29',
        cvv: '384',
      });

      const updateItem = handlers.get('vault:update-item')!;
      const renamed = await updateItem(fakeEvt, created.id, { title: 'Альфа МИР Личная' });
      expect(renamed.secretMeta?.service).toBe('Альфа МИР Личная');
      const rawCipher = repo.getRawEncryptedPayload(created.id);
      expect(rawCipher).toBeTruthy();
      expect(cryptoVault.decryptSecret(rawCipher!).service).toBe('Альфа МИР Личная');

      const updateSettings = handlers.get('settings:update')!;
      const disabledWipeState = await updateSettings(fakeEvt, { clipboardAutoWipeSeconds: 0 });
      expect(disabledWipeState.clipboardAutoWipeSeconds).toBe(0);
      expect(repo.getSetting('clipboard_wipe_sec')).toBe('0');

      const copySecret = handlers.get('secret:copy')!;
      const copyNoWipe = await copySecret(fakeEvt, created.id);
      expect(copyNoWipe).toEqual({ ok: true, wipeSeconds: 0 });

      await updateSettings(fakeEvt, { clipboardAutoWipeSeconds: 25 });

      ipcHooks.lockVaultIfProtected();
      expect(unlocked).toBe(false);

      const deleteItem = handlers.get('vault:delete-item')!;
      await expect(Promise.resolve().then(() => deleteItem(fakeEvt, created.id))).rejects.toThrow(
        /мастер-кодом/i
      );

      const unlockPin = handlers.get('secret:unlock-pin')!;
      for (let i = 0; i < 4; i++) {
        expect(await unlockPin(fakeEvt, '0000')).toBe(false);
      }
      await expect(Promise.resolve().then(() => unlockPin(fakeEvt, '0000'))).rejects.toThrow(
        /Слишком много неверных попыток/i
      );
      await expect(Promise.resolve().then(() => unlockPin(fakeEvt, '2580'))).rejects.toThrow(
        /Подожди/i
      );

      repo.close();
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});
