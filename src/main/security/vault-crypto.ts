import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppLocale, SecretPayload } from '@shared/types';
import { translate } from '@shared/i18n';

export interface DpapiBridge {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

interface PinWrappedVdkFile {
  v: 2;
  alg: 'aes-256-gcm';
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

interface LocalWrappedVdkFile {
  v: 2;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

const PIN_SCRYPT_N = 65536;
const PIN_SCRYPT_R = 8;
const PIN_SCRYPT_P = 1;
const PIN_SCRYPT_MAXMEM = 128 * 1024 * 1024;
const PIN_VDK_AAD = Buffer.from('kapsula:vdk-pin:v2', 'utf8');
const LOCAL_VDK_AAD = Buffer.from('kapsula:vdk-local:v2', 'utf8');

function atomicWriteFile(filePath: string, data: string | Buffer): void {
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    if (typeof data === 'string') {
      fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    } else {
      fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

function unlinkIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup error
  }
}

export class VaultCrypto {
  private masterKey: Buffer | null;
  private configKey: Buffer | null = null;
  private pinProtected = false;
  private readonly dataDir: string;
  private readonly dpapi: DpapiBridge | null;
  private readonly keyPath: string;
  private readonly pinKeyPath: string;
  private readonly bioKeyPath: string;
  private readonly localWrappedPath: string;
  private readonly fallbackSaltPath: string;
  private readonly configKeyPath: string;
  private readonly configSaltPath: string;
  private readonly usingDpapi: boolean;
  private readonly isPackaged: boolean;
  private locale: AppLocale;

  constructor(
    dataDir: string,
    dpapi?: DpapiBridge | null,
    locale: AppLocale = 'ru',
    options?: { isPackaged?: boolean }
  ) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = dataDir;
    this.dpapi = dpapi ?? null;
    this.locale = locale === 'en' ? 'en' : 'ru';
    this.isPackaged = Boolean(options?.isPackaged);
    this.keyPath = path.join(dataDir, 'master.key.dpapi');
    this.pinKeyPath = path.join(dataDir, 'vault.vdk.pin.json');
    this.bioKeyPath = path.join(dataDir, 'vault.vdk.bio.dpapi');
    this.localWrappedPath = path.join(dataDir, 'vault.vdk.local.json');
    this.fallbackSaltPath = path.join(dataDir, '.vault.salt');
    this.configKeyPath = path.join(dataDir, 'config.key.dpapi');
    this.configSaltPath = path.join(dataDir, '.config.salt');

    const dpapiAvailable = Boolean(dpapi && dpapi.isEncryptionAvailable());
    this.usingDpapi = dpapiAvailable;

    // Tier 2: PIN-KEK protected Vault Data Key — starts cryptographically locked (VDK not in RAM)
    if (fs.existsSync(this.pinKeyPath)) {
      this.pinProtected = true;
      this.masterKey = null;
      return;
    }

    if (dpapiAvailable && dpapi) {
      if (fs.existsSync(this.keyPath)) {
        const sealed = fs.readFileSync(this.keyPath);
        const hex = dpapi.decryptString(sealed);
        const key = Buffer.from(hex, 'hex');
        if (key.length !== 32) {
          throw new Error(translate(this.locale, 'main.vault.corruptKey'));
        }
        this.masterKey = key;
      } else {
        this.masterKey = crypto.randomBytes(32);
        const sealed = dpapi.encryptString(this.masterKey.toString('hex'));
        atomicWriteFile(this.keyPath, sealed);
      }
      return;
    }

    if (fs.existsSync(this.keyPath)) {
      throw new Error(translate(this.locale, 'main.vault.keychainUnavailable'));
    }

    if (this.isPackaged) {
      // Packaged builds without OS keychain/safeStorage must fail closed until Master PIN is set
      this.masterKey = null;
      return;
    }

    if (fs.existsSync(this.localWrappedPath)) {
      this.masterKey = this.unwrapLocalVdk();
      return;
    }

    // Deterministic machine-scoped key fallback for test / non-packaged headless environments without PIN
    this.masterKey = this.deriveLocalFallbackKey(this.fallbackSaltPath, 'kapsula-local-v1');
  }

