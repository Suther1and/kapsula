import {
  buildBlobAad,
  buildRecordAad,
  SYNC_BLOB_HEADER_BYTES,
  SYNC_BLOB_MAGIC,
  SYNC_CRYPTO_VERSION,
  SYNC_KDF_ALG,
  SYNC_KDF_ITERATIONS,
  SYNC_MAX_KDF_ITERATIONS,
  SYNC_MIN_KDF_ITERATIONS,
  SYNC_RECOVERY_ALPHABET,
  SYNC_RECOVERY_BYTE_LENGTH,
  type SyncEntityType,
  type SyncKeyEnvelopeRow,
} from '@shared/sync-contract';
import { tm } from '../lib/mobile-i18n';

const KEY_CHECK_PREFIX = 'kapsula-key-check-v1:';
const EXPECTED_BASE32_LEN = 32; // 160 bits / 5 = exactly 32 chars

interface WrappedKeyBlob {
  v: 1;
  alg: 'aes-256-gcm';
  salt?: string;
  iv: string;
  tag: string;
  data: string;
}

export interface MobileEncryptedRecordFields {
  payload_ciphertext: string;
  payload_iv: string;
  payload_tag: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(tm('crypto.unavailable'));
  }
  return c.subtle;
}

function getRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  const encoded = textEncoder.encode(text);
  return toArrayBufferView(encoded);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let part = '';
    for (let j = 0; j < chunk.length; j++) {
      part += String.fromCharCode(chunk[j]!);
    }
    binary += part;
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.trim();
  if (!clean) return new Uint8Array(new ArrayBuffer(0));
  const binary = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

export function generateDek(): Uint8Array<ArrayBuffer> {
  return getRandomBytes(32);
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += SYNC_RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += SYNC_RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function normalizeRecoveryKey(input: string): string {
  return input.toUpperCase().replace(/[\s\-_]+/g, '');
}

function decodeBase32(raw: string): Uint8Array<ArrayBuffer> {
  let cleaned = normalizeRecoveryKey(raw);
  if (cleaned.length === EXPECTED_BASE32_LEN + 4 && cleaned.startsWith('KAPS')) {
    cleaned = cleaned.slice(4);
  }
  if (cleaned.length !== EXPECTED_BASE32_LEN) {
    throw new Error(tm('crypto.recoveryLenErr'));
  }

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = SYNC_RECOVERY_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(tm('crypto.recoveryFormatErr'));
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits !== 0 || out.length !== SYNC_RECOVERY_BYTE_LENGTH) {
    throw new Error(tm('crypto.recoveryLenErr'));
  }
  const result = new Uint8Array(new ArrayBuffer(out.length));
  result.set(out);
  return result;
}

export function generateRecoveryKey(): string {
  const raw = getRandomBytes(SYNC_RECOVERY_BYTE_LENGTH);
  const encoded = encodeBase32(raw);
  raw.fill(0);
  const groups = encoded.match(/.{1,4}/g) ?? [encoded];
  return `KAPS-${groups.join('-')}`;
}

export async function derivePassphraseKek(
  passphrase: string,
  saltBase64: string,
  iterations: number = SYNC_KDF_ITERATIONS,
  minAllowedIterations: number = SYNC_MIN_KDF_ITERATIONS
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isInteger(iterations) ||
    iterations < minAllowedIterations ||
    iterations > SYNC_MAX_KDF_ITERATIONS
  ) {
    throw new Error(tm('crypto.kdfParamsErr'));
  }
  const salt = base64ToBytes(saltBase64);
  if (salt.length < 16) {
    throw new Error(tm('crypto.kdfSaltErr'));
  }

  const subtle = getSubtle();
  const normalized = passphrase.normalize('NFKC');
  const keyMaterial = await subtle.importKey(
    'raw',
    utf8Encode(normalized),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

export async function deriveRecoveryKek(
  recoveryKey: string,
  saltBase64: string
): Promise<Uint8Array<ArrayBuffer>> {
  const rawBytes = decodeBase32(recoveryKey);
  try {
    const salt = base64ToBytes(saltBase64);
    if (salt.length < 16) {
      throw new Error(tm('crypto.recoveryParamsErr'));
    }
    const subtle = getSubtle();
    const ikm = await subtle.importKey('raw', rawBytes, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: utf8Encode('kapsula-sync-recovery-v1'),
      },
      ikm,
      256
    );
    return new Uint8Array(bits);
  } finally {
    rawBytes.fill(0);
  }
}

