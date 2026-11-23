import React, { useId, useState } from 'react';
import { Select } from '@base-ui/react/select';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
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

const HIGHLIGHT_SPRING = { type: 'spring' as const, stiffness: 860, damping: 46, mass: 0.36 };

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
  const prefersReduced = useReducedMotion();
  const listLayoutId = useId();
  const [hoveredVal, setHoveredVal] = useState<string | null>(null);

  const current = options.find((o) => o.value === value);
  const resolvedPlaceholder = placeholder ?? t('ui.selectPlaceholder');

  return (
    <Select.Root
      value={value}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setHoveredVal(null);
        onOpenChange?.(nextOpen);
      }}
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
            data-k-popup="true"
            style={scopedAccentStyle}
            data-testid={testId ? `${testId}-popup` : 'select-menu-popup'}
            className="k-menu-motion min-w-[max(180px,var(--anchor-width))] max-w-[290px] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl outline-none"
          >
            <LayoutGroup id={listLayoutId}>
              <Select.List
                className="flex flex-col gap-0.5"
                onMouseLeave={() => setHoveredVal(null)}
              >
                {options.map((opt) => {
                  const isHovered = hoveredVal === opt.value;
                  return (
                    <Select.Item
                      key={opt.value}
                      value={opt.value}
                      onMouseEnter={() => setHoveredVal(opt.value)}
                      onFocus={() => setHoveredVal(opt.value)}
                      className={`relative flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--k-ink-primary)] transition-colors duration-[80ms] cursor-pointer outline-none data-[selected]:text-[var(--k-accent)] ${
                        hoveredVal === null ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)]' : ''
                      }`}
                    >
                      {isHovered ? (
                        <motion.span
                          layoutId={`sel-hl-${listLayoutId}`}
                          aria-hidden="true"
                          style={{ borderRadius: 8 }}
                          transition={prefersReduced ? { duration: 0 } : HIGHLIGHT_SPRING}
                          className="pointer-events-none absolute inset-0 bg-[var(--k-bg-surface-3)]"
                        />
                      ) : null}
                      <span className="relative z-10 flex items-center gap-2 min-w-0">
                        {opt.dotColor ? (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: opt.dotColor }}
                          />
                        ) : null}
                        <span className="truncate">{opt.label}</span>
                      </span>
                      <Select.ItemIndicator className="relative z-10 shrink-0 text-[var(--k-accent)]">
                        <Check weight="bold" className="w-3.5 h-3.5" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  );
                })}
              </Select.List>
            </LayoutGroup>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};
