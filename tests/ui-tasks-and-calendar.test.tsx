// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { TasksHubView } from '@renderer/components/studio/TasksHubView';
import { CalendarEventSheet } from '@renderer/components/studio/CalendarEventSheet';
import { CalendarHubView } from '@renderer/components/studio/CalendarHubView';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeCalendarEvent,
  makeOrbit,
  makeTaskEntry,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Wave 0 UI Safety: TasksHubView, CalendarEventSheet & CalendarHubView', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('TasksHubView', () => {
    it('renders tasks in list and board modes, toggles checkboxes, and submits quick tasks', async () => {
      installMockKapsulaApi({
        listTaskBoardColumns: vi.fn(async () => [
          { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
          { id: 'in_progress', title: 'В работе', color: '#E86A33', order: 1 },
          { id: 'done', title: 'Готово', color: '#2EA06B', order: 2, isDone: true },
        ]),
      });

      const task = makeTaskEntry({
        id: 't-1',
        itemId: 'note-1',
        text: 'Проверить бэкап',
        columnId: 'inbox',
      });
      const onToggleTask = vi.fn(async () => {});
      const onAddQuickTask = vi.fn(async () => {});

      renderWithI18n(
        <TasksHubView
          tasks={[task]}
          orbits={[makeOrbit()]}
          viewMode="list"
          onToggleTask={onToggleTask}
          onOpenItem={vi.fn()}
          onAddQuickTask={onAddQuickTask}
        />
      );

      expect(screen.getByText('Проверить бэкап')).toBeTruthy();

      // Toggle task checkbox
      fireEvent.click(screen.getByTestId('task-toggle-t-1'));
      await waitFor(() => {
        expect(onToggleTask).toHaveBeenCalledTimes(1);
      });

      // Add quick task
      const quickInput = screen.getByTestId('quick-task-input') as HTMLInputElement;
      fireEvent.change(quickInput, { target: { value: 'Новая быстрая задача' } });
      fireEvent.submit(quickInput.closest('form')!);

      await waitFor(() => {
        expect(onAddQuickTask).toHaveBeenCalledWith('Новая быстрая задача', 'inbox');
      });
    });

    it(
      '[Wave 2: BUG-08] rolls back optimistic renamed task text when updateVaultTaskText rejects',
      async () => {
        const updateTextMock = vi.fn(async () => {
          throw new Error('Rename IPC rejected');
        });
        installMockKapsulaApi({
          updateVaultTaskText: updateTextMock,
          listTaskBoardColumns: vi.fn(async () => [
            { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
            { id: 'done', title: 'Готово', color: '#2EA06B', order: 1, isDone: true },
          ]),
        });

        const task = makeTaskEntry({
          id: 't-rename',
          itemId: 'note-rename',
          text: 'Исходное имя задачи',
          columnId: 'inbox',
        });

        renderWithI18n(
          <TasksHubView
            tasks={[task]}
            orbits={[makeOrbit()]}
            viewMode="list"
            onToggleTask={vi.fn(async () => {})}
            onOpenItem={vi.fn()}
            onAddQuickTask={vi.fn(async () => {})}
          />
        );

        const taskLabel = screen.getByText('Исходное имя задачи');
        fireEvent.doubleClick(taskLabel);

        const editInput = screen.getByDisplayValue('Исходное имя задачи') as HTMLInputElement;
        fireEvent.change(editInput, { target: { value: 'Сломанное новое имя' } });
        fireEvent.keyDown(editInput, { key: 'Enter' });

        await waitFor(() => {
          expect(updateTextMock).toHaveBeenCalledTimes(1);
        });

        // After rejected IPC, UI must roll back to original task text
        await new Promise((r) => setTimeout(r, 30));
        expect(screen.queryByText('Сломанное новое имя')).toBeNull();
        expect(screen.getByText('Исходное имя задачи')).toBeTruthy();
      }
    );

    it(
      '[Wave 2: BUG-08] serializes or batches moves when deleting a column with 2+ tasks from the same parent itemId',
      async () => {
        let activeForSharedItem = 0;
        let maxConcurrentForSharedItem = 0;
        const pendingResolvers: Array<() => void> = [];

        const moveMock = vi.fn(
          () =>
            new Promise<null>((resolve) => {
              activeForSharedItem += 1;
              maxConcurrentForSharedItem = Math.max(
                maxConcurrentForSharedItem,
                activeForSharedItem
              );
              pendingResolvers.push(() => {
                activeForSharedItem -= 1;
                resolve(null);
              });
            })
        );

        installMockKapsulaApi({
          moveTaskOnBoard: moveMock,
          listTaskBoardColumns: vi.fn(async () => [
            { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
            { id: 'custom_col', title: 'Своя колонка', color: '#3B82F6', order: 1 },
            { id: 'done', title: 'Готово', color: '#2EA06B', order: 2, isDone: true },
          ]),
        });

        const sharedTasks = [
          makeTaskEntry({
            id: 'shared-note:markdown:0',
            itemId: 'shared-note',
            taskKey: 'md:0',
            taskIndex: 0,
            text: 'Первая из одной заметки',
            columnId: 'custom_col',
          }),
          makeTaskEntry({
            id: 'shared-note:markdown:1',
            itemId: 'shared-note',
            taskKey: 'md:1',
            taskIndex: 1,
            text: 'Вторая из одной заметки',
            columnId: 'custom_col',
          }),
        ];

        renderWithI18n(
          <TasksHubView
            tasks={sharedTasks}
            orbits={[makeOrbit()]}
            viewMode="board"
            onToggleTask={vi.fn(async () => {})}
            onOpenItem={vi.fn()}
            onAddQuickTask={vi.fn(async () => {})}
          />
        );

        const colMenuBtn = await screen.findByTestId('kanban-col-menu-custom_col');
        fireEvent.click(colMenuBtn);

        const deleteColBtn = await screen.findByRole('button', { name: 'Удалить колонку' });
        fireEvent.click(deleteColBtn);

        await waitFor(() => {
          expect(moveMock).toHaveBeenCalled();
        });

        // Drain any queued/in-flight moves sequentially or all pending
        for (let guard = 0; guard < 10 && pendingResolvers.length > 0; guard++) {
          const fn = pendingResolvers.shift()!;
          await act(async () => {
            fn();
            await Promise.resolve();
          });
        }

        expect(maxConcurrentForSharedItem).toBeLessThanOrEqual(1);
      }
    );
  });

  describe('CalendarEventSheet', () => {
    it('opens existing event in view mode, switches to edit mode, and submits updated title', async () => {
      installMockKapsulaApi();
      const ev = makeCalendarEvent({ id: 'ev-edit', title: 'Дизайн-ревью' });
      const onSave = vi.fn(async () => {});

      renderWithI18n(
        <CalendarEventSheet
          open={true}
          event={ev}
          vaultItems={[]}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );

      expect(screen.getByTestId('calendar-event-view-mode')).toBeTruthy();
      fireEvent.click(screen.getByTestId('calendar-event-edit-btn'));

      const titleInput = (await screen.findByTestId('calendar-event-title-input')) as HTMLInputElement;
      expect(titleInput.value).toBe('Дизайн-ревью');

      fireEvent.change(titleInput, { target: { value: 'Финальное дизайн-ревью' } });
      fireEvent.click(screen.getByTestId('calendar-event-save-btn'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ev-edit',
          title: 'Финальное дизайн-ревью',
        })
      );
    });

    it(
      '[Wave 2: BUG-09] preserves active edit mode and unsaved title draft when background calendar sync passes a fresh event reference with the same id',
      async () => {
        installMockKapsulaApi();
        const ev = makeCalendarEvent({ id: 'ev-sync-race', title: 'Созвон' });
        const onClose = vi.fn();
        const onSave = vi.fn(async () => {});

        const { rerender } = renderWithI18n(
          <CalendarEventSheet
            open={true}
            event={ev}
            vaultItems={[]}
            onClose={onClose}
            onSave={onSave}
          />
        );

        fireEvent.click(screen.getByTestId('calendar-event-edit-btn'));
        const titleInput = (await screen.findByTestId(
          'calendar-event-title-input'
        )) as HTMLInputElement;
        fireEvent.change(titleInput, { target: { value: 'Созвон с продюсером (несохранено)' } });

        // Simulate background vault:calendar-changed refresh delivering a new object reference for the same id
        rerender(
          <CalendarEventSheet
            open={true}
            event={{ ...ev, updatedAt: ev.updatedAt + 5000 }}
            vaultItems={[]}
            onClose={onClose}
            onSave={onSave}
          />
        );

        await act(async () => {
          await new Promise((r) => setTimeout(r, 200));
        });

        expect(screen.queryByTestId('calendar-event-edit-mode')).not.toBeNull();
        expect(
          (screen.getByTestId('calendar-event-title-input') as HTMLInputElement).value
        ).toBe('Созвон с продюсером (несохранено)');
      }
    );
  });

  describe('CalendarHubView', () => {
    it('renders calendar views (month/week/agenda) and opens create sheet on openCreateTrigger', async () => {
      const ev = makeCalendarEvent({
        id: 'ev-nov',
        title: 'Синхронизация команды',
        startAt: new Date(2026, 10, 22, 11, 0, 0, 0).getTime(),
        endAt: new Date(2026, 10, 22, 12, 0, 0, 0).getTime(),
      });
      installMockKapsulaApi({
        listCalendarEvents: vi.fn(async () => [ev]),
      });

      const { rerender } = renderWithI18n(
        <CalendarHubView
          tasks={[]}
          items={[]}
          initialEvents={[ev]}
          openCreateTrigger={0}
          onOpenItem={vi.fn()}
          onOpenIntegrations={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getAllByText('Синхронизация команды').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Неделя' }));
      await waitFor(() => {
        expect(screen.getByText('07:00')).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Список' }));
      await waitFor(() => {
        expect(screen.getAllByText('Синхронизация команды').length).toBeGreaterThan(0);
      });

      rerender(
        <CalendarHubView
          tasks={[]}
          items={[]}
          initialEvents={[ev]}
          openCreateTrigger={1}
          onOpenItem={vi.fn()}
          onOpenIntegrations={vi.fn()}
        />
      );

      expect(await screen.findByTestId('calendar-event-sheet')).toBeTruthy();
    });

    it(
      '[Wave 2: BUG-09] clamps monthly day-31 recurring event into 30-day November instead of dropping the occurrence',
      async () => {
        const oct31Event = makeCalendarEvent({
          id: 'ev-monthly-31',
          title: 'Оплата аренды',
          recurrence: 'monthly',
          startAt: new Date(2026, 9, 31, 10, 0, 0, 0).getTime(), // 2026-10-31
          endAt: new Date(2026, 9, 31, 11, 0, 0, 0).getTime(),
        });

        installMockKapsulaApi({
          listCalendarEvents: vi.fn(async () => [oct31Event]),
        });

        renderWithI18n(
          <CalendarHubView
            tasks={[]}
            items={[]}
            initialEvents={[oct31Event]}
            onOpenItem={vi.fn()}
            onOpenIntegrations={vi.fn()}
          />
        );

        await waitFor(() => {
          expect(screen.getAllByText('Оплата аренды').length).toBeGreaterThan(0);
        });

        fireEvent.click(screen.getByRole('tab', { name: 'Список' }));
        await waitFor(() => {
          expect(screen.getByText(/31 окт/i)).toBeTruthy();
        });

        // Window covers Oct 1 .. Jan 15 -> Oct 31, Nov 30, Dec 31 must all be present (3 occurrences) in agenda list
        const agendaList = screen.getByTestId('calendar-agenda-list');
        expect(within(agendaList).getAllByText('Оплата аренды')).toHaveLength(3);
        expect(within(agendaList).getByText(/30 ноя/i)).toBeTruthy();
      }
    );

    it(
      '[Wave 2: BUG-09] prevents duplicate event creation when quick-add form is submitted twice rapidly',
      async () => {
        const deferredUpsert = createDeferred<ReturnType<typeof makeCalendarEvent>>();
        const upsertMock = vi.fn(() => deferredUpsert.promise);
        installMockKapsulaApi({
          upsertCalendarEvent: upsertMock,
        });

        renderWithI18n(
          <CalendarHubView
            tasks={[]}
            items={[]}
            initialEvents={[]}
            onOpenItem={vi.fn()}
            onOpenIntegrations={vi.fn()}
          />
        );

        const quickInput = screen.getByTestId('calendar-quick-input') as HTMLInputElement;
        fireEvent.change(quickInput, { target: { value: 'Быстрая встреча' } });
        const form = quickInput.closest('form')!;

        fireEvent.submit(form);
        fireEvent.submit(form);

        await waitFor(() => {
          expect(upsertMock).toHaveBeenCalled();
        });

        expect(upsertMock).toHaveBeenCalledTimes(1);

        deferredUpsert.resolve(makeCalendarEvent({ id: 'ev-quick-1', title: 'Быстрая встреча' }));
        await act(async () => {
          await Promise.resolve();
        });
      }
    );
  });
});
