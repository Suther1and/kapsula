// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { VaultItem } from '@shared/types';
import { MobileI18nProvider } from '@mobile/lib/mobile-i18n';
import {
  DRAFT_NOTE_ID,
  MobileNoteEditor,
  type MaterializeDraftInput,
  type NoteDraftBuffer,
} from '@mobile/components/MobileNoteEditor';
import { installJsdomPolyfills, makeVaultItem } from './helpers/ui-test-harness';

describe('MobileNoteEditor — Android Enter, Draft Promotion, External Sync & Toolbar Parity', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it('splits paragraph on Android beforeinput insertParagraph, preserves cursor & paragraph 2 through promotion, and resets cleanly on a second new draft without overwriting note #1', async () => {
    const savedById = new Map<string, { title: string; body: string }>();
    const materializedInputs: Array<{ id: string; input: MaterializeDraftInput }> = [];
    const onSaveSpy = vi.fn(async (id: string, patch: { title?: string; body?: string }) => {
      const prev = savedById.get(id) ?? { title: '', body: '' };
      savedById.set(id, {
        title: patch.title ?? prev.title,
        body: patch.body ?? prev.body,
      });
    });
    const onDraftChangeSpy = vi.fn();
    let seq = 0;

    const Harness: React.FC = () => {
      const [drafts, setDrafts] = useState<Record<string, NoteDraftBuffer>>({});
      const [item, setItem] = useState<VaultItem>(() =>
        makeVaultItem({
          id: DRAFT_NOTE_ID,
          dna: 'note',
          title: '',
          body: '',
        })
      );

      return (
        <MobileI18nProvider locale="ru">
          <button
            type="button"
            data-testid="open-second-draft-btn"
            onClick={() =>
              setItem(
                makeVaultItem({
                  id: DRAFT_NOTE_ID,
                  dna: 'note',
                  title: '',
                  body: '',
                })
              )
            }
          >
            New Draft
          </button>
          <MobileNoteEditor
            item={item}
            allItems={[]}
            draft={drafts[item.id]}
            orbits={[]}
            boards={[]}
            showBackButton={true}
            isExpanded={true}
            ensureMediaUrl={async () => null}
            onOpenImage={() => {}}
            onMaterializeDraft={async (input: MaterializeDraftInput) => {
              seq += 1;
              const id = `promoted-note-${seq}`;
              materializedInputs.push({ id, input });
              savedById.set(id, { title: input.title, body: input.body });
              const created = makeVaultItem({
                id,
                dna: 'note',
                title: input.title,
                body: input.body,
                updatedAt: Date.now() + seq * 100,
              });
              queueMicrotask(() => {
                setItem(created);
              });
              return created;
            }}
            onDraftChange={(id, draft) => {
              onDraftChangeSpy(id, draft);
              setDrafts((prev) => ({ ...prev, [id]: draft }));
            }}
            onDraftSaved={(id, savedRev) => {
              setDrafts((prev) => {
                const cur = prev[id];
                if (!cur || cur.rev !== savedRev) return prev;
                const next = { ...prev };
                delete next[id];
                return next;
              });
            }}
            onSave={onSaveSpy}
            onDelete={async () => {}}
          />
        </MobileI18nProvider>
      );
    };

    render(<Harness />);

    const editorEl = await screen.findByTestId('mobile-note-editor-body');
    await waitFor(() => {
      expect(editorEl.querySelector('p')).toBeTruthy();
    });

    // Type line 1 and place cursor at end of line 1
    const p1 = editorEl.querySelector('p')!;
    act(() => {
      fireEvent.focus(editorEl);
      p1.textContent = 'Первая строка';
      const range = document.createRange();
      range.selectNodeContents(p1);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      fireEvent.input(editorEl);
    });

    // Dispatch Android IME insertParagraph
    const beforeInputEv = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(beforeInputEv, 'inputType', { value: 'insertParagraph' });
    act(() => {
      editorEl.dispatchEvent(beforeInputEv);
    });

    expect(beforeInputEv.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(editorEl.querySelectorAll('p').length).toBeGreaterThanOrEqual(2);
    });

    // Type second line into paragraph 2 before autosave/materialization
    const p2BeforeSave = editorEl.querySelectorAll('p')[1]!;
    act(() => {
      p2BeforeSave.textContent = 'Вторая строка';
      const range = document.createRange();
      range.selectNodeContents(p2BeforeSave);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      fireEvent.input(editorEl);
    });

    // onDraftChange must NOT fire synchronously on keystroke before debounce settles
    expect(onDraftChangeSpy).toHaveBeenCalledTimes(0);

    // Wait through draft debounce (220ms) + autosave & materialization (450ms)
    await waitFor(
      () => {
        expect(materializedInputs.length).toBe(1);
      },
      { timeout: 1800 }
    );

    // Materialized draft #1 must contain BOTH lines
    expect(materializedInputs[0]!.id).toBe('promoted-note-1');
    expect(materializedInputs[0]!.input.body).toContain('Первая строка');
    expect(materializedInputs[0]!.input.body).toContain('Вторая строка');

    // Allow microtask item.id promotion to render, then verify paragraph 2 is still intact & typing continues there
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const parasAfterPromotion = editorEl.querySelectorAll('p');
    expect(parasAfterPromotion.length).toBeGreaterThanOrEqual(2);
    expect(parasAfterPromotion[1]?.textContent).toContain('Вторая строка');

    act(() => {
      parasAfterPromotion[1]!.textContent = 'Вторая строка продолжена';
      fireEvent.input(editorEl);
    });
    await waitFor(
      () => {
        expect(savedById.get('promoted-note-1')?.body).toContain('Вторая строка продолжена');
      },
      { timeout: 1800 }
    );

    // Now open a SECOND new draft (simulating Fold "+ Новая" after note #1 auto-saved)
    act(() => {
      fireEvent.click(screen.getByTestId('open-second-draft-btn'));
    });

    // Editor must reset to a fresh empty draft instead of keeping note #1's text
    await waitFor(() => {
      expect(editorEl.textContent?.trim()).toBe('');
    });

    const freshP = editorEl.querySelector('p')!;
    act(() => {
      freshP.textContent = 'Совершенно новая вторая заметка';
      fireEvent.input(editorEl);
    });

    await waitFor(
      () => {
        expect(materializedInputs.length).toBe(2);
      },
      { timeout: 1800 }
    );
    expect(materializedInputs[1]!.id).toBe('promoted-note-2');
    expect(materializedInputs[1]!.input.body).toContain('Совершенно новая вторая заметка');
    // Note #1 MUST NOT have been overwritten by draft #2
    expect(savedById.get('promoted-note-1')?.body).toContain('Первая строка');
    expect(savedById.get('promoted-note-1')?.body).toContain('Вторая строка продолжена');
  });

  it('defers external sync updates while focused and reconciles them cleanly on blur when clean', async () => {
    const baseItem = makeVaultItem({
      id: 'sync-reconcile-1',
      dna: 'note',
      title: 'Старый заголовок',
      body: 'Старое тело',
      updatedAt: 1000,
    });

    const { rerender } = render(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={baseItem}
          allItems={[baseItem]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={() => {}}
          onDraftSaved={() => {}}
          onSave={async () => {}}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );

    const titleInput = (await screen.findByTestId('mobile-note-editor-title')) as HTMLTextAreaElement;
    const bodyEl = await screen.findByTestId('mobile-note-editor-body');

    // Focus title (without typing -> !dirtyRef.current)
    act(() => {
      titleInput.focus();
      fireEvent.focus(titleInput);
    });

    // External sync update arrives with new title & body while title is focused
    const syncedItem = makeVaultItem({
      ...baseItem,
      title: 'Синхронизированный заголовок',
      body: 'Синхронизированное тело',
      updatedAt: 2000,
    });
    rerender(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={syncedItem}
          allItems={[syncedItem]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={() => {}}
          onDraftSaved={() => {}}
          onSave={async () => {}}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );

    // While title is focused, title stays untouched so cursor is not disrupted
    expect(titleInput.value).toBe('Старый заголовок');
    // Unfocused body already synced immediately
    await waitFor(() => {
      expect(bodyEl.textContent).toContain('Синхронизированное тело');
    });

    // Blurring title reconciles the pending external title cleanly
    act(() => {
      titleInput.blur();
      fireEvent.blur(titleInput);
    });
    await waitFor(() => {
      expect(titleInput.value).toBe('Синхронизированный заголовок');
    });

    // Now focus body editor (without editing -> !dirtyRef.current) and receive another external body sync
    act(() => {
      bodyEl.focus();
      fireEvent.focus(bodyEl);
    });
    const syncedItem2 = makeVaultItem({
      ...syncedItem,
      body: 'Финальное тело с другого устройства',
      updatedAt: 3000,
    });
    rerender(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={syncedItem2}
          allItems={[syncedItem2]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={() => {}}
          onDraftSaved={() => {}}
          onSave={async () => {}}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );

    // Blurring body reconciles the deferred external body cleanly
    act(() => {
      bodyEl.blur();
      fireEvent.blur(bodyEl);
    });
    await waitFor(() => {
      expect(bodyEl.textContent).toContain('Финальное тело с другого устройства');
    });
  });

  it('handles Android IME Title Enter newline in onChange without redundant save or dropping pending external sync', async () => {
    const item = makeVaultItem({
      id: 'existing-note-1',
      dna: 'note',
      title: 'Мой заголовок',
      body: 'Тело заметки',
      updatedAt: 1000,
    });
    const onSave = vi.fn(async () => {});
    const onDraftChange = vi.fn();

    const { rerender } = render(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={item}
          allItems={[item]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={onDraftChange}
          onDraftSaved={() => {}}
          onSave={onSave}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );

    const titleInput = (await screen.findByTestId('mobile-note-editor-title')) as HTMLTextAreaElement;
    const bodyEl = await screen.findByTestId('mobile-note-editor-body');

    // Focus title and simulate a deferred external sync arriving while focused
    act(() => {
      titleInput.focus();
      fireEvent.focus(titleInput);
    });
    const syncedExternal = makeVaultItem({
      ...item,
      title: 'Обновлённый с ПК заголовок',
      updatedAt: 2000,
    });
    rerender(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={syncedExternal}
          allItems={[syncedExternal]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={onDraftChange}
          onDraftSaved={() => {}}
          onSave={onSave}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );
    expect(titleInput.value).toBe('Мой заголовок');

    // Android IME inserts '\n' without modifying title text -> moves focus to body, no save/draft emit, keeps pending sync
    act(() => {
      fireEvent.change(titleInput, { target: { value: 'Мой заголовок\n' } });
    });

    await waitFor(() => {
      expect(document.activeElement === bodyEl || bodyEl.contains(document.activeElement)).toBe(
        true
      );
    });
    expect(onDraftChange).not.toHaveBeenCalled();

    // Blurring title reconciles the pending external title that was NOT dropped by the no-op newline
    act(() => {
      fireEvent.blur(titleInput);
    });
    await waitFor(() => {
      expect(titleInput.value).toBe('Обновлённый с ПК заголовок');
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 750));
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('exposes Divider (HR) and Highlight color picker bar in mobile formatting toolbar', async () => {
    const item = makeVaultItem({
      id: 'existing-note-toolbar',
      dna: 'note',
      title: 'Форматирование',
      body: 'Абзац текста',
    });

    render(
      <MobileI18nProvider locale="ru">
        <MobileNoteEditor
          item={item}
          allItems={[item]}
          orbits={[]}
          boards={[]}
          showBackButton={true}
          isExpanded={false}
          ensureMediaUrl={async () => null}
          onOpenImage={() => {}}
          onDraftChange={() => {}}
          onDraftSaved={() => {}}
          onSave={async () => {}}
          onDelete={async () => {}}
        />
      </MobileI18nProvider>
    );

    const bodyEl = await screen.findByTestId('mobile-note-editor-body');
    const hrBtn = await screen.findByTestId('note-toolbar-hr');
    const hlBtn = await screen.findByTestId('note-toolbar-highlight');

    act(() => {
      fireEvent.click(hrBtn);
    });
    await waitFor(() => {
      expect(bodyEl.querySelector('hr')).toBeTruthy();
    });

    expect(screen.queryByTestId('mobile-highlight-color-bar')).toBeNull();
    act(() => {
      fireEvent.click(hlBtn);
    });
    expect(await screen.findByTestId('mobile-highlight-color-bar')).toBeTruthy();
    expect(screen.getByTestId('mobile-highlight-swatch-amber')).toBeTruthy();
    expect(screen.getByTestId('mobile-highlight-swatch-green')).toBeTruthy();
    expect(screen.getByTestId('mobile-highlight-clear')).toBeTruthy();
  });
});
