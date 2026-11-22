import { maskLoginHint } from '@shared/secret-helpers';
import { parseOtpAuthUri } from '@shared/totp';
import type { SecretMeta, SecretPayload, StructuredSecretInput } from '@shared/types';
import { tm } from '../lib/mobile-i18n';
import { mobileBridge } from '../native/bridge';
import {
  base64ToBytes,
  bytesToBase64,
  utf8Decode,
  utf8Encode,
} from '../sync/mobile-crypto';

interface WrappedVdkPinRecord {
  v: 1;
  alg: 'pbkdf2-sha256-aes-gcm';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * Local at-rest encryption wrapper for Android Secrets & DEK cache (AD-A1 / AD-3).
 * Uses hardware-backed Android Keystore (AES-256-GCM) on Android devices, a RAM-only
 * 2-tier PIN-KEK VDK when Master PIN is enabled, and falls back to WebCrypto AES-256-GCM
 * in web/test environments.
 */
export class MobileLocalCrypto {
  private fallbackKey: CryptoKey | null = null;
  private keystoreAvailable: boolean | null = null;
  private pinProtected = false;
  private vdk: Uint8Array | null = null;

  constructor(private readonly getOrCreateFallbackSeed: () => Promise<string>) {}

  public setPinProtectedMode(enabled: boolean): void {
    this.pinProtected = Boolean(enabled);
    if (!this.pinProtected) {
      this.lock();
    }
  }

  public isPinProtected(): boolean {
    return this.pinProtected;
  }

  public isLocked(): boolean {
    return this.pinProtected && !this.vdk;
  }

  public lock(): void {
    if (this.vdk) {
      this.vdk.fill(0);
      this.vdk = null;
    }
  }

  public resetForAccountWipe(): void {
    this.lock();
    this.pinProtected = false;
  }

  public setUnlockedVdk(vdk: Uint8Array): void {
    if (vdk.length !== 32) {
      throw new Error(tm('crypto.keyLenErr'));
    }
    this.lock();
    this.vdk = new Uint8Array(vdk);
  }

  public getVdkCopy(): Uint8Array | null {
    return this.vdk ? new Uint8Array(this.vdk) : null;
  }

  public generateVdk(): Uint8Array {
    const out = new Uint8Array(new ArrayBuffer(32));
    globalThis.crypto.getRandomValues(out);
    return out;
  }

  private async importRawAesKey(rawBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
    const copy = new Uint8Array(rawBytes.byteLength);
    copy.set(rawBytes);
    return globalThis.crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, usages);
  }

