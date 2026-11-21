import { describe, expect, it } from 'vitest';
import * as desktopCrypto from '@main/sync/sync-crypto';
import * as mobileCrypto from '@mobile/sync/mobile-crypto';
import type {
  SyncedCalendarEventPayload,
  SyncedItemPayload,
} from '@shared/sync-contract';

describe('Cross-platform E2EE compatibility (Desktop Node <-> Android WebCrypto)', () => {
  const userId = '550e8400-e29b-41d4-a716-446655440000';

  it('Desktop creates 600k PBKDF2 envelope -> Android unwraps by passphrase & Recovery Key with identical DEK', async () => {
    const passphrase = 'Моя Секретная Фраза 2026! №1';
    const created = await desktopCrypto.createKeyEnvelope(userId, passphrase, 600_000);

    const dekFromPass = await mobileCrypto.unwrapDekWithPassphrase(
      userId,
      passphrase,
      created.envelope
    );
    expect(Buffer.from(dekFromPass)).toEqual(created.dek);

    const dekFromRec = await mobileCrypto.unwrapDekWithRecoveryKey(
      userId,
      created.recoveryKey.toLowerCase().replace(/-/g, ' '),
      created.envelope
    );
    expect(Buffer.from(dekFromRec)).toEqual(created.dek);

    await expect(
      mobileCrypto.unwrapDekWithPassphrase(userId, 'неверная-фраза', created.envelope)
    ).rejects.toThrow();
  });

  it('Android creates 600k PBKDF2 envelope -> Desktop unwraps by passphrase & Recovery Key with identical DEK', async () => {
    const passphrase = 'Капсула-Фолд-2026-СуперКлюч';
    const created = await mobileCrypto.createKeyEnvelope(userId, passphrase, 600_000);

    const dekFromPass = await desktopCrypto.unwrapDekWithPassphrase(
      userId,
      passphrase,
      created.envelope
    );
    expect(dekFromPass).toEqual(Buffer.from(created.dek));

    const dekFromRec = desktopCrypto.unwrapDekWithRecoveryKey(
      userId,
      created.recoveryKey,
      created.envelope
    );
    expect(dekFromRec).toEqual(Buffer.from(created.dek));
  });

  it('Encrypts and decrypts Vault Secret (bank card with notes) bidirectionally with AAD enforcement', async () => {
    const dek = desktopCrypto.generateDek();
    const dekMobile = new Uint8Array(dek);
    const entityId = 'card-item-001';

    const secretItem: SyncedItemPayload = {
      v: 1,
      id: entityId,
      dna: 'secret',
      subKind: null,
      orbit: 'finance',
      modeCaptured: 'autopilot',
      focusBoardId: null,
      title: 'Тинькофф Black',
      body: 'Основная карта для подписок и поездок',
      summary: 'Банковская карта',
      url: null,
      domain: null,
      platform: null,
      imagePath: null,
      thumbPath: null,
      mediaPath: null,
      mediaType: null,
      mediaDurationSec: null,
      mediaMeta: null,
      ogImageUrl: null,
      ocrText: '',
      extractedActions: [],
      colorPalette: [],
      secretPayload: {
        service: 'Тинькофф Black',
        login: 'IVANOVA MARIA',
        secretValue: '5536913844229911',
        notes: 'Лимит 100к/мес, кэшбэк на супермаркеты и такси',
        cardHolder: 'MARIA IVANOVA',
        expiry: '08/29',
        cvv: '742',
      },
      secretMeta: {
        service: 'Тинькофф Black',
        loginHint: 'MARIA IVANOVA',
        kind: 'bank_card',
        cardBrand: 'mastercard',
        last4: '9911',
        hasCvv: true,
        expiry: '08/29',
        hasLogin: true,
      },
      tags: ['финансы', 'карта'],
      source: 'vault_ui',
      externalId: null,
      contentHash: 'abc123',
      aiStatus: 'skipped_secret',
      aiConfidence: null,
      isPinned: true,
      isArchived: false,
      remindAt: null,
      remindedAt: null,
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      contentUpdatedAt: 1700000001000,
      deletedAt: null,
      canvasX: null,
      canvasY: null,
      canvasW: null,
      canvasH: null,
      canvasFrame: null,
      annotations: [],
      linksOut: [],
      syncVersion: 3,
      mediaRefs: [],
    };

    // Desktop -> Android
    const desktopEnc = desktopCrypto.encryptRecordPayload(dek, userId, 'item', entityId, secretItem);
    const mobileDec = await mobileCrypto.decryptRecordPayload<SyncedItemPayload>(
      dekMobile,
      userId,
      'item',
      entityId,
      desktopEnc
    );
    expect(mobileDec).toEqual(secretItem);

    // Tampered AAD must reject
    await expect(
      mobileCrypto.decryptRecordPayload(dekMobile, userId, 'item', 'wrong-id', desktopEnc)
    ).rejects.toThrow();
    await expect(
      mobileCrypto.decryptRecordPayload(dekMobile, 'other-user', 'item', entityId, desktopEnc)
    ).rejects.toThrow();

    // Android -> Desktop
    const calPayload: SyncedCalendarEventPayload = {
      v: 1,
      id: 'evt-42',
      title: 'Демо прототипа на Fold',
      notes: 'Проверить оба экрана',
      location: 'Офис',
      startAt: 1700010000000,
      endAt: 1700013600000,
      allDay: false,
      hasEndTime: true,
      color: '#E86A33',
      kind: 'event',
      recurrence: 'weekly',
      isDone: false,
      linkedItemId: entityId,
      checklist: [{ id: 'c1', text: 'Зарядить Fold', done: true }],
      attachments: ['shot-1.png'],
      externalSource: null,
      externalId: null,
      etag: null,
      createdAt: 1700000000000,
      updatedAt: 1700000005000,
      deletedAt: null,
      syncVersion: 2,
      mediaRefs: [],
    };
    const mobileEnc = await mobileCrypto.encryptRecordPayload(
      dekMobile,
      userId,
      'calendar_event',
      calPayload.id,
      calPayload
    );
    const desktopDec = desktopCrypto.decryptRecordPayload<SyncedCalendarEventPayload>(
      dek,
      userId,
      'calendar_event',
      calPayload.id,
      mobileEnc
    );
    expect(desktopDec).toEqual(calPayload);
  });

  it('KAPS1 encrypted media blobs and HMAC opaque blobId match byte-for-byte in both directions', async () => {
    const dek = desktopCrypto.generateDek();
    const dekMobile = new Uint8Array(dek);

    // 140 KB deterministic payload (tests chunked base64 & large WebCrypto buffers)
    const plaintext = new Uint8Array(140_000);
    for (let i = 0; i < plaintext.length; i++) {
      plaintext[i] = (i * 31 + 17) & 0xff;
    }
    const plainBuf = Buffer.from(plaintext);

    const shaDesktop = desktopCrypto.computePlaintextSha256(plainBuf);
    const shaMobile = await mobileCrypto.computePlaintextSha256(plaintext);
    expect(shaMobile).toBe(shaDesktop);

    const blobIdDesktop = desktopCrypto.deriveOpaqueBlobId(dek, shaDesktop);
    const blobIdMobile = await mobileCrypto.deriveOpaqueBlobId(dekMobile, shaMobile);
    expect(blobIdMobile).toBe(blobIdDesktop);

    // Desktop KAPS1 -> Android decrypt
    const encDesktop = desktopCrypto.encryptMediaBlob(dek, userId, blobIdDesktop, plainBuf);
    const decMobile = await mobileCrypto.decryptMediaBlob(
      dekMobile,
      userId,
      blobIdMobile,
      new Uint8Array(encDesktop)
    );
    expect(Buffer.from(decMobile)).toEqual(plainBuf);

    // Android KAPS1 -> Desktop decrypt
    const encMobile = await mobileCrypto.encryptMediaBlob(dekMobile, userId, blobIdMobile, plaintext);
    const decDesktop = desktopCrypto.decryptMediaBlob(
      dek,
      userId,
      blobIdDesktop,
      Buffer.from(encMobile)
    );
    expect(decDesktop).toEqual(plainBuf);

    // Wrong blobId AAD must reject
    await expect(
      mobileCrypto.decryptMediaBlob(dekMobile, userId, '0'.repeat(64), encMobile)
    ).rejects.toThrow();
  });

  it('Rewraps passphrase and recovery key compatibly across platforms', async () => {
    const initial = await mobileCrypto.createKeyEnvelope(userId, 'СтараяФраза123', 100_000);
    const rewrappedPass = await mobileCrypto.rewrapEnvelopePassphrase(
      userId,
      initial.dek,
      'НоваяФраза456',
      initial.envelope,
      100_000
    );
    const desktopUnwrapped = await desktopCrypto.unwrapDekWithPassphrase(
      userId,
      'НоваяФраза456',
      rewrappedPass,
      100_000
    );
    expect(desktopUnwrapped).toEqual(Buffer.from(initial.dek));

    const { recoveryKey: newRec, envelope: rewrappedRec } =
      await mobileCrypto.rewrapEnvelopeRecoveryKey(userId, initial.dek, rewrappedPass);
    const desktopRecUnwrapped = desktopCrypto.unwrapDekWithRecoveryKey(
      userId,
      newRec,
      rewrappedRec
    );
    expect(desktopRecUnwrapped).toEqual(Buffer.from(initial.dek));
  });
});
