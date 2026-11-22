// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { NoteStudio } from '@renderer/components/studio/NoteStudio';
import { CommandHudSurface } from '@renderer/surfaces/CommandHudSurface';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeFocusBoard,
  makeOrbit,
  makeSettingsState,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Wave 0 UI Safety: NoteStudio & CommandHudSurface', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('NoteStudio', () => {
    it('edits note title and persists via updateItem when flushed on close', async () => {
      const note = makeVaultItem({
        id: 'note-happy',
        title: 'Старый заголовок',
        body: 'Исходный текст заметки',
      });
      const updatedNote = makeVaultItem({
        id: 'note-happy',
        title: 'Новый заголовок',
        body: 'Исходный текст заметки',
      });

      const { api } = installMockKapsulaApi({
        updateItem: vi.fn(async () => updatedNote),
      });
      const onItemUpdated = vi.fn();
      const onClose = vi.fn();
      let registeredClose: (() => Promise<void>) | null = null;

      renderWithI18n(
        <NoteStudio
          item={note}
          orbits={[makeOrbit()]}
          focusBoards={[makeFocusBoard()]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={onItemUpdated}
          onDelete={vi.fn()}
          onRegisterClose={(fn) => {
            registeredClose = fn;
          }}
          onClose={onClose}
        />
      );

      const titleInput = screen.getByTestId('note-studio-title') as HTMLTextAreaElement;
      expect(titleInput.value).toBe('Старый заголовок');

      fireEvent.change(titleInput, { target: { value: 'Новый заголовок' } });
      expect(registeredClose).not.toBeNull();

      await act(async () => {
        await registeredClose!();
      });

      expect(api.updateItem).toHaveBeenCalledWith(
        'note-happy',
        expect.objectContaining({ title: 'Новый заголовок' })
      );
      expect(onItemUpdated).toHaveBeenCalledWith(updatedNote);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('cancels untitled empty draft without calling capture or delete', async () => {
      const draft = makeVaultItem({
        id: '__draft__',
        title: '',
        body: '',
      });
      const { api } = installMockKapsulaApi();
      const onCancelDraft = vi.fn();
      const onDelete = vi.fn();
      const onClose = vi.fn();
      let registeredClose: (() => Promise<void>) | null = null;

      renderWithI18n(
        <NoteStudio
          item={draft}
          isDraft={true}
          orbits={[makeOrbit()]}
          focusBoards={[]}
          availableTags={[]}
          soundEnabled={false}
          onItemUpdated={vi.fn()}
          onCancelDraft={onCancelDraft}
          onDelete={onDelete}
          onRegisterClose={(fn) => {
            registeredClose = fn;
          }}
          onClose={onClose}
        />
      );

      expect(registeredClose).not.toBeNull();
      await act(async () => {
        await registeredClose!();
      });

      expect(api.capture).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
      expect(onCancelDraft).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it(
      '[Wave 2: BUG-01] keeps dirty state and retries save on next flush when updateItem fails instead of silently marking saved',
      async () => {
        const note = makeVaultItem({
          id: 'note-fail-save',
          title: 'Исходная заметка',
          body: 'Содержимое заметки',
        });

        const updateMock = vi
          .fn()
          .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
          .mockResolvedValueOnce(
            makeVaultItem({
              id: 'note-fail-save',
              title: 'Непотерянная правка',
              body: 'Содержимое заметки',
            })
          );

        installMockKapsulaApi({
          updateItem: updateMock,
        });

        let registeredClose: (() => Promise<void>) | null = null;
        renderWithI18n(
          <NoteStudio
            item={note}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onRegisterClose={(fn) => {
              registeredClose = fn;
            }}
            onClose={vi.fn()}
          />
        );

        const titleInput = screen.getByTestId('note-studio-title') as HTMLTextAreaElement;
        fireEvent.change(titleInput, { target: { value: 'Непотерянная правка' } });
        expect(registeredClose).not.toBeNull();

        // First flush fails
        await act(async () => {
          await registeredClose!().catch(() => {});
        });
        expect(updateMock).toHaveBeenCalledTimes(1);

        // Retry flush after transient failure must still send the unsaved dirty edit
        await act(async () => {
          await registeredClose!().catch(() => {});
        });
        expect(updateMock).toHaveBeenCalledTimes(2);
      }
    );

    it(
      '[Wave 2: BUG-01] does not overwrite user edits with stale background item update while updateItem is still in-flight',
      async () => {
        const initial = makeVaultItem({
          id: 'note-inflight',
          title: 'Версия 1',
          body: 'Текст 1',
          updatedAt: 1000,
        });
        const deferredSave = createDeferred<ReturnType<typeof makeVaultItem>>();

        const { api } = installMockKapsulaApi({
          updateItem: vi.fn(() => deferredSave.promise),
        });

        let registeredClose: (() => Promise<void>) | null = null;
        const { rerender } = renderWithI18n(
          <NoteStudio
            item={initial}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onRegisterClose={(fn) => {
              registeredClose = fn;
            }}
            onClose={vi.fn()}
          />
        );

        const titleInput = screen.getByTestId('note-studio-title') as HTMLTextAreaElement;
        fireEvent.change(titleInput, { target: { value: 'Текущий ввод пользователя' } });

        // Kick off in-flight save without resolving yet
        let flushPromise!: Promise<void>;
        act(() => {
          flushPromise = registeredClose!();
        });
        expect(api.updateItem).toHaveBeenCalledTimes(1);

        // Simulate stale background sync update arriving while updateItem is in-flight
        const staleSyncItem = makeVaultItem({
          id: 'note-inflight',
          title: 'Старый заголовок из фона',
          body: 'Текст 1',
          updatedAt: 2000,
        });
        rerender(
          <NoteStudio
            item={staleSyncItem}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={vi.fn()}
            onRegisterClose={(fn) => {
              registeredClose = fn;
            }}
            onClose={vi.fn()}
          />
        );

        expect((screen.getByTestId('note-studio-title') as HTMLTextAreaElement).value).toBe(
          'Текущий ввод пользователя'
        );

        deferredSave.resolve(
          makeVaultItem({
            id: 'note-inflight',
            title: 'Текущий ввод пользователя',
            body: 'Текст 1',
          })
        );
        await act(async () => {
          await flushPromise;
        });
      }
    );

    it(
      '[Wave 2: BUG-01] preserves empty-body note on close when it has tags or reminder metadata',
      async () => {
        const taggedEmpty = makeVaultItem({
          id: 'note-tagged-empty',
          title: 'Новая заметка',
          body: '',
          tags: ['важное'],
          remindAt: Date.now() + 3_600_000,
        });
        installMockKapsulaApi();
        const onDelete = vi.fn();
        const onClose = vi.fn();

        renderWithI18n(
          <NoteStudio
            item={taggedEmpty}
            isDraft={false}
            orbits={[makeOrbit()]}
            focusBoards={[]}
            availableTags={[]}
            soundEnabled={false}
            onItemUpdated={vi.fn()}
            onDelete={onDelete}
            onClose={onClose}
          />
        );

        const closeBtn = screen.getByTestId('note-studio-close');
        await act(async () => {
          fireEvent.click(closeBtn);
          await Promise.resolve();
        });

        expect(onDelete).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('CommandHudSurface', () => {
    it('loads initial items and switches cleanly across HUD tabs', async () => {
      const settings = makeSettingsState();
      const note = makeVaultItem({ id: 'hud-1', title: 'Заметка для HUD', body: 'Текст' });
      const { api } = installMockKapsulaApi({
        queryVault: vi.fn(async () => [note]),
      });

      renderWithI18n(<CommandHudSurface settings={settings} onSettingsUpdated={vi.fn()} />);

      await waitFor(() => {
        expect(api.queryVault).toHaveBeenCalled();
        expect(screen.getAllByText('Заметка для HUD').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Записать' }));
      expect(await screen.findByTestId('hud-capture-input')).toBeTruthy();

      fireEvent.click(screen.getByRole('tab', { name: 'Сейф' }));
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Сейф' }).getAttribute('aria-selected')).toBe('true');
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Сегодня' }));
      expect(await screen.findByPlaceholderText(/быстрая задача/i)).toBeTruthy();

      fireEvent.click(screen.getByRole('tab', { name: 'Важное' }));
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Важное' }).getAttribute('aria-selected')).toBe('true');
      });
    });

    it(
      '[Wave 2: BUG-03] ignores out-of-order stale loadHudData responses so newer search results are not overwritten',
      async () => {
        const settings = makeSettingsState();
        const slowSearch = createDeferred<ReturnType<typeof makeVaultItem>[]>();
        const freshResult = [makeVaultItem({ id: 'fresh-1', title: 'Свежий результат' })];
        const staleResult = [makeVaultItem({ id: 'stale-1', title: 'Устаревший результат' })];

        const queryMock = vi.fn(async (q?: { search?: string }) => {
          if (q?.search === 'slow') return slowSearch.promise;
          if (q?.search === 'fresh') return freshResult;
          return [];
        });

        installMockKapsulaApi({ queryVault: queryMock });

        renderWithI18n(<CommandHudSurface settings={settings} onSettingsUpdated={vi.fn()} />);

        await waitFor(() => {
          expect(queryMock).toHaveBeenCalled();
        });

        // 1. Trigger slower earlier search ("slow")
        const searchInput = screen.getByTestId('hud-search-input');
        fireEvent.change(searchInput, { target: { value: 'slow' } });
        await waitFor(() => {
          expect(
            queryMock.mock.calls.some((call) => call[0]?.search === 'slow')
          ).toBe(true);
        });

        // 2. User immediately types newer search ("fresh"), which resolves fast
        fireEvent.change(searchInput, { target: { value: 'fresh' } });

        await waitFor(() => {
          expect(screen.queryAllByText('Свежий результат').length).toBeGreaterThan(0);
        });

        // 3. Older "slow" request settles late and must NOT clobber "fresh" results
        await act(async () => {
          slowSearch.resolve(staleResult);
          await Promise.resolve();
        });

        expect(screen.queryAllByText('Свежий результат').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Устаревший результат')).toHaveLength(0);
      }
    );

    it(
      '[Wave 2: BUG-03] preserves dirtyItemIdRef and avoids marking saved when HUD editor updateItem fails',
      async () => {
        const settings = makeSettingsState();
        const item = makeVaultItem({ id: 'hud-save-fail', title: 'Исходный HUD' });
        const updateMock = vi
          .fn()
          .mockRejectedValueOnce(new Error('IPC save failed'))
          .mockResolvedValueOnce(makeVaultItem({ id: 'hud-save-fail', title: 'Правка HUD' }));

        installMockKapsulaApi({
          queryVault: vi.fn(async () => [item]),
          updateItem: updateMock,
        });

        renderWithI18n(<CommandHudSurface settings={settings} onSettingsUpdated={vi.fn()} />);

        const titleInput = (await screen.findByTestId('hud-editor-title')) as HTMLTextAreaElement;
        expect(titleInput.value).toBe('Исходный HUD');

        fireEvent.change(titleInput, { target: { value: 'Правка HUD' } });

        // Trigger immediate flush via window blur
        await act(async () => {
          fireEvent.blur(window);
          await Promise.resolve();
        });

        await waitFor(() => {
          expect(updateMock).toHaveBeenCalledTimes(1);
        });

        // Must NOT falsely show "Сохранено" and must retry on next flush
        const statusText = screen.getByTestId('hud-editor-save-state').textContent || '';
        expect(statusText).not.toBe('Сохранено');

        await act(async () => {
          fireEvent.blur(window);
          await Promise.resolve();
        });
        expect(updateMock).toHaveBeenCalledTimes(2);
      }
    );

    it(
      '[Wave 2: BUG-03] does not truncate HUD queryVault requests at limit: 120',
      async () => {
        const settings = makeSettingsState();
        const { api } = installMockKapsulaApi({
          queryVault: vi.fn(async () => []),
        });

        renderWithI18n(<CommandHudSurface settings={settings} onSettingsUpdated={vi.fn()} />);

        await waitFor(() => {
          expect(api.queryVault).toHaveBeenCalled();
        });

        const firstQueryArg = (api.queryVault as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
          | { limit?: number }
          | undefined;
        expect(firstQueryArg?.limit === undefined || firstQueryArg.limit > 120).toBe(true);
      }
    );
  });
});
