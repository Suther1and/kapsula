import React from 'react';
import { Switch } from '@base-ui/react/switch';
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
    className={`group k-focus-ring relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-150 ease-[var(--k-ease-out)] cursor-pointer select-none ${
      checked
        ? 'bg-[var(--k-accent)] border-[var(--k-accent)]'
        : 'bg-[var(--k-bg-surface-3)] border-[var(--k-border-strong)]'
    } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
  >
    <Switch.Thumb className="block h-4 w-4 group-active:w-[19px] rounded-full bg-white shadow-xs transition-[transform,translate,width] duration-[150ms] ease-[var(--k-ease-out)] translate-x-[2px] data-[checked]:translate-x-[18px] data-[checked]:group-active:translate-x-[15px]" />
  </Switch.Root>
);
