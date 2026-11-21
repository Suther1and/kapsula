import React, { useId } from 'react';
import { motion, useReducedMotion } from 'motion/react';

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
            className={`relative ${fullWidth ? 'flex-1' : ''} inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium whitespace-nowrap cursor-pointer select-none transition-[color,transform] duration-[140ms] ease-[var(--k-ease-out)] ${
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
                : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] active:scale-[0.97]'
            }`}
          >
            {active ? (
              <motion.span
                aria-hidden="true"
                data-testid="segmented-thumb"
                layoutId={pillId}
                transition={
                  prefersReduced
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }
                }
                className="pointer-events-none absolute inset-0 rounded-[9px] bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] shadow-[var(--k-shadow-thumb)]"
              />
            ) : null}
            {opt.icon ? <span className="relative z-10 shrink-0">{opt.icon}</span> : null}
            {opt.label ? <span className="relative z-10">{opt.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
