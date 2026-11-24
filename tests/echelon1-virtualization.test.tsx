// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  computeMasonryLayout,
  filterVisiblePlacements,
  getFeedColumns,
  getMediaColumns,
  VirtualizedMasonryGrid,
} from '@renderer/components/ui/VirtualGrid';
import { MediaHubView } from '@renderer/components/studio/MediaHubView';
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

describe('Echelon 1 (#6, #8): Virtualization, Presence Mount & Callback Stability', () => {
  beforeAll(() => {
    installJsdomPolyfills();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('computes deterministic shortest-column (x, y) masonry layouts and column breakpoints', () => {
    expect(getFeedColumns(420)).toBe(1);
    expect(getFeedColumns(560)).toBe(2);
    expect(getFeedColumns(879)).toBe(2);
    expect(getFeedColumns(880)).toBe(3);

    expect(getMediaColumns(500, false)).toBe(1);
    expect(getMediaColumns(560, false)).toBe(2);
    expect(getMediaColumns(880, false)).toBe(3);
    expect(getMediaColumns(1220, false)).toBe(4);

    expect(getMediaColumns(500, true)).toBe(2);
    expect(getMediaColumns(640, true)).toBe(3);
    expect(getMediaColumns(940, true)).toBe(4);
    expect(getMediaColumns(1240, true)).toBe(5);

    const items = [
      { id: 'a', h: 100 },
      { id: 'b', h: 200 },
      { id: 'c', h: 120 },
      { id: 'd', h: 80 },
    ];
    const layout = computeMasonryLayout(items, {
      colWidth: 300,
      cols: 3,
      gapPx: 14,
      getKey: (x) => x.id,
      getHeight: (x) => x.h,
    });

    // Item 'd' must land in shortest column 0 (y = 100 + 14 = 114)
    expect(layout.placements[0]).toMatchObject({ x: 0, y: 0, width: 300, height: 100 });
    expect(layout.placements[1]).toMatchObject({ x: 314, y: 0, width: 300, height: 200 });
    expect(layout.placements[2]).toMatchObject({ x: 628, y: 0, width: 300, height: 120 });
    expect(layout.placements[3]).toMatchObject({ x: 0, y: 114, width: 300, height: 80 });
    expect(layout.totalHeight).toBe(200);

    const visible = filterVisiblePlacements(layout.placements, 150, 300);
    expect(visible.map((p) => p.key)).toEqual(['b', 'd']);
  });

  it('virtualizes 250-item Feed Grid & 52px List without @formkit/auto-animate and preserves scrollTop across NoteStudio', async () => {
    const mockItems = Array.from({ length: 250 }, (_, idx) =>
      makeVaultItem({
        id: `feed-item-${idx}`,
        title: `Заметка номер ${idx}`,
        body: `Содержимое карточки номер ${idx}`,
        createdAt: 1_700_000_000_000 - idx * 1000,
        updatedAt: 1_700_000_000_000 - idx * 1000,
        contentUpdatedAt: 1_700_000_000_000 - idx * 1000,
      })
    );

    installMockKapsulaApi({
      queryVault: vi.fn(async () => mockItems),
      getVaultItem: vi.fn(async (id) => mockItems.find((m) => m.id === id) ?? null),
      listOrbits: vi.fn(async () => [makeOrbit()]),
    });

    const { container } = renderWithI18n(
      <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
    );

    const grid = await screen.findByTestId('feed-grid-container');
    await waitFor(() => {
      expect(grid.querySelectorAll('[data-testid^="memory-card-"]').length).toBeGreaterThanOrEqual(10);
    });
    const mountedGridCards = grid.querySelectorAll('[data-testid^="memory-card-"]').length;
    expect(mountedGridCards).toBeLessThan(40);
    expect((grid as unknown as { __aa_tgt?: unknown }).__aa_tgt).toBeUndefined();
    expect(container.innerHTML).not.toContain('__aa_tgt');

    // Verify scrollTop is preserved across opening and closing NoteStudio
    const scroller = grid.closest('.overflow-y-auto') as HTMLElement;
    expect(scroller).toBeTruthy();
    scroller.scrollTop = 1800;
    await act(async () => {
      fireEvent.scroll(scroller);
      await new Promise((r) => setTimeout(r, 35));
    });

    const firstCard = grid.querySelector('[data-testid^="memory-card-"]') as HTMLElement;
    expect(firstCard).toBeTruthy();
    fireEvent.click(firstCard);

    await screen.findByTestId('note-studio-title', {}, { timeout: 5000 });
    const closeStudioBtn = screen.getByTestId('note-studio-close');
    await act(async () => {
      fireEvent.click(closeStudioBtn);
    });
    expect(scroller.scrollTop).toBe(1800);

    // Switch to List view (52px rows, totalHeight = 250 * 52 = 13000px) and scroll to 4000px
    const listBtn = screen.getByRole('tab', { name: 'Список' });
    fireEvent.click(listBtn);

    const listEl = await screen.findByTestId('feed-list-container');
    expect(listEl.style.height).toBe('13000px');

    const listScroller = listEl.closest('.overflow-y-auto') as HTMLElement;
    listScroller.scrollTop = 4000;
    await act(async () => {
      fireEvent.scroll(listScroller);
      await new Promise((r) => setTimeout(r, 35));
    });

    expect(listEl.querySelector('[data-testid="compact-row-feed-item-0"]')).toBeNull();
    expect(listEl.querySelector('[data-testid="compact-row-feed-item-80"]')).not.toBeNull();
  });

  it('virtualizes 180-item MediaHubView with lazy context menus and no motion.article layout projection', async () => {
    const mediaItems = Array.from({ length: 180 }, (_, idx) =>
      makeVaultItem({
        id: `media-item-${idx}`,
        dna: 'shot',
        title: `Референс ${idx}`,
        imagePath: `shot-${idx}.png`,
        thumbPath: `thumb-${idx}.png`,
        createdAt: 1_700_000_000_000 - idx * 1000,
      })
    );

    renderWithI18n(
      <MediaHubView
        items={mediaItems}
        orbits={[makeOrbit()]}
        focusBoards={[]}
        searchQuery=""
        serverSearchIds={null}
        soundEnabled={false}
        onOpenStudio={vi.fn()}
        onOpenLightbox={vi.fn()}
        onTogglePin={vi.fn()}
        onMoveToOrbit={vi.fn()}
        onMoveToBoard={vi.fn()}
        onDelete={vi.fn()}
        onUpdateCanvasPosition={vi.fn()}
      />
    );

    const mediaGrid = await screen.findByTestId('media-visual-grid');
    const mountedTiles = mediaGrid.querySelectorAll('[data-testid^="media-tile-"]');
    expect(mountedTiles.length).toBeGreaterThan(0);
    expect(mountedTiles.length).toBeLessThan(45);
    // Context menu should not eagerly mount menu DOM nodes during grid render
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it('passes full visibleItems (150 items) to QuickLookModal navigation', async () => {
    const mockItems = Array.from({ length: 150 }, (_, idx) =>
      makeVaultItem({
        id: `ql-item-${idx}`,
        title: `Карточка ${idx}`,
        body: `Текст ${idx}`,
        createdAt: 1_700_000_000_000 - idx * 1000,
      })
    );
    installMockKapsulaApi({
      queryVault: vi.fn(async () => mockItems),
      getVaultItem: vi.fn(async (id) => mockItems.find((m) => m.id === id) ?? null),
    });

    renderWithI18n(
      <StudioWorkspace settings={makeSettingsState({ viewLayout: 'grid' })} onSettingsUpdated={vi.fn()} />
    );

    const grid = await screen.findByTestId('feed-grid-container');
    await waitFor(() => {
      expect(grid.querySelectorAll('[data-testid^="memory-card-"]').length).toBeGreaterThanOrEqual(10);
    });

    const firstCard = screen.getByTestId('memory-card-ql-item-0');
    fireEvent.mouseEnter(firstCard);
    fireEvent.keyDown(window, { key: ' ' });

    const modal = await screen.findByTestId('quick-look-modal');
    expect(modal.textContent).toContain('1 / 150');
  });

  it('unmounts SettingsModal cleanly from DOM after closing via usePresenceMount', async () => {
    const mockItems = [makeVaultItem({ id: 'single-1', title: 'Один элемент' })];
    installMockKapsulaApi({
      queryVault: vi.fn(async () => mockItems),
    });

    renderWithI18n(
      <StudioWorkspace settings={makeSettingsState()} onSettingsUpdated={vi.fn()} />
    );

    await screen.findByTestId('feed-grid-container');
    expect(screen.queryByTestId('settings-modal')).toBeNull();

    const settingsBtn = screen.getByTestId('open-settings-btn');
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(document.body.textContent).toContain('Внешний вид');
    });

    // Close modal via Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(
      () => {
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      },
      { timeout: 1000 }
    );
  });

  it('uses 1-frame sidebar slot snap + GPU transform without width transition', async () => {
    const mockItems = Array.from({ length: 12 }, (_, idx) =>
      makeVaultItem({ id: `sb-item-${idx}`, title: `Запись ${idx}` })
    );
    installMockKapsulaApi({
      queryVault: vi.fn(async () => mockItems),
    });

    renderWithI18n(
      <StudioWorkspace settings={makeSettingsState()} onSettingsUpdated={vi.fn()} />
    );

    const sidebar = await screen.findByTestId('workspace-sidebar');
    expect(sidebar.tagName.toLowerCase()).toBe('aside');
    expect(sidebar.style.width).toBe('244px');

    const collapseBtn = sidebar.querySelector('[data-testid="toggle-sidebar-btn"]') as HTMLElement;
    fireEvent.click(collapseBtn);

    // Header expand button mounts immediately on t=0 without waiting 110ms
    const headerExpandBtn = await screen.findByLabelText('Показать боковую панель');
    expect(headerExpandBtn).toBeTruthy();

    await waitFor(
      () => {
        expect(sidebar.style.width).toBe('0px');
        expect(sidebar.style.display).toBe('none');
      },
      { timeout: 500 }
    );
  });

  it('adjusts scrollTop by max column delta (410, not 530) when parallel masonry columns grow above viewport', async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    const origOffsetDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const heights = new Map<string, number>();
    for (let i = 0; i < 9; i += 1) heights.set(`cell-${i}`, 120);

    const observerEntries: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    globalThis.ResizeObserver = class MockResizeObserver {
      private cb: ResizeObserverCallback;
      private targets = new Set<Element>();
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        observerEntries.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    };

    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        const key = (this as HTMLElement).dataset?.vgridKey;
        if (key && heights.has(key)) return heights.get(key)!;
        return 120;
      },
    });

    try {
      const items = Array.from({ length: 9 }, (_, i) => ({ id: `cell-${i}` }));
      const getKey = (it: { id: string }) => it.id;
      const estimateHeight = () => 120;
      const getColumns = () => 3;
      const renderItem = (it: { id: string }) => React.createElement('div', null, it.id);

      const { container } = renderWithI18n(
        <div className="overflow-y-auto" style={{ height: '900px' }}>
          <VirtualizedMasonryGrid
            items={items}
            getKey={getKey}
            estimateHeight={estimateHeight}
            getColumns={getColumns}
            overscanTopPx={400}
            renderItem={renderItem}
          />
        </div>
      );

      const scroller = container.firstElementChild as HTMLElement;
      scroller.scrollTop = 350;
      await act(async () => {
        fireEvent.scroll(scroller);
        await new Promise((r) => setTimeout(r, 35));
      });
      expect(scroller.scrollTop).toBe(350);

      // Grow all 3 row-0 cards (in 3 parallel columns above curRelTop=350) by +60px each
      heights.set('cell-0', 180);
      heights.set('cell-1', 180);
      heights.set('cell-2', 180);

      const row0Els = ['cell-0', 'cell-1', 'cell-2']
        .map((k) => container.querySelector(`[data-vgrid-key="${k}"]`))
        .filter((el): el is Element => Boolean(el));
      expect(row0Els).toHaveLength(3);

      await act(async () => {
        for (const rec of observerEntries) {
          const matched = row0Els.filter((el) => rec.targets.has(el));
          if (matched.length > 0) {
            rec.cb(
              matched.map((target) => ({ target }) as unknown as ResizeObserverEntry),
              {} as ResizeObserver
            );
          }
        }
        await new Promise((r) => setTimeout(r, 35));
      });

      expect(scroller.scrollTop).toBe(410);
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver;
      if (origOffsetDesc) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetDesc);
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      }
    }
  });
});
