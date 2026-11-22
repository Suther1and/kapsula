// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { SynthesizeNotesResult, TriagePreviewResult } from '@shared/types';
import { SmartTriageModal } from '@renderer/components/modals/SmartTriageModal';
import { SynthesizeNotesModal } from '@renderer/components/modals/SynthesizeNotesModal';
import { ReferenceBoardCanvas } from '@renderer/components/studio/ReferenceBoardCanvas';
import {
  installJsdomPolyfills,
  installMockKapsulaApi,
  makeOrbit,
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

describe('Wave 2 UI Modal Race Guards & ReferenceBoard Pointer Cancel', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('SmartTriageModal drops stale preview responses when re-opened or refreshed out of order', async () => {
    const req1 = createDeferred<TriagePreviewResult>();
    const req2 = createDeferred<TriagePreviewResult>();
    const previewSmartTriage = vi
      .fn<() => Promise<TriagePreviewResult>>()
      .mockImplementationOnce(() => req1.promise)
      .mockImplementationOnce(() => req2.promise);

    installMockKapsulaApi({ previewSmartTriage });
    const orbits = [makeOrbit({ id: 'inbox', name: 'Входящие' }), makeOrbit({ id: 'dev', name: 'Разработка' })];

    const { rerender } = renderWithI18n(
      <SmartTriageModal
        open={true}
        onOpenChange={vi.fn()}
        orbits={orbits}
        onApplied={vi.fn()}
        onOpenAiSettings={vi.fn()}
      />
    );

    expect(previewSmartTriage).toHaveBeenCalledTimes(1);

    // Close and reopen immediately so req2 supersedes req1
    rerender(
      <SmartTriageModal
        open={false}
        onOpenChange={vi.fn()}
        orbits={orbits}
        onApplied={vi.fn()}
        onOpenAiSettings={vi.fn()}
      />
    );
    rerender(
      <SmartTriageModal
        open={true}
        onOpenChange={vi.fn()}
        orbits={orbits}
        onApplied={vi.fn()}
        onOpenAiSettings={vi.fn()}
      />
    );

    expect(previewSmartTriage).toHaveBeenCalledTimes(2);

    await act(async () => {
      req2.resolve({
        configured: true,
        usedCloud: true,
        suggestions: [
          {
            itemId: 'item-fresh',
            itemTitle: 'Актуальная заметка',
            currentOrbit: 'inbox',
            targetOrbit: 'dev',
            targetOrbitName: 'Разработка',
            targetBoardId: null,
            targetBoardName: null,
            suggestedTags: [],
            archive: false,
            reason: 'Свежий разбор',
            confidence: 0.92,
          },
        ],
        newOrbits: [],
        mergeGroups: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Актуальная заметка')).toBeTruthy();
    });

    // Stale first response settles late — must NOT replace newer suggestions
    await act(async () => {
      req1.resolve({
        configured: true,
        usedCloud: false,
        suggestions: [
          {
            itemId: 'item-stale',
            itemTitle: 'Устаревшая заметка',
            currentOrbit: 'inbox',
            targetOrbit: 'dev',
            targetOrbitName: 'Разработка',
            targetBoardId: null,
            targetBoardName: null,
            suggestedTags: [],
            archive: false,
            reason: 'Старый ответ',
            confidence: 0.7,
          },
        ],
        newOrbits: [],
        mergeGroups: [],
      });
    });

    expect(screen.getByText('Актуальная заметка')).toBeTruthy();
    expect(screen.queryByText('Устаревшая заметка')).toBeNull();
  });

  it('SynthesizeNotesModal ignores out-of-order synthesis results and clears draft state on reopen', async () => {
    const d1 = createDeferred<{ item: null; preview: SynthesizeNotesResult }>();
    const d2 = createDeferred<{ item: null; preview: SynthesizeNotesResult }>();
    const d3 = createDeferred<{ item: null; preview: SynthesizeNotesResult }>();
    const synthesizeNotes = vi
      .fn()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementationOnce(() => d3.promise);

    installMockKapsulaApi({ synthesizeNotes });
    const items = [
      makeVaultItem({ id: 's-1', title: 'Идея 1', body: 'Первый черновик' }),
      makeVaultItem({ id: 's-2', title: 'Идея 2', body: 'Второй черновик' }),
    ];
    const orbits = [makeOrbit({ id: 'dev', name: 'Разработка' })];

    const { rerender } = renderWithI18n(
      <SynthesizeNotesModal
        open={true}
        onOpenChange={vi.fn()}
        items={items}
        orbits={orbits}
        onCreated={vi.fn()}
      />
    );

    expect(synthesizeNotes).toHaveBeenCalledTimes(1);

    // Trigger second synthesis request via mode switch
    fireEvent.click(screen.getByRole('tab', { name: 'Чек-лист' }));
    expect(synthesizeNotes).toHaveBeenCalledTimes(2);

    await act(async () => {
      d2.resolve({
        item: null,
        preview: {
          title: 'Свежий синтез',
          body: 'Актуальное содержимое',
          summary: 'Сводка',
          tags: [],
          orbit: 'dev',
          usedCloud: true,
          preservedDetailsCount: 2,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('Свежий синтез')).toBeTruthy();
    });

    // Late resolution of first request must be ignored
    await act(async () => {
      d1.resolve({
        item: null,
        preview: {
          title: 'Старый синтез',
          body: 'Устаревшее содержимое',
          summary: 'Старое',
          tags: [],
          orbit: 'dev',
          usedCloud: false,
          preservedDetailsCount: 1,
        },
      });
    });

    expect(screen.getByDisplayValue('Свежий синтез')).toBeTruthy();
    expect(screen.queryByDisplayValue('Старый синтез')).toBeNull();

    // Closing and reopening clears stale draft fields while the new preview is pending
    rerender(
      <SynthesizeNotesModal
        open={false}
        onOpenChange={vi.fn()}
        items={items}
        orbits={orbits}
        onCreated={vi.fn()}
      />
    );
    rerender(
      <SynthesizeNotesModal
        open={true}
        onOpenChange={vi.fn()}
        items={items}
        orbits={orbits}
        onCreated={vi.fn()}
      />
    );

    expect(screen.queryByDisplayValue('Свежий синтез')).toBeNull();
  });

  it('ReferenceBoardCanvas releases pointer capture and clears active pan drag state on pointercancel', () => {
    installMockKapsulaApi();
    const item = makeVaultItem({ id: 'board-card-1', title: 'Ref card', canvasX: 60, canvasY: 80 });

    renderWithI18n(
      <ReferenceBoardCanvas
        items={[item]}
        onOpenItem={vi.fn()}
        onUpdatePosition={vi.fn()}
      />
    );

    const canvas = screen.getByTestId('reference-board-canvas');
    const setPointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    const releasePointerCapture = vi.fn();
    Object.defineProperty(canvas, 'setPointerCapture', { configurable: true, value: setPointerCapture });
    Object.defineProperty(canvas, 'hasPointerCapture', { configurable: true, value: hasPointerCapture });
    Object.defineProperty(canvas, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });

    const gridEl = canvas.firstElementChild as HTMLElement;
    const beforePanPos = gridEl.style.backgroundPosition;

    fireEvent.pointerDown(canvas, { pointerId: 11, clientX: 100, clientY: 100, button: 0 });
    expect(setPointerCapture).toHaveBeenCalledWith(11);

    fireEvent.pointerCancel(canvas, { pointerId: 11 });
    expect(releasePointerCapture).toHaveBeenCalledWith(11);

    // Subsequent pointermove must NOT pan after cancel cleared panDragRef
    fireEvent.pointerMove(canvas, { pointerId: 11, clientX: 280, clientY: 260 });
    expect(gridEl.style.backgroundPosition).toBe(beforePanPos);
  });
});