  private deriveLocalFallbackKey(saltPath: string, domain: string): Buffer {
    if (this.isPackaged) {
      throw new Error(translate(this.locale, 'main.vault.keychainUnavailable'));
    }
    let salt: Buffer;
    if (fs.existsSync(saltPath)) {
      salt = fs.readFileSync(saltPath);
    } else {
      salt = crypto.randomBytes(16);
      atomicWriteFile(saltPath, salt);
    }
    return crypto.pbkdf2Sync(
      `${os.hostname()}:${this.dataDir}:${domain}`,
      salt,
      50_000,
      32,
      'sha256'
    );
  }

  private wrapLocalVdk(vdk: Buffer): void {
    const kek = this.deriveLocalFallbackKey(this.fallbackSaltPath, 'kapsula-local-v2');
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
      cipher.setAAD(LOCAL_VDK_AAD);
      const encrypted = Buffer.concat([cipher.update(vdk), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload: LocalWrappedVdkFile = {
        v: 2,
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64'),
      };
      atomicWriteFile(this.localWrappedPath, JSON.stringify(payload));
    } finally {
      kek.fill(0);
    }
  }

  public setLocale(locale: AppLocale): void {
    this.locale = locale === 'en' ? 'en' : 'ru';
  }

  private unwrapLocalVdk(): Buffer {
    const raw = JSON.parse(fs.readFileSync(this.localWrappedPath, 'utf8')) as LocalWrappedVdkFile;
    if (!raw || raw.v !== 2 || raw.alg !== 'aes-256-gcm') {
      throw new Error(translate(this.locale, 'main.vault.corruptEnvelope'));
    }
    const kek = this.deriveLocalFallbackKey(this.fallbackSaltPath, 'kapsula-local-v2');
    try {
      const iv = Buffer.from(raw.iv, 'base64');
      const tag = Buffer.from(raw.tag, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
      decipher.setAAD(LOCAL_VDK_AAD);
      decipher.setAuthTag(tag);
      const vdk = Buffer.concat([
        decipher.update(Buffer.from(raw.data, 'base64')),
        decipher.final(),
      ]);
      if (vdk.length !== 32) {
        vdk.fill(0);
        throw new Error(translate(this.locale, 'main.vault.corruptKey'));
      }
      return vdk;
    } finally {
      kek.fill(0);
    }
  }

  private getOrCreateConfigKey(): Buffer {
    if (this.configKey) return this.configKey;
    if (this.dpapi && this.dpapi.isEncryptionAvailable()) {
      if (fs.existsSync(this.configKeyPath)) {
        const sealed = fs.readFileSync(this.configKeyPath);
        const key = Buffer.from(this.dpapi.decryptString(sealed), 'hex');
        if (key.length === 32) {
          this.configKey = key;
          return key;
        }
      }
      const fresh = crypto.randomBytes(32);
      const sealed = this.dpapi.encryptString(fresh.toString('hex'));
      atomicWriteFile(this.configKeyPath, sealed);
      this.configKey = fresh;
      return fresh;
    }
    if (this.isPackaged) {
      this.configKey = crypto.randomBytes(32);
      return this.configKey;
    }
    this.configKey = this.deriveLocalFallbackKey(this.configSaltPath, 'kapsula-config-v1');
    return this.configKey;
  }

  private requireUnlockedVdk(): Buffer {
    if (!this.masterKey || this.masterKey.length !== 32) {
      throw new Error(translate(this.locale, 'main.vault.lockedError'));
    }
    return this.masterKey;
  }

  public isDpapiBacked(): boolean {
    return this.usingDpapi;
  }

  public isPinProtected(): boolean {
    return this.pinProtected;
  }

  public isLocked(): boolean {
    return this.masterKey === null;
  }

  public hasBiometricSlot(): boolean {
    return fs.existsSync(this.bioKeyPath);
  }

  private static scryptAsync(
    password: crypto.BinaryLike,
    salt: crypto.BinaryLike,
    keylen: number,
    options?: crypto.ScryptOptions
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else resolve(derivedKey);
      };
      if (options) {
        crypto.scrypt(password, salt, keylen, options, cb);
      } else {
        crypto.scrypt(password, salt, keylen, cb);
      }
    });
  }

