import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

interface ProseCaretOverlayProps {
  editor: Editor | null;
  containerEl: HTMLElement | null;
}

interface CaretGeometry {
  x: number;
  y: number;
  height: number;
}

const WIDE_FOOT_CYRILLIC_RE = /[дцщткфл]/i;
const WORD_END_AFTER_RE = /[\s.,!?;:)\]}]/;

function computeOpticalOffsetX(charBefore: string, charAfter: string): number {
  if (!charBefore) return 0;
  if (!charAfter || WORD_END_AFTER_RE.test(charAfter)) {
    return /\s/.test(charBefore) ? 0.5 : 2.25;
  }
  return WIDE_FOOT_CYRILLIC_RE.test(charBefore) ? 0.75 : 0.25;
}

export const ProseCaretOverlay: React.FC<ProseCaretOverlayProps> = ({
  editor,
  containerEl,
}) => {
  const [caret, setCaret] = useState<CaretGeometry | null>(null);
  const [blinking, setBlinking] = useState(false);
  const isComposingRef = useRef(false);
  const blinkTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!containerEl) return;
    containerEl.classList.toggle('k-prose-custom-caret', caret !== null);
    return () => {
      containerEl.classList.remove('k-prose-custom-caret');
    };
  }, [containerEl, caret !== null]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !containerEl) {
      setCaret(null);
      setBlinking(false);
      return;
    }

    let viewDom: HTMLElement | null = null;
    try {
      viewDom = editor.view.dom;
    } catch {
      setCaret(null);
      setBlinking(false);
      return;
    }

    const clearBlinkTimer = () => {
      if (blinkTimerRef.current !== null) {
        window.clearTimeout(blinkTimerRef.current);
        blinkTimerRef.current = null;
      }
    };

    const scheduleBlinkResume = () => {
      setBlinking(false);
      clearBlinkTimer();
      blinkTimerRef.current = window.setTimeout(() => {
        blinkTimerRef.current = null;
        setBlinking(true);
      }, 480);
    };

    const compute = (resetBlink: boolean) => {
      if (!editor || editor.isDestroyed || isComposingRef.current) {
        clearBlinkTimer();
        setCaret(null);
        setBlinking(false);
        return;
      }

      let view: typeof editor.view;
      try {
        view = editor.view;
      } catch {
        setCaret(null);
        return;
      }

      const activeEl = document.activeElement;
      const isNestedFormControl =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement;
      const isFocusedEditor =
        editor.isFocused &&
        !isNestedFormControl &&
        Boolean(activeEl && (activeEl === view.dom || view.dom.contains(activeEl)));

      if (!isFocusedEditor) {
        clearBlinkTimer();
        setCaret(null);
        setBlinking(false);
        return;
      }

      const sel = editor.state.selection;
      if (!sel.empty || !sel.$head.parent.isTextblock) {
        clearBlinkTimer();
        setCaret(null);
        setBlinking(false);
        return;
      }

      const hostRect = containerEl.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) {
        setCaret(null);
        return;
      }

      let coords: { left: number; right: number; top: number; bottom: number };
      try {
        coords = view.coordsAtPos(sel.head);
      } catch {
        setCaret(null);
        return;
      }

      if (
        !Number.isFinite(coords.left) ||
        !Number.isFinite(coords.top) ||
        !Number.isFinite(coords.bottom)
      ) {
        setCaret(null);
        return;
      }

      const $head = sel.$head;
      const nodeBefore = $head.nodeBefore;
      const nodeAfter = $head.nodeAfter;
      const charBefore = nodeBefore?.isText && nodeBefore.text ? nodeBefore.text.slice(-1) : '';
      const charAfter = nodeAfter?.isText && nodeAfter.text ? nodeAfter.text.slice(0, 1) : '';
      const offsetX = computeOpticalOffsetX(charBefore, charAfter);

      const rawHeight = coords.bottom - coords.top;
      const fallbackFontSize = parseFloat(window.getComputedStyle(view.dom).fontSize) || 15;
      const height = Math.max(16, Math.round(rawHeight > 4 ? rawHeight : fallbackFontSize * 1.25));

      const rawX =
        coords.left - hostRect.left - containerEl.clientLeft + containerEl.scrollLeft + offsetX;
      const maxX = containerEl.scrollWidth > 2 ? containerEl.scrollWidth - 2 : rawX;
      const x = Math.max(0, Math.min(rawX, maxX));
      const y = coords.top - hostRect.top - containerEl.clientTop + containerEl.scrollTop;

      setCaret((prev) => {
        if (
          prev &&
          Math.abs(prev.x - x) < 0.05 &&
          Math.abs(prev.y - y) < 0.05 &&
          prev.height === height
        ) {
          return prev;
        }
        return { x, y, height };
      });

      if (resetBlink) {
        scheduleBlinkResume();
      }
    };

    const scheduleRafCompute = (resetBlink: boolean) => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        compute(resetBlink);
      });
    };

    const clearSettleTimer = () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    const onActivity = () => {
      compute(true);
      scheduleRafCompute(false);
    };

    const onFocus = () => {
      compute(true);
      scheduleRafCompute(false);
      // Re-sync once after any parent modal/sheet entrance transform (~175ms) settles
      clearSettleTimer();
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        compute(false);
      }, 210);
    };

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const didChange = transaction.docChanged || transaction.selectionSet;
      compute(didChange);
      if (didChange) {
        scheduleRafCompute(false);
      }
    };

    const onBlur = () => {
      clearBlinkTimer();
      clearSettleTimer();
      setCaret(null);
      setBlinking(false);
    };

    const onLayout = () => {
      scheduleRafCompute(false);
    };

    const onCompositionStart = () => {
      isComposingRef.current = true;
      clearBlinkTimer();
      clearSettleTimer();
      setCaret(null);
      setBlinking(false);
    };

    const onCompositionEnd = () => {
      isComposingRef.current = false;
      compute(true);
      scheduleRafCompute(false);
    };

    editor.on('selectionUpdate', onActivity);
    editor.on('transaction', onTransaction);
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);

    viewDom.addEventListener('compositionstart', onCompositionStart);
    viewDom.addEventListener('compositionend', onCompositionEnd);
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onLayout) : null;
    resizeObserver?.observe(containerEl);
    resizeObserver?.observe(viewDom);

    // Sync immediately if editor is already focused on mount
    if (editor.isFocused) {
      onFocus();
    }

    return () => {
      clearBlinkTimer();
      clearSettleTimer();
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      editor.off('selectionUpdate', onActivity);
      editor.off('transaction', onTransaction);
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
      viewDom?.removeEventListener('compositionstart', onCompositionStart);
      viewDom?.removeEventListener('compositionend', onCompositionEnd);
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
      resizeObserver?.disconnect();
    };
  }, [editor, containerEl]);

  if (!caret) return null;

  return (
    <span
      aria-hidden="true"
      data-testid="prose-custom-caret"
      data-blinking={blinking ? 'true' : 'false'}
      className="k-prose-caret"
      style={{
        height: `${caret.height}px`,
        transform: `translate3d(${caret.x}px, ${caret.y}px, 0)`,
      }}
    />
  );
};
