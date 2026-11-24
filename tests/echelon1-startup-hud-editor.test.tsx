// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { NoteStudio } from '@renderer/components/studio/NoteStudio';
import { CommandHudSurface } from '@renderer/surfaces/CommandHudSurface';
import { QuickLookModal } from '@renderer/components/ui/QuickLookModal';
import { ShotLightbox } from '@renderer/components/cards/ShotLightbox';
import { MemoryCardRouter } from '@renderer/components/cards/MemoryCardRouter';
import { NotesHubView } from '@renderer/components/studio/NotesHubView';
import { StudioWorkspace } from '@renderer/surfaces/StudioWorkspace';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeOrbit,
  makeSettingsState,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

describe('Echelon 1 (#7): NoteStudio Zero-Lost-Chars Flush, HUD Storm & Full Hydration', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('NoteStudio synchronous markdown flush (0 lost characters)', () => {
    it('flushes 100% of characters typed <180ms before immediate close (existing note & draft)', async () => {
      const note = makeVaultItem({ id: 'flush-close-1', title: 'Заметка', body: 'Начало ' });
      const { api } = installMockKapsulaApi({
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      renderWithI18n(
        <NoteStudio
          item={note}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Начало');
      });
      await new Promise((r) => setTimeout(r, 30));

      const prose = screen.getByTestId('note-studio-editor') as HTMLElement;
      // Simulate rapid ProseMirror edit + immediate close well under 180ms debounce
      const tiptapPm = prose;
      fireEvent.input(tiptapPm, { target: { textContent: 'Начало финальный-текст-без-потерь' } });
      // Also directly dispatch DOM text mutation if TipTap listens to MutationObserver/input
      await act(async () => {
        const p = prose.querySelector('p');
        if (p) {
          p.textContent = 'Начало финальный-текст-без-потерь';
        }
        await new Promise((r) => setTimeout(r, 25));
      });

      // Verify debounced autosave hasn't fired yet (<180ms)
      expect(api.updateItem).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByTestId('note-studio-close'));
      });

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalled();
      });
      const lastPatch = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
        body?: string;
      };
      expect(lastPatch.body).toContain('финальный-текст-без-потерь');
    });

    it('flushes immediately on Ctrl+S, editor blur, unmount, and item switch without losing characters', async () => {
      const noteA = makeVaultItem({ id: 'note-a', title: 'Note A', body: 'BaseA' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Note B', body: 'BaseB' });
      const { api } = installMockKapsulaApi({
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      const { rerender, unmount } = renderWithI18n(
        <NoteStudio
          item={noteA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('BaseA');
      });
      await new Promise((r) => setTimeout(r, 30));

      const setBodyText = async (txt: string) => {
        await act(async () => {
          const editorEl = screen.getByTestId('note-studio-editor');
          const p = editorEl.querySelector('p');
          if (p) p.textContent = txt;
          await new Promise((r) => setTimeout(r, 25));
        });
      };

      // 1) Ctrl+S
      await setBodyText('BaseA ctrl-s-tail');
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('ctrl-s-tail') })
        );
      });

      // 2) Blur
      (api.updateItem as ReturnType<typeof vi.fn>).mockClear();
      await setBodyText('BaseA blur-tail');
      await act(async () => {
        fireEvent.blur(screen.getByTestId('note-studio-editor'));
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('blur-tail') })
        );
      });

      // 3) Item switch (noteA -> noteB)
      (api.updateItem as ReturnType<typeof vi.fn>).mockClear();
      await setBodyText('BaseA switch-tail');
      await act(async () => {
        rerender(
          <NoteStudio
            item={noteB}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('switch-tail') })
        );
      });
      await new Promise((r) => setTimeout(r, 30));

      // 4) Immediate unmount (useLayoutEffect cleanup must run BEFORE editor.destroy())
      (api.updateItem as ReturnType<typeof vi.fn>).mockClear();
      await setBodyText('BaseB unmount-tail');
      await act(async () => {
        unmount();
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-b',
          expect.objectContaining({ body: expect.stringContaining('unmount-tail') })
        );
      });
    });

    it('materializes non-empty draft typed <180ms before close via capture()', async () => {
      const draft = makeVaultItem({ id: '__draft__', title: '', body: '' });
      const { api } = installMockKapsulaApi({
        capture: vi.fn(async (input) =>
          makeVaultItem({ id: 'created-draft-1', title: input.title || 'Draft', body: input.text || '' })
        ),
      });

      renderWithI18n(
        <NoteStudio
          item={draft}
          isDraft={true}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDraftPersisted={vi.fn()}
          onCancelDraft={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Быстрый черновик без потери';
        await new Promise((r) => setTimeout(r, 25));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('note-studio-close'));
      });

      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('Быстрый черновик без потери') })
        );
      });
    });
  });

  describe('CommandHudSurface IPC deduplication, in-place upsert & lazy TipTap', () => {
    it('runs <= 2 data IPCs on HUD open, skips autosave reload storms, and lazy-mounts TipTap on click', async () => {
      const projectedNote = makeVaultItem({
        id: 'hud-note-1',
        title: 'HUD заметка',
        body: 'Сокращённое превью...',
        isCardProjection: true,
        isBodyTruncated: true,
        bodyLength: 3000,
      });
      const fullNote = makeVaultItem({
        id: 'hud-note-1',
        title: 'HUD заметка',
        body: 'Полный текст HUD заметки без обрезания '.repeat(30),
        isCardProjection: false,
      });

      const { api, emit } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [projectedNote]),
        getVaultItem: vi.fn(async (id) => (id === 'hud-note-1' ? fullNote : null)),
      });

      renderWithI18n(
        <CommandHudSurface settings={makeSettingsState()} onSettingsUpdated={vi.fn()} />
      );

      await waitFor(() => {
        expect(api.queryVault).toHaveBeenCalledTimes(1);
      });

      expect(api.queryVault).toHaveBeenCalledWith(
        expect.objectContaining({ projection: 'card' })
      );
      expect(api.listTasks).not.toHaveBeenCalled();
      expect(api.listCalendarEvents).not.toHaveBeenCalled();
      expect(api.listOrbits).not.toHaveBeenCalled();
      expect(api.getHudClipboardPreview).not.toHaveBeenCalled();

      // TipTap .ProseMirror must NOT be mounted on initial browse
      expect(document.querySelector('[data-testid="hud-right-editor"]')).toBeNull();
      expect(screen.getByTestId('hud-right-preview')).toBeTruthy();

      // Simulate onHudOpened -> exactly 1 more queryVault, still 0 listTasks
      (api.queryVault as ReturnType<typeof vi.fn>).mockClear();
      act(() => {
        emit('onHudOpened');
      });
      await waitFor(() => {
        expect(api.queryVault).toHaveBeenCalledTimes(1);
      });
      expect(api.listTasks).not.toHaveBeenCalled();

      // Simulate 350ms autosave upserts -> 0 queryVault & 0 listTasks reloads, title patches in-place
      (api.queryVault as ReturnType<typeof vi.fn>).mockClear();
      act(() => {
        emit(
          'onVaultItemUpserted',
          makeVaultItem({ id: 'hud-note-1', title: 'Обновлённый заголовок HUD', body: fullNote.body })
        );
      });
      expect(api.queryVault).not.toHaveBeenCalled();
      expect(api.listTasks).not.toHaveBeenCalled();
      expect((screen.getByTestId('hud-editor-title') as HTMLTextAreaElement).value).toBe(
        'Обновлённый заголовок HUD'
      );

      // Title-only edit on a truncated item must NOT overwrite DB body
      fireEvent.change(screen.getByTestId('hud-editor-title'), {
        target: { value: 'Только заголовок' },
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(api.updateItem).toHaveBeenCalledWith(
        'hud-note-1',
        expect.objectContaining({ title: 'Только заголовок' })
      );
      const patchArg = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<
        string,
        unknown
      >;
      expect(patchArg).not.toHaveProperty('body');

      // Clicking hud-right-preview hydrates full item and mounts TipTap
      await act(async () => {
        fireEvent.click(screen.getByTestId('hud-right-preview'));
      });
      await waitFor(() => {
        expect(document.querySelector('[data-testid="hud-right-editor"]')).not.toBeNull();
      });
    });
  });

  describe('Mandatory full-item hydration across QuickLookModal, ShotLightbox, NotesHubView, MemoryCardRouter', () => {
    it('hydrates full item via getVaultItem on QuickLookModal, ShotLightbox, NotesHubView, and MemoryCardRouter copy', async () => {
      const projectedShot = makeVaultItem({
        id: 'shot-proj-1',
        dna: 'shot',
        title: 'Скрин с пинами',
        body: 'Превью...',
        imagePath: 'shot.png',
        annotations: [],
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullShot = makeVaultItem({
        id: 'shot-proj-1',
        dna: 'shot',
        title: 'Скрин с пинами',
        body: 'Очень длинный текст заметки скриншота целиком',
        imagePath: 'shot.png',
        annotations: [{ id: 'pin-existing', xPct: 50, yPct: 50, text: 'Существующий пин' }],
        isCardProjection: false,
      });
      const projectedNote = makeVaultItem({
        id: 'note-proj-1',
        dna: 'note',
        title: 'Длинная заметка',
        body: 'Усечённое превью...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullNote = makeVaultItem({
        id: 'note-proj-1',
        dna: 'note',
        title: 'Длинная заметка',
        body: 'Полный текст длинной заметки для редактора',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
      });

      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn(async (id) => {
          if (id === 'shot-proj-1') return fullShot;
          if (id === 'note-proj-1') return fullNote;
          return null;
        }),
      });

      // 1) QuickLookModal hydrates full body
      const { rerender } = renderWithI18n(
        <QuickLookModal
          item={projectedShot}
          itemsList={[projectedShot]}
          onSelectItem={vi.fn()}
          onClose={vi.fn()}
          onEditInStudio={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId('quick-look-modal').textContent).toContain(
          'Очень длинный текст заметки скриншота целиком'
        );
      });

      // 2) ShotLightbox hydrates annotations before displaying/editing pins
      rerender(
        <ShotLightbox item={projectedShot} onClose={vi.fn()} onSaveAnnotations={vi.fn()} />
      );
      await waitFor(() => {
        expect(document.body.textContent).toContain('Существующий пин');
      });

      // 3) NotesHubView hydrates before initializing NoteStudio on truncated note
      renderWithI18n(
        <NotesHubView
          items={[projectedNote]}
          orbits={[]}
          focusBoards={[]}
          globalSearchQuery=""
          serverSearchIds={null}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDraftPersisted={vi.fn()}
          onDeleteItem={vi.fn()}
          onTogglePin={vi.fn()}
          onToggleNotesHub={vi.fn()}
          onMoveToOrbit={vi.fn()}
          onMoveToBoard={vi.fn()}
          onDuplicateItem={vi.fn()}
          onExportMarkdown={vi.fn()}
          onOpenExternalItem={vi.fn()}
          onOpenShotLightbox={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain(
          'Полный текст длинной заметки для редактора'
        );
      });

      // 4) MemoryCardRouter copy-text hydrates truncated card before copyText
      renderWithI18n(
        <MemoryCardRouter
          item={projectedNote}
          vaultLocked={false}
          wipeSeconds={30}
          onOpenStudio={vi.fn()}
          onOpenShotLightbox={vi.fn()}
          onDelete={vi.fn()}
          onTogglePin={vi.fn()}
          onUnlockVaultRequest={vi.fn()}
        />
      );
      const card = screen.getByTestId('memory-card-note-proj-1');
      fireEvent.contextMenu(card);
      const copyBtn = await screen.findByText(/Копировать текст/i);
      await act(async () => {
        fireEvent.click(copyBtn);
      });
      await waitFor(() => {
        expect(api.copyText).toHaveBeenCalledWith('Полный текст длинной заметки для редактора');
      });
    });

    it('preserves Note A content on blur in-flight updateItem + rapid A -> B switch and keeps active editor on B', async () => {
      const noteA = makeVaultItem({
        id: 'note-a',
        title: 'Заметка А',
        body: 'Исходный текст А',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_002_000,
      });
      const noteB = makeVaultItem({
        id: 'note-b',
        title: 'Заметка Б',
        body: 'Исходный текст Б',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_001_000,
      });

      const savedById = new Map<string, { title?: string; body?: string }>([
        ['note-a', { title: noteA.title, body: noteA.body }],
        ['note-b', { title: noteB.title, body: noteB.body }],
      ]);

      let resolveBlurUpdate!: (val: ReturnType<typeof makeVaultItem>) => void;
      const firstBlurDeferred = new Promise<ReturnType<typeof makeVaultItem>>((res) => {
        resolveBlurUpdate = res;
      });
      let updateCallIndex = 0;

      const { api } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [noteA, noteB]),
        getVaultItem: vi.fn(async (id) => (id === 'note-a' ? noteA : id === 'note-b' ? noteB : null)),
        updateItem: vi.fn(async (id, patch) => {
          updateCallIndex += 1;
          const p = patch as { title?: string; body?: string };
          savedById.set(id, { title: p.title, body: p.body });
          const updated = makeVaultItem({
            id,
            title: p.title ?? '',
            body: p.body ?? '',
            mediaMeta: { inNotesHub: true },
            updatedAt: 1_700_000_005_000 + updateCallIndex,
          });
          if (id === 'note-a' && updateCallIndex === 1) {
            return firstBlurDeferred;
          }
          return updated;
        }),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState()} onSettingsUpdated={vi.fn()} />
      );

      // Navigate to NotesHubView
      const notesNavBtn = await screen.findByTestId('nav-notes');
      fireEvent.click(notesNavBtn);

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный текст А');
      });
      await new Promise((r) => setTimeout(r, 30));

      // Edit Note A and trigger blur so first updateItem('note-a') is in-flight
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Исходный текст А сохранённый-хвост';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('сохранённый-хвост') })
        );
      });

      // Immediately switch to Note B while Note A's blur update is still pending
      const rowB = await screen.findByTestId('notes-list-item-note-b');
      await act(async () => {
        fireEvent.click(rowB);
      });

      await waitFor(() => {
        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Заметка Б');
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный текст Б');
      });

      // Resolve Note A's delayed blur updateItem AFTER Note B is active
      await act(async () => {
        resolveBlurUpdate(
          makeVaultItem({
            id: 'note-a',
            title: 'Заметка А',
            body: 'Исходный текст А сохранённый-хвост',
            mediaMeta: { inNotesHub: true },
            updatedAt: 1_700_000_009_000,
          })
        );
        await new Promise((r) => setTimeout(r, 40));
      });

      // Active editor must stay on Note B (no switch-back clobber), and Note A must never get Note B's content
      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Заметка Б');
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный текст Б');
      const finalA = savedById.get('note-a');
      expect(finalA?.title).toBe('Заметка А');
      expect(finalA?.body).toContain('сохранённый-хвост');
      expect(finalA?.body).not.toContain('Исходный текст Б');
      const noteACalls = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'note-a'
      );
      for (const call of noteACalls) {
        const p = call[1] as { title?: string; body?: string };
        expect(p.title).not.toBe('Заметка Б');
        expect(p.body).not.toContain('Исходный текст Б');
      }
    });

    it('never overwrites A2 with stale A1 on rapid A -> B -> A switch-back while updateItem is in flight', async () => {
      const noteA1 = makeVaultItem({
        id: 'note-a',
        title: 'Заголовок А1',
        body: 'Тело А1',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_001_000,
      });
      const noteB = makeVaultItem({
        id: 'note-b',
        title: 'Заголовок Б',
        body: 'Тело Б',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_002_000,
      });

      let resolveFirstAUpdate!: (val: ReturnType<typeof makeVaultItem>) => void;
      const firstAUpdateDeferred = new Promise<ReturnType<typeof makeVaultItem>>((res) => {
        resolveFirstAUpdate = res;
      });
      let noteAUpdateCount = 0;

      const { api } = installMockKapsulaApi({
        updateItem: vi.fn(async (id, patch) => {
          const p = patch as { title?: string; body?: string };
          if (id === 'note-a') {
            noteAUpdateCount += 1;
            if (noteAUpdateCount === 1) {
              return firstAUpdateDeferred;
            }
          }
          return makeVaultItem({
            id,
            title: p.title ?? '',
            body: p.body ?? '',
            mediaMeta: { inNotesHub: true },
            updatedAt: 1_700_000_010_000 + noteAUpdateCount,
          });
        }),
      });

      const TestSwitchHost: React.FC = () => {
        const [itemsById, setItemsById] = React.useState<Record<string, ReturnType<typeof makeVaultItem>>>({
          'note-a': noteA1,
          'note-b': noteB,
        });
        const [activeId, setActiveId] = React.useState<'note-a' | 'note-b'>('note-a');

        return (
          <div>
            <button
              type="button"
              data-testid="switch-to-a"
              onClick={() => setActiveId('note-a')}
            />
            <button
              type="button"
              data-testid="switch-to-b"
              onClick={() => setActiveId('note-b')}
            />
            <NoteStudio
              item={itemsById[activeId] ?? noteA1}
              orbits={[makeOrbit()]}
              focusBoards={[]}
              availableTags={[]}
              soundEnabled={false}
              onItemUpdated={(updated) => {
                setItemsById((prev) => ({ ...prev, [updated.id]: updated }));
              }}
              onDelete={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
        );
      };

      renderWithI18n(<TestSwitchHost />);

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело А1');
      });
      await new Promise((r) => setTimeout(r, 30));

      // Edit Note A (A1 -> A2) and trigger blur so updateItem('note-a', A2) is in flight
      fireEvent.change(screen.getByTestId('note-studio-title'), {
        target: { value: 'Заголовок А2' },
      });
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Тело А2';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({
            title: 'Заголовок А2',
            body: expect.stringContaining('Тело А2'),
          })
        );
      });

      // Switch A -> B while updateItem('note-a') is still pending
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-to-b'));
      });
      await waitFor(() => {
        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Заголовок Б');
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело Б');
      });
      await new Promise((r) => setTimeout(r, 25));

      // Switch B -> A while updateItem('note-a') is STILL pending (host still holds stale A1 prop):
      // 4e restores the in-flight A2 title/body immediately instead of flashing stale A1
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-to-a'));
      });
      await waitFor(() => {
        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Заголовок А2');
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело А2');
      });
      await new Promise((r) => setTimeout(r, 25));

      // Resolve the in-flight updateItem('note-a', A2) and wait > 350ms for any bogus timer/queued flush
      await act(async () => {
        resolveFirstAUpdate(
          makeVaultItem({
            id: 'note-a',
            title: 'Заголовок А2',
            body: 'Тело А2',
            mediaMeta: { inNotesHub: true },
            updatedAt: 1_700_000_009_000,
          })
        );
        await new Promise((r) => setTimeout(r, 420));
      });

      // Assert updateItem was NEVER called with stale A1, and Note A synced/retained A2
      const noteACalls = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === 'note-a'
      );
      expect(noteACalls).toHaveLength(1);
      expect(noteACalls[0]?.[1]).toEqual(
        expect.objectContaining({
          title: 'Заголовок А2',
          body: expect.stringContaining('Тело А2'),
        })
      );
      for (const call of noteACalls) {
        const p = call[1] as { title?: string; body?: string };
        expect(p.title).not.toBe('Заголовок А1');
        expect(p.body).not.toContain('Тело А1');
      }
      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Заголовок А2');
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело А2');
    });

    it('guards handleBeautify against concurrent typing so AI output never overwrites new edits', async () => {
      const note = makeVaultItem({ id: 'beautify-race-1', title: 'Заметка', body: 'Initial line' });
      let resolveTransform!: (val: {
        changed: boolean;
        formattedText: string;
        extractedTasks: string[];
        usedCloud: boolean;
      }) => void;
      const transformDeferred = new Promise<{
        changed: boolean;
        formattedText: string;
        extractedTasks: string[];
        usedCloud: boolean;
      }>((res) => {
        resolveTransform = res;
      });

      const { api } = installMockKapsulaApi({
        transformText: vi.fn(() => transformDeferred),
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      renderWithI18n(
        <NoteStudio
          item={note}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Initial line');
      });
      await new Promise((r) => setTimeout(r, 30));

      // Trigger handleBeautify via AI menu button -> Beautify apply button
      fireEvent.click(screen.getByTestId('studio-ai-menu-btn'));
      const applyBeautifyBtn = await screen.findByTestId('studio-beautify-btn');
      await act(async () => {
        fireEvent.click(applyBeautifyBtn);
      });
      await waitFor(() => {
        expect(api.transformText).toHaveBeenCalledTimes(1);
      });

      // User types concurrently while AI transformText is still pending
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Initial line CONCURRENT USER EDIT';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Resolve AI transformText with stale formatted output
      await act(async () => {
        resolveTransform({
          changed: true,
          formattedText: 'AI STALE OVERWRITE',
          extractedTasks: [],
          usedCloud: false,
        });
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(screen.getByTestId('note-studio-editor').textContent).toContain('CONCURRENT USER EDIT');
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('AI STALE OVERWRITE');
      const updateCalls = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of updateCalls) {
        expect((call[1] as { body?: string }).body ?? '').not.toContain('AI STALE OVERWRITE');
      }
    });

    it('hydrates card-projected item in handleToggleNotesHub so mediaMeta.transcript is preserved', async () => {
      const projectedNote = makeVaultItem({
        id: 'proj-toggle-1',
        dna: 'note',
        title: 'Заметка с расшифровкой',
        body: 'Короткое превью...',
        mediaMeta: { inNotesHub: false },
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullNote = makeVaultItem({
        id: 'proj-toggle-1',
        dna: 'note',
        title: 'Заметка с расшифровкой',
        body: 'Полный текст заметки',
        mediaMeta: { inNotesHub: false, transcript: 'Важная полная расшифровка аудио' },
        isCardProjection: false,
      });

      const { api } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [projectedNote]),
        getVaultItem: vi.fn(async (id) => (id === 'proj-toggle-1' ? fullNote : null)),
        updateItem: vi.fn(async (id, patch) =>
          makeVaultItem({ ...fullNote, id, ...(patch as Partial<typeof fullNote>) })
        ),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
      );

      const card = await screen.findByTestId('memory-card-proj-toggle-1');
      fireEvent.contextMenu(card);

      const addToNotesBtn = await screen.findByText(/Добавить в «Заметки»/i);
      await act(async () => {
        fireEvent.click(addToNotesBtn);
      });

      await waitFor(() => {
        expect(api.getVaultItem).toHaveBeenCalledWith('proj-toggle-1', expect.anything());
        expect(api.updateItem).toHaveBeenCalledWith(
          'proj-toggle-1',
          expect.objectContaining({
            mediaMeta: expect.objectContaining({
              inNotesHub: true,
              transcript: 'Важная полная расшифровка аудио',
            }),
          })
        );
      });
    });
  });

  describe('NoteStudio draft dedup & async note-switch race guards (M2 r4)', () => {
    function createDeferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('deduplicates draft capture() on Draft -> B switch while capture() is in flight (Target 4b)', async () => {
      const draft = makeVaultItem({ id: '__draft__', title: '', body: '' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Заметка Б', body: 'Тело Б' });
      const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();

      const { api } = installMockKapsulaApi({
        capture: vi.fn(() => captureDeferred.promise),
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      const onDraftPersisted = vi.fn();

      const Host: React.FC = () => {
        const [activeId, setActiveId] = React.useState<'__draft__' | 'note-b'>('__draft__');
        return (
          <div>
            <button type="button" data-testid="switch-to-b" onClick={() => setActiveId('note-b')} />
            <NoteStudio
              item={activeId === '__draft__' ? draft : noteB}
              isDraft={activeId === '__draft__'}
              orbits={[makeOrbit()]}
              focusBoards={[]}
              availableTags={[]}
              soundEnabled={false}
              onItemUpdated={vi.fn()}
              onDraftPersisted={onDraftPersisted}
              onCancelDraft={vi.fn()}
              onDelete={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
        );
      };

      renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Unique draft body';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });

      // Switch Draft -> B while capture() is still pending
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-to-b'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело Б');
      });

      await act(async () => {
        captureDeferred.resolve(
          makeVaultItem({
            id: 'created-draft-1',
            title: 'Unique draft body',
            body: 'Unique draft body',
          })
        );
        await new Promise((r) => setTimeout(r, 420));
      });

      expect(api.capture).toHaveBeenCalledTimes(1);
      expect(api.updateItem).not.toHaveBeenCalled();
      expect(onDraftPersisted).not.toHaveBeenCalled();
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело Б');
    });

    it('flushes post-snapshot draft edits via updateItem (not 2nd capture) on Draft -> edit -> B -> created.id', async () => {
      const draft = makeVaultItem({ id: '__draft__', title: '', body: '' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Заметка Б', body: 'Тело Б' });
      const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const savedById = new Map<string, ReturnType<typeof makeVaultItem>>();

      const { api } = installMockKapsulaApi({
        capture: vi.fn(() => captureDeferred.promise),
        updateItem: vi.fn(async (id, patch) => {
          const next = makeVaultItem({ id, ...(patch as object) });
          savedById.set(id, next);
          return next;
        }),
      });

      const Host: React.FC = () => {
        const [activeId, setActiveId] = React.useState<string>('__draft__');
        const currentItem =
          activeId === '__draft__'
            ? draft
            : activeId === 'note-b'
              ? noteB
              : savedById.get('created-draft-1') ?? noteB;
        return (
          <div>
            <button type="button" data-testid="switch-to-b" onClick={() => setActiveId('note-b')} />
            <button
              type="button"
              data-testid="switch-to-created"
              onClick={() => setActiveId('created-draft-1')}
            />
            <NoteStudio
              item={currentItem}
              isDraft={activeId === '__draft__'}
              orbits={[makeOrbit()]}
              focusBoards={[]}
              availableTags={[]}
              soundEnabled={false}
              onItemUpdated={(u) => savedById.set(u.id, u)}
              onDraftPersisted={vi.fn()}
              onCancelDraft={vi.fn()}
              onDelete={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
        );
      };

      renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Черновик v1';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });

      // Edit again BEFORE capture() resolves, then switch Draft -> B
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Черновик v2';
        await new Promise((r) => setTimeout(r, 25));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-to-b'));
      });

      await act(async () => {
        const created = makeVaultItem({
          id: 'created-draft-1',
          title: 'Черновик v1',
          body: 'Черновик v1',
        });
        savedById.set('created-draft-1', created);
        captureDeferred.resolve(created);
        await new Promise((r) => setTimeout(r, 420));
      });

      expect(api.capture).toHaveBeenCalledTimes(1);
      expect(api.updateItem).toHaveBeenCalledWith(
        'created-draft-1',
        expect.objectContaining({ body: expect.stringContaining('Черновик v2') })
      );
      expect(api.updateItem).not.toHaveBeenCalledWith('note-b', expect.anything());

      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-to-created'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Черновик v2');
      });
    });

    it('creates separate capture() for Draft -> B -> new __draft__ and ignores falsy 1st capture() return', async () => {
      // Subcase A: Draft 1 -> B -> Draft 2 (non-empty) while 1st capture() is in flight
      const capture1Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const capture2Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let captureCall = 0;

      const { api } = installMockKapsulaApi({
        capture: vi.fn(() => {
          captureCall += 1;
          return captureCall === 1 ? capture1Deferred.promise : capture2Deferred.promise;
        }),
      });

      const onDraftPersisted = vi.fn();
      const noteB = makeVaultItem({ id: 'note-b', title: 'Заметка Б', body: 'Тело Б' });

      const Host: React.FC = () => {
        const [step, setStep] = React.useState<'d1' | 'b' | 'd2'>('d1');
        const cur =
          step === 'd1'
            ? makeVaultItem({ id: '__draft__', title: '', body: '' })
            : step === 'b'
              ? noteB
              : makeVaultItem({ id: '__draft__', title: '', body: '' });
        return (
          <div>
            <button type="button" data-testid="go-b" onClick={() => setStep('b')} />
            <button type="button" data-testid="go-d2" onClick={() => setStep('d2')} />
            <NoteStudio
              item={cur}
              isDraft={step !== 'b'}
              orbits={[makeOrbit()]}
              focusBoards={[]}
              availableTags={[]}
              soundEnabled={false}
              onItemUpdated={vi.fn()}
              onDraftPersisted={onDraftPersisted}
              onCancelDraft={vi.fn()}
              onDelete={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
        );
      };

      const { unmount } = renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Первый черновик';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));
      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('go-b'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Тело Б');
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('go-d2'));
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Второй черновик';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      const created1 = makeVaultItem({ id: 'created-1', title: 'Первый черновик', body: 'Первый черновик' });
      const created2 = makeVaultItem({ id: 'created-2', title: 'Второй черновик', body: 'Второй черновик' });

      await act(async () => {
        capture1Deferred.resolve(created1);
        await new Promise((r) => setTimeout(r, 20));
        capture2Deferred.resolve(created2);
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(api.capture).toHaveBeenCalledTimes(2);
      expect(api.capture).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ text: expect.stringContaining('Первый черновик') })
      );
      expect(api.capture).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ text: expect.stringContaining('Второй черновик') })
      );
      expect(onDraftPersisted).toHaveBeenCalledTimes(1);
      expect(onDraftPersisted).toHaveBeenCalledWith(created2);
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Второй черновик');

      unmount();

      // Subcase B: Falsy 1st capture() return after __draft__ -> B -> clean __draft__ does NOT mark new draft dirty/error
      const falsyDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let falsyCall = 0;
      const { api: api2 } = installMockKapsulaApi({
        capture: vi.fn(() => {
          falsyCall += 1;
          if (falsyCall === 1) return falsyDeferred.promise;
          return Promise.resolve(null as unknown as ReturnType<typeof makeVaultItem>);
        }),
      });

      renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Упавший черновик';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));
      await waitFor(() => {
        expect(api2.capture).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('go-b'));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('go-d2'));
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        falsyDeferred.resolve(null as unknown as ReturnType<typeof makeVaultItem>);
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(screen.queryByText(/Не сохранено/i)).toBeNull();
      const callsBeforeLeaveD2 = (api2.capture as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByTestId('go-b'));
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(api2.capture).toHaveBeenCalledTimes(callsBeforeLeaveD2);
    });

    it('aborts handleBeautify when switching Draft -> B while flushDraft capture() is in flight (Target 3c) and supports Draft -> Promoted Draft', async () => {
      // Subcase 1: Draft -> B during capture()
      const draft = makeVaultItem({ id: '__draft__', title: '', body: '' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Note B', body: 'Protected Body B' });
      const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();

      const { api } = installMockKapsulaApi({
        capture: vi.fn(() => captureDeferred.promise),
        transformText: vi.fn(async () => ({
          changed: true,
          formattedText: 'BEAUTIFIED:Draft secret text',
          extractedTasks: [],
          usedCloud: false,
        })),
      });

      const { rerender, unmount } = renderWithI18n(
        <NoteStudio
          item={draft}
          isDraft={true}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDraftPersisted={vi.fn()}
          onCancelDraft={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Draft secret text';
        await new Promise((r) => setTimeout(r, 25));
      });

      fireEvent.click(screen.getByTestId('studio-ai-menu-btn'));
      const beautifyBtn = await screen.findByTestId('studio-beautify-btn');
      await act(async () => {
        fireEvent.click(beautifyBtn);
      });
      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        rerender(
          <NoteStudio
            item={noteB}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDraftPersisted={vi.fn()}
            onCancelDraft={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });

      await act(async () => {
        captureDeferred.resolve(
          makeVaultItem({ id: 'created-draft-1', title: 'Draft', body: 'Draft secret text' })
        );
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(api.transformText).not.toHaveBeenCalled();
      expect(api.updateItem).not.toHaveBeenCalledWith('note-b', expect.anything());
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Protected Body B');
      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Note B');

      unmount();

      // Subcase 2: Draft -> Promoted Draft (staying on draft) completes Beautify
      const promotedItem = makeVaultItem({
        id: 'promoted-1',
        title: 'Draft rough text',
        body: 'Draft rough text',
      });
      const { api: api2 } = installMockKapsulaApi({
        capture: vi.fn(async () => promotedItem),
        transformText: vi.fn(async () => ({
          changed: true,
          formattedText: 'BEAUTIFIED:Draft rough text',
          extractedTasks: [],
          usedCloud: false,
        })),
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      const PromotedHost: React.FC = () => {
        const [cur, setCur] = React.useState(draft);
        const [curIsDraft, setCurIsDraft] = React.useState(true);
        return (
          <NoteStudio
            item={cur}
            isDraft={curIsDraft}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={(u) => setCur(u)}
            onDraftPersisted={(c) => {
              setCur(c);
              setCurIsDraft(false);
            }}
            onCancelDraft={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      };

      renderWithI18n(<PromotedHost />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Draft rough text';
        await new Promise((r) => setTimeout(r, 25));
      });

      fireEvent.click(screen.getByTestId('studio-ai-menu-btn'));
      const applyBtn2 = await screen.findByTestId('studio-beautify-btn');
      await act(async () => {
        fireEvent.click(applyBtn2);
      });

      await waitFor(() => {
        expect(api2.transformText).toHaveBeenCalledWith(
          expect.objectContaining({ itemId: 'promoted-1' })
        );
        expect(api2.updateItem).toHaveBeenCalledWith(
          'promoted-1',
          expect.objectContaining({ body: expect.stringContaining('BEAUTIFIED:Draft rough text') })
        );
      });
    });

    it('guards applyMetaPatch across Draft -> B (tag) and Note A -> Note B (favorite) switches', async () => {
      // Subcase A: Draft -> B during capture() triggered by adding a tag
      const draft = makeVaultItem({ id: '__draft__', title: '', body: '' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Note B', body: 'Body B', tags: [] });
      const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();

      const { api } = installMockKapsulaApi({
        capture: vi.fn(() => captureDeferred.promise),
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      const { rerender, unmount } = renderWithI18n(
        <NoteStudio
          item={draft}
          isDraft={true}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDraftPersisted={vi.fn()}
          onCancelDraft={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Draft with tag';
        await new Promise((r) => setTimeout(r, 25));
      });

      fireEvent.click(screen.getByLabelText('Добавить тег'));
      const tagInput = await screen.findByPlaceholderText('тег');
      fireEvent.change(tagInput, { target: { value: 'draft-tag' } });
      await act(async () => {
        fireEvent.keyDown(tagInput, { key: 'Enter' });
      });

      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });
      expect(api.capture).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['draft-tag'] })
      );

      await act(async () => {
        rerender(
          <NoteStudio
            item={noteB}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDraftPersisted={vi.fn()}
            onCancelDraft={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });

      await act(async () => {
        captureDeferred.resolve(
          makeVaultItem({ id: 'created-tag-1', title: 'Draft with tag', body: 'Draft with tag', tags: ['draft-tag'] })
        );
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(api.updateItem).not.toHaveBeenCalledWith('note-b', expect.anything());
      unmount();

      // Subcase B: Note A dirty + favorite click -> switch Note A -> Note B while flushDraft updateItem is pending
      const noteA = makeVaultItem({ id: 'note-a', title: 'Note A', body: 'Body A', isPinned: false });
      const flushDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let aCalls = 0;

      const { api: api2 } = installMockKapsulaApi({
        updateItem: vi.fn(async (id, patch) => {
          if (id === 'note-a') {
            aCalls += 1;
            if (aCalls === 1) return flushDeferred.promise;
          }
          return makeVaultItem({ id, ...(patch as object) });
        }),
      });

      const { rerender: rerender2 } = renderWithI18n(
        <NoteStudio
          item={noteA}
          isDraft={false}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Body A');
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Body A edited';
        await new Promise((r) => setTimeout(r, 25));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-favorite-btn'));
      });
      await waitFor(() => {
        expect(api2.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('Body A edited') })
        );
      });

      await act(async () => {
        rerender2(
          <NoteStudio
            item={noteB}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });

      await act(async () => {
        flushDeferred.resolve(makeVaultItem({ id: 'note-a', title: 'Note A', body: 'Body A edited' }));
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(api2.updateItem).toHaveBeenCalledWith('note-a', { isPinned: true });
      expect(api2.updateItem).not.toHaveBeenCalledWith('note-b', expect.anything());
    });

    it('guards handleTranscribeVoice across Note A -> Note B switch (including !res.ok extractTasks fallback)', async () => {
      const voiceA = makeVaultItem({
        id: 'voice-a',
        dna: 'voice',
        title: 'Голос А',
        body: '',
        mediaPath: 'voice-a.wav',
        mediaType: 'audio/wav',
      });
      const noteB = makeVaultItem({
        id: 'note-b',
        dna: 'note',
        title: 'Note B',
        body: 'Protected Body B',
      });

      // Case A: res.ok = true
      const transcribeDeferred = createDeferred<{ ok: boolean; item?: ReturnType<typeof makeVaultItem>; transcript?: string }>();
      const onItemUpdated = vi.fn();
      const { api } = installMockKapsulaApi({
        transcribeItem: vi.fn(() => transcribeDeferred.promise),
      });

      const { rerender, unmount } = renderWithI18n(
        <NoteStudio
          item={voiceA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={onItemUpdated}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('studio-audio-transcribe-btn')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-audio-transcribe-btn'));
      });
      await waitFor(() => {
        expect(api.transcribeItem).toHaveBeenCalledWith(
          expect.objectContaining({ itemId: 'voice-a', extractTasks: false })
        );
      });

      await act(async () => {
        rerender(
          <NoteStudio
            item={noteB}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={onItemUpdated}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });

      await act(async () => {
        transcribeDeferred.resolve({
          ok: true,
          item: makeVaultItem({ id: 'voice-a', title: 'Голос А', body: 'Voice A Transcript' }),
        });
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Protected Body B');
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('Voice A Transcript');
      expect(api.updateItem).not.toHaveBeenCalledWith('note-b', expect.anything());
      unmount();

      // Case B: !res.ok && extractTasks fallback must NOT run handleBeautify on Note B
      const voiceAWithText = makeVaultItem({
        id: 'voice-a-2',
        dna: 'voice',
        title: 'Голос А2',
        body: 'Существующий текст',
        mediaPath: 'voice-a2.wav',
        mediaType: 'audio/wav',
      });
      const failDeferred = createDeferred<{ ok: boolean; error?: string }>();
      const { api: api2 } = installMockKapsulaApi({
        transcribeItem: vi.fn(() => failDeferred.promise),
      });

      const { rerender: rerender2 } = renderWithI18n(
        <NoteStudio
          item={voiceAWithText}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('studio-voice-extract-tasks-btn')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-voice-extract-tasks-btn'));
      });
      await act(async () => {
        rerender2(
          <NoteStudio
            item={noteB}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });
      await act(async () => {
        failDeferred.resolve({ ok: false, error: 'fail' });
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(api2.transformText).not.toHaveBeenCalled();
    });

    it('guards handleQuickRevert and handleOpenHistoryModal across Note A -> Note B switch', async () => {
      const noteA = makeVaultItem({ id: 'note-a', title: 'Note A', body: 'Current Body A' });
      const noteB = makeVaultItem({ id: 'note-b', title: 'Note B', body: 'Protected Body B' });
      const rev1 = {
        id: 'rev-1',
        itemId: 'note-a',
        title: 'Old Title A',
        content: 'Old Body A',
        source: 'manual' as const,
        createdAt: 1_700_000_000_000,
      };
      const revertDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();

      const { api } = installMockKapsulaApi({
        listRevisions: vi.fn(async (id) => (id === 'note-a' ? [rev1] : [])),
        revertRevision: vi.fn(() => revertDeferred.promise),
      });

      const { rerender, unmount } = renderWithI18n(
        <NoteStudio
          item={noteA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('studio-history-btn')).toBeTruthy();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-history-btn'));
      });
      const restoreBtn = await screen.findByText('Восстановить эту версию');
      await act(async () => {
        fireEvent.click(restoreBtn);
      });
      await waitFor(() => {
        expect(api.revertRevision).toHaveBeenCalledWith('note-a', 'rev-1');
      });

      await act(async () => {
        rerender(
          <NoteStudio
            item={noteB}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });

      await act(async () => {
        revertDeferred.resolve(makeVaultItem({ id: 'note-a', title: 'Old Title A', body: 'Old Body A' }));
        await new Promise((r) => setTimeout(r, 50));
      });

      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Note B');
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Protected Body B');
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('Old Body A');
      unmount();

      // handleOpenHistoryModal across A -> B while listRevisions('note-a') is pending
      const listRevDeferred = createDeferred<Array<typeof rev1>>();
      installMockKapsulaApi({
        listRevisions: vi.fn((id) => (id === 'note-a' ? listRevDeferred.promise : Promise.resolve([]))),
      });

      const { rerender: rerender2 } = renderWithI18n(
        <NoteStudio
          item={noteA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId('studio-history-btn')).toBeTruthy();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-history-btn'));
      });
      await act(async () => {
        rerender2(
          <NoteStudio
            item={noteB}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      });
      await act(async () => {
        listRevDeferred.resolve([rev1]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(screen.queryByText('История версий')).toBeNull();
    });

    it('closes modal NoteStudio on Escape when ProseMirror has focus and no internal popup is open', async () => {
      const note = makeVaultItem({ id: 'esc-modal-1', title: 'Заметка', body: 'Текст' });
      const onClose = vi.fn();
      const { api } = installMockKapsulaApi({
        updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
      });

      renderWithI18n(
        <NoteStudio
          item={note}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          presentation="modal"
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Текст');
      });
      await new Promise((r) => setTimeout(r, 30));

      const prose = screen.getByTestId('note-studio-editor');
      await act(async () => {
        prose.focus();
        const p = prose.querySelector('p');
        if (p) p.textContent = 'Текст с новым хвостом';
        await new Promise((r) => setTimeout(r, 25));
      });

      await act(async () => {
        fireEvent.keyDown(prose, { key: 'Escape', code: 'Escape' });
      });

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(api.updateItem).toHaveBeenCalledWith(
          'esc-modal-1',
          expect.objectContaining({ body: expect.stringContaining('Текст с новым хвостом') })
        );
      });
    });
  });

  describe('Concurrency & hydration guards across StudioWorkspace, QuickLookModal, ShotLightbox, NotesHubView (M2 r4)', () => {
    function createDeferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('serializes handleToggleNotesHub on concurrent double-click and true -> false inversion without losing mediaMeta.transcript', async () => {
      const projectedNote = makeVaultItem({
        id: 'proj-race-1',
        dna: 'note',
        title: 'Заметка для рассинхрона',
        body: 'Короткое превью...',
        mediaMeta: { inNotesHub: false },
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullNote = makeVaultItem({
        id: 'proj-race-1',
        dna: 'note',
        title: 'Заметка для рассинхрона',
        body: 'Полный текст',
        mediaMeta: { inNotesHub: false, transcript: 'Сохранённая расшифровка' },
        isCardProjection: false,
      });

      const call1Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let getCallCount = 0;

      const { api } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [projectedNote]),
        getVaultItem: vi.fn(() => {
          getCallCount += 1;
          if (getCallCount === 1) return call1Deferred.promise;
          return Promise.resolve(fullNote);
        }),
        updateItem: vi.fn(async (id, patch) =>
          makeVaultItem({
            ...fullNote,
            id,
            ...(patch as Partial<typeof fullNote>),
          })
        ),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
      );

      const card = await screen.findByTestId('memory-card-proj-race-1');

      // Rapid double-click "Добавить в Заметки" before Call 1 hydration resolves
      fireEvent.contextMenu(card);
      const btn1 = await screen.findByText(/Добавить в «Заметки»/i);
      fireEvent.click(btn1);

      fireEvent.contextMenu(card);
      const btn2 = await screen.findByText(/Добавить в «Заметки»/i);
      fireEvent.click(btn2);

      await act(async () => {
        call1Deferred.resolve(fullNote);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(api.updateItem).toHaveBeenCalledTimes(1);
      expect(api.updateItem).toHaveBeenCalledWith(
        'proj-race-1',
        expect.objectContaining({
          mediaMeta: expect.objectContaining({
            inNotesHub: true,
            transcript: 'Сохранённая расшифровка',
          }),
        })
      );

      // Phase 2: fresh StudioWorkspace with projected item (inNotesHub: true) so Drop(true) genuinely awaits dropDeferred before Toggle(false)
      cleanup();
      const projPhase2 = makeVaultItem({
        id: 'proj-race-2',
        dna: 'note',
        title: 'Заметка для инверсии',
        body: 'Короткое превью...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullPhase2 = makeVaultItem({
        id: 'proj-race-2',
        dna: 'note',
        title: 'Заметка для инверсии',
        body: 'Полный текст фазы 2',
        mediaMeta: { inNotesHub: true, transcript: 'Сохранённая расшифровка' },
        isCardProjection: false,
      });

      const dropDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let phase2GetCount = 0;
      const { api: api2 } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [projPhase2]),
        getVaultItem: vi.fn(() => {
          phase2GetCount += 1;
          if (phase2GetCount === 1) return dropDeferred.promise;
          return Promise.resolve(fullPhase2);
        }),
        updateItem: vi.fn(async (id, patch) =>
          makeVaultItem({
            ...fullPhase2,
            id,
            ...(patch as Partial<typeof fullPhase2>),
          })
        ),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
      );

      const card2 = await screen.findByTestId('memory-card-proj-race-2');
      const navNotes = await screen.findByTestId('nav-notes');
      const dt = {
        types: ['text/kapsula-item-id'],
        getData: (k: string) => (k === 'text/kapsula-item-id' ? 'proj-race-2' : ''),
        dropEffect: 'move',
      };
      // Trigger drop (inNotesHub: true) which suspends on dropDeferred, then immediately remove (inNotesHub: false)
      fireEvent.drop(navNotes, { dataTransfer: dt });
      fireEvent.contextMenu(card2);
      const removeBtn = await screen.findByText(/Убрать из «Заметок»/i);
      fireEvent.click(removeBtn);

      await act(async () => {
        dropDeferred.resolve(fullPhase2);
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(phase2GetCount).toBeGreaterThanOrEqual(1);
      // Latest intent (inNotesHub: false) must win without inversion
      const calls = (api2.updateItem as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastCallMeta = calls.at(-1)?.[1] as { mediaMeta?: { inNotesHub?: boolean; transcript?: string } };
      expect(lastCallMeta.mediaMeta?.inNotesHub).toBe(false);
      expect(lastCallMeta.mediaMeta?.transcript).toBe('Сохранённая расшифровка');
    });

    it('aborts delayed handleOpenItem hydration when Ctrl+N, Escape, or onFocusItem(B) supersedes', async () => {
      const projA = makeVaultItem({
        id: 'proj-a',
        title: 'Card A',
        body: 'Preview A',
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const fullA = makeVaultItem({
        id: 'proj-a',
        title: 'Card A Full',
        body: 'Full Body A',
        isCardProjection: false,
      });
      const fullB = makeVaultItem({
        id: 'item-b',
        title: 'Focus Item B',
        body: 'Focus Body B',
        isCardProjection: false,
      });

      const aDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const { api, emit } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [projA]),
        getVaultItem: vi.fn((id) => {
          if (id === 'proj-a') return aDeferred.promise;
          if (id === 'item-b') return Promise.resolve(fullB);
          return Promise.resolve(null);
        }),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
      );

      const cardA = await screen.findByTestId('memory-card-proj-a');
      fireEvent.click(cardA);
      await waitFor(() => {
        expect(api.getVaultItem).toHaveBeenCalledWith('proj-a', expect.anything());
      });

      // Trigger Ctrl+N (blank draft) before proj-a hydration resolves
      await act(async () => {
        fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true });
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio')).toBeTruthy();
        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('');
      });

      await act(async () => {
        aDeferred.resolve(fullA);
        await new Promise((r) => setTimeout(r, 50));
      });
      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('');
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('Full Body A');

      // Close draft, then test onFocusItem(B) superseding slow proj-a
      await act(async () => {
        fireEvent.click(screen.getByTestId('note-studio-close'));
      });
      const aDeferred2 = createDeferred<ReturnType<typeof makeVaultItem>>();
      (api.getVaultItem as ReturnType<typeof vi.fn>).mockImplementation((id) => {
        if (id === 'proj-a') return aDeferred2.promise;
        if (id === 'item-b') return Promise.resolve(fullB);
        return Promise.resolve(null);
      });

      fireEvent.click(cardA);
      await act(async () => {
        emit('onFocusItem', 'item-b');
      });
      await waitFor(() => {
        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Focus Item B');
      });
      await act(async () => {
        aDeferred2.resolve(fullA);
        await new Promise((r) => setTimeout(r, 50));
      });
      expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe('Focus Item B');
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Focus Body B');
    });

    it('invalidates stale QuickLookModal hydration on A (proj, slow) -> A (unprojected upsert) and awaits hydration on early Copy', async () => {
      const aProjV1 = makeVaultItem({
        id: 'ql-a',
        title: 'QL A',
        body: 'Truncated...',
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const aFullV1 = makeVaultItem({
        id: 'ql-a',
        title: 'QL A',
        body: 'STALE_V1_BODY',
        isCardProjection: false,
      });
      const aFullV2 = makeVaultItem({
        id: 'ql-a',
        title: 'QL A',
        body: 'FRESH_V2_BODY',
        isCardProjection: false,
      });

      const slowHydrate = createDeferred<ReturnType<typeof makeVaultItem>>();
      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn(() => slowHydrate.promise),
      });

      const { rerender, unmount } = renderWithI18n(
        <QuickLookModal
          item={aProjV1}
          itemsList={[aProjV1]}
          onSelectItem={vi.fn()}
          onClose={vi.fn()}
          onEditInStudio={vi.fn()}
        />
      );

      rerender(
        <QuickLookModal
          item={aFullV2}
          itemsList={[aFullV2]}
          onSelectItem={vi.fn()}
          onClose={vi.fn()}
          onEditInStudio={vi.fn()}
        />
      );
      expect(screen.getByTestId('quick-look-modal').textContent).toContain('FRESH_V2_BODY');

      await act(async () => {
        slowHydrate.resolve(aFullV1);
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(screen.getByTestId('quick-look-modal').textContent).toContain('FRESH_V2_BODY');
      expect(screen.getByTestId('quick-look-modal').textContent).not.toContain('STALE_V1_BODY');
      unmount();

      // Early Copy on projected truncated item awaits full body before copyText
      const earlyHydrate = createDeferred<ReturnType<typeof makeVaultItem>>();
      (api.getVaultItem as ReturnType<typeof vi.fn>).mockImplementation(() => earlyHydrate.promise);
      renderWithI18n(
        <QuickLookModal
          item={aProjV1}
          itemsList={[aProjV1]}
          onSelectItem={vi.fn()}
          onClose={vi.fn()}
          onEditInStudio={vi.fn()}
        />
      );
      const copyBtn = screen.getByText('Копировать').closest('button')!;
      fireEvent.click(copyBtn);

      await act(async () => {
        earlyHydrate.resolve(aFullV2);
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(api.copyText).toHaveBeenCalledWith('FRESH_V2_BODY');
    });

    it('preserves ShotLightbox annotateMode on upsert, invalidates stale A_v1 hydration, and merges pre-hydration pins', async () => {
      const existingPin = { id: 'pin-1', xPct: 20, yPct: 30, text: 'Existing Pin' };
      const shotProj = makeVaultItem({
        id: 'shot-lb-1',
        dna: 'shot',
        title: 'Shot 1',
        imagePath: 'shot.png',
        annotations: [],
        isCardProjection: true,
        isBodyTruncated: true,
      });
      const shotFullV1 = makeVaultItem({
        id: 'shot-lb-1',
        dna: 'shot',
        title: 'Shot V1 Stale',
        imagePath: 'shot.png',
        annotations: [existingPin],
        isCardProjection: false,
      });
      const shotFullV2 = makeVaultItem({
        id: 'shot-lb-1',
        dna: 'shot',
        title: 'Shot V2 Fresh',
        imagePath: 'shot.png',
        annotations: [existingPin],
        isCardProjection: false,
      });

      const slowHydrate = createDeferred<ReturnType<typeof makeVaultItem>>();
      installMockKapsulaApi({
        getVaultItem: vi.fn(() => slowHydrate.promise),
      });

      const onSaveAnnotations = vi.fn(async () => {});
      const { rerender, unmount } = renderWithI18n(
        <ShotLightbox item={shotProj} onClose={vi.fn()} onSaveAnnotations={onSaveAnnotations} />
      );

      // Enter annotateMode, then simulate an unprojected upsert of the same item.id
      fireEvent.click(screen.getByText('Пометить точку'));
      expect(screen.getByText('Кликни по картинке…')).toBeTruthy();

      rerender(
        <ShotLightbox item={shotFullV2} onClose={vi.fn()} onSaveAnnotations={onSaveAnnotations} />
      );
      expect(screen.getByText('Кликни по картинке…')).toBeTruthy();
      expect(document.body.textContent).toContain('Shot V2 Fresh');

      await act(async () => {
        slowHydrate.resolve(shotFullV1);
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(document.body.textContent).toContain('Shot V2 Fresh');
      expect(document.body.textContent).not.toContain('Shot V1 Stale');
      unmount();

      // Adding a pin while projected merges with hydrated existingPin
      installMockKapsulaApi({
        getVaultItem: vi.fn(async () => shotFullV2),
      });
      const onSave2 = vi.fn(async () => {});
      renderWithI18n(
        <ShotLightbox item={shotProj} onClose={vi.fn()} onSaveAnnotations={onSave2} />
      );

      fireEvent.click(screen.getByText('Пометить точку'));
      const img = document.querySelector('img[alt="Shot 1"]')!;
      fireEvent.click(img.parentElement!, { clientX: 50, clientY: 50 });
      const pinInput = await screen.findByPlaceholderText('Комментарий к точке…');
      fireEvent.change(pinInput, { target: { value: 'New Pin' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Сохранить'));
      });

      await waitFor(() => {
        expect(onSave2).toHaveBeenCalledWith(
          'shot-lb-1',
          expect.arrayContaining([
            expect.objectContaining({ id: 'pin-1', text: 'Existing Pin' }),
            expect.objectContaining({ text: 'New Pin' }),
          ])
        );
      });
    });

    it('preserves NotesHubView Note A edits across A (edited, delayed updateItem) -> B (truncated, slow hydration) -> A unmount/remount', async () => {
      const noteA = makeVaultItem({
        id: 'note-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный А',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_002_000,
      });
      const noteBTruncated = makeVaultItem({
        id: 'note-b',
        dna: 'note',
        title: 'Заметка Б',
        body: 'Усечённый Б...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
        updatedAt: 1_700_000_001_000,
      });
      const noteBFull = makeVaultItem({
        ...noteBTruncated,
        body: 'Полный текст Б',
        isCardProjection: false,
        isBodyTruncated: false,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateBDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) => (id === 'note-b' ? hydrateBDeferred.promise : Promise.resolve(noteA))),
        updateItem: vi.fn((id, patch) => {
          if (id === 'note-a') return updateADeferred.promise;
          return Promise.resolve(makeVaultItem({ id, ...(patch as object) }));
        }),
      });

      const Host: React.FC = () => {
        const [items, setItems] = React.useState([noteA, noteBTruncated]);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный А');
      });
      await new Promise((r) => setTimeout(r, 30));

      // Edit Note A, then click truncated Note B (unmounting NoteStudio while updateItem(A) is triggered & delayed)
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Сохранённая правка А';
        await new Promise((r) => setTimeout(r, 25));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-note-b'));
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledWith(
          'note-a',
          expect.objectContaining({ body: expect.stringContaining('Сохранённая правка А') })
        );
      });

      // Immediately switch back to Note A BEFORE B hydrates AND BEFORE updateItem(A) resolves
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-note-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Сохранённая правка А');
      });

      // Resolve delayed updateItem(A) and stale hydrate(B)
      await act(async () => {
        updateADeferred.resolve(
          makeVaultItem({
            ...noteA,
            body: 'Сохранённая правка А',
            updatedAt: 1_700_000_009_000,
          })
        );
        hydrateBDeferred.resolve(noteBFull);
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Сохранённая правка А');
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('Полный текст Б');
    });

    it('T4b: invokes updateItem twice (false then true) when Drop(true) queues behind in-flight Toggle(false) on unprojected item', async () => {
      const unprojNote = makeVaultItem({
        id: 'unproj-toggle-2',
        dna: 'note',
        title: 'Непроецированная заметка',
        body: 'Полный текст сразу',
        mediaMeta: { inNotesHub: true, transcript: 'Транскрипт цел' },
        isCardProjection: false,
        updatedAt: 1_700_000_010_000,
      });

      const removeDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let updateCount = 0;
      const { api } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [unprojNote]),
        updateItem: vi.fn((id, patch) => {
          updateCount += 1;
          const typedPatch = patch as Partial<typeof unprojNote>;
          const updatedItem = makeVaultItem({
            ...unprojNote,
            id,
            ...typedPatch,
            updatedAt: 1_700_000_010_000,
          });
          if (updateCount === 1) return removeDeferred.promise;
          return Promise.resolve(updatedItem);
        }),
      });

      renderWithI18n(
        <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
      );

      const card = await screen.findByTestId('memory-card-unproj-toggle-2');
      const navNotes = await screen.findByTestId('nav-notes');

      // 1. Trigger Toggle(false) via context menu -> updateItem(false) is now in-flight
      fireEvent.contextMenu(card);
      const removeBtn = await screen.findByText(/Убрать из «Заметок»/i);
      fireEvent.click(removeBtn);

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
      });

      // 2. Immediately drop onto Notes (true) while updateItem(false) is deferred
      const dt = {
        types: ['text/kapsula-item-id'],
        getData: (k: string) => (k === 'text/kapsula-item-id' ? 'unproj-toggle-2' : ''),
        dropEffect: 'move',
      };
      fireEvent.drop(navNotes, { dataTransfer: dt });

      // 3. Resolve updateItem(false); queued Drop(true) must NOT read stale itemsRef and must call updateItem(true)
      await act(async () => {
        removeDeferred.resolve(
          makeVaultItem({
            ...unprojNote,
            mediaMeta: { inNotesHub: false, transcript: 'Транскрипт цел' },
            updatedAt: 1_700_000_010_000,
          })
        );
        await new Promise((r) => setTimeout(r, 60));
      });

      expect(api.updateItem).toHaveBeenCalledTimes(2);
      const calls = (api.updateItem as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]?.[1]).toEqual(
        expect.objectContaining({
          mediaMeta: expect.objectContaining({ inNotesHub: false, transcript: 'Транскрипт цел' }),
        })
      );
      expect(calls[1]?.[1]).toEqual(
        expect.objectContaining({
          mediaMeta: expect.objectContaining({ inNotesHub: true, transcript: 'Транскрипт цел' }),
        })
      );
    });

    it('T5c: deduplicates capture() when VoiceRecorderStudio onDictated fires on dirty draft and switches Draft -> B mid-flight', async () => {
      (window as unknown as { __KAPSULA_SYNTH_MIC__?: boolean }).__KAPSULA_SYNTH_MIC__ = true;
      try {
        const draft = makeVaultItem({ id: '__draft__', dna: 'note', title: '', body: '' });
        const noteB = makeVaultItem({
          id: 'note-b-voice',
          dna: 'note',
          title: 'Note B Intact',
          body: 'Note B Body',
        });

        const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
        const { api } = installMockKapsulaApi({
          dictateAudio: vi.fn(async () => ({
            transcript: 'Диктованная речь',
            formattedText: 'Диктованная речь',
            titleSuggestion: 'Голосовая заметка',
            keyPoints: [],
            actionItems: [],
            durationSec: 1.5,
            usedCloud: false,
          })),
          capture: vi.fn(() => captureDeferred.promise),
          updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
        });

        const onDraftPersisted = vi.fn();
        const onItemUpdated = vi.fn();

        const { rerender } = renderWithI18n(
          <NoteStudio
            item={draft}
            isDraft={true}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={onItemUpdated}
            onDraftPersisted={onDraftPersisted}
            onDelete={vi.fn()}
          />
        );

        await waitFor(() => {
          expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
        });
        await new Promise((r) => setTimeout(r, 30));

        // Type draft prefix (dirtyRef = true)
        await act(async () => {
          const p = screen.getByTestId('note-studio-editor').querySelector('p');
          if (p) p.textContent = 'Typed draft prefix';
          await new Promise((r) => setTimeout(r, 25));
        });

        // Open VoiceRecorderStudio and finish recording -> triggers onDictated -> capture() deferred
        fireEvent.click(screen.getByTestId('studio-more-menu-btn'));
        fireEvent.click(await screen.findByTestId('studio-dictate-btn'));
        const finishBtn = await screen.findByTestId('voice-finish-btn');
        await waitFor(() => {
          expect((finishBtn as HTMLButtonElement).disabled).toBe(false);
        });
        await act(async () => {
          fireEvent.click(finishBtn);
          await new Promise((r) => setTimeout(r, 30));
        });

        expect(api.capture).toHaveBeenCalledTimes(1);
        const captureArg = (api.capture as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
          text?: string;
        };
        expect(captureArg.text).toContain('Typed draft prefix');
        expect(captureArg.text).toContain('Диктованная речь');

        // Switch Draft -> Note B while capture() is still pending
        rerender(
          <NoteStudio
            item={noteB}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={onItemUpdated}
            onDraftPersisted={onDraftPersisted}
            onDelete={vi.fn()}
          />
        );

        await act(async () => {
          captureDeferred.resolve(
            makeVaultItem({
              id: 'created-voice-draft-1',
              dna: 'note',
              title: 'Голосовая заметка',
              body: 'Typed draft prefix\n\nДиктованная речь',
            })
          );
          await new Promise((r) => setTimeout(r, 60));
        });

        expect(api.capture).toHaveBeenCalledTimes(1);
        expect(onDraftPersisted).not.toHaveBeenCalled();
        expect(onItemUpdated).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'created-voice-draft-1' })
        );
        expect(api.updateItem).not.toHaveBeenCalledWith('note-b-voice', expect.anything());
        expect(api.updateItem).not.toHaveBeenCalledWith('created-voice-draft-1', expect.anything());
      } finally {
        delete (window as unknown as { __KAPSULA_SYNTH_MIC__?: boolean }).__KAPSULA_SYNTH_MIC__;
      }
    });

    it('T5e: deduplicates capture() when VoiceRecorderStudio onFallbackSaveAudio fires on dirty draft and switches Draft -> B mid-flight', async () => {
      (window as unknown as { __KAPSULA_SYNTH_MIC__?: boolean }).__KAPSULA_SYNTH_MIC__ = true;
      try {
        const draft = makeVaultItem({ id: '__draft__', dna: 'note', title: '', body: '' });
        const noteB = makeVaultItem({
          id: 'note-b-fallback',
          dna: 'note',
          title: 'Note B Fallback',
          body: 'Note B Body',
        });

        const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
        const { api } = installMockKapsulaApi({
          dictateAudio: vi.fn(async () => ({
            transcript: '',
            formattedText: '',
            keyPoints: [],
            actionItems: [],
            durationSec: 1.5,
            usedCloud: false,
          })),
          capture: vi.fn(() => captureDeferred.promise),
          updateItem: vi.fn(async (id, patch) => makeVaultItem({ id, ...(patch as object) })),
        });

        const onDraftPersisted = vi.fn();
        const onItemUpdated = vi.fn();

        const { rerender } = renderWithI18n(
          <NoteStudio
            item={draft}
            isDraft={true}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={onItemUpdated}
            onDraftPersisted={onDraftPersisted}
            onDelete={vi.fn()}
          />
        );

        await waitFor(() => {
          expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
        });
        await new Promise((r) => setTimeout(r, 30));

        // Type draft prefix (dirtyRef = true)
        await act(async () => {
          const p = screen.getByTestId('note-studio-editor').querySelector('p');
          if (p) p.textContent = 'Typed fallback prefix';
          await new Promise((r) => setTimeout(r, 25));
        });

        // Open VoiceRecorderStudio, finish recording -> empty transcript -> click fallback Save Audio
        fireEvent.click(screen.getByTestId('studio-more-menu-btn'));
        fireEvent.click(await screen.findByTestId('studio-dictate-btn'));
        const finishBtn = await screen.findByTestId('voice-finish-btn');
        await waitFor(() => {
          expect((finishBtn as HTMLButtonElement).disabled).toBe(false);
        });
        await act(async () => {
          fireEvent.click(finishBtn);
        });

        const saveAudioBtn = await screen.findByText(/Сохранить аудио/i);
        await act(async () => {
          fireEvent.click(saveAudioBtn);
          await new Promise((r) => setTimeout(r, 20));
        });

        expect(api.capture).toHaveBeenCalledTimes(1);
        const captureArg = (api.capture as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
          text?: string;
        };
        expect(captureArg.text).toContain('Typed fallback prefix');

        // Switch Draft -> Note B while capture() is still pending
        rerender(
          <NoteStudio
            item={noteB}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={onItemUpdated}
            onDraftPersisted={onDraftPersisted}
            onDelete={vi.fn()}
          />
        );

        await act(async () => {
          captureDeferred.resolve(
            makeVaultItem({
              id: 'created-fallback-draft-1',
              dna: 'voice',
              title: 'Аудиозапись',
              body: 'Typed fallback prefix',
            })
          );
          await new Promise((r) => setTimeout(r, 60));
        });

        expect(api.capture).toHaveBeenCalledTimes(1);
        expect(onDraftPersisted).not.toHaveBeenCalled();
        expect(onItemUpdated).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'created-fallback-draft-1' })
        );
        expect(api.updateItem).not.toHaveBeenCalledWith('note-b-fallback', expect.anything());
        expect(api.updateItem).not.toHaveBeenCalledWith('created-fallback-draft-1', expect.anything());
      } finally {
        delete (window as unknown as { __KAPSULA_SYNTH_MIC__?: boolean }).__KAPSULA_SYNTH_MIC__;
      }
    });

    it('Probe 1b: keeps NotesHubView on truncated Note B when Draft unmounts during pending capture()', async () => {
      const noteBTruncated = makeVaultItem({
        id: 'note-b-trunc',
        dna: 'note',
        title: 'Заметка Б (длинная)',
        body: 'Усечённый Б...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
        updatedAt: 1_700_000_001_000,
      });
      const noteBFull = makeVaultItem({
        ...noteBTruncated,
        body: 'Полный текст Заметки Б после гидратации',
        isCardProjection: false,
        isBodyTruncated: false,
      });

      const captureDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateBDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) =>
          id === 'note-b-trunc' ? hydrateBDeferred.promise : Promise.resolve(null)
        ),
        capture: vi.fn(() => captureDeferred.promise),
      });

      const Host: React.FC = () => {
        const [items, setItems] = React.useState([noteBTruncated]);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) =>
                prev.some((it) => it.id === u.id)
                  ? prev.map((it) => (it.id === u.id ? u : it))
                  : [u, ...prev]
              )
            }
            onDraftPersisted={(created) =>
              setItems((prev) =>
                prev.some((it) => it.id === created.id)
                  ? prev.map((it) => (it.id === created.id ? created : it))
                  : [created, ...prev]
              )
            }
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host />);

      // Start new draft, type text, blur, then switch to truncated Note B (unmounting NoteStudio)
      await act(async () => {
        fireEvent.click(await screen.findByTestId('notes-new-btn'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor')).toBeTruthy();
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'DRAFTDEDUP991';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(screen.getByTestId('note-studio-editor'));

      await waitFor(() => {
        expect(api.capture).toHaveBeenCalledTimes(1);
      });

      // Switch to truncated Note B while capture() is still pending -> NoteStudio unmounts
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-note-b-trunc'));
      });

      // Resolve capture() first, then Note B hydration
      await act(async () => {
        captureDeferred.resolve(
          makeVaultItem({
            id: 'promoted-draft-1b',
            dna: 'note',
            title: 'DRAFTDEDUP991',
            body: 'DRAFTDEDUP991',
            mediaMeta: { inNotesHub: true },
          })
        );
        await new Promise((r) => setTimeout(r, 30));
      });

      await act(async () => {
        hydrateBDeferred.resolve(noteBFull);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(api.capture).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain(
          'Полный текст Заметки Б после гидратации'
        );
      });
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('DRAFTDEDUP991');
      expect(screen.getByTestId('notes-list-item-promoted-draft-1b')).toBeTruthy();
    });

    it('4d: surfaces error status and retries A2 via Ctrl+S when updateItem(A2) rejects while A is remounted after A -> B (truncated) -> A', async () => {
      const noteA = makeVaultItem({
        id: 'rej-note-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный текст A1',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_002_000,
      });
      const noteBTruncated = makeVaultItem({
        id: 'rej-note-b',
        dna: 'note',
        title: 'Заметка Б',
        body: 'Усечённый Б...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
        updatedAt: 1_700_000_001_000,
      });
      const noteBFull = makeVaultItem({
        ...noteBTruncated,
        body: 'Полный текст Б',
        isCardProjection: false,
        isBodyTruncated: false,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateBDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let noteAUpdateCalls = 0;

      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) =>
          id === 'rej-note-b' ? hydrateBDeferred.promise : Promise.resolve(noteA)
        ),
        updateItem: vi.fn((id, patch) => {
          if (id === 'rej-note-a') {
            noteAUpdateCalls += 1;
            if (noteAUpdateCalls === 1) {
              return updateADeferred.promise;
            }
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA,
              id,
              title: p.title ?? noteA.title,
              body: p.body ?? noteA.body,
              updatedAt: 1_700_000_010_000 + noteAUpdateCalls,
            })
          );
        }),
      });

      const Host: React.FC = () => {
        const [items, setItems] = React.useState([noteA, noteBTruncated]);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный текст A1');
      });
      await new Promise((r) => setTimeout(r, 30));

      // Edit Note A -> A2
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка A2 перед ошибкой';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Switch to truncated Note B -> NoteStudio unmounts and triggers updateItem('rej-note-a') #1
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-rej-note-b'));
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
        expect(api.updateItem).toHaveBeenCalledWith(
          'rej-note-a',
          expect.objectContaining({ body: expect.stringContaining('Правка A2 перед ошибкой') })
        );
      });

      // Immediately switch back to Note A while updateADeferred & hydrateBDeferred are still pending
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-rej-note-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка A2 перед ошибкой');
      });

      // Reject updateItem(A2) while Note A is remounted, and resolve stale Note B hydration
      await act(async () => {
        updateADeferred.reject(new Error('Network error'));
        hydrateBDeferred.resolve(noteBFull);
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(screen.getByText('· Не сохранено')).toBeTruthy();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка A2 перед ошибкой');

      // Ctrl+S must retry updateItem('rej-note-a') with A2 and resolve cleanly to saved state
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
      });

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(2);
      });
      expect((api.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'rej-note-a',
        expect.objectContaining({ body: expect.stringContaining('Правка A2 перед ошибкой') }),
      ]);
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка A2 перед ошибкой');
    });

    it('4e: preserves same-instance A -> C (full, non-truncated) -> A edits, surfaces error on rejection, and retries via Ctrl+S and concurrent A3', async () => {
      // Subcase 1: A -> C (full) -> A with updateItem(A2) rejecting, then Ctrl+S retry
      const noteA = makeVaultItem({
        id: 'same-inst-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный A1',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_002_000,
      });
      const noteC = makeVaultItem({
        id: 'same-inst-c',
        dna: 'note',
        title: 'Заметка С',
        body: 'Полный текст С',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_001_000,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let noteACalls = 0;

      const { api } = installMockKapsulaApi({
        updateItem: vi.fn((id, patch) => {
          if (id === 'same-inst-a') {
            noteACalls += 1;
            if (noteACalls === 1) {
              return updateADeferred.promise;
            }
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA,
              id,
              title: p.title ?? noteA.title,
              body: p.body ?? noteA.body,
              updatedAt: 1_700_000_010_000 + noteACalls,
            })
          );
        }),
      });

      const Host: React.FC<{ initialItems: ReturnType<typeof makeVaultItem>[] }> = ({ initialItems }) => {
        const [items, setItems] = React.useState(initialItems);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host initialItems={[noteA, noteC]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка SameInst A2';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Switch A -> C (full, non-truncated: NoteStudio stays mounted on same instance)
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-same-inst-c'));
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Полный текст С');
      });

      // Immediately switch back C -> A while updateItem(A2) is still pending
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-same-inst-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка SameInst A2');
      });
      expect(screen.getByTestId('note-studio-editor').textContent).not.toContain('Исходный A1');

      // Reject Call 1 -> '· Не сохранено' appears and 'Правка SameInst A2' remains in editor
      await act(async () => {
        updateADeferred.reject(new Error('Network error'));
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(screen.getByText('· Не сохранено')).toBeTruthy();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка SameInst A2');
      expect(api.updateItem).toHaveBeenCalledTimes(1);

      // Ctrl+S retries updateItem('same-inst-a') with A2 and clears error
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
      });

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(2);
      });
      expect((api.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'same-inst-a',
        expect.objectContaining({ body: expect.stringContaining('Правка SameInst A2') }),
      ]);
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка SameInst A2');

      // Subcase 2: Concurrent A3 typed in session 3 before Call 1 rejects -> preserves A3 and saves A3
      cleanup();
      const noteA2 = makeVaultItem({
        ...noteA,
        id: 'same-inst-a3',
        body: 'Исходный A1',
      });
      const noteC2 = makeVaultItem({
        ...noteC,
        id: 'same-inst-c3',
        body: 'Полный текст С',
      });
      const updateA2Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let a2Calls = 0;
      const { api: api2 } = installMockKapsulaApi({
        updateItem: vi.fn((id, patch) => {
          if (id === 'same-inst-a3') {
            a2Calls += 1;
            if (a2Calls === 1) return updateA2Deferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA2,
              id,
              title: p.title ?? noteA2.title,
              body: p.body ?? noteA2.body,
              updatedAt: 1_700_000_020_000 + a2Calls,
            })
          );
        }),
      });

      renderWithI18n(<Host initialItems={[noteA2, noteC2]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });
      await new Promise((r) => setTimeout(r, 30));

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка SameInst A2';
        await new Promise((r) => setTimeout(r, 25));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-same-inst-c3'));
      });
      await waitFor(() => {
        expect(api2.updateItem).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-same-inst-a3'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка SameInst A2');
      });

      // Type A3 while Call 1 is still pending
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка SameInst A3 живая';
        await new Promise((r) => setTimeout(r, 25));
      });

      await act(async () => {
        updateA2Deferred.reject(new Error('Network error'));
        await new Promise((r) => setTimeout(r, 500));
      });

      await waitFor(() => {
        expect(api2.updateItem).toHaveBeenCalledTimes(2);
      });
      expect((api2.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'same-inst-a3',
        expect.objectContaining({ body: expect.stringContaining('Правка SameInst A3 живая') }),
      ]);
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка SameInst A3 живая');
    });

    it('4d-blur: prevents dead unmounted NoteStudio from firing rogue retry after onBlur + unmount across A -> B (truncated) -> A', async () => {
      // Subcase 1: onBlur fires Call 1 -> click truncated Note B (unmount) -> click Note A (remount) -> reject Call 1 -> only 1 call before Ctrl+S
      const noteA = makeVaultItem({
        id: 'blur-note-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный A1',
        mediaMeta: { inNotesHub: true },
        updatedAt: 1_700_000_002_000,
      });
      const noteBTruncated = makeVaultItem({
        id: 'blur-note-b',
        dna: 'note',
        title: 'Заметка Б',
        body: 'Усечённый Б...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
        updatedAt: 1_700_000_001_000,
      });
      const noteBFull = makeVaultItem({
        ...noteBTruncated,
        body: 'Полный текст Б',
        isCardProjection: false,
        isBodyTruncated: false,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateBDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let callsA = 0;

      const { api } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) =>
          id === 'blur-note-b' ? hydrateBDeferred.promise : Promise.resolve(noteA)
        ),
        updateItem: vi.fn((id, patch) => {
          if (id === 'blur-note-a') {
            callsA += 1;
            if (callsA === 1) return updateADeferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA,
              id,
              title: p.title ?? noteA.title,
              body: p.body ?? noteA.body,
              updatedAt: 1_700_000_010_000 + callsA,
            })
          );
        }),
      });

      const Host: React.FC<{ initialItems: ReturnType<typeof makeVaultItem>[] }> = ({ initialItems }) => {
        const [items, setItems] = React.useState(initialItems);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host initialItems={[noteA, noteBTruncated]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });
      await new Promise((r) => setTimeout(r, 30));

      const editorEl = screen.getByTestId('note-studio-editor');
      await act(async () => {
        fireEvent.focus(editorEl);
        const p = editorEl.querySelector('p');
        if (p) p.textContent = 'Правка BlurMount A2';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Real mouse navigation: blur fires Call 1, then click Note B unmounts instance #1
      fireEvent.blur(editorEl);
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-blur-note-b'));
      });
      expect(screen.queryByTestId('note-studio')).toBeNull();

      // Remount Note A (instance #2) while Call 1 & hydrate(B) are still pending
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-blur-note-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка BlurMount A2');
      });

      // Reject Call 1 -> dead instance #1 MUST NOT fire a rogue Call 2
      await act(async () => {
        updateADeferred.reject(new Error('E2E_SIMULATED_UPDATE_ERROR'));
        hydrateBDeferred.resolve(noteBFull);
        await new Promise((r) => setTimeout(r, 80));
      });

      expect(api.updateItem).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.getByText('· Не сохранено')).toBeTruthy();
      });

      // Ctrl+S triggers Call 2 (total 2 calls) and clears '· Не сохранено'
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });

      // Subcase 2: A3FRESH typed in remounted instance #2 before Call 1 rejects -> NO rogue A2 call; Call 2 saves A3FRESH
      cleanup();
      const noteA2 = makeVaultItem({
        ...noteA,
        id: 'blur-fresh-a',
        body: 'Исходный A1',
      });
      const noteB2 = makeVaultItem({
        ...noteBTruncated,
        id: 'blur-fresh-b',
      });
      const updateA2Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateB2Deferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let freshCallsA = 0;

      const { api: api2 } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) =>
          id === 'blur-fresh-b' ? hydrateB2Deferred.promise : Promise.resolve(noteA2)
        ),
        updateItem: vi.fn((id, patch) => {
          if (id === 'blur-fresh-a') {
            freshCallsA += 1;
            if (freshCallsA === 1) return updateA2Deferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA2,
              id,
              title: p.title ?? noteA2.title,
              body: p.body ?? noteA2.body,
              updatedAt: 1_700_000_020_000 + freshCallsA,
            })
          );
        }),
      });

      renderWithI18n(<Host initialItems={[noteA2, noteB2]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });
      await new Promise((r) => setTimeout(r, 30));

      const ed2 = screen.getByTestId('note-studio-editor');
      await act(async () => {
        fireEvent.focus(ed2);
        const p = ed2.querySelector('p');
        if (p) p.textContent = 'A2STALE';
        await new Promise((r) => setTimeout(r, 25));
      });
      fireEvent.blur(ed2);
      await waitFor(() => {
        expect(api2.updateItem).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-blur-fresh-b'));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-blur-fresh-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('A2STALE');
      });

      // Type A3FRESH in remounted instance #2 and press Ctrl+S while Call 1 is still pending
      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'A3FRESH';
        await new Promise((r) => setTimeout(r, 25));
      });
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
      });

      // Reject Call 1 -> dead instance #1 MUST NOT fire rogue A2STALE write; Call 2 must save A3FRESH
      await act(async () => {
        updateA2Deferred.reject(new Error('E2E_SIMULATED_UPDATE_ERROR'));
        hydrateB2Deferred.resolve({ ...noteBFull, id: 'blur-fresh-b' });
        await new Promise((r) => setTimeout(r, 80));
      });

      await waitFor(() => {
        expect(api2.updateItem).toHaveBeenCalledTimes(2);
      });
      const mockCalls2 = (api2.updateItem as ReturnType<typeof vi.fn>).mock.calls;
      expect(mockCalls2[0]?.[1]).toEqual(
        expect.objectContaining({ body: expect.stringContaining('A2STALE') })
      );
      expect(mockCalls2[1]?.[1]).toEqual(
        expect.objectContaining({ body: expect.stringContaining('A3FRESH') })
      );
      expect(mockCalls2.length).toBe(2);
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('A3FRESH');
    });

    it('4e-6c: awaits foreign pendingSave on modal close and NotesHubView switch-away so rejection retries without losing A2', async () => {
      // Subcase 1: Modal NoteStudio A -> C (full, non-truncated) -> A while Call 1 pending -> click close before Call 1 rejects
      const noteA = makeVaultItem({
        id: 'modal-4e6c-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный A1',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_002_000,
      });
      const noteC = makeVaultItem({
        id: 'modal-4e6c-c',
        dna: 'note',
        title: 'Заметка С',
        body: 'Полный текст С',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_001_000,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let modalCallsA = 0;

      const { api } = installMockKapsulaApi({
        updateItem: vi.fn((id, patch) => {
          if (id === 'modal-4e6c-a') {
            modalCallsA += 1;
            if (modalCallsA === 1) return updateADeferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA,
              id,
              title: p.title ?? noteA.title,
              body: p.body ?? noteA.body,
              updatedAt: 1_700_000_010_000 + modalCallsA,
            })
          );
        }),
      });

      const onCloseMock = vi.fn();
      const { rerender } = renderWithI18n(
        <NoteStudio
          item={noteA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          presentation="modal"
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={onCloseMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка 4e6c A2';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Switch modal A -> C (triggers Call 1 deferred)
      rerender(
        <NoteStudio
          item={noteC}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          presentation="modal"
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={onCloseMock}
        />
      );

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Полный текст С');
      });

      // Switch modal back C -> A while Call 1 is still pending
      rerender(
        <NoteStudio
          item={noteA}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          presentation="modal"
          onItemUpdated={vi.fn()}
          onDelete={vi.fn()}
          onClose={onCloseMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка 4e6c A2');
      });

      // Click close BEFORE Call 1 rejects -> must NOT close prematurely
      await act(async () => {
        fireEvent.click(screen.getByTestId('note-studio-close'));
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(onCloseMock).not.toHaveBeenCalled();

      // Reject Call 1 -> flushDraft awaits & retries A2 (2 calls total), then closes cleanly
      await act(async () => {
        updateADeferred.reject(new Error('Network error'));
        await new Promise((r) => setTimeout(r, 40));
      });

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(2);
        expect(onCloseMock).toHaveBeenCalledTimes(1);
      });
      expect((api.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'modal-4e6c-a',
        expect.objectContaining({ body: expect.stringContaining('Правка 4e6c A2') }),
      ]);

      // Subcase 2: NotesHubView A -> C (full) -> A -> click truncated B while Call 1 pending -> reject Call 1 -> cleanup retries A2
      cleanup();
      const hubA = makeVaultItem({
        id: 'hub-4e6c-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный A1',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_003_000,
      });
      const hubC = makeVaultItem({
        id: 'hub-4e6c-c',
        dna: 'note',
        title: 'Заметка С',
        body: 'Полный текст С',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_002_000,
      });
      const hubBTruncated = makeVaultItem({
        id: 'hub-4e6c-b',
        dna: 'note',
        title: 'Заметка Б',
        body: 'Усечённый Б...',
        mediaMeta: { inNotesHub: true },
        isCardProjection: true,
        isBodyTruncated: true,
        updatedAt: 1_700_000_001_000,
      });
      const hubBFull = makeVaultItem({
        ...hubBTruncated,
        body: 'Полный текст Б',
        isCardProjection: false,
        isBodyTruncated: false,
      });

      const updateHubADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const hydrateHubBDeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      let hubCallsA = 0;

      const { api: hubApi } = installMockKapsulaApi({
        getVaultItem: vi.fn((id) =>
          id === 'hub-4e6c-b' ? hydrateHubBDeferred.promise : Promise.resolve(hubA)
        ),
        updateItem: vi.fn((id, patch) => {
          if (id === 'hub-4e6c-a') {
            hubCallsA += 1;
            if (hubCallsA === 1) return updateHubADeferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...hubA,
              id,
              title: p.title ?? hubA.title,
              body: p.body ?? hubA.body,
              updatedAt: 1_700_000_020_000 + hubCallsA,
            })
          );
        }),
      });

      const HubHost: React.FC<{ initialItems: ReturnType<typeof makeVaultItem>[] }> = ({ initialItems }) => {
        const [items, setItems] = React.useState(initialItems);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<HubHost initialItems={[hubA, hubC, hubBTruncated]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка Hub 4e6c A2';
        await new Promise((r) => setTimeout(r, 25));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-hub-4e6c-c'));
      });
      await waitFor(() => {
        expect(hubApi.updateItem).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-hub-4e6c-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка Hub 4e6c A2');
      });

      // Switch to truncated B while Call 1 is pending (unmounts NoteStudio)
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-hub-4e6c-b'));
      });
      expect(screen.queryByTestId('note-studio')).toBeNull();

      // Reject Call 1 & resolve B hydration -> cleanup flush retries A2 cleanly
      await act(async () => {
        updateHubADeferred.reject(new Error('Network error'));
        hydrateHubBDeferred.resolve(hubBFull);
        await new Promise((r) => setTimeout(r, 40));
      });

      await waitFor(() => {
        expect(hubApi.updateItem).toHaveBeenCalledTimes(2);
      });
      expect((hubApi.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'hub-4e6c-a',
        expect.objectContaining({ body: expect.stringContaining('Правка Hub 4e6c A2') }),
      ]);
    });

    it('4e-5c: clears save error badge and dirtyRef when Beautify succeeds after awaited foreign pendingSave rejects', async () => {
      const noteA = makeVaultItem({
        id: 'beautify-4e5c-a',
        dna: 'note',
        title: 'Заметка А',
        body: 'Исходный A1',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_002_000,
      });
      const noteC = makeVaultItem({
        id: 'beautify-4e5c-c',
        dna: 'note',
        title: 'Заметка С',
        body: 'Полный текст С',
        mediaMeta: { inNotesHub: true },
        isCardProjection: false,
        updatedAt: 1_700_000_001_000,
      });

      const updateADeferred = createDeferred<ReturnType<typeof makeVaultItem>>();
      const transformDeferred = createDeferred<{
        changed: boolean;
        formattedText: string;
        extractedTasks: string[];
        usedCloud: boolean;
      }>();
      let callsA = 0;

      const { api } = installMockKapsulaApi({
        transformText: vi.fn(() => transformDeferred.promise),
        updateItem: vi.fn((id, patch) => {
          if (id === 'beautify-4e5c-a') {
            callsA += 1;
            if (callsA === 1) return updateADeferred.promise;
          }
          const p = patch as { title?: string; body?: string };
          return Promise.resolve(
            makeVaultItem({
              ...noteA,
              id,
              title: p.title ?? noteA.title,
              body: p.body ?? noteA.body,
              updatedAt: 1_700_000_010_000 + callsA,
            })
          );
        }),
      });

      const Host: React.FC<{ initialItems: ReturnType<typeof makeVaultItem>[] }> = ({ initialItems }) => {
        const [items, setItems] = React.useState(initialItems);
        return (
          <NotesHubView
            items={items}
            orbits={[]}
            focusBoards={[]}
            globalSearchQuery=""
            serverSearchIds={null}
            soundEnabled={false}
            onItemUpdated={(u) =>
              setItems((prev) => prev.map((it) => (it.id === u.id ? u : it)))
            }
            onDraftPersisted={vi.fn()}
            onDeleteItem={vi.fn()}
            onTogglePin={vi.fn()}
            onMoveToOrbit={vi.fn()}
            onMoveToBoard={vi.fn()}
            onDuplicateItem={vi.fn()}
            onExportMarkdown={vi.fn()}
            onOpenExternalItem={vi.fn()}
            onOpenShotLightbox={vi.fn()}
          />
        );
      };

      renderWithI18n(<Host initialItems={[noteA, noteC]} />);
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Исходный A1');
      });

      await act(async () => {
        const p = screen.getByTestId('note-studio-editor').querySelector('p');
        if (p) p.textContent = 'Правка 4e5c A2';
        await new Promise((r) => setTimeout(r, 25));
      });

      // Switch A -> C (Call 1 deferred) -> A
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-beautify-4e5c-c'));
      });
      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-beautify-4e5c-a'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('note-studio-editor').textContent).toContain('Правка 4e5c A2');
      });

      // Click Beautify -> transformText resolves -> handleBeautify awaits Call 1
      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-ai-menu-btn'));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('studio-beautify-btn'));
        transformDeferred.resolve({
          changed: true,
          formattedText: 'Красивый текст 4e5c',
          extractedTasks: [],
          usedCloud: false,
        });
        await new Promise((r) => setTimeout(r, 30));
      });

      // Reject Call 1 while handleBeautify awaits foreign save -> handleBeautify Call 2 succeeds
      await act(async () => {
        updateADeferred.reject(new Error('Network error'));
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(api.updateItem).toHaveBeenCalledTimes(2);
      });
      expect((api.updateItem as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
        'beautify-4e5c-a',
        expect.objectContaining({ body: expect.stringContaining('Красивый текст 4e5c') }),
      ]);
      await waitFor(() => {
        expect(screen.queryByText('· Не сохранено')).toBeNull();
      });
      expect(screen.getByTestId('note-studio-editor').textContent).toContain('Красивый текст 4e5c');

      // Switching away must NOT trigger an extra dirty write because dirtyRef was cleared
      await act(async () => {
        fireEvent.click(screen.getByTestId('notes-list-item-beautify-4e5c-c'));
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(api.updateItem).toHaveBeenCalledTimes(2);
    });
  });
});