  private wrapVdkWithPinKek(vdk: Buffer, salt: Buffer, pinKek: Buffer): void {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', pinKek, iv, { authTagLength: 16 });
      cipher.setAAD(PIN_VDK_AAD);
      const encrypted = Buffer.concat([cipher.update(vdk), cipher.final()]);
      const tag = cipher.getAuthTag();

      const filePayload: PinWrappedVdkFile = {
        v: 2,
        alg: 'aes-256-gcm',
        kdf: 'scrypt',
        N: PIN_SCRYPT_N,
        r: PIN_SCRYPT_R,
        p: PIN_SCRYPT_P,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64'),
      };
      atomicWriteFile(this.pinKeyPath, JSON.stringify(filePayload));
    } finally {
      pinKek.fill(0);
    }
  }

  private finalizePinProtection(opts?: { enableBiometric?: boolean }): void {
    // Remove plain OS safeStorage & local fallback unwraps so DB tampering cannot bypass PIN
    unlinkIfExists(this.keyPath);
    unlinkIfExists(this.localWrappedPath);
    unlinkIfExists(this.fallbackSaltPath);

    if (opts?.enableBiometric === true) {
      this.setBiometricSlotEnabled(true);
    } else if (opts?.enableBiometric === false) {
      unlinkIfExists(this.bioKeyPath);
    }

    this.pinProtected = true;
  }

