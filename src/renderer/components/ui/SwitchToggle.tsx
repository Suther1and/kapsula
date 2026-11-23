import React from 'react';
import { Switch } from '@animate-ui/react/primitives/base-ui/switch';
import { playTactileSound } from '../../lib/tactileSound';

interface SwitchToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}

export const SwitchToggle: React.FC<SwitchToggleProps> = ({
  checked,
  onCheckedChange,
  disabled = false,
  'aria-label': ariaLabel,
  'data-testid': testId,
}) => (
  <Switch.Root
    checked={checked}
    onCheckedChange={(next) => {
      playTactileSound('toggle');
      onCheckedChange(next);
    }}
    disabled={disabled}
    aria-label={ariaLabel}
    data-testid={testId}
    className={`k-focus-ring relative inline-flex h-[22px] w-[38px] shrink-0 items-center justify-start data-[checked]:justify-end rounded-full p-[2px] border transition-colors duration-150 ease-[var(--k-ease-out)] cursor-pointer select-none ${
      checked
        ? 'bg-[var(--k-accent)] border-[var(--k-accent)]'
        : 'bg-[var(--k-bg-surface-3)] border-[var(--k-border-strong)]'
    } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
  >
    <Switch.Thumb
      transition={{ type: 'spring', stiffness: 540, damping: 32, mass: 0.68 }}
      className="block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.28)]"
    />
  </Switch.Root>
);
