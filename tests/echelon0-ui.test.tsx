// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { OmniComposer } from '@renderer/components/studio/OmniComposer';
import { CompactMemoryRow } from '@renderer/components/cards/CompactMemoryRow';
import { SelectMenu } from '@renderer/components/ui/SelectMenu';
import { CalendarHubView } from '@renderer/components/studio/CalendarHubView';
import { TasksHubView } from '@renderer/components/studio/TasksHubView';
import { StudioWorkspace } from '@renderer/surfaces/StudioWorkspace';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeCalendarEvent,
  makeSettingsState,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    useReducedMotion: () => false,
  };
});

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

describe('Echelon 0 UI & Interaction Guards (#1, #3, #4)', () => {
  beforeAll(() => {
    installJsdomPolyfills();
    installMockKapsulaApi();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('#1 OmniComposer uses GPU-composited continuous BorderTrail while focused (zero JS offset-distance) and cleans up on blur', async () => {
    renderWithI18n(
      <OmniComposer
        orbits={[]}
        activeOrbitId={null}
        activeFocusBoardId={null}
        soundEnabled={false}
        onCaptured={() => {}}
      />
    );

    const textarea = screen.getByTestId('omni-composer').querySelector('textarea')!;
    expect(textarea).toBeTruthy();

    act(() => {
      fireEvent.focus(textarea);
    });
    expect(screen.getByTestId('omni-composer').innerHTML).toContain('k-border-trail-spin');
    expect(screen.getByTestId('omni-composer').innerHTML).not.toContain('offset-distance');

    act(() => {
      fireEvent.blur(textarea);
    });
    await waitFor(
      () => {
        expect(screen.getByTestId('omni-composer').innerHTML).not.toContain('k-border-trail-spin');
      },
      { timeout: 1500 }
    );
  });

  it('#3 CompactMemoryRow is memoized and renders thumbnails eagerly without pop-in delay', () => {
    expect((CompactMemoryRow as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );

    const item = makeVaultItem({
      id: 'compact-img-1',
      dna: 'shot',
      title: 'Screenshot',
      thumbPath: 'thumb_abc.jpg',
    });

    const { container } = renderWithI18n(
      <CompactMemoryRow item={item} onOpen={() => {}} />
    );

    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('loading')).toBeNull();
  });

  it('#3 SelectMenu opens popup and highlights hovered option smoothly', () => {
    renderWithI18n(
      <SelectMenu
        data-testid="e0-select"
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />
    );

    fireEvent.click(screen.getByTestId('e0-select'));
    const popup = screen.getByTestId('e0-select-popup');
    const betaOption = screen.getByText('Beta').closest('[role="option"]')!;
    fireEvent.mouseEnter(betaOption);

    const highlight = popup.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    expect(highlight).toBeTruthy();
  });

  it('#4 CalendarHubView suppresses accidental click after resize while allowing normal event clicks', async () => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const evStart = dayStart.getTime() + 9 * 3600_000;
    const evEnd = evStart + 90 * 60_000;
    const ev = makeCalendarEvent({
      id: 'ev-resize-1',
      title: 'Design Review',
      startAt: evStart,
      endAt: evEnd,
      allDay: false,
      hasEndTime: true,
    });
    installMockKapsulaApi({
      listCalendarEvents: vi.fn(async () => [ev]),
    });

    renderWithI18n(
      <CalendarHubView
        items={[]}
        tasks={[]}
        initialEvents={[ev]}
        onOpenItem={() => {}}
        onOpenIntegrations={() => {}}
      />
    );

    // Switch to Day view
    const dayTab = screen.getByRole('tab', { name: 'День' });
    fireEvent.click(dayTab);

    const handle = await screen.findByTestId('calendar-resize-handle-ev-resize-1');
    const eventBtn = screen.getByTestId('calendar-timed-event-ev-resize-1');

    // Simulate resize mousedown -> mouseup -> browser-synthesized click on parent button
    fireEvent.mouseDown(handle, { clientY: 100 });
    fireEvent.mouseUp(window, { clientY: 140 });
    fireEvent.click(eventBtn);

    expect(screen.queryByTestId('calendar-event-sheet')).toBeNull();

    // Wait a tick for suppression flag to reset, then verify normal click opens the sheet
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    fireEvent.click(eventBtn);
    await waitFor(() => {
      expect(screen.getByTestId('calendar-event-sheet')).toBeTruthy();
    });
  });

  it('#4 StudioWorkspace skips listTasks() on prose autosave when checkboxes/task fields did not change, and calls listTasks() when a checkbox changes', async () => {
    const note = makeVaultItem({
      id: 'note-task-guard-1',
      dna: 'note',
      title: 'Note with task',
      body: '- [ ] Keep this task\n\nInitial prose',
    });
    const listTasksMock = vi.fn(async () => []);
    const { emit } = installMockKapsulaApi({
      queryVault: vi.fn(async () => [note]),
      listTasks: listTasksMock,
    });

    renderWithI18n(
      <StudioWorkspace
        settings={makeSettingsState({ onboarded: true })}
        onSettingsUpdated={() => {}}
      />
    );

    await screen.findByTestId(`memory-card-${note.id}`);
    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
    listTasksMock.mockClear();

    // 1. Prose-only autosave -> 0 extra listTasks calls
    act(() => {
      emit('onVaultItemUpserted', {
        ...note,
        body: '- [ ] Keep this task\n\nInitial prose plus more typing',
        updatedAt: note.updatedAt + 350,
        contentUpdatedAt: note.updatedAt + 350,
      });
    });
    expect(listTasksMock).toHaveBeenCalledTimes(0);

    // 2. Checkbox toggled -> triggers listTasks()
    act(() => {
      emit('onVaultItemUpserted', {
        ...note,
        body: '- [x] Keep this task\n\nInitial prose plus more typing',
        updatedAt: note.updatedAt + 700,
        contentUpdatedAt: note.updatedAt + 700,
      });
    });
    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
  });

  it('#4 StudioWorkspace refreshes listTasks() when external onVaultItemUpserted toggles voice mediaMeta.checkedActionIndices', async () => {
    const voiceItem = makeVaultItem({
      id: 'voice-action-sync-1',
      dna: 'voice',
      title: 'Голосовая заметка',
      body: 'Расшифровка звонка',
      mediaMeta: {
        actionItems: ['Отправить отчёт', 'Позвонить дизайнеру'],
        checkedActionIndices: [],
      },
    });
    const listTasksMock = vi.fn(async () => []);
    const { emit } = installMockKapsulaApi({
      queryVault: vi.fn(async () => [voiceItem]),
      listTasks: listTasksMock,
    });

    renderWithI18n(
      <StudioWorkspace
        settings={makeSettingsState({ onboarded: true })}
        onSettingsUpdated={() => {}}
      />
    );

    await screen.findByTestId(`memory-card-${voiceItem.id}`);
    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
    listTasksMock.mockClear();

    // External/sync upsert toggles checkedActionIndices without altering taskMeta
    act(() => {
      emit('onVaultItemUpserted', {
        ...voiceItem,
        mediaMeta: {
          ...voiceItem.mediaMeta,
          checkedActionIndices: [0],
        },
        updatedAt: voiceItem.updatedAt + 500,
      });
    });

    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
  });

  it('#4 StudioWorkspace extractTaskLinesSignature preserves mixed ``` / ~~~ fence parity with parseMarkdownTasks', async () => {
    const fencedNote = makeVaultItem({
      id: 'note-mixed-fence-1',
      dna: 'note',
      title: 'Markdown examples',
      body: '```\n- [ ] Fake inside backticks\n~~~\n```\n- [ ] Real task',
    });
    const listTasksMock = vi.fn(async () => []);
    const { emit } = installMockKapsulaApi({
      queryVault: vi.fn(async () => [fencedNote]),
      listTasks: listTasksMock,
    });

    renderWithI18n(
      <StudioWorkspace
        settings={makeSettingsState({ onboarded: true })}
        onSettingsUpdated={() => {}}
      />
    );

    await screen.findByTestId(`memory-card-${fencedNote.id}`);
    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
    listTasksMock.mockClear();

    // 1. Prose edit + toggling fake checkbox inside fenced block -> 0 listTasks calls
    act(() => {
      emit('onVaultItemUpserted', {
        ...fencedNote,
        body: '```\n- [x] Fake inside backticks\n~~~\n```\n- [ ] Real task\n\nExtra prose',
        updatedAt: fencedNote.updatedAt + 350,
        contentUpdatedAt: fencedNote.updatedAt + 350,
      });
    });
    expect(listTasksMock).toHaveBeenCalledTimes(0);

    // 2. Toggling the real task AFTER the mixed fence -> triggers listTasks()
    act(() => {
      emit('onVaultItemUpserted', {
        ...fencedNote,
        body: '```\n- [x] Fake inside backticks\n~~~\n```\n- [x] Real task\n\nExtra prose',
        updatedAt: fencedNote.updatedAt + 700,
        contentUpdatedAt: fencedNote.updatedAt + 700,
      });
    });
    await waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledTimes(1);
    });
  });

  it('#4 TasksHubView & StudioWorkspace inline mode avoid redundant getSettings/listTaskBoardColumns when toggling showColumnIcons', async () => {
    const listColumnsMock = vi.fn(async () => [
      { id: 'inbox', title: 'Входящие', color: '#94A3B8', order: 0 },
      { id: 'done', title: 'Готово', color: '#2EA06B', order: 1, isDone: true },
    ]);
    const getSettingsMock = vi.fn(async () => makeSettingsState({ showBoardColumnIcons: true }));
    const updateSettingsMock = vi.fn(async () => makeSettingsState({ showBoardColumnIcons: false }));

    installMockKapsulaApi({
      listTaskBoardColumns: listColumnsMock,
      getSettings: getSettingsMock,
      updateSettings: updateSettingsMock,
    });

    const { rerender } = renderWithI18n(
      <TasksHubView
        tasks={[]}
        orbits={[]}
        viewMode="board"
        initialShowColumnIcons={true}
        onToggleTask={async () => {}}
        onOpenItem={() => {}}
        onViewModeChange={() => {}}
        onAddQuickTask={async () => {}}
      />
    );
    await waitFor(() => {
      expect(listColumnsMock).toHaveBeenCalledTimes(1);
    });
    expect(getSettingsMock).toHaveBeenCalledTimes(0);

    // Toggle column icons via UI button & also verify prop change does not re-trigger listTaskBoardColumns
    fireEvent.click(screen.getByTestId('tasks-toggle-col-icons'));
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ showBoardColumnIcons: false });
    });

    rerender(
      <TasksHubView
        tasks={[]}
        orbits={[]}
        viewMode="board"
        initialShowColumnIcons={false}
        onToggleTask={async () => {}}
        onOpenItem={() => {}}
        onViewModeChange={() => {}}
        onAddQuickTask={async () => {}}
      />
    );
    expect(listColumnsMock).toHaveBeenCalledTimes(1);
    expect(getSettingsMock).toHaveBeenCalledTimes(0);
    cleanup();

    // Also verify StudioWorkspace inline tasks mode passes initialShowColumnIcons -> 0 getSettings calls
    listColumnsMock.mockClear();
    getSettingsMock.mockClear();
    installMockKapsulaApi({
      listTaskBoardColumns: listColumnsMock,
      getSettings: getSettingsMock,
      updateSettings: updateSettingsMock,
    });

    renderWithI18n(
      <StudioWorkspace
        settings={makeSettingsState({ onboarded: true, showBoardColumnIcons: true })}
        onSettingsUpdated={() => {}}
      />
    );

    const quickTaskChip = await screen.findByTestId('quick-filter-task');
    fireEvent.click(quickTaskChip);

    await waitFor(() => {
      expect(listColumnsMock).toHaveBeenCalledTimes(1);
    });
    expect(getSettingsMock).toHaveBeenCalledTimes(0);
  });
});
