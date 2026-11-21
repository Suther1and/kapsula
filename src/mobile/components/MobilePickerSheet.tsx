import React, { useMemo, useState } from 'react';
import { CaretDown, Check, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { SECTION_COLOR_PALETTE } from '@shared/constants';
import { useMobileI18n } from '../lib/mobile-i18n';
import { BottomSheet } from './BottomSheet';

export interface MobilePickerOption {
  value: string;
  label: string;
  color?: string;
  count?: number;
  subtitle?: string;
}

interface MobilePickerSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  value: string;
  options: MobilePickerOption[];
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  allowCreate?: boolean;
  createPlaceholder?: string;
  onCreateNew?: (name: string, color: string) => Promise<string | void>;
  onSelect: (value: string) => void;
  onClose: () => void;
}

/**
 * Branded mobile selector sheet replacing ugly native Android <select> spinners everywhere.
 */
export const MobilePickerSheet: React.FC<MobilePickerSheetProps> = ({
  open,
  title,
  subtitle,
  value,
  options,
  isExpanded,
  hingeRightOffsetPx = 0,
  allowCreate = false,
  createPlaceholder,
  onCreateNew,
  onSelect,
  onClose,
}) => {
  const { t } = useMobileI18n();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(SECTION_COLOR_PALETTE[0] ?? '#E86A33');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) || (opt.subtitle?.toLowerCase().includes(q) ?? false)
    );
  }, [options, query]);

  const handleClose = () => {
    setQuery('');
    setCreating(false);
    setNewName('');
    onClose();
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newName.trim();
    if (!clean || !onCreateNew || busy) return;
    setBusy(true);
    try {
      const createdId = await onCreateNew(clean, newColor);
      if (typeof createdId === 'string') {
        onSelect(createdId);
      }
      handleClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      title={title}
      subtitle={subtitle}
      isExpanded={isExpanded}
      hingeRightOffsetPx={hingeRightOffsetPx}
      maxWidthClass="max-w-md"
      onClose={handleClose}
    >
      <div className="p-3.5 space-y-2.5">
        {options.length > 6 ? (
          <div className="relative">
            <MagnifyingGlass className="w-4 h-4 text-[var(--k-ink-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.findPlaceholder')}
              className="w-full h-10 pl-9 pr-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
            />
          </div>
        ) : null}

        <div className="space-y-1">
          {filtered.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value || '__empty__'}
                type="button"
                data-testid={`picker-opt-${opt.value || 'none'}`}
                onClick={() => {
                  onSelect(opt.value);
                  handleClose();
                }}
                className={`k-tap w-full flex items-center justify-between gap-3 px-3.5 min-h-[46px] py-2 rounded-2xl border text-left transition-colors ${
                  active
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                    : 'bg-[var(--k-bg-surface-2)] border-transparent hover:border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {opt.color ? (
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ background: opt.color }}
                    />
                  ) : (
                    <span className="w-3 h-3 rounded-full shrink-0 border border-dashed border-[var(--k-ink-muted)]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium truncate">{opt.label}</div>
                    {opt.subtitle ? (
                      <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                        {opt.subtitle}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {typeof opt.count === 'number' ? (
                    <span className="text-[12px] text-[var(--k-ink-muted)] k-tabular">
                      {opt.count}
                    </span>
                  ) : null}
                  {active ? (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]">
                      <Check weight="bold" className="w-3.5 h-3.5" />
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {allowCreate && onCreateNew ? (
          creating ? (
            <form
              onSubmit={(e) => void handleCreateSubmit(e)}
              className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-2.5"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={createPlaceholder ?? t('common.namePlaceholder')}
                  className="flex-1 h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                />
                <button
                  type="submit"
                  disabled={!newName.trim() || busy}
                  className="k-tap px-3.5 h-10 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold disabled:opacity-40"
                >
                  {t('common.create')}
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {SECTION_COLOR_PALETTE.slice(0, 12).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    style={{ background: c }}
                    className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                      newColor === c
                        ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                        : 'opacity-80'
                    }`}
                  >
                    {newColor === c ? <Check weight="bold" className="w-3 h-3 text-white" /> : null}
                  </button>
                ))}
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="k-tap w-full h-11 rounded-2xl border border-dashed border-[var(--k-border-strong)] text-[13.5px] font-medium text-[var(--k-accent)] inline-flex items-center justify-center gap-1.5"
            >
              <Plus weight="bold" className="w-4 h-4" />
              {t('common.createNew')}
            </button>
          )
        ) : null}
      </div>
    </BottomSheet>
  );
};

interface PickerTriggerChipProps {
  icon?: React.ReactNode;
  colorDot?: string | null;
  label: string;
  placeholder?: boolean;
  compact?: boolean;
  onClick: () => void;
  testId?: string;
  className?: string;
}

export const PickerTriggerChip: React.FC<PickerTriggerChipProps> = ({
  icon,
  colorDot,
  label,
  placeholder = false,
  compact = false,
  onClick,
  testId,
  className = '',
}) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onClick}
    className={`k-tap inline-flex items-center justify-between bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] text-left ${
      compact
        ? 'h-7 px-2 gap-1 rounded-lg'
        : 'min-h-[38px] px-3 gap-2 rounded-xl'
    } ${className}`}
  >
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {icon ? (
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={colorDot ? { color: colorDot } : undefined}
        >
          {icon}
        </span>
      ) : colorDot ? (
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorDot }} />
      ) : null}
      <span
        className={`${compact ? 'text-[11px]' : 'text-[12.5px]'} font-medium truncate ${
          placeholder ? 'text-[var(--k-ink-muted)]' : 'text-[var(--k-ink-primary)]'
        }`}
      >
        {label}
      </span>
    </span>
    <CaretDown className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-[var(--k-ink-muted)] shrink-0`} />
  </button>
);
