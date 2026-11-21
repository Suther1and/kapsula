import crypto from 'node:crypto';
import type { AppLocale } from '@shared/types';
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

let syncCryptoLocale: AppLocale = 'ru';

export function setSyncCryptoLocale(locale: AppLocale): void {
  syncCryptoLocale = locale === 'en' ? 'en' : 'ru';
}

function msg(ruText: string, enText: string): string {
  return syncCryptoLocale === 'en' ? enText : ruText;
}

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

export interface EncryptedRecordFields {
  payload_ciphertext: string;
  payload_iv: string;
  payload_tag: string;
}

export function generateDek(): Buffer {
  return crypto.randomBytes(32);
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
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

function decodeBase32(raw: string): Buffer {
  let cleaned = normalizeRecoveryKey(raw);
  if (cleaned.length === EXPECTED_BASE32_LEN + 4 && cleaned.startsWith('KAPS')) {
    cleaned = cleaned.slice(4);
  }
  if (cleaned.length !== EXPECTED_BASE32_LEN) {
    throw new Error(msg('Неверная длина резервного ключа восстановления', 'Invalid recovery key length'));
  }

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = SYNC_RECOVERY_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(msg('Неверный формат резервного ключа восстановления', 'Invalid recovery key format'));
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits !== 0 || out.length !== SYNC_RECOVERY_BYTE_LENGTH) {
    throw new Error(msg('Неверная длина резервного ключа восстановления', 'Invalid recovery key length'));
  }
  return Buffer.from(out);
}

export function generateRecoveryKey(): string {
  const raw = crypto.randomBytes(SYNC_RECOVERY_BYTE_LENGTH);
  const encoded = encodeBase32(raw); // exactly 32 chars
  const groups = encoded.match(/.{1,4}/g) ?? [encoded];
  return `KAPS-${groups.join('-')}`;
}

