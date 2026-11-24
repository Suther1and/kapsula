import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  ariaLabel?: string;
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (val: T) => void;
  options: Array<SegmentedOption<T>>;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

interface ThumbRect {
  left: number;
  width: number;
  ready: boolean;
}

/**
 * Local-coordinate segmented control: the active thumb is positioned strictly relative
 * to its own tablist container and animates ONLY when `value` changes — so switching
 * sections or resizing the window never causes the pill to fly across the screen.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  fullWidth = false,
  className = '',
}: SegmentedControlProps<T>) {
  const prefersReduced = useReducedMotion();
  const listRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const prevValueRef = useRef<T>(value);
  const [thumb, setThumb] = useState<ThumbRect>({ left: 0, width: 0, ready: false });
  const [animateThumb, setAnimateThumb] = useState(false);

  const measureActive = useCallback(
    (shouldAnimate: boolean) => {
      const btn = btnRefs.current.get(value);
      if (!btn) return;
      const nextLeft = Math.round(btn.offsetLeft);
      const nextWidth = Math.round(btn.offsetWidth);
      setAnimateThumb(shouldAnimate && !prefersReduced);
      setThumb((prev) =>
        prev.ready && prev.left === nextLeft && prev.width === nextWidth
          ? prev
          : { left: nextLeft, width: nextWidth, ready: true }
      );
    },
    [value, prefersReduced]
  );

  useLayoutEffect(() => {
    const valueChanged = prevValueRef.current !== value;
    prevValueRef.current = value;
    measureActive(valueChanged);
  }, [value, options, size, fullWidth, measureActive]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      measureActive(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureActive]);

  return (
    <div
      ref={listRef}
      role="tablist"
      className={`relative ${fullWidth ? 'flex w-full' : 'inline-flex'} items-center gap-0.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-0.5 ${className}`}
    >
      {thumb.ready ? (
        <span
          aria-hidden="true"
          data-testid="segmented-thumb"
          style={{
            transform: `translate3d(${thumb.left}px, 0, 0)`,
            width: `${thumb.width}px`,
            transition: animateThumb
              ? 'transform 170ms cubic-bezier(0.22, 1, 0.36, 1), width 170ms cubic-bezier(0.22, 1, 0.36, 1)'
              : 'none',
          }}
          className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-[9px] bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] shadow-[var(--k-shadow-thumb)]"
        />
      ) : null}
      {options.map((opt) => {
        const active = opt.value === value;
        const iconOnly = !opt.label;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.value, el);
              else btnRefs.current.delete(opt.value);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={opt.ariaLabel || (iconOnly ? opt.title || opt.value : undefined)}
            title={opt.title || opt.ariaLabel}
            onClick={() => onChange(opt.value)}
            className={`group relative ${fullWidth ? 'flex-1' : ''} inline-flex items-center justify-center rounded-[9px] font-medium whitespace-nowrap cursor-pointer select-none transition-colors duration-[130ms] ease-[var(--k-ease-out)] ${
              size === 'sm'
                ? iconOnly
                  ? 'h-7 w-7 text-[12px]'
                  : 'h-7 px-2 text-[12px]'
                : iconOnly
                  ? 'h-8 w-8 text-[13px]'
                  : 'h-8 px-3 text-[13px]'
            } ${
              active
                ? 'text-[var(--k-ink-primary)]'
                : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
            }`}
          >
            <span
              className={`relative z-10 inline-flex items-center justify-center gap-1 transition-transform duration-[100ms] ease-[var(--k-ease-out)] ${
                active ? '' : 'group-active:scale-[0.97]'
              }`}
            >
              {opt.icon ? <span className="shrink-0">{opt.icon}</span> : null}
              {opt.label ? <span>{opt.label}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
