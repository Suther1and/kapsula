import React, { useCallback, useRef, useState } from 'react';
import { Select } from '@base-ui/react/select';
import { useReducedMotion } from 'motion/react';
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

interface HighlightBox {
  value: string;
  top: number;
  height: number;
  visible: boolean;
  animatePosition: boolean;
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
  const prefersReduced = useReducedMotion();
  const [hl, setHl] = useState<HighlightBox | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const focusRow = useCallback((val: string) => {
    const el = itemRefs.current.get(val);
    if (!el) return;
    const top = Math.round(el.offsetTop);
    const height = Math.round(el.offsetHeight);
    setHl((prev) => ({
      value: val,
      top,
      height,
      visible: true,
      animatePosition: Boolean(prev?.visible),
    }));
  }, []);

  const clearRow = useCallback(() => {
    setHl((prev) => (prev ? { ...prev, visible: false, animatePosition: false } : null));
  }, []);

  const registerRow = useCallback(
    (val: string) => (el: HTMLElement | null) => {
      if (el) itemRefs.current.set(val, el);
      else itemRefs.current.delete(val);
    },
    []
  );

  const current = options.find((o) => o.value === value);
  const resolvedPlaceholder = placeholder ?? t('ui.selectPlaceholder');

  return (
    <Select.Root
      value={value}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setHl(null);
        onOpenChange?.(nextOpen);
      }}
      onValueChange={(next) => {
        if (next !== null) onChange(String(next));
      }}
    >
      <Select.Trigger
        data-no-press-scale="true"
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
            className="k-popover-card k-menu-motion min-w-[max(180px,var(--anchor-width))] max-w-[290px] max-h-[280px] overflow-y-auto p-1.5 outline-none"
          >
            <Select.List
              className="relative flex flex-col gap-0.5"
              onMouseLeave={clearRow}
            >
              {hl ? (
                <span
                  aria-hidden="true"
                  style={{
                    transform: `translate3d(0, ${hl.top}px, 0)`,
                    height: `${hl.height}px`,
                    opacity: hl.visible ? 1 : 0,
                    transition: prefersReduced
                      ? 'none'
                      : hl.animatePosition
                        ? 'transform 110ms cubic-bezier(0.22, 1, 0.36, 1), height 110ms cubic-bezier(0.22, 1, 0.36, 1), opacity 80ms ease-out'
                        : 'opacity 80ms ease-out',
                  }}
                  className="pointer-events-none absolute top-0 left-0 right-0 z-0 rounded-lg bg-[var(--k-bg-surface-3)]"
                />
              ) : null}
              {options.map((opt) => (
                <Select.Item
                  key={opt.value}
                  ref={registerRow(opt.value)}
                  value={opt.value}
                  onMouseEnter={() => focusRow(opt.value)}
                  onFocus={() => focusRow(opt.value)}
                  className={`relative z-[1] flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--k-ink-primary)] transition-colors duration-[80ms] cursor-pointer outline-none data-[selected]:text-[var(--k-accent)] ${
                    !hl?.visible ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)]' : ''
                  }`}
                >
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
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};