async function importAesKey(key: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  if (key.length !== 32) {
    throw new Error(tm('crypto.keyLenErr'));
  }
  return getSubtle().importKey('raw', toArrayBufferView(key), { name: 'AES-GCM' }, false, usage);
}

async function aesGcmEncryptRaw(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: string
): Promise<{
  iv: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
}> {
  const cryptoKey = await importAesKey(key, ['encrypt']);
  const iv = getRandomBytes(12);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv,
    tagLength: 128,
    ...(aad ? { additionalData: utf8Encode(aad) } : {}),
  };
  const encryptedBuf = await getSubtle().encrypt(params, cryptoKey, toArrayBufferView(plaintext));
  const combined = new Uint8Array(encryptedBuf);
  if (combined.length < 16) {
    throw new Error(tm('crypto.encryptErr'));
  }
  const split = combined.length - 16;
  const data = toArrayBufferView(combined.subarray(0, split));
  const tag = toArrayBufferView(combined.subarray(split));
  return { iv, tag, data };
}

async function aesGcmDecryptRaw(
  key: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  ciphertext: Uint8Array,
  aad?: string
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) {
    throw new Error(tm('crypto.corruptBlock'));
  }
  const cryptoKey = await importAesKey(key, ['decrypt']);
  const combined = concatBytes(ciphertext, tag);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: toArrayBufferView(iv),
    tagLength: 128,
    ...(aad ? { additionalData: utf8Encode(aad) } : {}),
  };
  const plainBuf = await getSubtle().decrypt(params, cryptoKey, combined);
  return new Uint8Array(plainBuf);
}

async function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  aad: string,
  salt?: string
): Promise<string> {
  const { iv, tag, data } = await aesGcmEncryptRaw(kek, dek, aad);
  const blob: WrappedKeyBlob = {
    v: 1,
    alg: 'aes-256-gcm',
    ...(salt ? { salt } : {}),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    data: bytesToBase64(data),
  };
  return JSON.stringify(blob);
}

async function unwrapDek(
  kek: Uint8Array,
  serialized: string,
  aad: string
): Promise<Uint8Array<ArrayBuffer>> {
  let blob: WrappedKeyBlob;
  try {
    blob = JSON.parse(serialized) as WrappedKeyBlob;
  } catch {
    throw new Error(tm('crypto.corruptEnvelope'));
  }
  if (!blob || blob.v !== 1 || blob.alg !== 'aes-256-gcm') {
    throw new Error(tm('crypto.unsupportedKeyFormat'));
  }
  const dek = await aesGcmDecryptRaw(
    kek,
    base64ToBytes(blob.iv),
    base64ToBytes(blob.tag),
    base64ToBytes(blob.data),
    aad
  );
  if (dek.length !== 32) {
    throw new Error(tm('crypto.corruptKey'));
  }
  return dek;
}

export async function createKeyCheckToken(dek: Uint8Array, userId: string): Promise<string> {
  const { iv, tag, data } = await aesGcmEncryptRaw(
    dek,
    utf8Encode(`${KEY_CHECK_PREFIX}${userId}`),
    `kapsula:check:v1:${userId}`
  );
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    data: bytesToBase64(data),
  });
}

export async function verifyKeyCheckToken(
  dek: Uint8Array,
  userId: string,
  tokenSerialized: string
): Promise<boolean> {
  try {
    const parsed = JSON.parse(tokenSerialized) as WrappedKeyBlob;
    if (!parsed || parsed.v !== 1 || parsed.alg !== 'aes-256-gcm') return false;
    const plain = await aesGcmDecryptRaw(
      dek,
      base64ToBytes(parsed.iv),
      base64ToBytes(parsed.tag),
      base64ToBytes(parsed.data),
      `kapsula:check:v1:${userId}`
    );
    return utf8Decode(plain) === `${KEY_CHECK_PREFIX}${userId}`;
  } catch {
    return false;
  }
}

