import React, { useState } from 'react';
import { Keyboard } from '@phosphor-icons/react';
import { formatShortcutDisplay, keyboardEventToAccelerator } from '@shared/shortcuts';

interface ShortcutRecorderProps {
  value: string;
  onChange: (shortcut: string) => void;
  registered?: boolean;
}

export const ShortcutRecorder: React.FC<ShortcutRecorderProps> = ({
  value,
  onChange,
  registered = true,
}) => {
  const [capturing, setCapturing] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={(e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setCapturing(false);
          return;
        }
        const accel = keyboardEventToAccelerator(
          {
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
          },
          window.kapsula?.platform
        );
        if (accel) {
          onChange(accel);
          setCapturing(false);
        }
      }}
      className={`k-interactive k-focus-ring inline-flex items-center justify-center gap-2 h-8 min-w-[172px] px-3 rounded-lg border text-[12px] cursor-pointer whitespace-nowrap ${
        capturing
          ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
          : !registered
            ? 'border-[var(--k-amber)]/50 bg-[var(--k-amber-soft)] text-[var(--k-ink-primary)]'
            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]'
      }`}
    >
      <Keyboard className="w-3.5 h-3.5 shrink-0 opacity-75" />
      <span className="k-mono">
        {capturing ? 'Нажми клавиши…' : formatShortcutDisplay(value, window.kapsula?.platform)}
      </span>
    </button>
  );
};
