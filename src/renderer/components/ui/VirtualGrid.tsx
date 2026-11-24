import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface MasonryPlacement<T> {
  item: T;
  key: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MasonryLayoutResult<T> {
  placements: MasonryPlacement<T>[];
  totalHeight: number;
}

export function getFeedColumns(containerWidth: number): number {
  if (containerWidth >= 880) return 3;
  if (containerWidth >= 560) return 2;
  return 1;
}

export function getMediaColumns(containerWidth: number, compact: boolean): number {
  if (compact) {
    if (containerWidth >= 1240) return 5;
    if (containerWidth >= 940) return 4;
    if (containerWidth >= 640) return 3;
    return 2;
  }
  if (containerWidth >= 1220) return 4;
  if (containerWidth >= 880) return 3;
  if (containerWidth >= 560) return 2;
  return 1;
}

export function computeMasonryLayout<T>(
  items: readonly T[],
  opts: {
    colWidth: number;
    cols: number;
    gapPx: number;
    getKey: (item: T) => string;
    getHeight: (item: T, colWidth: number) => number;
  }
): MasonryLayoutResult<T> {
  const cols = Math.max(1, Math.floor(opts.cols));
  const colWidth = Math.max(80, opts.colWidth);
  const gapPx = Math.max(0, opts.gapPx);
  const colHeights = new Float64Array(cols);
  const placements: MasonryPlacement<T>[] = new Array(items.length);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const key = opts.getKey(item);
    let minCol = 0;
    let minH = colHeights[0]!;
    for (let c = 1; c < cols; c += 1) {
      if (colHeights[c]! < minH) {
        minH = colHeights[c]!;
        minCol = c;
      }
    }
    const rawH = opts.getHeight(item, colWidth);
    const height = Math.max(40, Math.round(Number.isFinite(rawH) ? rawH : 160));
    const x = Math.round(minCol * (colWidth + gapPx));
    const y = Math.round(minH);
    placements[i] = {
      item,
      key,
      index: i,
      x,
      y,
      width: colWidth,
      height,
    };
    colHeights[minCol] = y + height + gapPx;
  }

  let maxColHeight = 0;
  for (let c = 0; c < cols; c += 1) {
    if (colHeights[c]! > maxColHeight) maxColHeight = colHeights[c]!;
  }
  const totalHeight = maxColHeight > 0 ? Math.max(0, Math.round(maxColHeight - gapPx)) : 0;
  return { placements, totalHeight };
}

export function filterVisiblePlacements<T>(
  placements: readonly MasonryPlacement<T>[],
  viewTop: number,
  viewBottom: number
): MasonryPlacement<T>[] {
  const visible: MasonryPlacement<T>[] = [];
  for (let i = 0; i < placements.length; i += 1) {
    const p = placements[i]!;
    if (p.y + p.height >= viewTop && p.y <= viewBottom) {
      visible.push(p);
    }
  }
  return visible;
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    try {
      const style = window.getComputedStyle(cur);
      if (
        /(?:auto|scroll|overlay)/.test(style.overflowY) ||
        cur.classList?.contains('overflow-y-auto') ||
        cur.classList?.contains('overflow-y-scroll')
      ) {
        return cur;
      }
    } catch {
      // ignore in JSDOM edge cases
    }
    cur = cur.parentElement;
  }
  return null;
}

function readViewportMetrics(containerEl: HTMLElement | null, scrollerEl: HTMLElement | null) {
  const fallbackW = 960;
  const fallbackH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 900;
  if (!containerEl) {
    return {
      containerWidth: fallbackW,
      scrollTop: 0,
      viewportHeight: fallbackH,
      offsetTop: 0,
    };
  }
  const rawWidth = containerEl.clientWidth;
  const containerWidth = rawWidth > 0 ? rawWidth : fallbackW;

  if (!scrollerEl) {
    return {
      containerWidth,
      scrollTop: typeof window !== 'undefined' ? window.scrollY || 0 : 0,
      viewportHeight: fallbackH,
      offsetTop: 0,
    };
  }

  const scrollerH = scrollerEl.clientHeight > 0 ? scrollerEl.clientHeight : fallbackH;
  let offsetTop = 0;
  if (scrollerEl.clientHeight > 0) {
    try {
      const cRect = containerEl.getBoundingClientRect();
      const sRect = scrollerEl.getBoundingClientRect();
      offsetTop = Math.max(0, cRect.top - sRect.top + scrollerEl.scrollTop);
    } catch {
      offsetTop = 0;
    }
  }
  return {
    containerWidth,
    scrollTop: scrollerEl.scrollTop,
    viewportHeight: scrollerH,
    offsetTop,
  };
}

export interface VirtualizedMasonryGridProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  estimateHeight: (item: T, colWidth: number) => number;
  getColumns: (containerWidth: number) => number;
  gapPx?: number;
  overscanTopPx?: number;
  overscanBottomPx?: number;
  testId?: string;
  className?: string;
  onReachEnd?: () => void;
  renderItem: (item: T, index: number) => React.ReactNode;
}

export function VirtualizedMasonryGrid<T>({
  items,
  getKey,
  estimateHeight,
  getColumns,
  gapPx = 14,
  overscanTopPx = 400,
  overscanBottomPx = 500,
  testId,
  className,
  onReachEnd,
  renderItem,
}: VirtualizedMasonryGridProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState(() => ({
    containerWidth: 960,
    scrollTop: 0,
    viewportHeight: typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 900,
    offsetTop: 0,
  }));
  const [measureVersion, setMeasureVersion] = useState(0);

  const heightCacheRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const cellElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const measureRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const cellRoRef = useRef<ResizeObserver | null>(null);
  const syncMeasurePassRef = useRef(0);

  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;

  const cols = Math.max(1, getColumns(metrics.containerWidth));
  const colWidth = Math.max(
    80,
    Math.floor((metrics.containerWidth - gapPx * Math.max(0, cols - 1)) / cols)
  );

  const getHeightForLayout = useCallback(
    (item: T, width: number) => {
      const key = getKey(item);
      const cached = heightCacheRef.current.get(key);
      if (cached && Math.abs(cached.width - width) <= 1) {
        return cached.height;
      }
      return estimateHeight(item, width);
    },
    [getKey, estimateHeight]
  );

  const layout = useMemo(
    () =>
      computeMasonryLayout(items, {
        colWidth,
        cols,
        gapPx,
        getKey,
        getHeight: getHeightForLayout,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, colWidth, cols, gapPx, getKey, getHeightForLayout, measureVersion]
  );

  const relScrollTop = Math.max(0, metrics.scrollTop - metrics.offsetTop);
  const viewTop = Math.max(0, relScrollTop - overscanTopPx);
  const viewBottom = relScrollTop + metrics.viewportHeight + overscanBottomPx;

  const visiblePlacements = useMemo(
    () => filterVisiblePlacements(layout.placements, viewTop, viewBottom),
    [layout.placements, viewTop, viewBottom]
  );

  const layoutPlacementMapRef = useRef<Map<string, MasonryPlacement<T>>>(new Map());
  const placementMap = new Map<string, MasonryPlacement<T>>();
  for (let i = 0; i < layout.placements.length; i += 1) {
    const p = layout.placements[i]!;
    placementMap.set(p.key, p);
  }
  layoutPlacementMapRef.current = placementMap;

  const relScrollTopRef = useRef(relScrollTop);
  relScrollTopRef.current = relScrollTop;
  const colWidthRef = useRef(colWidth);
  colWidthRef.current = colWidth;

  const flushMeasuredCells = useCallback(
    (keys: Iterable<string>) => {
      let changed = false;
      const colDeltas = new Map<number, number>();
      const curColWidth = colWidthRef.current;
      const curRelTop = relScrollTopRef.current;
      const scroller = scrollerRef.current;

      for (const key of keys) {
        const el = cellElementsRef.current.get(key);
        if (!el) continue;
        const measuredH = Math.round(el.offsetHeight);
        if (measuredH <= 0) continue;
        const prev = heightCacheRef.current.get(key);
        if (!prev || Math.abs(prev.height - measuredH) >= 1 || Math.abs(prev.width - curColWidth) > 1) {
          const placement = layoutPlacementMapRef.current.get(key);
          const prevH = prev && Math.abs(prev.width - curColWidth) <= 1 ? prev.height : placement?.height ?? measuredH;
          heightCacheRef.current.set(key, { width: curColWidth, height: measuredH });
          changed = true;
          if (
            scroller &&
            scroller.scrollTop > 0 &&
            placement &&
            placement.y + prevH < curRelTop
          ) {
            const delta = measuredH - prevH;
            colDeltas.set(placement.x, (colDeltas.get(placement.x) ?? 0) + delta);
          }
        }
      }

      let scrollAdjust = 0;
      for (const colDelta of colDeltas.values()) {
        if (Math.abs(colDelta) > Math.abs(scrollAdjust)) {
          scrollAdjust = colDelta;
        }
      }

      if (scrollAdjust !== 0 && scroller && scroller.scrollTop > 0) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop + scrollAdjust);
      }
      if (changed) {
        setMeasureVersion((v) => v + 1);
      }
      return changed;
    },
    []
  );

  // Measure container width, scroll parent & mounted cell ResizeObserver
  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const scroller = findScrollParent(containerEl);
    scrollerRef.current = scroller;

    const syncMetrics = () => {
      const next = readViewportMetrics(containerEl, scrollerRef.current);
      setMetrics((prev) => {
        if (
          Math.abs(prev.containerWidth - next.containerWidth) < 1 &&
          Math.abs(prev.scrollTop - next.scrollTop) < 24 &&
          Math.abs(prev.viewportHeight - next.viewportHeight) < 2 &&
          Math.abs(prev.offsetTop - next.offsetTop) < 4
        ) {
          return prev;
        }
        return next;
      });
    };

    syncMetrics();

    const onScroll = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const next = readViewportMetrics(containerEl, scrollerRef.current);
        setMetrics((prev) => {
          if (
            Math.abs(prev.scrollTop - next.scrollTop) < 24 &&
            Math.abs(prev.viewportHeight - next.viewportHeight) < 2 &&
            Math.abs(prev.containerWidth - next.containerWidth) < 1 &&
            Math.abs(prev.offsetTop - next.offsetTop) < 4
          ) {
            return prev;
          }
          return next;
        });
      });
    };

    const scrollTarget: HTMLElement | Window = scroller ?? window;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    let containerRo: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      containerRo = new ResizeObserver(() => {
        const next = readViewportMetrics(containerEl, scrollerRef.current);
        setMetrics((prev) => {
          if (
            Math.abs(prev.containerWidth - next.containerWidth) < 1 &&
            Math.abs(prev.viewportHeight - next.viewportHeight) < 2 &&
            Math.abs(prev.offsetTop - next.offsetTop) < 4
          ) {
            return prev;
          }
          return next;
        });
      });
      containerRo.observe(containerEl);
      if (scroller) containerRo.observe(scroller);
    }

    return () => {
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      containerRo?.disconnect();
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // Mounted-only cell ResizeObserver coalesced into 1 rAF
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      let added = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vgridKey;
        if (key) {
          dirtyKeysRef.current.add(key);
          added = true;
        }
      }
      if (!added || measureRafRef.current !== null) return;
      measureRafRef.current = window.requestAnimationFrame(() => {
        measureRafRef.current = null;
        const batch = Array.from(dirtyKeysRef.current);
        dirtyKeysRef.current.clear();
        flushMeasuredCells(batch);
      });
    });
    cellRoRef.current = ro;

    for (const el of cellElementsRef.current.values()) {
      ro.observe(el);
    }

    return () => {
      ro.disconnect();
      cellRoRef.current = null;
      dirtyKeysRef.current.clear();
      if (measureRafRef.current !== null) {
        window.cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
    };
  }, [flushMeasuredCells]);

  // Pre-paint synchronous measurement for newly mounted / width-changed / styled cells (CLS = 0)
  useLayoutEffect(() => {
    const staleKeys: string[] = [];
    for (const p of visiblePlacements) {
      const cached = heightCacheRef.current.get(p.key);
      if (!cached || Math.abs(cached.width - colWidth) > 1) {
        staleKeys.push(p.key);
        continue;
      }
      const el = cellElementsRef.current.get(p.key);
      if (el) {
        const measuredH = Math.round(el.offsetHeight);
        if (measuredH > 0 && Math.abs(measuredH - p.height) >= 1) {
          staleKeys.push(p.key);
        }
      }
    }
    if (staleKeys.length > 0 && syncMeasurePassRef.current < 2) {
      syncMeasurePassRef.current += 1;
      const didChange = flushMeasuredCells(staleKeys);
      if (didChange) return;
    }
    syncMeasurePassRef.current = 0;
  }, [visiblePlacements, colWidth, flushMeasuredCells]);

  // Trigger infinite scroll near end
  useEffect(() => {
    if (items.length === 0 || !onReachEndRef.current) return;
    if (viewBottom >= layout.totalHeight - 400) {
      onReachEndRef.current();
    }
  }, [items.length, viewBottom, layout.totalHeight]);

  // Prune heightCache when items list shrinks significantly
  useEffect(() => {
    if (heightCacheRef.current.size <= items.length + 120) return;
    const valid = new Set<string>();
    for (let i = 0; i < items.length; i += 1) {
      valid.add(getKey(items[i]!));
    }
    for (const k of heightCacheRef.current.keys()) {
      if (!valid.has(k)) heightCacheRef.current.delete(k);
    }
  }, [items, getKey]);

  const cellRefCallbacksRef = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());

  const setCellRef = useCallback((key: string, el: HTMLDivElement | null) => {
    const prevEl = cellElementsRef.current.get(key);
    if (prevEl && prevEl !== el) {
      cellRoRef.current?.unobserve(prevEl);
      cellElementsRef.current.delete(key);
    }
    if (el) {
      cellElementsRef.current.set(key, el);
      cellRoRef.current?.observe(el);
    }
  }, []);

  const getCellRefCallback = useCallback(
    (key: string) => {
      let cb = cellRefCallbacksRef.current.get(key);
      if (!cb) {
        cb = (el: HTMLDivElement | null) => {
          setCellRef(key, el);
        };
        cellRefCallbacksRef.current.set(key, cb);
      }
      return cb;
    },
    [setCellRef]
  );

  useEffect(() => {
    const visibleKeys = new Set<string>();
    for (let i = 0; i < visiblePlacements.length; i += 1) {
      visibleKeys.add(visiblePlacements[i]!.key);
    }
    for (const key of cellRefCallbacksRef.current.keys()) {
      if (!visibleKeys.has(key)) {
        cellRefCallbacksRef.current.delete(key);
      }
    }
  }, [visiblePlacements]);

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className={className}
      style={{ position: 'relative', height: `${layout.totalHeight}px` }}
    >
      {visiblePlacements.map((p) => (
        <div
          key={p.key}
          data-vgrid-key={p.key}
          ref={getCellRefCallback(p.key)}
          className="min-w-0"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${p.width}px`,
            transform: `translate3d(${p.x}px, ${p.y}px, 0)`,
          }}
        >
          {renderItem(p.item, p.index)}
        </div>
      ))}
    </div>
  );
}

export interface VirtualizedFixedListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  rowHeight?: number;
  overscanCount?: number;
  testId?: string;
  className?: string;
  onReachEnd?: () => void;
  renderRow: (item: T, index: number) => React.ReactNode;
}

export function VirtualizedFixedList<T>({
  items,
  getKey,
  rowHeight = 52,
  overscanCount = 8,
  testId,
  className,
  onReachEnd,
  renderRow,
}: VirtualizedFixedListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;

  const [metrics, setMetrics] = useState(() => ({
    scrollTop: 0,
    viewportHeight: typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 900,
    offsetTop: 0,
  }));

  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const scroller = findScrollParent(containerEl);
    scrollerRef.current = scroller;

    const syncMetrics = () => {
      const next = readViewportMetrics(containerEl, scrollerRef.current);
      setMetrics((prev) => {
        if (
          Math.abs(prev.scrollTop - next.scrollTop) < 24 &&
          Math.abs(prev.viewportHeight - next.viewportHeight) < 2 &&
          Math.abs(prev.offsetTop - next.offsetTop) < 4
        ) {
          return prev;
        }
        return {
          scrollTop: next.scrollTop,
          viewportHeight: next.viewportHeight,
          offsetTop: next.offsetTop,
        };
      });
    };

    syncMetrics();

    const onScroll = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        syncMetrics();
      });
    };

    const scrollTarget: HTMLElement | Window = scroller ?? window;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const totalHeight = items.length * rowHeight;
  const relScrollTop = Math.max(0, metrics.scrollTop - metrics.offsetTop);
  const startIdx = Math.max(0, Math.floor(relScrollTop / rowHeight) - overscanCount);
  const endIdx = Math.min(
    items.length,
    Math.ceil((relScrollTop + metrics.viewportHeight) / rowHeight) + overscanCount
  );

  useEffect(() => {
    if (items.length === 0 || !onReachEndRef.current) return;
    if (relScrollTop + metrics.viewportHeight + overscanCount * rowHeight >= totalHeight - 400) {
      onReachEndRef.current();
    }
  }, [items.length, relScrollTop, metrics.viewportHeight, overscanCount, rowHeight, totalHeight]);

  const slice = items.slice(startIdx, endIdx);

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className={className}
      style={{ position: 'relative', height: `${totalHeight}px` }}
    >
      {slice.map((item, offset) => {
        const index = startIdx + offset;
        const isLast = index === items.length - 1;
        return (
          <div
            key={getKey(item)}
            className={isLast ? undefined : 'border-b border-[var(--k-border-hairline)]'}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: `${rowHeight}px`,
              transform: `translate3d(0, ${index * rowHeight}px, 0)`,
            }}
          >
            {renderRow(item, index)}
          </div>
        );
      })}
    </div>
  );
}