export async function createKeyEnvelope(
  userId: string,
  passphrase: string,
  iterations: number = SYNC_KDF_ITERATIONS
): Promise<{
  dek: Uint8Array<ArrayBuffer>;
  recoveryKey: string;
  envelope: SyncKeyEnvelopeRow;
}> {
  if (passphrase.trim().length < 10) {
    throw new Error(tm('crypto.passMin10'));
  }
  const dek = generateDek();
  const recoveryKey = generateRecoveryKey();
  const passphraseSalt = bytesToBase64(getRandomBytes(16));
  const recoverySalt = bytesToBase64(getRandomBytes(16));
  const minFloor = Math.min(iterations, SYNC_MIN_KDF_ITERATIONS);

  const passphraseKek = await derivePassphraseKek(passphrase, passphraseSalt, iterations, minFloor);
  const recoveryKek = await deriveRecoveryKek(recoveryKey, recoverySalt);

  try {
    const envelope: SyncKeyEnvelopeRow = {
      user_id: userId,
      version: SYNC_CRYPTO_VERSION,
      kdf_alg: SYNC_KDF_ALG,
      kdf_iterations: iterations,
      kdf_salt: passphraseSalt,
      wrapped_dek_passphrase: await wrapDek(passphraseKek, dek, `kapsula:wrap:pass:v1:${userId}`),
      wrapped_dek_recovery: await wrapDek(
        recoveryKek,
        dek,
        `kapsula:wrap:rec:v1:${userId}`,
        recoverySalt
      ),
      key_check_token: await createKeyCheckToken(dek, userId),
    };
    return { dek, recoveryKey, envelope };
  } finally {
    passphraseKek.fill(0);
    recoveryKek.fill(0);
  }
}

export async function unwrapDekWithPassphrase(
  userId: string,
  passphrase: string,
  envelope: SyncKeyEnvelopeRow,
  minAllowedIterations: number = SYNC_MIN_KDF_ITERATIONS
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.kdf_alg !== SYNC_KDF_ALG) {
    throw new Error(tm('crypto.unsupportedAlg'));
  }
  const kek = await derivePassphraseKek(
    passphrase,
    envelope.kdf_salt,
    envelope.kdf_iterations,
    minAllowedIterations
  );
  try {
    let dek: Uint8Array<ArrayBuffer>;
    try {
      dek = await unwrapDek(kek, envelope.wrapped_dek_passphrase, `kapsula:wrap:pass:v1:${userId}`);
    } catch {
      throw new Error(tm('crypto.wrongPassphrase'));
    }
    if (!(await verifyKeyCheckToken(dek, userId, envelope.key_check_token))) {
      dek.fill(0);
      throw new Error(tm('crypto.keyVerifyErr'));
    }
    return dek;
  } finally {
    kek.fill(0);
  }
}

export async function unwrapDekWithRecoveryKey(
  userId: string,
  recoveryKey: string,
  envelope: SyncKeyEnvelopeRow
): Promise<Uint8Array<ArrayBuffer>> {
  let parsed: WrappedKeyBlob;
  try {
    parsed = JSON.parse(envelope.wrapped_dek_recovery) as WrappedKeyBlob;
  } catch {
    throw new Error(tm('crypto.corruptRecoveryEnvelope'));
  }
  const recoverySalt = parsed.salt || envelope.kdf_salt;
  const kek = await deriveRecoveryKek(recoveryKey, recoverySalt);
  try {
    let dek: Uint8Array<ArrayBuffer>;
    try {
      dek = await unwrapDek(kek, envelope.wrapped_dek_recovery, `kapsula:wrap:rec:v1:${userId}`);
    } catch {
      throw new Error(tm('crypto.wrongRecoveryKey'));
    }
    if (!(await verifyKeyCheckToken(dek, userId, envelope.key_check_token))) {
      dek.fill(0);
      throw new Error(tm('crypto.recoveryVerifyErr'));
    }
    return dek;
  } finally {
    kek.fill(0);
  }
}

