import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TAGS_PER_ITEM } from '@shared/constants';
import { canonicalizeTags, VaultRepository } from '@main/db/repository';

const repos: VaultRepository[] = [];

function createRepo(): VaultRepository {
  const repo = new VaultRepository(':memory:');
  repos.push(repo);
  return repo;
}

afterEach(() => {
  while (repos.length > 0) {
    repos.pop()!.close();
  }
});

describe('VaultRepository FTS5, Orbits & Tag Anti-Entropy', () => {
  it('performs Cyrillic & Latin FTS5 search including OCR text', () => {
    const repo = createRepo();
    repo.createItem({
      dna: 'shot',
      orbit: 'finance',
      modeCaptured: 'autopilot',
      title: 'Чек облачного сервиса',
      body: 'Оплата подписки',
      ocrText: 'Промокод KAPSULA-2026 на скидку и электроника',
      tags: ['чек', 'финансы'],
      source: 'clipboard_snatch',
      contentHash: 'hash1',
    });

    repo.createItem({
      dna: 'link',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Electron 45 Docs',
      url: 'https://electronjs.org',
      domain: 'electronjs.org',
      tags: ['electron'],
      source: 'vault_ui',
      contentHash: 'hash2',
    });

    const cyr = repo.queryItems({ search: 'промок' });
    expect(cyr).toHaveLength(1);
    expect(cyr[0]?.orbit).toBe('finance');

    // Uppercase Cyrillic substring & malformed FTS5 syntax fallback preserve active filters
    const upperCyr = repo.queryItems({ search: 'ПРОМОКОД' });
    expect(upperCyr).toHaveLength(1);
    expect(upperCyr[0]?.orbit).toBe('finance');

    const malformedMatchingFilter = repo.queryItems({
      search: 'ПРОМОКОД )(',
      orbit: 'finance',
      dna: 'shot',
    });
    expect(malformedMatchingFilter).toHaveLength(1);
    expect(malformedMatchingFilter[0]?.orbit).toBe('finance');

    const malformedWrongOrbit = repo.queryItems({
      search: 'ПРОМОКОД )(',
      orbit: 'work',
    });
    expect(malformedWrongOrbit).toHaveLength(0);

    const codeMatch = repo.queryItems({ search: 'KAPSULA' });
    expect(codeMatch).toHaveLength(1);

    const engMatch = repo.queryItems({ search: 'electronjs' });
    expect(engMatch).toHaveLength(1);
  });

  it('supports updateItem, deleteItem, clearDemoItems, and deleteOrbit safely', () => {
    const repo = createRepo();
    const customOrbit = repo.createOrbit({ name: 'Хобби', description: 'Фото и модели' });
    const board = repo.createFocusBoard('Спринт 1', '#F5A524');

    const live = repo.createItem({
      dna: 'note',
      orbit: customOrbit.id,
      modeCaptured: 'autopilot',
      title: 'Старая заметка',
      body: 'Текст',
      tags: ['заметка'],
      source: 'vault_ui',
      contentHash: 'h-live',
    });
    const demo = repo.createItem({
      dna: 'link',
      orbit: 'work',
      modeCaptured: 'autopilot',
      title: 'Демо карточка',
      url: 'https://demo.local',
      tags: ['демо'],
      source: 'vault_ui',
      contentHash: 'h-demo',
      isDemo: true,
    });

    const updated = repo.updateItem(live.id, {
      title: 'Обновлённая заметка',
      body: 'Новый текст',
      focusBoardId: board.id,
      tags: ['идея', 'приоритет'],
      isPinned: true,
    });
    expect(updated?.title).toBe('Обновлённая заметка');
    expect(updated?.body).toBe('Новый текст');
    expect(updated?.focusBoardId).toBe(board.id);
    expect(updated?.isPinned).toBe(true);
    expect(updated?.tags).toContain('идея');

    // Deleting custom orbit moves its items to unassigned (''); nonexistent returns false
    expect(repo.deleteOrbit('inbox')).toBe(false);
    expect(repo.deleteOrbit(customOrbit.id)).toBe(true);
    expect(repo.getItemById(live.id)?.orbit).toBe('');

    // clearDemoItems deletes demo item only
    expect(repo.clearDemoItems()).toBe(1);
    expect(repo.getItemById(demo.id)).toBeNull();
    expect(repo.getItemById(live.id)).not.toBeNull();

    // deleteItem deletes live item
    expect(repo.deleteItem(live.id)).toBe(true);
    expect(repo.getItemById(live.id)).toBeNull();
  });

  it('supports unlimited orbits, reorderOrbits, stable contentUpdatedAt on pin/unpin, and soft-delete restoreItem', () => {
    const repo = createRepo();
    const initial = repo.listOrbits();
    expect(initial).toHaveLength(0);

    const createdIds: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const o = repo.createOrbit({ name: `Раздел ${i}`, description: `Описание ${i}` });
      createdIds.push(o.id);
    }
    expect(repo.listOrbits()).toHaveLength(15);

    const reversedIds = [...createdIds].reverse();
    const reordered = repo.reorderOrbits(reversedIds);
    expect(reordered[0]?.id).toBe(createdIds[14]);
    expect(reordered[14]?.id).toBe(createdIds[0]);

    const item = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Хронология закрепления',
      body: 'Текст',
      source: 'vault_ui',
      contentHash: 'pin-chrono-1',
      createdAt: 1_700_000_000_000,
    });
    const baseChrono = item.contentUpdatedAt;

    const pinned = repo.updateItem(item.id, { isPinned: true });
    expect(pinned?.isPinned).toBe(true);
    expect(pinned?.contentUpdatedAt).toBe(baseChrono);

    const unpinned = repo.updateItem(item.id, { isPinned: false });
    expect(unpinned?.isPinned).toBe(false);
    expect(unpinned?.contentUpdatedAt).toBe(baseChrono);

    // Content edit DOES advance contentUpdatedAt
    const edited = repo.updateItem(item.id, { body: 'Обновлённый текст' });
    expect(edited?.contentUpdatedAt).toBeGreaterThanOrEqual(baseChrono);

    // Soft-delete tombstone + restore
    expect(repo.deleteItem(item.id)).toBe(true);
    expect(repo.getItemById(item.id)).toBeNull();
    const deletedRow = repo.queryItems({ includeDeleted: true }).find((x) => x.id === item.id);
    expect(deletedRow).toBeDefined();
    expect(deletedRow?.deletedAt).not.toBeNull();

    const restored = repo.restoreItem(item.id);
    expect(restored).not.toBeNull();
    expect(restored?.deletedAt).toBeNull();
    expect(repo.getItemById(item.id)?.title).toBe('Хронология закрепления');
  });

  it('canonicalizes near-duplicate tags and enforces max tags per item', () => {
    const universe = ['анимация', 'референс', 'telegram'];
    const result = canonicalizeTags(
      ['#Анимации', 'референсы', 'ux', 'frontend', 'extra1', 'extra2'],
      universe
    );
    expect(result).toContain('анимация');
    expect(result).toContain('референс');
    expect(result.length).toBeLessThanOrEqual(MAX_TAGS_PER_ITEM);

    const inflected = canonicalizeTags(['заметок'], ['заметка']);
    expect(inflected).toEqual(['заметка']);
  });

  it('indexes non-secret secretMeta (service, cardBrand, last4) for renamed cards while keeping secrets excluded from searchNonSecretForAsk', () => {
    const repo = createRepo();
    const card = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: 'Личная карта',
      body: '',
      summary: 'Банковская карта · скрыта в Сейфе',
      encryptedPayload: 'enc-mock-v1',
      secretMeta: {
        service: 'Т-Банк',
        loginHint: '•••• 5676',
        kind: 'bank_card',
        cardBrand: 'МИР',
        last4: '5676',
      },
      tags: ['сейф', 'карта'],
      source: 'vault_ui',
      contentHash: 'secret-meta-search-1',
    });

    const byLast4 = repo.queryItems({ search: '5676' });
    expect(byLast4.map((it) => it.id)).toContain(card.id);

    const byService = repo.queryItems({ search: 'Т-Банк' });
    expect(byService.map((it) => it.id)).toContain(card.id);

    expect(repo.searchNonSecretForAsk('5676')).toEqual([]);
  });

  it('filters older items strictly with createdBefore cursor for serendipity feed', () => {
    const repo = createRepo();
    const now = Date.now();
    const tenDaysAgo = now - 10 * 86_400_000;
    const eightDaysAgo = now - 8 * 86_400_000;
    const sevenDaysCutoff = now - 7 * 86_400_000;

    const oldA = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Давняя идея 1',
      body: 'Первая старая заметка',
      summary: 'Первая старая заметка',
      source: 'vault_ui',
      contentHash: 'ser-old-a',
      createdAt: tenDaysAgo,
    });
    const oldB = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Давняя идея 2',
      body: 'Вторая старая заметка',
      summary: 'Вторая старая заметка',
      source: 'vault_ui',
      contentHash: 'ser-old-b',
      createdAt: eightDaysAgo,
    });
    const fresh = repo.createItem({
      dna: 'note',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Свежая заметка',
      body: 'Сделано сегодня',
      summary: 'Сделано сегодня',
      source: 'vault_ui',
      contentHash: 'ser-fresh',
      createdAt: now,
    });

    const staleItems = repo.queryItems({ createdBefore: sevenDaysCutoff, limit: 20 });
    const ids = staleItems.map((it) => it.id);
    expect(ids).toContain(oldA.id);
    expect(ids).toContain(oldB.id);
    expect(ids).not.toContain(fresh.id);

    const strictlyOlderThanEightDays = repo.queryItems({ createdBefore: eightDaysAgo, limit: 20 });
    expect(strictlyOlderThanEightDays.map((it) => it.id)).toEqual([oldA.id]);
  });

  it('matches Russian stems, type synonyms, hyphenated commands, normalized phone digits, and ranks title matches first', () => {
    const repo = createRepo();

    const post = repo.createItem({
      dna: 'note',
      subKind: 'post',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Claude Code: скилл для обучения агентов',
      body: 'Дизайнер и разработчик интерфейсов Эмиль Ковальски рекомендует установить скилл /learn-taste для Claude Code.',
      tags: ['claude', 'design'],
      source: 'vault_ui',
      contentHash: 'smart-post',
    });

    const card = repo.createItem({
      dna: 'secret',
      orbit: '',
      modeCaptured: 'ghost',
      title: '123123',
      body: '',
      encryptedPayload: 'enc-mock',
      secretMeta: {
        service: 'Тинькофф',
        loginHint: '•••• 1231',
        kind: 'bank_card',
        cardBrand: 'Visa',
        last4: '1231',
        hasCvv: true,
      },
      tags: [],
      source: 'vault_ui',
      contentHash: 'smart-card',
    });

    const phone = repo.createItem({
      dna: 'note',
      subKind: 'contact',
      orbit: '',
      modeCaptured: 'autopilot',
      title: '+7 999 888-77-66',
      body: '+7 999 888-77-66',
      source: 'vault_ui',
      contentHash: 'smart-phone',
    });

    const ocrShot = repo.createItem({
      dna: 'shot',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'Скриншот редактора',
      ocrText: 'Секретный слоган дизайн и анимация агентов',
      source: 'clipboard_snatch',
      contentHash: 'smart-shot',
    });

    const linkItem = repo.createItem({
      dna: 'link',
      orbit: '',
      modeCaptured: 'autopilot',
      title: 'SVG Artista — SVG Drawing Animation Generator',
      url: 'https://svgartista.net',
      domain: 'svgartista.net',
      source: 'vault_ui',
      contentHash: 'smart-link',
    });

    // Russian case inflection: Ковальского -> Ковальски
    expect(repo.queryItems({ search: 'Ковальского' }).map((i) => i.id)).toContain(post.id);

    // Hyphenated code/command token
    expect(repo.queryItems({ search: 'learn-taste' }).map((i) => i.id)).toContain(post.id);

    // Type synonym searches work even if user renames title to digits
    expect(repo.queryItems({ search: 'карта' }).map((i) => i.id)).toContain(card.id);
    expect(repo.queryItems({ search: 'скриншот' }).map((i) => i.id)).toContain(ocrShot.id);
    expect(repo.queryItems({ search: 'ссылка' }).map((i) => i.id)).toContain(linkItem.id);
    expect(repo.queryItems({ search: 'телефон' }).map((i) => i.id)).toContain(phone.id);

    // Normalized phone digits without spaces/hyphens
    expect(repo.queryItems({ search: '999888' }).map((i) => i.id)).toContain(phone.id);

    // Title match outranks OCR-only match for same word
    const ranked = repo.queryItems({ search: 'агентов' }).map((i) => i.id);
    expect(ranked[0]).toBe(post.id);
    expect(ranked).toContain(ocrShot.id);
  });
});