  private async derivePinKek(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const saltCopy = new Uint8Array(salt.byteLength);
    saltCopy.set(salt);
    const keyMat = await globalThis.crypto.subtle.importKey(
      'raw',
      utf8Encode(pin.trim().normalize('NFKC')),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return globalThis.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltCopy, iterations, hash: 'SHA-256' },
      keyMat,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  public async wrapVdkWithPin(
    vdk: Uint8Array,
    pin: string,
    iterations = PIN_KDF_ITERATIONS
  ): Promise<string> {
    const clean = pin.trim();
    if (clean.length < 4) {
      throw new Error(tm('vaultCrypto.pinMin4'));
    }
    if (vdk.length !== 32) {
      throw new Error(tm('crypto.keyLenErr'));
    }
    const salt = new Uint8Array(new ArrayBuffer(16));
    const iv = new Uint8Array(new ArrayBuffer(12));
    globalThis.crypto.getRandomValues(salt);
    globalThis.crypto.getRandomValues(iv);
    const kek = await this.derivePinKek(clean, salt, iterations);
    const vdkCopy = new Uint8Array(vdk.byteLength);
    vdkCopy.set(vdk);
    const ctBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      kek,
      vdkCopy
    );
    const rec: WrappedVdkPinRecord = {
      v: 1,
      alg: 'pbkdf2-sha256-aes-gcm',
      iter: iterations,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ctBuf)),
    };
    return JSON.stringify(rec);
  }

  public async unwrapVdkWithPin(wrappedJson: string, pin: string): Promise<Uint8Array | null> {
    try {
      const parsed = JSON.parse(wrappedJson) as WrappedVdkPinRecord;
      if (
        !parsed ||
        parsed.v !== 1 ||
        parsed.alg !== 'pbkdf2-sha256-aes-gcm' ||
        !Number.isInteger(parsed.iter) ||
        parsed.iter < 10_000
      ) {
        return null;
      }
      const salt = base64ToBytes(parsed.salt);
      const iv = base64ToBytes(parsed.iv);
      const ct = base64ToBytes(parsed.ct);
      if (salt.length < 16 || iv.length !== 12 || ct.length < 32) return null;
      const kek = await this.derivePinKek(pin.trim(), salt, parsed.iter);
      const plainBuf = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
        kek,
        new Uint8Array(ct)
      );
      const vdk = new Uint8Array(plainBuf);
      return vdk.length === 32 ? vdk : null;
    } catch {
      return null;
    }
  }

  public async isOsProtected(): Promise<boolean> {
    if (this.keystoreAvailable === true) return true;
    const avail = await mobileBridge.isKeystoreAvailable();
    // Never cache `false` permanently (Keystore can become ready after Direct Boot / lock unlock)
    if (avail) this.keystoreAvailable = true;
    return avail;
  }

  private async getFallbackKey(): Promise<CryptoKey> {
    if (this.fallbackKey) return this.fallbackKey;
    const seed = await this.getOrCreateFallbackSeed();
    const rawKey = base64ToBytes(seed);
    this.fallbackKey = await globalThis.crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
    return this.fallbackKey;
  }

  public async encryptString(plain: string, requireOsProtection = false): Promise<string> {
    const hasKeystore = await this.isOsProtected();
    if (hasKeystore) {
      try {
        const cipher = await mobileBridge.keystoreEncrypt(plain);
        return `aks:${cipher}`;
      } catch (err) {
        if (requireOsProtection) throw err;
      }
    } else if (requireOsProtection) {
      throw new Error(tm('vaultCrypto.keystoreUnavailable'));
    }

    const key = await this.getFallbackKey();
    const iv = new Uint8Array(new ArrayBuffer(12));
    globalThis.crypto.getRandomValues(iv);
    const enc = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      utf8Encode(plain)
    );
    return `wfb:${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(enc))}`;
  }

  public async decryptString(encoded: string): Promise<string | null> {
    try {
      if (encoded.startsWith('aks:')) {
        if (!(await this.isOsProtected())) return null;
        return await mobileBridge.keystoreDecrypt(encoded.slice(4));
      }
      if (encoded.startsWith('wfb:')) {
        const [ivB64, dataB64] = encoded.slice(4).split('.');
        if (!ivB64 || !dataB64) return null;
        const key = await this.getFallbackKey();
        const plain = await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(ivB64), tagLength: 128 },
          key,
          base64ToBytes(dataB64)
        );
        return utf8Decode(new Uint8Array(plain));
      }
      return null;
    } catch {
      return null;
    }
  }

  public async encryptSecretPayload(payload: SecretPayload): Promise<string> {
    const json = JSON.stringify(payload);
    if (this.pinProtected) {
      if (!this.vdk) {
        throw new Error(tm('vaultCrypto.locked'));
      }
      const iv = new Uint8Array(new ArrayBuffer(12));
      globalThis.crypto.getRandomValues(iv);
      const key = await this.importRawAesKey(this.vdk, ['encrypt']);
      const ctBuf = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        key,
        utf8Encode(json)
      );
      return `vdk:${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ctBuf))}`;
    }
    // On native Android without PIN, strictly require hardware-backed AndroidKeyStore (never downgrade to wfb)
    return this.encryptString(json, mobileBridge.isNativeAndroid());
  }

  public async decryptSecretPayload(encoded: string): Promise<SecretPayload> {
    if (this.pinProtected && !this.vdk) {
      throw new Error(tm('vaultCrypto.locked'));
    }
    if (encoded.startsWith('vdk:')) {
      if (!this.vdk) {
        throw new Error(tm('vaultCrypto.locked'));
      }
      try {
        const [ivB64, dataB64] = encoded.slice(4).split('.');
        if (!ivB64 || !dataB64) {
          throw new Error(tm('vaultCrypto.decryptFailed'));
        }
        const iv = new Uint8Array(base64ToBytes(ivB64));
        const data = new Uint8Array(base64ToBytes(dataB64));
        if (iv.length !== 12 || data.length < 16) {
          throw new Error(tm('vaultCrypto.decryptFailed'));
        }
        const key = await this.importRawAesKey(this.vdk, ['decrypt']);
        const plainBuf = await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, tagLength: 128 },
          key,
          data
        );
        return JSON.parse(utf8Decode(new Uint8Array(plainBuf))) as SecretPayload;
      } catch (err) {
        if (err instanceof Error && err.message === tm('vaultCrypto.locked')) throw err;
        throw new Error(tm('vaultCrypto.decryptFailed'));
      }
    }
    const plain = await this.decryptString(encoded);
    if (!plain) {
      throw new Error(tm('vaultCrypto.decryptFailed'));
    }
    return JSON.parse(plain) as SecretPayload;
  }
}

