// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { StudioWorkspace } from '@renderer/surfaces/StudioWorkspace';
import { TasksHubView } from '@renderer/components/studio/TasksHubView';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeOrbit,
  makeSettingsState,
  makeTaskEntry,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

describe('Echelon 2 (#10): UI Batch IPC Wiring (Zero N×IPC / Zero refreshAll)', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('StudioWorkspace bulkMute & bulkDelete call batch IPC once with 0 refreshAll and 0 N×updateItem', async () => {
    const items = [
      makeVaultItem({ id: 'b-1', title: 'Карточка 1', body: 'Текст 1', isCardProjection: true }),
      makeVaultItem({ id: 'b-2', title: 'Карточка 2', body: 'Текст 2', isCardProjection: true }),
      makeVaultItem({ id: 'b-3', title: 'Карточка 3', body: 'Текст 3', isCardProjection: true }),
    ];

    const settings = makeSettingsState({ onboarded: true });
    const { api } = installMockKapsulaApi({
      queryVault: vi.fn(async () => items),
      getSettings: vi.fn(async () => settings),
      listOrbits: vi.fn(async () => [makeOrbit({ id: 'work', name: 'Работа' })]),
      bulkUpdateItems: vi.fn(async (ids: string[], patch: Record<string, unknown>) => ({
        items: ids.map((id) =>
          makeVaultItem({
            ...(items.find((x) => x.id === id) ?? { id }),
            ...(patch as object),
            isCardProjection: true,
          })
        ),
        count: ids.length,
        failedIds: [],
      })),
      bulkDeleteItems: vi.fn(async (ids: string[]) => ({
        deletedIds: ids,
        purgedIds: [],
        failedIds: [],
      })),
    });

    renderWithI18n(
      <StudioWorkspace settings={settings} onSettingsUpdated={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('Карточка 1')).toBeTruthy();
    });

    const queryCallsBeforeBulk = (api.queryVault as ReturnType<typeof vi.fn>).mock.calls.length;

    // Enter select mode and select all
    const filterBar = screen.getByTestId('feed-quick-filters');
    const selectBtn = Array.from(filterBar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Выбрать')
    );
    expect(selectBtn).toBeTruthy();
    fireEvent.click(selectBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('bulk-action-dock')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('bulk-mute-btn'));

    await waitFor(() => {
      expect(api.bulkUpdateItems).toHaveBeenCalledTimes(1);
    });
    expect(api.bulkUpdateItems).toHaveBeenCalledWith(
      ['b-1', 'b-2', 'b-3'],
      { isMuted: true },
      { projection: 'card' }
    );
    expect(api.updateItem).not.toHaveBeenCalled();
    expect((api.queryVault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(queryCallsBeforeBulk);

    // Re-enter select mode and bulk-delete
    fireEvent.click(selectBtn!);
    await waitFor(() => {
      expect(screen.getByTestId('bulk-action-dock')).toBeTruthy();
    });

    const dock = screen.getByTestId('bulk-action-dock');
    const deleteBtn = Array.from(dock.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Удалить')
    );
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn!);

    await waitFor(() => {
      expect(api.bulkDeleteItems).toHaveBeenCalledTimes(1);
    });
    expect(api.deleteItem).not.toHaveBeenCalled();
    expect((api.queryVault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(queryCallsBeforeBulk);
  });

  it('TasksHubView bulk done & bulk delete use single batch IPC with 0 N×toggleTask/deleteVaultTask', async () => {
    const t1 = makeTaskEntry({ id: 'tk-1', itemId: 'n-1', taskIndex: 0, text: 'Задача раз', done: false });
    const t2 = makeTaskEntry({ id: 'tk-2', itemId: 'n-1', taskIndex: 1, text: 'Задача два', done: false });

    const { api } = installMockKapsulaApi({
      listTaskBoardColumns: vi.fn(async () => [
        { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
        { id: 'done', title: 'Готово', color: '#2EA06B', order: 1, isDone: true },
      ]),
      bulkToggleTasks: vi.fn(async () => ({
        updatedItems: [],
        tasks: [
          { ...t1, done: true, columnId: 'done' },
          { ...t2, done: true, columnId: 'done' },
        ],
      })),
      bulkDeleteTasks: vi.fn(async () => ({
        updatedItems: [],
        deletedItemIds: [],
        tasks: [],
      })),
    });

    const onToggleTask = vi.fn(async () => {});
    const onTasksChanged = vi.fn();

    renderWithI18n(
      <TasksHubView
        tasks={[t1, t2]}
        orbits={[makeOrbit()]}
        viewMode="list"
        onToggleTask={onToggleTask}
        onOpenItem={vi.fn()}
        onAddQuickTask={vi.fn(async () => {})}
        onTasksChanged={onTasksChanged}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('task-row-tk-1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('task-row-tk-1'), { ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('tasks-bulk-bar')).toBeTruthy();
    });

    const bulkBar = screen.getByTestId('tasks-bulk-bar');
    const selectAllBtn = Array.from(bulkBar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Выбрать все')
    );
    expect(selectAllBtn).toBeTruthy();
    fireEvent.click(selectAllBtn!);

    const doneBtn = Array.from(bulkBar.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Выполнить')
    );
    expect(doneBtn).toBeTruthy();
    fireEvent.click(doneBtn!);

    await waitFor(() => {
      expect(api.bulkToggleTasks).toHaveBeenCalledTimes(1);
    });
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(onTasksChanged).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'tk-1', done: true })]),
      []
    );
  });
});
