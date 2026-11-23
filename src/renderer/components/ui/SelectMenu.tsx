import React from 'react';
import { Select } from '@base-ui/react/select';
import { CaretDown, Check } from '@phosphor-icons/react';
import { useI18n } from '@shared/i18n/react';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  dotColor?: string;
}

interface SelectMenuProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  align?: 'start' | 'center' | 'end';
  onOpenChange?: (open: boolean) => void;
  'data-testid'?: string;
}

export const SelectMenu: React.FC<SelectMenuProps> = ({
  value,
  onChange,
  options,
  placeholder,
  className = '',
  size = 'md',
  align = 'start',
  onOpenChange,
  'data-testid': testId,
}) => {
  const { t } = useI18n();
  const scopedAccentStyle = useScopedAccentStyle();
  const current = options.find((o) => o.value === value);
  const resolvedPlaceholder = placeholder ?? t('ui.selectPlaceholder');

  return (
    <Select.Root
      value={value}
      onOpenChange={onOpenChange}
      onValueChange={(next) => {
        if (next !== null) onChange(String(next));
      }}
    >
      <Select.Trigger
        data-testid={testId}
        className={`group k-interactive k-focus-ring inline-flex items-center justify-between gap-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer select-none ${
          size === 'sm' ? 'h-8 px-2.5 text-[12px]' : 'h-9 px-3 text-[13px]'
        } ${className}`}
      >
        <span className="inline-flex items-center gap-2 min-w-0 truncate">
          {current?.dotColor ? (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: current.dotColor }}
            />
          ) : null}
          <span className="truncate">{current ? current.label : resolvedPlaceholder}</span>
        </span>
        <Select.Icon className="shrink-0 text-[var(--k-ink-muted)] transition-[rotate,transform] duration-150 ease-[var(--k-ease-out)] group-data-[popup-open]:rotate-180">
          <CaretDown weight="bold" className="w-3.5 h-3.5" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-[140]"
        >
          <Select.Popup
            style={scopedAccentStyle}
            data-testid={testId ? `${testId}-popup` : 'select-menu-popup'}
            className="k-popup-motion min-w-[max(180px,var(--anchor-width))] max-w-[290px] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl outline-none"
          >
            <Select.List className="flex flex-col gap-0.5">
              {options.map((opt) => (
                <Select.Item
                  key={opt.value}
                  value={opt.value}
                  className="k-interactive flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--k-ink-primary)] cursor-pointer outline-none data-[highlighted]:bg-[var(--k-bg-surface-3)] data-[selected]:text-[var(--k-accent)]"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {opt.dotColor ? (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: opt.dotColor }}
                      />
                    ) : null}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  <Select.ItemIndicator className="shrink-0 text-[var(--k-accent)]">
                    <Check weight="bold" className="w-3.5 h-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};