export function detectCardBrand(pan: string): string | undefined {
  const digits = pan.replace(/\D/g, '');
  if (!digits) return undefined;
  if (/^220[0-4]/.test(digits)) return 'mir';
  if (/^4/.test(digits)) return 'visa';
  if (/^(?:5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^62/.test(digits)) return 'unionpay';
  return undefined;
}

export function buildSecretMetaFromInput(
  input: StructuredSecretInput,
  existingTotpMeta?: { hasTotp?: boolean; totpDigits?: 6 | 8; totpPeriod?: number }
): SecretMeta {
  const service = input.service.trim() || input.title?.trim() || tm('vault.secretFallback');
  const login = (input.login ?? '').trim();
  const value = input.secretValue.trim();

  const parsedTotp =
    typeof input.totpUriOrSecret === 'string' && input.totpUriOrSecret.trim()
      ? parseOtpAuthUri(input.totpUriOrSecret)
      : null;
  const totpFields: Pick<SecretMeta, 'hasTotp' | 'totpDigits' | 'totpPeriod'> = parsedTotp
    ? {
        hasTotp: true,
        totpDigits: input.totpDigits ?? parsedTotp.digits,
        totpPeriod: input.totpPeriod ?? parsedTotp.period,
      }
    : input.totpUriOrSecret === undefined && existingTotpMeta?.hasTotp
      ? {
          hasTotp: true,
          ...(existingTotpMeta.totpDigits ? { totpDigits: existingTotpMeta.totpDigits } : {}),
          ...(existingTotpMeta.totpPeriod ? { totpPeriod: existingTotpMeta.totpPeriod } : {}),
        }
      : {};

  if (input.kind === 'bank_card') {
    const digits = value.replace(/\D/g, '');
    const last4 = digits.length >= 4 ? digits.slice(-4) : undefined;
    const holder = (input.cardHolder ?? login).trim();
    return {
      service,
      loginHint: maskLoginHint(holder),
      kind: 'bank_card',
      cardBrand: detectCardBrand(digits),
      last4,
      hasCvv: Boolean(input.cvv?.trim()),
      expiry: input.expiry?.trim() || undefined,
      hasLogin: Boolean(holder),
      ...totpFields,
    };
  }

  return {
    service,
    loginHint: maskLoginHint(login),
    kind: input.kind,
    hasLogin: Boolean(login),
    ...totpFields,
  };
}

const PIN_KDF_ITERATIONS = 210_000;

interface StoredPinHash {
  v: 1;
  alg: 'pbkdf2-sha256';
  iter: number;
  salt: string;
  hash: string;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function hashMasterPin(pin: string, iterations = PIN_KDF_ITERATIONS): Promise<string> {
  const clean = pin.trim();
  if (clean.length < 4) {
    throw new Error(tm('vaultCrypto.pinMin4'));
  }
  const salt = new Uint8Array(new ArrayBuffer(16));
  globalThis.crypto.getRandomValues(salt);
  const keyMat = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8Encode(clean.normalize('NFKC')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMat,
    256
  );
  const record: StoredPinHash = {
    v: 1,
    alg: 'pbkdf2-sha256',
    iter: iterations,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(new Uint8Array(bits)),
  };
  return JSON.stringify(record);
}

export async function verifyMasterPin(pin: string, serialized: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(serialized) as StoredPinHash;
    if (!parsed || parsed.v !== 1 || parsed.alg !== 'pbkdf2-sha256') return false;
    const salt = base64ToBytes(parsed.salt);
    const expected = base64ToBytes(parsed.hash);
    if (salt.length < 16 || expected.length !== 32) return false;
    const keyMat = await globalThis.crypto.subtle.importKey(
      'raw',
      utf8Encode(pin.trim().normalize('NFKC')),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: parsed.iter || PIN_KDF_ITERATIONS, hash: 'SHA-256' },
      keyMat,
      256
    );
    return constantTimeEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}
