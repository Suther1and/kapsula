import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

interface RectSnap {
  top: number;
  bottom: number;
  height: number;
  centerY: number;
}

interface ActiveDragState<T extends string> {
  id: T;
  startIndex: number;
  overIndex: number;
  offsetY: number;
  slotStep: number;
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 2) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

export function reorderArrayByIndex<T>(ids: readonly T[], fromIndex: number, toIndex: number): T[] | null {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= ids.length ||
    toIndex >= ids.length ||
    fromIndex === toIndex
  ) {
    return null;
  }
  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return null;
  next.splice(toIndex, 0, moved);
  return next;
}

export function computeTargetOverIndex(
  rects: readonly RectSnap[],
  currentOverIndex: number,
  draggedCenterY: number,
  hysteresisPx = 4
): number {
  let nextIdx = currentOverIndex;
  while (nextIdx < rects.length - 1) {
    const cur = rects[nextIdx];
    const neighbor = rects[nextIdx + 1];
    if (!cur || !neighbor) break;
    const midpoint = (cur.centerY + neighbor.centerY) / 2;
    if (draggedCenterY <= midpoint + hysteresisPx) break;
    nextIdx += 1;
  }
  while (nextIdx > 0) {
    const cur = rects[nextIdx];
    const neighbor = rects[nextIdx - 1];
    if (!cur || !neighbor) break;
    const midpoint = (cur.centerY + neighbor.centerY) / 2;
    if (draggedCenterY >= midpoint - hysteresisPx) break;
    nextIdx -= 1;
  }
  return nextIdx;
}

interface UsePointerSortableOptions<T extends string> {
  ids: readonly T[];
  onCommit: (nextIds: T[]) => void;
  disabled?: boolean;
  prefersReducedMotion?: boolean;
}

/**
 * Smooth pointer-driven vertical sortable list (zero native HTML5 drag ghost / zero double card).
 * The grabbed row follows the cursor 1:1 while sibling rows shift out of the way with spring-like CSS easing,
 * and hysteresis prevents jitter on item boundaries.
 */