export async function rewrapEnvelopePassphrase(
  userId: string,
  dek: Uint8Array,
  newPassphrase: string,
  existingEnvelope: SyncKeyEnvelopeRow,
  iterations: number = SYNC_KDF_ITERATIONS
): Promise<SyncKeyEnvelopeRow> {
  if (newPassphrase.trim().length < 10) {
    throw new Error(tm('crypto.newPassMin10'));
  }
  const newPassSalt = bytesToBase64(getRandomBytes(16));
  const minFloor = Math.min(iterations, SYNC_MIN_KDF_ITERATIONS);
  const newKek = await derivePassphraseKek(newPassphrase, newPassSalt, iterations, minFloor);
  try {
    return {
      ...existingEnvelope,
      kdf_alg: SYNC_KDF_ALG,
      kdf_iterations: iterations,
      kdf_salt: newPassSalt,
      wrapped_dek_passphrase: await wrapDek(newKek, dek, `kapsula:wrap:pass:v1:${userId}`),
      wrapped_dek_recovery: existingEnvelope.wrapped_dek_recovery,
      key_check_token: existingEnvelope.key_check_token,
    };
  } finally {
    newKek.fill(0);
  }
}

export async function rewrapEnvelopeRecoveryKey(
  userId: string,
  dek: Uint8Array,
  existingEnvelope: SyncKeyEnvelopeRow
): Promise<{ recoveryKey: string; envelope: SyncKeyEnvelopeRow }> {
  const recoveryKey = generateRecoveryKey();
  const recoverySalt = bytesToBase64(getRandomBytes(16));
  const recoveryKek = await deriveRecoveryKek(recoveryKey, recoverySalt);
  try {
    return {
      recoveryKey,
      envelope: {
        ...existingEnvelope,
        wrapped_dek_recovery: await wrapDek(
          recoveryKek,
          dek,
          `kapsula:wrap:rec:v1:${userId}`,
          recoverySalt
        ),
      },
    };
  } finally {
    recoveryKek.fill(0);
  }
}

export async function encryptRecordPayload(
  dek: Uint8Array,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  payload: unknown
): Promise<MobileEncryptedRecordFields> {
  const raw = utf8Encode(JSON.stringify(payload));
  const aad = buildRecordAad(userId, entityType, entityId);
  const { iv, tag, data } = await aesGcmEncryptRaw(dek, raw, aad);
  return {
    payload_ciphertext: bytesToBase64(data),
    payload_iv: bytesToBase64(iv),
    payload_tag: bytesToBase64(tag),
  };
}

export async function decryptRecordPayload<T>(
  dek: Uint8Array,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  fields: MobileEncryptedRecordFields
): Promise<T> {
  const aad = buildRecordAad(userId, entityType, entityId);
  const plain = await aesGcmDecryptRaw(
    dek,
    base64ToBytes(fields.payload_iv),
    base64ToBytes(fields.payload_tag),
    base64ToBytes(fields.payload_ciphertext),
    aad
  );
  return JSON.parse(utf8Decode(plain)) as T;
}

export async function computePlaintextSha256(buf: Uint8Array): Promise<string> {
  const digest = await getSubtle().digest('SHA-256', toArrayBufferView(buf));
  return bytesToHex(new Uint8Array(digest));
}

export async function deriveOpaqueBlobId(
  dek: Uint8Array,
  plaintextSha256Hex: string
): Promise<string> {
  const hmacKey = await getSubtle().importKey(
    'raw',
    toArrayBufferView(dek),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await getSubtle().sign(
    'HMAC',
    hmacKey,
    utf8Encode(`kapsula-blob-v1:${plaintextSha256Hex}`)
  );
  return bytesToHex(new Uint8Array(sig));
}

export async function encryptMediaBlob(
  dek: Uint8Array,
  userId: string,
  blobId: string,
  plaintext: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const magic = utf8Encode(SYNC_BLOB_MAGIC);
  const { iv, tag, data } = await aesGcmEncryptRaw(dek, plaintext, buildBlobAad(userId, blobId));
  return concatBytes(magic, iv, tag, data);
}

export async function decryptMediaBlob(
  dek: Uint8Array,
  userId: string,
  blobId: string,
  encrypted: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  if (encrypted.length < SYNC_BLOB_HEADER_BYTES) {
    throw new Error(tm('crypto.corruptMediaSmall'));
  }
  const magic = utf8Decode(encrypted.subarray(0, 5));
  if (magic !== SYNC_BLOB_MAGIC) {
    throw new Error(tm('crypto.unknownMediaFormat'));
  }
  const iv = encrypted.subarray(5, 17);
  const tag = encrypted.subarray(17, 33);
  const data = encrypted.subarray(33);
  return aesGcmDecryptRaw(dek, iv, tag, data, buildBlobAad(userId, blobId));
}
