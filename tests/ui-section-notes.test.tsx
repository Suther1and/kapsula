// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { NotesHubView } from '@renderer/components/studio/NotesHubView';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeFocusBoard,
  makeOrbit,
  makeVaultItem,
  renderWithI18n,
} from './helpers/ui-test-harness';

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => React.createElement('span', null, String(value)),
}));

describe('Section-scoped & Global NotesHubView', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const orbits = [
    makeOrbit({ id: 'the-game', name: 'The Game', color: '#E86A33' }),
    makeOrbit({ id: 'work', name: 'Работа', color: '#3B82F6' }),
  ];

  const gameDedicatedNote = makeVaultItem({
    id: 'game-doc-1',
    dna: 'note',
    orbit: 'the-game',
    title: 'Диздок боссов',
    body: 'Подробный документ по фазам боссов.',
    mediaMeta: { inNotesHub: true },
  });

  const gameQuickThought = makeVaultItem({
    id: 'game-thought-1',
    dna: 'note',
    orbit: 'the-game',
    title: 'недельное испытание: один герой',
    body: 'режим включая арену но у всех один герой',
    mediaMeta: null,
  });

  const workDedicatedNote = makeVaultItem({
    id: 'work-doc-1',
    dna: 'note',
    orbit: 'work',
    title: 'План релиза',
    body: 'Чек-лист задач на неделю.',
    mediaMeta: { inNotesHub: true },
  });

  const commonCallbacks = {
    focusBoards: [makeFocusBoard()],
    globalSearchQuery: '',
    serverSearchIds: null,
    soundEnabled: false,
    onItemUpdated: vi.fn(),
    onDraftPersisted: vi.fn(),
    onDeleteItem: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleNotesHub: vi.fn(),
    onMoveToOrbit: vi.fn(),
    onMoveToBoard: vi.fn(),
    onDuplicateItem: vi.fn(),
    onExportMarkdown: vi.fn(),
    onOpenExternalItem: vi.fn(),
    onOpenShotLightbox: vi.fn(),
  };

  it('shows only dedicated notes of the section by default and switches to all texts of that section', () => {
    installMockKapsulaApi();
    const sectionItems = [gameDedicatedNote, gameQuickThought];

    renderWithI18n(
      <NotesHubView
        items={sectionItems}
        allItemsForLinks={[gameDedicatedNote, gameQuickThought, workDedicatedNote]}
        defaultOrbitId="the-game"
        orbits={orbits}
        {...commonCallbacks}
      />
    );

    expect(screen.getByTestId('notes-list-item-game-doc-1')).toBeTruthy();
    expect(screen.queryByTestId('notes-list-item-game-thought-1')).toBeNull();
    expect(screen.queryByTestId('notes-list-item-work-doc-1')).toBeNull();

    // Orbit badge is suppressed inside a specific section list
    const row = screen.getByTestId('notes-list-item-game-doc-1');
    expect(within(row).queryByText('The Game')).toBeNull();

    // Switch to "Все тексты (2)"
    fireEvent.click(screen.getByRole('tab', { name: 'Все тексты (2)' }));

    expect(screen.getByTestId('notes-list-item-game-doc-1')).toBeTruthy();
    expect(screen.getByTestId('notes-list-item-game-thought-1')).toBeTruthy();
    expect(screen.queryByTestId('notes-list-item-work-doc-1')).toBeNull();
  });

  it('binds a new note draft to defaultOrbitId and inNotesHub: true when saved', async () => {
    const createdNote = makeVaultItem({
      id: 'captured-game-note',
      dna: 'note',
      orbit: 'the-game',
      title: 'Экономика арены',
      body: '',
      mediaMeta: { inNotesHub: true },
    });
    const { api } = installMockKapsulaApi({
      capture: vi.fn(async () => createdNote),
    });
    const onDraftPersisted = vi.fn();

    renderWithI18n(
      <NotesHubView
        items={[gameDedicatedNote]}
        allItemsForLinks={[gameDedicatedNote, workDedicatedNote]}
        defaultOrbitId="the-game"
        orbits={orbits}
        {...commonCallbacks}
        onDraftPersisted={onDraftPersisted}
      />
    );

    fireEvent.click(screen.getByTestId('notes-new-btn'));
    expect(screen.getByTestId('notes-draft-row')).toBeTruthy();

    const titleInput = screen.getByTestId('note-studio-title') as HTMLTextAreaElement;
    fireEvent.change(titleInput, { target: { value: 'Экономика арены' } });

    await waitFor(
      () => {
        expect(api.capture).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Экономика арены',
            orbitOverride: 'the-game',
            mediaMeta: { inNotesHub: true },
          })
        );
      },
      { timeout: 2000 }
    );

    await waitFor(() => {
      expect(onDraftPersisted).toHaveBeenCalledWith(createdNote);
    });
  });

  it('ignores non-zero initial createDraftTrigger on mount and opens draft only when incremented', () => {
    installMockKapsulaApi();

    const { rerender, i18nProps } = (() => {
      const rendered = renderWithI18n(
        <NotesHubView
          items={[gameDedicatedNote]}
          defaultOrbitId="the-game"
          orbits={orbits}
          createDraftTrigger={2}
          {...commonCallbacks}
        />
      );
      return {
        ...rendered,
        i18nProps: {
          items: [gameDedicatedNote],
          defaultOrbitId: 'the-game',
          orbits,
          ...commonCallbacks,
        },
      };
    })();

    expect(screen.queryByTestId('notes-draft-row')).toBeNull();

    rerender(
      <NotesHubView
        {...i18nProps}
        createDraftTrigger={3}
      />
    );

    expect(screen.getByTestId('notes-draft-row')).toBeTruthy();
  });

  it('shows dedicated notes across all sections with their section badges when defaultOrbitId is omitted', () => {
    installMockKapsulaApi();

    renderWithI18n(
      <NotesHubView
        items={[gameDedicatedNote, gameQuickThought, workDedicatedNote]}
        orbits={orbits}
        {...commonCallbacks}
      />
    );

    const gameRow = screen.getByTestId('notes-list-item-game-doc-1');
    const workRow = screen.getByTestId('notes-list-item-work-doc-1');

    expect(within(gameRow).getByText('The Game')).toBeTruthy();
    expect(within(workRow).getByText('Работа')).toBeTruthy();
    expect(screen.queryByTestId('notes-list-item-game-thought-1')).toBeNull();
  });
});
