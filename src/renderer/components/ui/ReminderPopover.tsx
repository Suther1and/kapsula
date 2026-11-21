import React, { useState } from 'react';
import { Bell, BellSlash } from '@phosphor-icons/react';
import { formatReminderStamp } from '../../lib/format';
import { PopoverSurface } from './PopoverSurface';

interface ReminderPopoverProps {
  remindAt: number | null;
  onChange: (nextMs: number | null) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  labelClassName?: string;
}

function toLocalDatetimeValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ReminderPopover: React.FC<ReminderPopoverProps> = ({
  remindAt,
  onChange,
  onOpenChange,
  className = '',
  labelClassName = '',
}) => {
  const [open, setOpen] = useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const [customVal, setCustomVal] = useState(() =>
    toLocalDatetimeValue(remindAt || Date.now() + 3600_000)
  );

  const presets = [
    {
      label: 'Через 1 час',
      getTs: () => Date.now() + 3600_000,
    },
    {
      label: 'Сегодня в 19:00',
      getTs: () => {
        const d = new Date();
        d.setHours(19, 0, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        return d.getTime();
      },
    },
    {
      label: 'Завтра в 10:00',
      getTs: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(10, 0, 0, 0);
        return d.getTime();
      },
    },
    {
      label: 'Через 7 дней',
      getTs: () => Date.now() + 7 * 86400_000,
    },
  ];

  return (
    <PopoverSurface
      open={open}
      onOpenChange={handleOpenChange}
      widthClass="w-64"
      trigger={
        <button
          type="button"
          title={remindAt ? formatReminderStamp(remindAt) : 'Напомнить'}
          aria-label={remindAt ? `Напоминание: ${formatReminderStamp(remindAt)}` : 'Напомнить'}
          className={`k-interactive k-focus-ring inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] font-medium cursor-pointer whitespace-nowrap ${
            remindAt
              ? 'border-[var(--k-amber)]/40 bg-[var(--k-amber-soft)] text-[var(--k-amber)]'
              : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
          } ${className}`}
        >
          <Bell weight={remindAt ? 'fill' : 'regular'} className="w-3.5 h-3.5 shrink-0" />
          <span className={`truncate ${labelClassName}`}>
            {remindAt ? formatReminderStamp(remindAt) : 'Напомнить'}
          </span>
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="text-[12px] font-semibold text-[var(--k-ink-secondary)]">
          Когда напомнить
        </div>
        <div className="flex flex-col gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                onChange(p.getTs());
                setOpen(false);
              }}
              className="k-interactive text-left px-2.5 py-1.5 rounded-lg text-[12.5px] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="pt-2 border-t border-[var(--k-border-hairline)] flex flex-col gap-1.5">
          <input
            type="datetime-local"
            value={customVal}
            onChange={(e) => setCustomVal(e.target.value)}
            className="w-full h-8 px-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-primary)] outline-none"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const parsed = new Date(customVal).getTime();
                if (Number.isFinite(parsed)) {
                  onChange(parsed);
                  setOpen(false);
                }
              }}
              className="flex-1 h-7 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
            >
              Установить
            </button>
            {remindAt ? (
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
                aria-label="Убрать напоминание"
                className="h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-danger)] text-[12px] cursor-pointer"
              >
                <BellSlash className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </PopoverSurface>
  );
};
