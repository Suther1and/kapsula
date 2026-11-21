import { describe, expect, it } from 'vitest';
import {
  computePlaintextSha256,
  createKeyEnvelope,
  decryptMediaBlob,
  decryptRecordPayload,
  deriveOpaqueBlobId,
  encryptMediaBlob,
  encryptRecordPayload,
  rewrapEnvelopePassphrase,
  rewrapEnvelopeRecoveryKey,
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
} from '../src/main/sync/sync-crypto';

const TEST_USER = '11111111-2222-3333-4444-555555555555';
const OTHER_USER = '99999999-2222-3333-4444-555555555555';
const FAST_ITERS = 10_000; // fast iteration count for unit tests only

describe('Kapsula E2EE Sync Crypto (Story 1.2 + Security Hardening)', () => {
  it('creates key envelope and unwraps DEK with both passphrase and recovery key', async () => {
    const { dek, recoveryKey, envelope } = await createKeyEnvelope(
      TEST_USER,
      'моя-секретная-фраза-2026',
      FAST_ITERS
    );

    expect(dek.length).toBe(32);
    expect(recoveryKey).toMatch(/^KAPS(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){8}$/);

    const fromPass = await unwrapDekWithPassphrase(
      TEST_USER,
      'моя-секретная-фраза-2026',
      envelope,
      FAST_ITERS
    );
    expect(fromPass.equals(dek)).toBe(true);

    // Recovery key tolerates lowercase / extra spaces
    const fromRec = unwrapDekWithRecoveryKey(
      TEST_USER,
      recoveryKey.toLowerCase().replace(/-/g, ' '),
      envelope
    );
    expect(fromRec.equals(dek)).toBe(true);
  });

  it('rejects wrong passphrase, wrong recovery key, 33-char base32 key, and out-of-bounds KDF iterations', async () => {
    const { recoveryKey, envelope } = await createKeyEnvelope(
      TEST_USER,
      'correct-phrase-123',
      FAST_ITERS
    );

    await expect(
      unwrapDekWithPassphrase(TEST_USER, 'wrong-phrase-123', envelope, FAST_ITERS)
    ).rejects.toThrow();

    // Downgraded or DoS KDF iterations rejected (H4)
    await expect(
      unwrapDekWithPassphrase(TEST_USER, 'correct-phrase-123', { ...envelope, kdf_iterations: 1 })
    ).rejects.toThrow();
    await expect(
      unwrapDekWithPassphrase(
        TEST_USER,
        'correct-phrase-123',
        { ...envelope, kdf_iterations: 50_000_000 },
        FAST_ITERS
      )
    ).rejects.toThrow();

    // Wrong recovery key and extra trailing character rejected (M5)
    expect(() =>
      unwrapDekWithRecoveryKey(
        TEST_USER,
        'KAPS-2222-3333-4444-5555-6666-7777-8888-9999',
        envelope
      )
    ).toThrow();
    expect(() =>
      unwrapDekWithRecoveryKey(TEST_USER, `${recoveryKey}A`, envelope)
    ).toThrow();
  });

  it('rotates passphrase without invalidating Recovery Key, and regenerates Recovery Key cleanly', async () => {
    const { dek, recoveryKey, envelope } = await createKeyEnvelope(
      TEST_USER,
      'old-passphrase-1',
      FAST_ITERS
    );
    const updated = await rewrapEnvelopePassphrase(
      TEST_USER,
      dek,
      'brand-new-passphrase-2',
      envelope,
      FAST_ITERS
    );

    await expect(
      unwrapDekWithPassphrase(TEST_USER, 'old-passphrase-1', updated, FAST_ITERS)
    ).rejects.toThrow();

    const unwrappedNew = await unwrapDekWithPassphrase(
      TEST_USER,
      'brand-new-passphrase-2',
      updated,
      FAST_ITERS
    );
    expect(unwrappedNew.equals(dek)).toBe(true);

    // Original Recovery Key still works after passphrase change
    const unwrappedRec = unwrapDekWithRecoveryKey(TEST_USER, recoveryKey, updated);
    expect(unwrappedRec.equals(dek)).toBe(true);

    // Regenerating Recovery Key invalidates old one and unlocks with new one (H6)
    const regen = rewrapEnvelopeRecoveryKey(TEST_USER, dek, updated);
    expect(regen.recoveryKey).not.toBe(recoveryKey);
    expect(() => unwrapDekWithRecoveryKey(TEST_USER, recoveryKey, regen.envelope)).toThrow();
    expect(unwrapDekWithRecoveryKey(TEST_USER, regen.recoveryKey, regen.envelope).equals(dek)).toBe(
      true
    );
  });

  it('encrypts/decrypts entity payloads with AAD binding and rejects truncated GCM auth tags (C2)', async () => {
    const { dek } = await createKeyEnvelope(TEST_USER, 'vault-pass-999', FAST_ITERS);
    const payload = {
      v: 1,
      id: 'note-42',
      title: 'Секретный план релиза',
      secretPayload: {
        service: 'Tinkoff',
        login: 'user@mail.ru',
        secretValue: '4276 5500 1234 5678',
        notes: '',
      },
    };

    const encrypted = encryptRecordPayload(dek, TEST_USER, 'item', 'note-42', payload);
    expect(encrypted.payload_ciphertext).not.toContain('Секретный');
    expect(encrypted.payload_ciphertext).not.toContain('4276');

    const decrypted = decryptRecordPayload<typeof payload>(
      dek,
      TEST_USER,
      'item',
      'note-42',
      encrypted
    );
    expect(decrypted).toEqual(payload);

    // Truncated 4-byte GCM auth tag MUST be rejected (C2)
    const truncatedTag = Buffer.from(encrypted.payload_tag, 'base64').subarray(0, 4).toString('base64');
    expect(() =>
      decryptRecordPayload(dek, TEST_USER, 'item', 'note-42', {
        ...encrypted,
        payload_tag: truncatedTag,
      })
    ).toThrow();

    // Tampered entityId / entityType breaks AAD
    expect(() =>
      decryptRecordPayload(dek, TEST_USER, 'item', 'note-999', encrypted)
    ).toThrow();
    expect(() =>
      decryptRecordPayload(dek, TEST_USER, 'orbit', 'note-42', encrypted)
    ).toThrow();
  });

  it('derives opaque HMAC blob IDs and encrypts/decrypts KAPS1 media frames bound to userId & blobId', async () => {
    const { dek } = await createKeyEnvelope(TEST_USER, 'media-pass-123', FAST_ITERS);
    const sampleBytes = Buffer.from('binary-image-or-audio-payload-\x00\xff\x10\x20', 'binary');
    const sha = computePlaintextSha256(sampleBytes);
    const blobId = deriveOpaqueBlobId(dek, sha);

    expect(blobId).toHaveLength(64);
    expect(blobId).not.toBe(sha);

    const enc = encryptMediaBlob(dek, TEST_USER, blobId, sampleBytes);
    expect(enc.subarray(0, 5).toString('ascii')).toBe('KAPS1');
    expect(enc.includes(sampleBytes)).toBe(false);

    const dec = decryptMediaBlob(dek, TEST_USER, blobId, enc);
    expect(dec.equals(sampleBytes)).toBe(true);

    // Wrong blobId or wrong userId fails GCM auth tag
    expect(() => decryptMediaBlob(dek, TEST_USER, 'a'.repeat(64), enc)).toThrow();
    expect(() => decryptMediaBlob(dek, OTHER_USER, blobId, enc)).toThrow();
  });
});
