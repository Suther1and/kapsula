import { describe, expect, it } from 'vitest';
import { compareLww, MobileVaultStore, parseMarkdownTasks } from '@mobile/storage/mobile-store';
import { eventOccursOnDay, filterItemsByQuery } from '@mobile/lib/mobile-helpers';
import { detectCardBrand } from '@mobile/storage/mobile-vault-crypto';
import type { CalendarEvent } from '@shared/types';

describe('MobileVaultStore offline operations, tasks, bilingual search, cards & calendar recurrence', () => {
  it('detects bank card brands and persists encrypted bank card with comment', async () => {
    expect(detectCardBrand('4276 3800 1234 5678')).toBe('visa');
    expect(detectCardBrand('5536 9138 4422 9911')).toBe('mastercard');
    expect(detectCardBrand('2200 7007 1111 2222')).toBe('mir');
    expect(detectCardBrand('3782 8224 6310 005')).toBe('amex');

    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const item = await store.upsertSecret({
      kind: 'bank_card',
      title: 'Сбер МИР',
      service: 'Сбербанк',
      secretValue: '2202 2006 1111 3344',
      expiry: '05/29',
      cvv: '318',
      cardHolder: 'IVAN IVANOV',
      notes: 'Зарплатная карта, автоплатёж за интернет 15 числа',
    });

    expect(item.dna).toBe('secret');
    expect(item.secretMeta?.cardBrand).toBe('mir');
    expect(item.secretMeta?.last4).toBe('3344');
    expect(item.hasEncryptedPayload).toBe(true);

    // Raw storage must NOT contain plaintext card number or CVV
    const raw = store.getRawItem(item.id)!;
    expect(raw.encryptedSecretPayload).toBeTruthy();
    expect(raw.encryptedSecretPayload).not.toContain('2202');
    expect(raw.encryptedSecretPayload).not.toContain('318');
    expect(raw.encryptedSecretPayload).not.toContain('автоплатёж');

    // Decryption returns full card + comment
    const revealed = await store.revealSecret(item.id);
    expect(revealed?.secretValue).toBe('2202 2006 1111 3344');
    expect(revealed?.cvv).toBe('318');
    expect(revealed?.notes).toBe('Зарплатная карта, автоплатёж за интернет 15 числа');
    expect(await store.getSecretFieldValue(item.id, 'cvv')).toBe('318');
    expect(await store.getSecretFieldValue(item.id, 'expiry')).toBe('05/29');
  });

  it('parses & toggles markdown and voice tasks compatibly with desktop', async () => {
    const md = '# Заголовок\n```md\n- [ ] не задача внутри кода\n```\n- [ ] Первая задача\n- [x] Вторая задача';
    const parsed = parseMarkdownTasks(md);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ text: 'Первая задача', done: false, taskIndex: 0 });
    expect(parsed[1]).toMatchObject({ text: 'Вторая задача', done: true, taskIndex: 1 });

    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const note = await store.createItem({
      dna: 'note',
      title: 'Чеклист',
      body: md,
    });
    const tasks = store.listVaultTasks();
    expect(tasks).toHaveLength(2);
    await store.toggleVaultTask(tasks[0]!);
    const updated = store.getItemById(note.id)!;
    expect(updated.body).toContain('- [x] Первая задача');
    expect(updated.body).toContain('- [ ] не задача внутри кода');
  });

  it('supports bilingual RU<->EN search and deterministic LWW conflict ordering', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    await store.createItem({
      dna: 'link',
      title: 'Shader breakdown for water VFX',
      body: 'Great tutorial on youtube',
      url: 'https://youtube.com/watch?v=abc',
    });
    await store.createItem({
      dna: 'note',
      title: 'Список покупок',
      body: 'Молоко, хлеб, кофе',
    });

    const all = store.listItems();
    const found = filterItemsByQuery(all, 'ютуб шейдер');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toContain('Shader');

    expect(
      compareLww(
        { updatedAt: 1000, syncVersion: 1, deletedAt: null, deviceId: 'a' },
        { updatedAt: 1000, syncVersion: 2, deletedAt: null, deviceId: 'a' }
      )
    ).toBe('remote');
    expect(
      compareLww(
        { updatedAt: 2000, syncVersion: 1, deletedAt: null, deviceId: 'a' },
        { updatedAt: 1500, syncVersion: 9, deletedAt: null, deviceId: 'z' }
      )
    ).toBe('local');
  });

  it('expands weekly and weekday calendar recurrences accurately', () => {
    const monday = new Date(2026, 10, 16, 10, 0, 0, 0); // Mon Nov 16 2026
    const ev: CalendarEvent = {
      id: 'ev1',
      title: 'Стендап',
      notes: '',
      location: '',
      startAt: monday.getTime(),
      endAt: monday.getTime() + 1800_000,
      allDay: false,
      hasEndTime: true,
      color: '#E86A33',
      kind: 'event',
      recurrence: 'weekdays',
      isDone: false,
      linkedItemId: null,
      checklist: [],
      attachments: [],
      externalSource: null,
      externalId: null,
      etag: null,
      createdAt: monday.getTime(),
      updatedAt: monday.getTime(),
      deletedAt: null,
    };

    expect(eventOccursOnDay(ev, new Date(2026, 10, 17))).toBe(true); // Tue
    expect(eventOccursOnDay(ev, new Date(2026, 10, 21))).toBe(false); // Sat
    expect(eventOccursOnDay(ev, new Date(2026, 10, 15))).toBe(false); // Before start
  });

  it('clears sync_dirty on remote LWW win (C7), scrubs deleted secrets (L4), and clears orphan orbit/board refs (H10)', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const orbit = await store.createOrbit({ name: 'Временный раздел', color: '#E86A33' });
    const board = await store.createBoard({ name: 'Временная доска', color: '#2EA06B' });
    const note = await store.createItem({
      dna: 'note',
      title: 'Локальная заметка',
      body: 'Старая версия',
      orbit: orbit.id,
      focusBoardId: board.id,
    });
    expect(store.countDirtyEntities()).toBe(3);

    // Remote strictly newer update wins LWW and MUST clear sync_dirty for that item (zero echo write!)
    const applied = await store.applySyncedItem(
      {
        v: 1,
        id: note.id,
        dna: 'note',
        subKind: null,
        orbit: orbit.id,
        modeCaptured: 'autopilot',
        focusBoardId: board.id,
        title: 'Свежая с ПК',
        body: 'Новая версия',
        summary: '',
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
        secretPayload: null,
        secretMeta: null,
        tags: [],
        source: 'vault_ui',
        externalId: null,
        contentHash: 'h2',
        aiStatus: 'local',
        aiConfidence: null,
        isPinned: false,
        isArchived: false,
        remindAt: null,
        remindedAt: null,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt + 5000,
        contentUpdatedAt: note.updatedAt + 5000,
        deletedAt: null,
        canvasX: null,
        canvasY: null,
        canvasW: null,
        canvasH: null,
        canvasFrame: null,
        annotations: [],
        linksOut: [],
        syncVersion: 5,
        mediaRefs: [],
      },
      null,
      'desktop-dev-1',
      'android-dev-1'
    );
    expect(applied.applied).toBe(true);
    expect(store.listDirtyEntities().some((d) => d.entityType === 'item' && d.entityId === note.id)).toBe(false);

    // Deleting orbit and board clears orphan references on items
    await store.deleteOrbit(orbit.id);
    await store.deleteBoard(board.id);
    const updatedNote = store.getItemById(note.id)!;
    expect(updatedNote.orbit).toBe('');
    expect(updatedNote.focusBoardId).toBeNull();

    // Soft-deleting secret moves it to reversible Trash (preserving encryptedSecretPayload),
    // while permanent purge scrubs encryptedSecretPayload and stamps purgedAt!
    const sec = await store.upsertSecret({
      kind: 'password',
      title: 'Тестовый доступ',
      service: 'Тестовый доступ',
      secretValue: 'top-secret-pass',
    });
    expect(store.getRawItem(sec.id)?.encryptedSecretPayload).toBeTruthy();
    await store.deleteItem(sec.id);
    expect(store.listItems({ includeSecrets: true }).find((i) => i.id === sec.id)).toBeUndefined();
    expect(store.listTrashedItems().map((i) => i.id)).toContain(sec.id);
    expect(store.getRawItem(sec.id)?.encryptedSecretPayload).toBeTruthy();

    await store.purgeItemPermanently(sec.id);
    expect(store.listTrashedItems().find((i) => i.id === sec.id)).toBeUndefined();
    expect(store.getRawItem(sec.id)?.encryptedSecretPayload).toBeNull();
    expect(store.getRawItem(sec.id)?.hasEncryptedPayload).toBe(false);
    expect(store.getRawItem(sec.id)?.purgedAt).not.toBeNull();
  });
});