export function usePointerSortableList<T extends string>({
  ids,
  onCommit,
  disabled = false,
  prefersReducedMotion = false,
}: UsePointerSortableOptions<T>) {
  const [activeDrag, setActiveDrag] = useState<ActiveDragState<T> | null>(null);
  const itemElsRef = useRef<Map<T, HTMLElement>>(new Map());
  const idsRef = useRef<readonly T[]>(ids);
  idsRef.current = ids;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const suppressClickUntilRef = useRef<number>(0);

  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const registerItemRef = useCallback(
    (id: T) => (el: HTMLElement | null) => {
      if (el) {
        itemElsRef.current.set(id, el);
      } else {
        itemElsRef.current.delete(id);
      }
    },
    []
  );

  const shouldSuppressClick = useCallback(() => {
    if (Date.now() < suppressClickUntilRef.current) {
      suppressClickUntilRef.current = 0;
      return true;
    }
    return false;
  }, []);

  const handlePointerDown = useCallback(
    (id: T, e: ReactPointerEvent<HTMLElement>) => {
      if (disabled) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const nestedBtn = target?.closest('button, input, textarea, a');
      if (nestedBtn && nestedBtn !== e.currentTarget) return;

      const currentIds = idsRef.current;
      if (currentIds.length < 2) return;
      const startIndex = currentIds.indexOf(id);
      if (startIndex === -1) return;

      const startClientY = e.clientY;
      const pointerId = e.pointerId;
      const anchorEl = e.currentTarget;

      let started = false;
      let rects: RectSnap[] = [];
      let slotStep = 36;
      let minOffset = 0;
      let maxOffset = 0;
      let curOverIndex = startIndex;
      let scrollParent: HTMLElement | null = null;
      let startScrollTop = 0;
      let lastClientY = startClientY;
      let autoScrollRaf: number | null = null;
      let prevBodyCursor = '';
      let prevBodyUserSelect = '';

      const stopAutoScroll = () => {
        if (autoScrollRaf !== null) {
          window.cancelAnimationFrame(autoScrollRaf);
          autoScrollRaf = null;
        }
      };

      const updatePosition = (clientY: number) => {
        lastClientY = clientY;
        const scrollDelta = scrollParent ? scrollParent.scrollTop - startScrollTop : 0;
        const rawOffset = clientY - startClientY + scrollDelta;
        const clampedOffset = Math.max(minOffset, Math.min(maxOffset, rawOffset));
        const draggedSnap = rects[startIndex];
        if (!draggedSnap) return;
        const draggedCenterY = draggedSnap.centerY + clampedOffset;
        curOverIndex = computeTargetOverIndex(rects, curOverIndex, draggedCenterY, 4);
        setActiveDrag({
          id,
          startIndex,
          overIndex: curOverIndex,
          offsetY: clampedOffset,
          slotStep,
        });
      };

      const tickAutoScroll = () => {
        if (!started || !scrollParent) {
          autoScrollRaf = null;
          return;
        }
        const bounds = scrollParent.getBoundingClientRect();
        const edge = 28;
        let delta = 0;
        if (lastClientY < bounds.top + edge) {
          delta = -Math.ceil(((bounds.top + edge - lastClientY) / edge) * 6);
        } else if (lastClientY > bounds.bottom - edge) {
          delta = Math.ceil(((lastClientY - (bounds.bottom - edge)) / edge) * 6);
        }
        if (delta !== 0) {
          const prevTop = scrollParent.scrollTop;
          scrollParent.scrollTop = prevTop + delta;
          if (scrollParent.scrollTop !== prevTop) {
            updatePosition(lastClientY);
          }
        }
        autoScrollRaf = window.requestAnimationFrame(tickAutoScroll);
      };

      const startDrag = (clientY: number) => {
        const snapshot: RectSnap[] = [];
        for (const itemId of currentIds) {
          const el = itemElsRef.current.get(itemId);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          snapshot.push({
            top: r.top,
            bottom: r.bottom,
            height: r.height,
            centerY: r.top + r.height / 2,
          });
        }
        rects = snapshot;
        const draggedSnap = rects[startIndex];
        const firstSnap = rects[0];
        const lastSnap = rects[rects.length - 1];
        if (!draggedSnap || !firstSnap || !lastSnap) return false;

        if (rects.length >= 2) {
          const stepCandidate = rects[1]!.top - rects[0]!.top;
          slotStep = stepCandidate > 0 ? stepCandidate : draggedSnap.height + 4;
        } else {
          slotStep = draggedSnap.height + 4;
        }
        minOffset = firstSnap.top - draggedSnap.top - 6;
        maxOffset = lastSnap.bottom - draggedSnap.bottom + 6;
        scrollParent = findScrollParent(anchorEl);
        startScrollTop = scrollParent?.scrollTop ?? 0;

        started = true;
        prevBodyCursor = document.body.style.cursor;
        prevBodyUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        updatePosition(clientY);
        if (scrollParent) {
          autoScrollRaf = window.requestAnimationFrame(tickAutoScroll);
        }
        return true;
      };

      const finish = (commit: boolean) => {
        cleanup();
        if (!started) return;
        suppressClickUntilRef.current = Date.now() + 260;
        const targetIndex = curOverIndex;
        setActiveDrag(null);
        if (commit && targetIndex !== startIndex) {
          const next = reorderArrayByIndex(idsRef.current, startIndex, targetIndex);
          if (next) {
            onCommitRef.current(next);
          }
        }
      };

      const onPointerMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!started) {
          if (Math.abs(ev.clientY - startClientY) < 5) return;
          if (!startDrag(ev.clientY)) {
            cleanup();
          }
          return;
        }
        ev.preventDefault();
        updatePosition(ev.clientY);
      };

      const onPointerUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(true);
      };

      const onPointerCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(false);
      };

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && started) {
          ev.preventDefault();
          ev.stopPropagation();
          finish(false);
        }
      };

      const cleanup = () => {
        stopAutoScroll();
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown, true);
        if (started) {
          document.body.style.cursor = prevBodyCursor;
          document.body.style.userSelect = prevBodyUserSelect;
        }
        cleanupRef.current = null;
      };

      cleanupRef.current?.();
      cleanupRef.current = cleanup;
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown, true);
    },
    [disabled]
  );

  const getItemDragStyle = useCallback(
    (id: T, index: number): CSSProperties | undefined => {
      if (!activeDrag) return undefined;
      if (activeDrag.id === id) {
        return {
          transform: `translate3d(0, ${Math.round(activeDrag.offsetY)}px, 0) scale(1.012)`,
          zIndex: 30,
          position: 'relative',
          transition: 'none',
          willChange: 'transform',
        };
      }
      let shiftY = 0;
      if (activeDrag.startIndex < activeDrag.overIndex) {
        if (index > activeDrag.startIndex && index <= activeDrag.overIndex) {
          shiftY = -activeDrag.slotStep;
        }
      } else if (activeDrag.startIndex > activeDrag.overIndex) {
        if (index >= activeDrag.overIndex && index < activeDrag.startIndex) {
          shiftY = activeDrag.slotStep;
        }
      }
      return {
        transform: `translate3d(0, ${Math.round(shiftY)}px, 0)`,
        position: 'relative',
        zIndex: 1,
        transition: prefersReducedMotion
          ? 'none'
          : 'transform 175ms cubic-bezier(0.22, 1, 0.36, 1)',
      };
    },
    [activeDrag, prefersReducedMotion]
  );

  return {
    draggingId: activeDrag?.id ?? null,
    isAnyDragging: activeDrag !== null,
    registerItemRef,
    handlePointerDown,
    getItemDragStyle,
    shouldSuppressClick,
  };
}
