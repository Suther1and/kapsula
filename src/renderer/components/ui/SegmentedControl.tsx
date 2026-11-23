import React, { useId } from 'react';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';

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

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  fullWidth = false,
  className = '',
}: SegmentedControlProps<T>) {
  const pillId = useId();
  const prefersReduced = useReducedMotion();

  return (
    <LayoutGroup id={pillId}>
      <div
        role="tablist"
        className={`relative ${fullWidth ? 'flex w-full' : 'inline-flex'} items-center gap-0.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-0.5 ${className}`}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          const iconOnly = !opt.label;
          return (
            <button
              key={opt.value}
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
                    : 'h-7 px-2.5 text-[12px]'
                  : iconOnly
                    ? 'h-8 w-8 text-[13px]'
                    : 'h-8 px-3 text-[13px]'
              } ${
                active
                  ? 'text-[var(--k-ink-primary)]'
                  : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              {active ? (
                <motion.span
                  aria-hidden="true"
                  data-testid="segmented-thumb"
                  layoutId={pillId}
                  style={{ borderRadius: 9 }}
                  transition={
                    prefersReduced
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 600, damping: 38, mass: 0.6 }
                  }
                  className="pointer-events-none absolute inset-0 bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] shadow-[var(--k-shadow-thumb)]"
                />
              ) : null}
              <span
                className={`relative z-10 inline-flex items-center justify-center gap-1.5 transition-transform duration-[100ms] ease-[var(--k-ease-out)] ${
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
    </LayoutGroup>
  );
}
