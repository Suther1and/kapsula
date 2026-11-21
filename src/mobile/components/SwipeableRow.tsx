import React, { useEffect, useRef, useState } from 'react';
import { mobileBridge } from '../native/bridge';

export interface SwipeActionConfig {
  label: string;
  icon: React.ReactNode;
  bgClass: string;
  textClass?: string;
  onTrigger: () => void;
}

interface SwipeableRowProps {
  children: React.ReactNode;
  leftAction?: SwipeActionConfig; // revealed when swiping RIGHT (dx > 0)
  rightAction?: SwipeActionConfig; // revealed when swiping LEFT (dx < 0)
  onLongPress?: () => void;
  disabled?: boolean;
  className?: string;
}

const SWIPE_LOCK_PX = 14;
const SWIPE_TRIGGER_PX = 80;
const SWIPE_MAX_PX = 116;
const LONG_PRESS_MS = 430;
const ANDROID_EDGE_GUARD_PX = 24;

function isInsideInteractiveHorizontalChild(target: EventTarget | null, boundary: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== boundary) {
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || node.getAttribute('role') === 'slider') {
      return true;
    }
    if (node.scrollWidth > node.clientWidth + 6) {
      const style = window.getComputedStyle(node);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Native-feel mobile swipeable row + long-press trigger with strict Android & Fold safety:
 * - Ignores touches starting within 24px of left/right edges (Android Back gesture & One UI Edge Panel).
 * - Ignores touches inside horizontal scroll strips, sliders (audio scrubber), or inputs.
 * - Never fires actions on `touchcancel` (system takeover safely resets row to 0).
 * - Suppresses duplicate Android `contextmenu` events after timer-based long-press.
 */
export const SwipeableRow: React.FC<SwipeableRowProps> = ({
  children,
  leftAction,
  rightAction,
  onLongPress,
  disabled = false,
  className = '',
}) => {
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const modeRef = useRef<'idle' | 'horizontal' | 'vertical'>('idle');
  const hapticFiredRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const suppressContextMenuUntilRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const currentOffsetRef = useRef(0);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  useEffect(() => () => clearLongPress(), []);

  const resetSwipe = () => {
    trackingRef.current = false;
    modeRef.current = 'idle';
    hapticFiredRef.current = false;
    currentOffsetRef.current = 0;
    setDragging(false);
    setOffsetX(0);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (disabled || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    // Preserve Android edge-back gesture & Samsung One UI Edge Panel
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    if (vw > 0 && (t.clientX < ANDROID_EDGE_GUARD_PX || t.clientX > vw - ANDROID_EDGE_GUARD_PX)) {
      return;
    }
    if (isInsideInteractiveHorizontalChild(e.target, e.currentTarget)) {
      return;
    }

    startXRef.current = t.clientX;
    startYRef.current = t.clientY;
    trackingRef.current = true;
    modeRef.current = 'idle';
    hapticFiredRef.current = false;
    longPressedRef.current = false;

    clearLongPress();
    if (onLongPress) {
      longPressTimerRef.current = setTimeout(() => {
        if (!trackingRef.current || modeRef.current !== 'idle') return;
        longPressedRef.current = true;
        const now = Date.now();
        suppressClickUntilRef.current = now + 550;
        suppressContextMenuUntilRef.current = now + 700;
        mobileBridge.haptic('medium');
        onLongPress();
      }, LONG_PRESS_MS);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!trackingRef.current || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const dx = t.clientX - startXRef.current;
    const dy = t.clientY - startYRef.current;

    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      clearLongPress();
    }

    if (modeRef.current === 'idle') {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        modeRef.current = 'vertical';
        return;
      }
      if (Math.abs(dx) > SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.45) {
        if ((dx > 0 && !leftAction) || (dx < 0 && !rightAction)) {
          modeRef.current = 'vertical';
          return;
        }
        modeRef.current = 'horizontal';
        setDragging(true);
      } else {
        return;
      }
    }

    if (modeRef.current !== 'horizontal') return;

    let clamped = dx;
    if (clamped > 0 && !leftAction) clamped = 0;
    if (clamped < 0 && !rightAction) clamped = 0;

    // Gentle rubber-band resistance beyond trigger threshold
    const abs = Math.abs(clamped);
    const damped =
      abs <= SWIPE_TRIGGER_PX
        ? clamped
        : Math.sign(clamped) *
          Math.min(SWIPE_MAX_PX, SWIPE_TRIGGER_PX + (abs - SWIPE_TRIGGER_PX) * 0.38);

    if (Math.abs(damped) >= SWIPE_TRIGGER_PX && !hapticFiredRef.current) {
      hapticFiredRef.current = true;
      mobileBridge.haptic('light');
    } else if (Math.abs(damped) < SWIPE_TRIGGER_PX - 12 && hapticFiredRef.current) {
      hapticFiredRef.current = false;
    }

    currentOffsetRef.current = damped;
    setOffsetX(damped);
  };

  const handleTouchEnd = () => {
    clearLongPress();
    const wasHorizontal = modeRef.current === 'horizontal';
    const finalOffset = currentOffsetRef.current;
    resetSwipe();

    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (!wasHorizontal) return;
    suppressClickUntilRef.current = Date.now() + 360;

    if (finalOffset >= SWIPE_TRIGGER_PX && leftAction) {
      mobileBridge.haptic('success');
      leftAction.onTrigger();
    } else if (finalOffset <= -SWIPE_TRIGGER_PX && rightAction) {
      mobileBridge.haptic('medium');
      rightAction.onTrigger();
    }
  };

  const handleTouchCancel = () => {
    // System gesture or interruption: ALWAYS cancel safely without triggering delete/pin
    clearLongPress();
    longPressedRef.current = false;
    resetSwipe();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onLongPress || disabled) return;
    e.preventDefault();
    if (longPressedRef.current || Date.now() < suppressContextMenuUntilRef.current) {
      return;
    }
    suppressClickUntilRef.current = Date.now() + 400;
    mobileBridge.haptic('medium');
    onLongPress();
  };

  const handleClickCapture = (e: React.MouseEvent) => {
    if (Date.now() < suppressClickUntilRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const showLeft = offsetX > 4 && Boolean(leftAction);
  const showRight = offsetX < -4 && Boolean(rightAction);
  const progress = Math.min(1, Math.abs(offsetX) / SWIPE_TRIGGER_PX);

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-2xl ${className}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onContextMenu={handleContextMenu}
      onClickCapture={handleClickCapture}
    >
      {/* Left revealed pill (on swipe right) */}
      {showLeft && leftAction ? (
        <div
          aria-hidden="true"
          className={`absolute inset-0 flex items-center justify-start pl-4 rounded-2xl ${leftAction.bgClass} ${
            leftAction.textClass ?? 'text-white'
          }`}
        >
          <div
            style={{
              transform: `scale(${0.82 + progress * 0.24})`,
              opacity: Math.min(1, progress * 1.25),
            }}
            className="inline-flex items-center gap-1.5 font-semibold text-[13px]"
          >
            {leftAction.icon}
            <span>{leftAction.label}</span>
          </div>
        </div>
      ) : null}

      {/* Right revealed pill (on swipe left) */}
      {showRight && rightAction ? (
        <div
          aria-hidden="true"
          className={`absolute inset-0 flex items-center justify-end pr-4 rounded-2xl ${rightAction.bgClass} ${
            rightAction.textClass ?? 'text-white'
          }`}
        >
          <div
            style={{
              transform: `scale(${0.82 + progress * 0.24})`,
              opacity: Math.min(1, progress * 1.25),
            }}
            className="inline-flex items-center gap-1.5 font-semibold text-[13px]"
          >
            <span>{rightAction.label}</span>
            {rightAction.icon}
          </div>
        </div>
      ) : null}

      <div
        style={{
          transform: offsetX !== 0 ? `translate3d(${offsetX}px, 0, 0)` : undefined,
          transition: dragging ? 'none' : 'transform 220ms var(--k-ease-out)',
        }}
        className="relative z-10 will-change-transform"
      >
        {children}
      </div>
    </div>
  );
};