  private readPinWrappedEnvelope(): {
    parsed: PinWrappedVdkFile;
    salt: Buffer;
    iv: Buffer;
    tag: Buffer;
    scryptN: number;
    scryptR: number;
    scryptP: number;
  } | null {
    if (!fs.existsSync(this.pinKeyPath)) {
      return null;
    }
    let parsed: PinWrappedVdkFile;
    try {
      parsed = JSON.parse(fs.readFileSync(this.pinKeyPath, 'utf8')) as PinWrappedVdkFile;
    } catch {
      return null;
    }
    if (!parsed || parsed.v !== 2 || parsed.alg !== 'aes-256-gcm' || parsed.kdf !== 'scrypt') {
      return null;
    }
    const salt = Buffer.from(parsed.salt, 'base64');
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) {
      return null;
    }
    return {
      parsed,
      salt,
      iv,
      tag,
      scryptN: Number.isInteger(parsed.N) && parsed.N >= 16384 ? parsed.N : PIN_SCRYPT_N,
      scryptR: Number.isInteger(parsed.r) && parsed.r >= 1 ? parsed.r : PIN_SCRYPT_R,
      scryptP: Number.isInteger(parsed.p) && parsed.p >= 1 ? parsed.p : PIN_SCRYPT_P,
    };
  }

  private decryptPinWrappedEnvelope(
    env: NonNullable<ReturnType<VaultCrypto['readPinWrappedEnvelope']>>,
    pinKek: Buffer
  ): Buffer | null {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', pinKek, env.iv, { authTagLength: 16 });
      decipher.setAAD(PIN_VDK_AAD);
      decipher.setAuthTag(env.tag);
      const vdk = Buffer.concat([
        decipher.update(Buffer.from(env.parsed.data, 'base64')),
        decipher.final(),
      ]);
      if (vdk.length !== 32) {
        vdk.fill(0);
        return null;
      }
      return vdk;
    } catch {
      return null;
    } finally {
      pinKek.fill(0);
    }
  }

  /**
   * Wraps the 256-bit Vault Data Key (VDK) with a scrypt-derived PIN-KEK (N=65536, r=8, p=1)
   * and removes the plain OS safeStorage unwrap file so deleting SQLite rows cannot unlock secrets.
   */
  public setPinProtection(pin: string, opts?: { enableBiometric?: boolean }): void {
    const cleanPin = pin.trim();
    if (cleanPin.length < 4) {
      throw new Error(translate(this.locale, 'main.ipc.pinMinChars'));
    }
    const vdk = this.requireUnlockedVdk();
    const salt = crypto.randomBytes(16);
    const pinKek = crypto.scryptSync(cleanPin, salt, 32, {
      N: PIN_SCRYPT_N,
      r: PIN_SCRYPT_R,
      p: PIN_SCRYPT_P,
      maxmem: PIN_SCRYPT_MAXMEM,
    });
    this.wrapVdkWithPinKek(vdk, salt, pinKek);
    this.finalizePinProtection(opts);
  }

  /**
   * Async worker-pool variant of setPinProtection so scrypt does not stall Electron's main event loop.
   */
  public async setPinProtectionAsync(
    pin: string,
    opts?: { enableBiometric?: boolean }
  ): Promise<void> {
    const cleanPin = pin.trim();
    if (cleanPin.length < 4) {
      throw new Error(translate(this.locale, 'main.ipc.pinMinChars'));
    }
    const vdk = this.requireUnlockedVdk();
    const salt = crypto.randomBytes(16);
    const pinKek = await VaultCrypto.scryptAsync(cleanPin, salt, 32, {
      N: PIN_SCRYPT_N,
      r: PIN_SCRYPT_R,
      p: PIN_SCRYPT_P,
      maxmem: PIN_SCRYPT_MAXMEM,
    });
    this.wrapVdkWithPinKek(vdk, salt, pinKek);
    this.finalizePinProtection(opts);
  }

  /**
   * Unwraps the PIN-protected VDK into a freshly allocated Buffer, or returns null on mismatch.
   */
  private unwrapPinKeyBuffer(pin: string): Buffer | null {
    const env = this.readPinWrappedEnvelope();
    if (!env) return null;
    const pinKek = crypto.scryptSync(pin.trim(), env.salt, 32, {
      N: env.scryptN,
      r: env.scryptR,
      p: env.scryptP,
      maxmem: PIN_SCRYPT_MAXMEM,
    });
    return this.decryptPinWrappedEnvelope(env, pinKek);
  }

  private async unwrapPinKeyBufferAsync(pin: string): Promise<Buffer | null> {
    const env = this.readPinWrappedEnvelope();
    if (!env) return null;
    const pinKek = await VaultCrypto.scryptAsync(pin.trim(), env.salt, 32, {
      N: env.scryptN,
      r: env.scryptR,
      p: env.scryptP,
      maxmem: PIN_SCRYPT_MAXMEM,
    });
    return this.decryptPinWrappedEnvelope(env, pinKek);
  }

  /**
   * Verifies the provided PIN against the PIN-KEK envelope without mutating unlock state.
   */
  public verifyPinProtection(pin: string): boolean {
    const vdk = this.unwrapPinKeyBuffer(pin);
    if (!vdk) return false;
    vdk.fill(0);
    return true;
  }

  /**
   * Async worker-pool variant of verifyPinProtection.
   */
  public async verifyPinProtectionAsync(pin: string): Promise<boolean> {
    const vdk = await this.unwrapPinKeyBufferAsync(pin);
    if (!vdk) return false;
    vdk.fill(0);
    return true;
  }

  /**
   * Disables Master PIN cryptographic wrapping while unlocked and restores OS safeStorage protection.
   */
  public removePinProtection(): void {
    const vdk = this.requireUnlockedVdk();
    if (this.dpapi && this.dpapi.isEncryptionAvailable()) {
      const sealed = this.dpapi.encryptString(vdk.toString('hex'));
      atomicWriteFile(this.keyPath, sealed);
    } else if (this.isPackaged) {
      throw new Error(translate(this.locale, 'main.vault.keychainUnavailable'));
    } else {
      this.wrapLocalVdk(vdk);
    }
    unlinkIfExists(this.pinKeyPath);
    unlinkIfExists(this.bioKeyPath);
    this.pinProtected = false;
  }

  /**
   * Unconditionally zeroes keys and deletes PIN/VDK local material during account wipe.
   * Safe to invoke even when Vault is locked.
   */
  public resetForAccountWipe(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    this.pinProtected = false;
    unlinkIfExists(this.pinKeyPath);
    unlinkIfExists(this.bioKeyPath);
    unlinkIfExists(this.keyPath);
    unlinkIfExists(this.localWrappedPath);
    unlinkIfExists(this.fallbackSaltPath);

    if (this.dpapi && this.dpapi.isEncryptionAvailable()) {
      const fresh = crypto.randomBytes(32);
      const sealed = this.dpapi.encryptString(fresh.toString('hex'));
      atomicWriteFile(this.keyPath, sealed);
      this.masterKey = fresh;
    } else if (!this.isPackaged) {
      this.masterKey = this.deriveLocalFallbackKey(this.fallbackSaltPath, 'kapsula-local-v1');
    }
  }

  /**
   * Attempts to unwrap VDK into RAM using the provided Master PIN.
   */
  public unlockWithPin(pin: string): boolean {
    if (!fs.existsSync(this.pinKeyPath)) {
      return this.masterKey !== null;
    }
    const vdk = this.unwrapPinKeyBuffer(pin);
    return this.installUnwrappedPinVdk(vdk);
  }

  /**
   * Async worker-pool variant of unlockWithPin so scrypt does not stall Electron's main event loop.
   */
  public async unlockWithPinAsync(pin: string): Promise<boolean> {
    if (!fs.existsSync(this.pinKeyPath)) {
      return this.masterKey !== null;
    }
    const vdk = await this.unwrapPinKeyBufferAsync(pin);
    return this.installUnwrappedPinVdk(vdk);
  }

  private installUnwrappedPinVdk(vdk: Buffer | null): boolean {
    if (!vdk) return false;
    if (this.masterKey && this.masterKey !== vdk) {
      this.masterKey.fill(0);
    }
    this.masterKey = vdk;
    this.pinProtected = true;
    return true;
  }

  /**
   * Creates or removes the OS-keychain-backed biometric unwrap slot (only called while unlocked).
   */
  public setBiometricSlotEnabled(enabled: boolean): boolean {
    if (!enabled) {
      unlinkIfExists(this.bioKeyPath);
      return true;
    }
    if (!this.dpapi || !this.dpapi.isEncryptionAvailable()) {
      return false;
    }
    const vdk = this.requireUnlockedVdk();
    const sealed = this.dpapi.encryptString(vdk.toString('hex'));
    atomicWriteFile(this.bioKeyPath, sealed);
    return true;
  }

  /**
   * Unwraps VDK using the biometric OS keychain slot (must only be called after OS Touch ID prompt succeeds).
   */
  public unlockWithBiometric(): boolean {
    if (!this.pinProtected && this.masterKey) {
      return true;
    }
    if (!this.dpapi || !this.dpapi.isEncryptionAvailable() || !fs.existsSync(this.bioKeyPath)) {
      return false;
    }
    try {
      const sealed = fs.readFileSync(this.bioKeyPath);
      const hex = this.dpapi.decryptString(sealed);
      const vdk = Buffer.from(hex, 'hex');
      if (vdk.length !== 32) {
        vdk.fill(0);
        return false;
      }
      if (this.masterKey && this.masterKey !== vdk) {
        this.masterKey.fill(0);
      }
      this.masterKey = vdk;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Zeroizes the in-memory VDK buffer when PIN-protected Vault locks.
   */
  public lock(): void {
    if (!this.pinProtected) return;
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
  }

  /**
   * Zeroizes all in-memory key material on process exit.
   */
  public dispose(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    if (this.configKey) {
      this.configKey.fill(0);
      this.configKey = null;
    }
  }

  private encryptWithKey(key: Buffer, payload: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
    const tag = cipher.getAuthTag();
    const env: EncryptedEnvelope = {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
    return JSON.stringify(env);
  }

  private decryptWithKey<T>(key: Buffer, serialized: string): T {
    const env = JSON.parse(serialized) as EncryptedEnvelope;
    if (env.v !== 1 || env.alg !== 'aes-256-gcm') {
      throw new Error('Unsupported encrypted payload envelope');
    }
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('Corrupted encrypted payload envelope');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([
      decipher.update(Buffer.from(env.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(dec.toString('utf8')) as T;
  }

  public encryptJson(payload: unknown): string {
    return this.encryptWithKey(this.requireUnlockedVdk(), payload);
  }

  public decryptJson<T = SecretPayload>(serialized: string): T {
    return this.decryptWithKey<T>(this.requireUnlockedVdk(), serialized);
  }

  /**
   * App-configuration encryption (AI API keys, non-Vault integration tokens) backed by OS safeStorage
   * independently of Vault Master PIN lock so background AI keeps working while Vault is locked.
   */
  public encryptConfigJson(payload: unknown): string {
    return this.encryptWithKey(this.getOrCreateConfigKey(), payload);
  }

  public decryptConfigJson<T>(serialized: string): { value: T; migratedFromVdk: boolean } {
    try {
      return {
        value: this.decryptWithKey<T>(this.getOrCreateConfigKey(), serialized),
        migratedFromVdk: false,
      };
    } catch (cfgErr) {
      if (this.masterKey) {
        return {
          value: this.decryptWithKey<T>(this.masterKey, serialized),
          migratedFromVdk: true,
        };
      }
      throw cfgErr;
    }
  }

  public encryptSecret(payload: SecretPayload): string {
    return this.encryptJson(payload);
  }

  public decryptSecret(serialized: string): SecretPayload {
    return this.decryptJson<SecretPayload>(serialized);
  }

  public static hashPin(pin: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto
      .scryptSync(pin, salt, 32, {
        N: PIN_SCRYPT_N,
        r: PIN_SCRYPT_R,
        p: PIN_SCRYPT_P,
        maxmem: PIN_SCRYPT_MAXMEM,
      })
      .toString('hex');
    return `scrypt2:${salt}:${derived}`;
  }

  public static async hashPinAsync(pin: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = (
      await VaultCrypto.scryptAsync(pin, salt, 32, {
        N: PIN_SCRYPT_N,
        r: PIN_SCRYPT_R,
        p: PIN_SCRYPT_P,
        maxmem: PIN_SCRYPT_MAXMEM,
      })
    ).toString('hex');
    return `scrypt2:${salt}:${derived}`;
  }

  public static verifyPin(pin: string, stored: string): boolean {
    const parts = stored.split(':');
    if (parts.length === 3 && parts[0] === 'scrypt2') {
      const [, salt, hexHash] = parts;
      if (!salt || !hexHash) return false;
      const derived = crypto.scryptSync(pin, salt, 32, {
        N: PIN_SCRYPT_N,
        r: PIN_SCRYPT_R,
        p: PIN_SCRYPT_P,
        maxmem: PIN_SCRYPT_MAXMEM,
      });
      const expected = Buffer.from(hexHash, 'hex');
      if (derived.length !== expected.length) return false;
      return crypto.timingSafeEqual(derived, expected);
    }
    // Backwards-compatible verification for legacy scrypt v1 hashes
    if (parts.length !== 2) return false;
    const [salt, hexHash] = parts;
    if (!salt || !hexHash) return false;
    const derived = crypto.scryptSync(pin, salt, 32);
    const expected = Buffer.from(hexHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }

  public static async verifyPinAsync(pin: string, stored: string): Promise<boolean> {
    const parts = stored.split(':');
    if (parts.length === 3 && parts[0] === 'scrypt2') {
      const [, salt, hexHash] = parts;
      if (!salt || !hexHash) return false;
      const derived = await VaultCrypto.scryptAsync(pin, salt, 32, {
        N: PIN_SCRYPT_N,
        r: PIN_SCRYPT_R,
        p: PIN_SCRYPT_P,
        maxmem: PIN_SCRYPT_MAXMEM,
      });
      const expected = Buffer.from(hexHash, 'hex');
      if (derived.length !== expected.length) return false;
      return crypto.timingSafeEqual(derived, expected);
    }
    if (parts.length !== 2) return false;
    const [salt, hexHash] = parts;
    if (!salt || !hexHash) return false;
    const derived = await VaultCrypto.scryptAsync(pin, salt, 32);
    const expected = Buffer.from(hexHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }
}

export class ClipboardWiper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private copiedSha256: string | null = null;

  public scheduleCopy(
    secretText: string,
    writeClipboard: (txt: string) => void | Promise<void>,
    readClipboard: () => string | Promise<string>,
    delayMs: number,
    onWiped?: () => void
  ): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void Promise.resolve(writeClipboard(secretText)).catch(() => {});
    if (delayMs <= 0) return;

    this.copiedSha256 = crypto.createHash('sha256').update(secretText).digest('hex');
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          const current = await Promise.resolve(readClipboard());
          const currentHash = crypto.createHash('sha256').update(current).digest('hex');
          if (currentHash === this.copiedSha256) {
            await Promise.resolve(writeClipboard(''));
            onWiped?.();
          }
        } catch {
          // Ignore clipboard access errors on background wipe
        } finally {
          this.copiedSha256 = null;
          this.timer = null;
        }
      })();
    }, delayMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public async clearNow(
    writeClipboard: (txt: string) => void | Promise<void>,
    readClipboard: () => string | Promise<string>
  ): Promise<void> {
    const hash = this.copiedSha256;
    this.dispose();
    if (!hash) return;
    try {
      const current = await Promise.resolve(readClipboard());
      const currentHash = crypto.createHash('sha256').update(current).digest('hex');
      if (currentHash === hash) {
        await Promise.resolve(writeClipboard(''));
      }
    } catch {
      // Ignore clipboard access errors during teardown
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.copiedSha256 = null;
  }
}