export async function derivePassphraseKek(
  passphrase: string,
  saltBase64: string,
  iterations: number = SYNC_KDF_ITERATIONS,
  minAllowedIterations: number = SYNC_MIN_KDF_ITERATIONS
): Promise<Buffer> {
  if (
    !Number.isInteger(iterations) ||
    iterations < minAllowedIterations ||
    iterations > SYNC_MAX_KDF_ITERATIONS
  ) {
    throw new Error(msg('Недопустимые параметры защиты ключа синхронизации', 'Invalid sync key protection parameters'));
  }
  const salt = Buffer.from(saltBase64, 'base64');
  if (salt.length < 16) {
    throw new Error(msg('Некорректные параметры соли ключа синхронизации', 'Invalid sync key salt parameters'));
  }
  const normalized = passphrase.normalize('NFKC');
  return new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(normalized, salt, iterations, 32, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export function deriveRecoveryKek(recoveryKey: string, saltBase64: string): Buffer {
  const rawBytes = decodeBase32(recoveryKey);
  const salt = Buffer.from(saltBase64, 'base64');
  if (salt.length < 16) {
    throw new Error(msg('Некорректные параметры резервного ключа', 'Invalid recovery key parameters'));
  }
  try {
    return Buffer.from(
      crypto.hkdfSync('sha256', rawBytes, salt, Buffer.from('kapsula-sync-recovery-v1', 'utf8'), 32)
    );
  } finally {
    rawBytes.fill(0);
  }
}

function aesGcmEncryptRaw(
  key: Buffer,
  plaintext: Buffer,
  aad?: string
): { iv: Buffer; tag: Buffer; data: Buffer } {
  if (key.length !== 32) {
    throw new Error(msg('Некорректная длина ключа шифрования', 'Invalid encryption key length'));
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, data };
}

function aesGcmDecryptRaw(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  aad?: string
): Buffer {
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) {
    throw new Error(msg('Повреждённый зашифрованный блок', 'Corrupted encrypted payload'));
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wrapDek(kek: Buffer, dek: Buffer, aad: string, salt?: string): string {
  const { iv, tag, data } = aesGcmEncryptRaw(kek, dek, aad);
  const blob: WrappedKeyBlob = {
    v: 1,
    alg: 'aes-256-gcm',
    ...(salt ? { salt } : {}),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(blob);
}

function unwrapDek(kek: Buffer, serialized: string, aad: string): Buffer {
  let blob: WrappedKeyBlob;
  try {
    blob = JSON.parse(serialized) as WrappedKeyBlob;
  } catch {
    throw new Error(msg('Повреждённый конверт ключа шифрования', 'Corrupted encryption key envelope'));
  }
  if (!blob || blob.v !== 1 || blob.alg !== 'aes-256-gcm') {
    throw new Error(msg('Неподдерживаемый формат ключа шифрования', 'Unsupported encryption key format'));
  }
  const dek = aesGcmDecryptRaw(
    kek,
    Buffer.from(blob.iv, 'base64'),
    Buffer.from(blob.tag, 'base64'),
    Buffer.from(blob.data, 'base64'),
    aad
  );
  if (dek.length !== 32) {
    throw new Error(msg('Повреждённый ключ шифрования', 'Corrupted encryption key'));
  }
  return dek;
}

export function createKeyCheckToken(dek: Buffer, userId: string): string {
  const { iv, tag, data } = aesGcmEncryptRaw(
    dek,
    Buffer.from(`${KEY_CHECK_PREFIX}${userId}`, 'utf8'),
    `kapsula:check:v1:${userId}`
  );
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  });
}

export function verifyKeyCheckToken(dek: Buffer, userId: string, tokenSerialized: string): boolean {
  try {
    const parsed = JSON.parse(tokenSerialized) as WrappedKeyBlob;
    if (!parsed || parsed.v !== 1 || parsed.alg !== 'aes-256-gcm') return false;
    const plain = aesGcmDecryptRaw(
      dek,
      Buffer.from(parsed.iv, 'base64'),
      Buffer.from(parsed.tag, 'base64'),
      Buffer.from(parsed.data, 'base64'),
      `kapsula:check:v1:${userId}`
    ).toString('utf8');
    return plain === `${KEY_CHECK_PREFIX}${userId}`;
  } catch {
    return false;
  }
}

export const SYNC_NEW_PASSPHRASE_MIN_LEN = 10;

export async function createKeyEnvelope(
  userId: string,
  passphrase: string,
  iterations: number = SYNC_KDF_ITERATIONS
): Promise<{ dek: Buffer; recoveryKey: string; envelope: SyncKeyEnvelopeRow }> {
  if (passphrase.trim().length < SYNC_NEW_PASSPHRASE_MIN_LEN) {
    throw new Error(
      msg(
        `Секретная фраза должна содержать не менее ${SYNC_NEW_PASSPHRASE_MIN_LEN} символов`,
        `Passphrase must be at least ${SYNC_NEW_PASSPHRASE_MIN_LEN} characters`
      )
    );
  }
  const dek = generateDek();
  const recoveryKey = generateRecoveryKey();
  const passphraseSalt = crypto.randomBytes(16).toString('base64');
  const recoverySalt = crypto.randomBytes(16).toString('base64');
  const minFloor = Math.min(iterations, SYNC_MIN_KDF_ITERATIONS);

  const passphraseKek = await derivePassphraseKek(passphrase, passphraseSalt, iterations, minFloor);
  const recoveryKek = deriveRecoveryKek(recoveryKey, recoverySalt);

  try {
    const envelope: SyncKeyEnvelopeRow = {
      user_id: userId,
      version: SYNC_CRYPTO_VERSION,
      kdf_alg: SYNC_KDF_ALG,
      kdf_iterations: iterations,
      kdf_salt: passphraseSalt,
      wrapped_dek_passphrase: wrapDek(passphraseKek, dek, `kapsula:wrap:pass:v1:${userId}`),
      wrapped_dek_recovery: wrapDek(recoveryKek, dek, `kapsula:wrap:rec:v1:${userId}`, recoverySalt),
      key_check_token: createKeyCheckToken(dek, userId),
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
): Promise<Buffer> {
  if (envelope.kdf_alg !== SYNC_KDF_ALG) {
    throw new Error(msg('Неподдерживаемый алгоритм деривации ключа', 'Unsupported key derivation algorithm'));
  }
  const kek = await derivePassphraseKek(
    passphrase,
    envelope.kdf_salt,
    envelope.kdf_iterations,
    minAllowedIterations
  );
  try {
    let dek: Buffer;
    try {
      dek = unwrapDek(kek, envelope.wrapped_dek_passphrase, `kapsula:wrap:pass:v1:${userId}`);
    } catch {
      throw new Error(msg('Неверная секретная фраза шифрования', 'Incorrect encryption passphrase'));
    }
    if (!verifyKeyCheckToken(dek, userId, envelope.key_check_token)) {
      dek.fill(0);
      throw new Error(msg('Проверка ключа шифрования не пройдена', 'Encryption key check failed'));
    }
    return dek;
  } finally {
    kek.fill(0);
  }
}

export function unwrapDekWithRecoveryKey(
  userId: string,
  recoveryKey: string,
  envelope: SyncKeyEnvelopeRow
): Buffer {
  let parsed: WrappedKeyBlob;
  try {
    parsed = JSON.parse(envelope.wrapped_dek_recovery) as WrappedKeyBlob;
  } catch {
    throw new Error(msg('Повреждённый конверт резервного ключа', 'Corrupted recovery key envelope'));
  }
  const recoverySalt = parsed.salt || envelope.kdf_salt;
  const kek = deriveRecoveryKek(recoveryKey, recoverySalt);
  try {
    let dek: Buffer;
    try {
      dek = unwrapDek(kek, envelope.wrapped_dek_recovery, `kapsula:wrap:rec:v1:${userId}`);
    } catch {
      throw new Error(msg('Неверный резервный ключ восстановления', 'Invalid recovery key'));
    }
    if (!verifyKeyCheckToken(dek, userId, envelope.key_check_token)) {
      dek.fill(0);
      throw new Error(msg('Проверка резервного ключа не пройдена', 'Recovery key check failed'));
    }
    return dek;
  } finally {
    kek.fill(0);
  }
}

export async function rewrapEnvelopePassphrase(
  userId: string,
  dek: Buffer,
  newPassphrase: string,
  existingEnvelope: SyncKeyEnvelopeRow,
  iterations: number = SYNC_KDF_ITERATIONS
): Promise<SyncKeyEnvelopeRow> {
  if (newPassphrase.trim().length < SYNC_NEW_PASSPHRASE_MIN_LEN) {
    throw new Error(
      msg(
        `Новая секретная фраза должна содержать не менее ${SYNC_NEW_PASSPHRASE_MIN_LEN} символов`,
        `New passphrase must be at least ${SYNC_NEW_PASSPHRASE_MIN_LEN} characters`
      )
    );
  }
  const newPassSalt = crypto.randomBytes(16).toString('base64');
  const minFloor = Math.min(iterations, SYNC_MIN_KDF_ITERATIONS);
  const newKek = await derivePassphraseKek(newPassphrase, newPassSalt, iterations, minFloor);
  try {
    return {
      ...existingEnvelope,
      kdf_alg: SYNC_KDF_ALG,
      kdf_iterations: iterations,
      kdf_salt: newPassSalt,
      wrapped_dek_passphrase: wrapDek(newKek, dek, `kapsula:wrap:pass:v1:${userId}`),
      wrapped_dek_recovery: existingEnvelope.wrapped_dek_recovery,
      key_check_token: existingEnvelope.key_check_token,
    };
  } finally {
    newKek.fill(0);
  }
}

export function rewrapEnvelopeRecoveryKey(
  userId: string,
  dek: Buffer,
  existingEnvelope: SyncKeyEnvelopeRow
): { recoveryKey: string; envelope: SyncKeyEnvelopeRow } {
  const recoveryKey = generateRecoveryKey();
  const recoverySalt = crypto.randomBytes(16).toString('base64');
  const recoveryKek = deriveRecoveryKek(recoveryKey, recoverySalt);
  try {
    return {
      recoveryKey,
      envelope: {
        ...existingEnvelope,
        wrapped_dek_recovery: wrapDek(
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

export function encryptRecordPayload(
  dek: Buffer,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  payload: unknown
): EncryptedRecordFields {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const aad = buildRecordAad(userId, entityType, entityId);
  const { iv, tag, data } = aesGcmEncryptRaw(dek, raw, aad);
  return {
    payload_ciphertext: data.toString('base64'),
    payload_iv: iv.toString('base64'),
    payload_tag: tag.toString('base64'),
  };
}

export function decryptRecordPayload<T>(
  dek: Buffer,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  fields: EncryptedRecordFields
): T {
  const aad = buildRecordAad(userId, entityType, entityId);
  const plain = aesGcmDecryptRaw(
    dek,
    Buffer.from(fields.payload_iv, 'base64'),
    Buffer.from(fields.payload_tag, 'base64'),
    Buffer.from(fields.payload_ciphertext, 'base64'),
    aad
  );
  return JSON.parse(plain.toString('utf8')) as T;
}

export function computePlaintextSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function deriveOpaqueBlobId(dek: Buffer, plaintextSha256Hex: string): string {
  return crypto
    .createHmac('sha256', dek)
    .update(`kapsula-blob-v1:${plaintextSha256Hex}`, 'utf8')
    .digest('hex');
}

export function encryptMediaBlob(
  dek: Buffer,
  userId: string,
  blobId: string,
  plaintext: Buffer
): Buffer {
  const magic = Buffer.from(SYNC_BLOB_MAGIC, 'ascii');
  const { iv, tag, data } = aesGcmEncryptRaw(dek, plaintext, buildBlobAad(userId, blobId));
  return Buffer.concat([magic, iv, tag, data]);
}

export function decryptMediaBlob(
  dek: Buffer,
  userId: string,
  blobId: string,
  encrypted: Buffer
): Buffer {
  if (encrypted.length < SYNC_BLOB_HEADER_BYTES) {
    throw new Error(
      msg(
        'Зашифрованный медиафайл повреждён (слишком малый размер)',
        'Encrypted media file is corrupted (file too small)'
      )
    );
  }
  const magic = encrypted.subarray(0, 5).toString('ascii');
  if (magic !== SYNC_BLOB_MAGIC) {
    throw new Error(msg('Неизвестный формат зашифрованного медиафайла', 'Unknown encrypted media format'));
  }
  const iv = encrypted.subarray(5, 17);
  const tag = encrypted.subarray(17, 33);
  const data = encrypted.subarray(33);
  return aesGcmDecryptRaw(dek, iv, tag, data, buildBlobAad(userId, blobId));
}
