import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { playTactileSound } from '../../lib/tactileSound';

interface AnimatedCheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: 'sm' | 'md';
  label?: string;
  stopPropagation?: boolean;
  className?: string;
  'data-testid'?: string;
}

export const AnimatedCheckbox: React.FC<AnimatedCheckboxProps> = ({
  checked,
  onChange,
  size = 'md',
  label,
  stopPropagation = true,
  className = '',
  'data-testid': testId,
}) => {
  const prefersReduced = useReducedMotion();
  const boxSize = size === 'sm' ? 'w-4 h-4 rounded-[4.5px]' : 'w-[18px] h-[18px] rounded-[5px]';

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      data-checkbox-control="true"
      onMouseDown={(e) => {
        if (stopPropagation) e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (stopPropagation) e.stopPropagation();
      }}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        playTactileSound('check');
        onChange(!checked);
        // Clear pointer focus so hover-reveal card toolbars hide cleanly after unchecking
        if (e.detail > 0) {
          e.currentTarget.blur();
        }
      }}
      className={`k-focus-ring inline-flex items-center justify-center shrink-0 border transition-[background-color,border-color,color,box-shadow,transform] duration-[110ms] ease-[var(--k-ease-out)] active:scale-[0.88] cursor-pointer select-none ${boxSize} ${
        checked
          ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
          : 'bg-[var(--k-bg-surface-1)] border-[color-mix(in_srgb,var(--k-ink-primary)_26%,transparent)] shadow-[0_1px_1.5px_rgba(15,23,42,0.05)] hover:border-[var(--k-accent)] hover:bg-[var(--k-accent-soft)]/35 active:border-[var(--k-accent)]'
      } ${className}`}
    >
      <svg viewBox="0 0 14 14" fill="none" className="w-3 h-3" aria-hidden="true">
        <motion.path
          d="M2.8 7.3L5.6 10.1L11.2 4"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{
            pathLength: checked ? 1 : 0,
            opacity: checked ? 1 : 0,
          }}
          transition={{ duration: prefersReduced ? 0 : 0.11, delay: 0, ease: [0.23, 1, 0.32, 1] }}
        />
      </svg>
    </button>
  );
};
