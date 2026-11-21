import { describe, expect, it } from 'vitest';
import { MobileVaultStore } from '../src/mobile/storage/mobile-store';
import { getWeekStripDays, toDateIso } from '../src/mobile/components/CalendarView';
import { ACCENT_PRESETS } from '../src/renderer/lib/appearance';
import { stripMarkdownPreview } from '../src/renderer/lib/format';

describe('Kapsula Android v2 Overhaul — Store, Undo, Tasks, Calendar & Accents', () => {
  it('restores soft-deleted items AND encrypted Vault bank cards with comments intact (Undo)', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const card = await store.upsertSecret({
      kind: 'bank_card',
      title: 'Тинькофф Black',
      service: 'Тинькофф Black',
      secretValue: '5536913844229911',
      expiry: '08/29',
      cvv: '742',
      cardHolder: 'IVAN IVANOV',
      notes: 'Основная карта: 5% кэшбэк на рестораны и подписки',
    });

    const rawBefore = store.getRawItem(card.id)!;
    expect(rawBefore).toBeTruthy();
    expect(rawBefore.encryptedSecretPayload).toBeTruthy();
    const snapshot = { ...rawBefore, tags: [...rawBefore.tags] };

    await store.deleteItem(card.id);
    expect(store.listItems({ includeSecrets: true }).find((i) => i.id === card.id)).toBeUndefined();

    // Undo restores the item AND its encrypted secret payload with incremented syncVersion
    const restored = await store.restoreRawItem(snapshot);
    expect(restored).toBeTruthy();
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.syncVersion ?? 0).toBeGreaterThan(rawBefore.syncVersion ?? 0);

    const revealed = await store.revealSecret(card.id);
    expect(revealed?.secretValue).toBe('5536913844229911');
    expect(revealed?.cvv).toBe('742');
    expect(revealed?.notes).toContain('5% кэшбэк');
  });

  it('restores soft-deleted calendar events cleanly via restoreRawCalendarEvent', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const ev = await store.upsertCalendarEvent({
      title: 'Демо Android Fold',
      startAt: 1732200000000,
      endAt: 1732203600000,
      kind: 'event',
      color: '#3B82F6',
    });
    const raw = store.getRawCalendarEvent(ev.id)!;
    const snap = { ...raw };

    await store.deleteCalendarEvent(ev.id);
    expect(store.listCalendarEvents().length).toBe(0);

    const restored = await store.restoreRawCalendarEvent(snap);
    expect(restored?.title).toBe('Демо Android Fold');
    expect(store.listCalendarEvents().length).toBe(1);
    expect(store.listCalendarEvents()[0]!.syncVersion ?? 0).toBeGreaterThan(raw.syncVersion ?? 0);
  });

  it('edits and deletes individual markdown tasks with Undo restoration', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const note = await store.createItem({
      dna: 'note',
      title: 'Чеклист релиза',
      body: '- [ ] Первая задача\n- [ ] Вторая задача',
    });

    const initialTasks = store.listVaultTasks();
    expect(initialTasks).toHaveLength(2);

    // Edit first task text
    await store.updateVaultTaskText(initialTasks[0]!, 'Первая задача (обновлена)');
    const afterEdit = store.listVaultTasks();
    expect(afterEdit[0]!.text).toBe('Первая задача (обновлена)');
    expect(afterEdit[1]!.text).toBe('Вторая задача');

    // Delete first task, keeping the second intact
    const snap = await store.deleteVaultTask(afterEdit[0]!);
    expect(snap).toBeTruthy();
    const afterDel = store.listVaultTasks();
    expect(afterDel).toHaveLength(1);
    expect(afterDel[0]!.text).toBe('Вторая задача');

    // Restore deleted task via Undo
    await store.restoreRawItem(snap!);
    expect(store.listVaultTasks()).toHaveLength(2);
    expect(store.getItemById(note.id)?.body).toContain('Первая задача (обновлена)');
  });

  it('deletes standalone quick-task note completely when its only task is deleted, and restores cleanly', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    await store.addQuickTask('Купить адаптер USB-C');
    const tasks = store.listVaultTasks();
    expect(tasks).toHaveLength(1);

    const snap = await store.deleteVaultTask(tasks[0]!);
    expect(snap).toBeTruthy();
    expect(store.listVaultTasks()).toHaveLength(0);
    expect(store.listItems({ includeSecrets: false })).toHaveLength(0);

    await store.restoreRawItem(snap!);
    expect(store.listVaultTasks()).toHaveLength(1);
    expect(store.listVaultTasks()[0]!.text).toBe('Купить адаптер USB-C');
  });

  it('computes Monday-to-Sunday week strip cleanly across month boundaries', () => {
    // 2026-11-01 is a Sunday -> week should be Mon 2026-10-26 .. Sun 2026-11-01
    const sunday = new Date(2026, 10, 1);
    const strip = getWeekStripDays(sunday);
    expect(strip).toHaveLength(7);
    expect(toDateIso(strip[0]!)).toBe('2026-10-26');
    expect(toDateIso(strip[6]!)).toBe('2026-11-01');
  });

  it('renames and recolors orbits & focus boards cleanly and ships all 6 desktop accent presets', async () => {
    expect(ACCENT_PRESETS.map((p) => p.id)).toEqual([
      'terracotta',
      'cobalt',
      'emerald',
      'violet',
      'amber',
      'rose',
    ]);

    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();
    const orb = await store.createOrbit({ name: 'Старое имя', color: '#E86A33' });
    const brd = await store.createBoard({ name: 'Доска 1', color: '#2EA06B' });

    await store.updateOrbit(orb.id, { name: 'Новое имя', color: '#4F86F7' });
    await store.updateBoard(brd.id, { name: 'Релиз v2', color: '#9A75F5' });

    expect(store.listOrbits()[0]!.name).toBe('Новое имя');
    expect(store.listOrbits()[0]!.color).toBe('#4F86F7');
    expect(store.listBoards()[0]!.name).toBe('Релиз v2');
    expect(store.listBoards()[0]!.color).toBe('#9A75F5');
  });

  it('refuses to silently mutate a soft-deleted tombstone in updateItem', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const note = await store.createItem({ dna: 'note', title: 'Временная', body: 'Текст' });
    await store.deleteItem(note.id);
    const res = await store.updateItem(note.id, { title: 'Оживление призрака' });
    expect(res).toBeNull();
    expect(store.getRawItem(note.id)?.deletedAt).not.toBeNull();
  });

  it('formats multi-line markdown headings & checklists cleanly with middle-dot separators', () => {
    const md = '## План проверки\n- [ ] Проверить узкий экран\n- [x] Проверить раскрытие';
    expect(stripMarkdownPreview(md)).toBe(
      'План проверки · Проверить узкий экран · Проверить раскрытие'
    );
  });

  it('preserves blank title on editor-materialized notes while still deriving default titles for quick capture', async () => {
    const store = new MobileVaultStore({ memoryOnly: true });
    await store.init();

    const editorNote = await store.createItem({
      dna: 'note',
      title: '',
      body: 'Купить молоко и хлеб',
      preserveEmptyTitle: true,
    });
    expect(editorNote.title).toBe('');
    expect(editorNote.body).toBe('Купить молоко и хлеб');

    const quickNote = await store.createItem({
      dna: 'note',
      title: '',
      body: 'Быстрая мысль с захватом',
    });
    expect(quickNote.title).toBe('Быстрая мысль с захватом');
  });
});
