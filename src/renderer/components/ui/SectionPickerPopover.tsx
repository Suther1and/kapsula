import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, Check, FolderSimple, Plus, Sparkle, X } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { OrbitDef } from '@shared/types';
import { SECTION_COLOR_PALETTE } from '@shared/constants';
import { useI18n } from '@shared/i18n/react';
import { friendlyErrorMessage } from '../../lib/format';
import { PopoverSurface } from './PopoverSurface';
import { SectionIcon } from './SectionIcon';

export interface SectionPickerPopoverProps {
  orbits: OrbitDef[];
  value: string; // '' means Auto / No section
  onChange: (orbitId: string) => void;
  onOrbitCreated?: (orbit: OrbitDef) => void;
  emptyOptionLabel: string;
  emptyOptionKind?: 'auto' | 'none';
  size?: 'sm' | 'md';
  align?: 'start' | 'center' | 'end';
  triggerVariant?: 'select' | 'chip';
  onOpenChange?: (open: boolean) => void;
  'data-testid'?: string;
}

const QUICK_COLORS = SECTION_COLOR_PALETTE.slice(0, 8);

export const SectionPickerPopover: React.FC<SectionPickerPopoverProps> = ({
  orbits,
  value,
  onChange,
  onOrbitCreated,
  emptyOptionLabel,
  emptyOptionKind = 'none',
  size = 'md',
  align = 'start',
  triggerVariant = 'select',
  onOpenChange,
  'data-testid': testId,
}) => {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(QUICK_COLORS[0] ?? '#E86A33');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [optimisticOrbit, setOptimisticOrbit] = useState<OrbitDef | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const newBtnRef = useRef<HTMLButtonElement | null>(null);

  const mergedOrbits = useMemo(() => {
    if (optimisticOrbit && !orbits.some((o) => o.id === optimisticOrbit.id)) {
      return [...orbits, optimisticOrbit];
    }
    return orbits;
  }, [orbits, optimisticOrbit]);

  useEffect(() => {
    if (optimisticOrbit && orbits.some((o) => o.id === optimisticOrbit.id)) {
      setOptimisticOrbit(null);
    }
  }, [orbits, optimisticOrbit]);

  const selectedOrbit = useMemo(
    () => (value ? mergedOrbits.find((o) => o.id === value) ?? null : null),
    [mergedOrbits, value]
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
      if (!next) {
        setCreating(false);
        setNewName('');
        setNewColor(QUICK_COLORS[0] ?? '#E86A33');
        setCreatingBusy(false);
      }
    },
    [onOpenChange]
  );

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setNewName('');
    setNewColor(QUICK_COLORS[0] ?? '#E86A33');
    requestAnimationFrame(() => {
      newBtnRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    if (!open || !creating) return;
    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    const el = inputRef.current;
    if (!el) {
      return () => cancelAnimationFrame(rafId);
    }
    // Intercept Escape on the input itself before Base UI's document-level dismiss closes the popover
    const onNativeKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        cancelCreate();
      }
    };
    el.addEventListener('keydown', onNativeKeyDown);
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('keydown', onNativeKeyDown);
    };
  }, [open, creating, cancelCreate]);

  const handleCreateSection = async () => {
    const trimmed = newName.trim();
    if (!trimmed || creatingBusy) return;
    setCreatingBusy(true);
    try {
      const created = await window.kapsula.createOrbit({
        name: trimmed,
        description: '',
        color: newColor,
        icon: 'Folder',
      });
      setOptimisticOrbit(created);
      onOrbitCreated?.(created);
      onChange(created.id);
      toast.success(t('nav.sectionCreated', { name: created.name }));
      handleOpenChange(false);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setCreatingBusy(false);
    }
  };

  const EmptyKindIcon = emptyOptionKind === 'auto' ? Sparkle : FolderSimple;

  const triggerElement =
    triggerVariant === 'chip' ? (
      selectedOrbit ? (
        <button
          type="button"
          data-testid={testId}
          title={t('cards.sectionChipTitle', { name: selectedOrbit.name })}
          style={{
            backgroundColor: `color-mix(in srgb, ${selectedOrbit.color} 13%, transparent)`,
            borderColor: `color-mix(in srgb, ${selectedOrbit.color} 28%, transparent)`,
          }}
          className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] border text-[12px] font-medium text-[var(--k-ink-primary)] hover:brightness-105 cursor-pointer min-w-0 max-w-[200px]"
        >
          <SectionIcon
            name={selectedOrbit.icon}
            color={selectedOrbit.color}
            className="w-3.5 h-3.5 shrink-0"
          />
          <span className="truncate">{selectedOrbit.name}</span>
        </button>
      ) : (
        <button
          type="button"
          data-testid={testId}
          title={emptyOptionLabel}
          className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] border border-dashed border-[var(--k-border-strong)]/70 bg-transparent text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]/70 cursor-pointer min-w-0 max-w-[180px]"
        >
          <EmptyKindIcon className="w-3.5 h-3.5 shrink-0 opacity-75" />
          <span className="truncate">{emptyOptionLabel}</span>
        </button>
      )
    ) : (
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        className={`group k-interactive k-focus-ring inline-flex items-center justify-between gap-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer select-none max-w-[210px] ${
          size === 'sm' ? 'h-8 px-2.5 text-[12px]' : 'h-9 px-3 text-[13px]'
        }`}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
          {selectedOrbit ? (
            <SectionIcon
              name={selectedOrbit.icon}
              color={selectedOrbit.color}
              className="w-3.5 h-3.5 shrink-0"
            />
          ) : (
            <EmptyKindIcon
              className={`w-3.5 h-3.5 shrink-0 ${
                emptyOptionKind === 'auto'
                  ? 'text-[var(--k-accent)] opacity-85'
                  : 'text-[var(--k-ink-muted)]'
              }`}
            />
          )}
          <span className="truncate">{selectedOrbit ? selectedOrbit.name : emptyOptionLabel}</span>
        </span>
        <CaretDown
          weight="bold"
          className={`w-3.5 h-3.5 shrink-0 text-[var(--k-ink-muted)] transition-transform duration-150 ease-[var(--k-ease-out)] ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
    );

  return (
    <PopoverSurface
      open={open}
      onOpenChange={handleOpenChange}
      align={align}
      widthClass="w-[264px] !p-1.5"
      trigger={triggerElement}
    >
      <div className="flex flex-col text-[12.5px]">
        <div className="space-y-0.5 max-h-[220px] overflow-y-auto pr-0.5">
          <button
            type="button"
            onClick={() => {
              onChange('');
              handleOpenChange(false);
            }}
            className={`k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer ${
              value === ''
                ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
            }`}
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              <EmptyKindIcon className="w-3.5 h-3.5 shrink-0 opacity-75" />
              <span className="truncate">{emptyOptionLabel}</span>
            </span>
            {value === '' ? <Check weight="bold" className="w-3.5 h-3.5 shrink-0" /> : null}
          </button>

          {mergedOrbits.map((o) => {
            const selected = value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  handleOpenChange(false);
                }}
                className={`k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer ${
                  selected
                    ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                    : 'text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]'
                }`}
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  <SectionIcon
                    name={o.icon}
                    color={o.color}
                    className="w-3.5 h-3.5 shrink-0"
                  />
                  <span className="truncate">{o.name}</span>
                </span>
                {selected ? <Check weight="bold" className="w-3.5 h-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>

        <div className="mt-1.5 pt-1.5 border-t border-[var(--k-border-hairline)]">
          {!creating ? (
            <button
              ref={newBtnRef}
              type="button"
              data-testid="section-picker-new-btn"
              onClick={() => setCreating(true)}
              className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent-soft)] cursor-pointer text-left"
            >
              <Plus weight="bold" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{t('nav.newSectionInline')}</span>
            </button>
          ) : (
            <div className="flex flex-col gap-1.5 px-1 py-0.5">
              <input
                ref={inputRef}
                type="text"
                data-testid="section-picker-new-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopPropagation();
                    void handleCreateSection();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopPropagation();
                    cancelCreate();
                  }
                }}
                placeholder={t('nav.newSectionPlaceholder')}
                maxLength={48}
                disabled={creatingBusy}
                className="w-full h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none focus:border-[var(--k-border-focus)] k-selectable"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {QUICK_COLORS.map((hex) => {
                    const active = newColor === hex;
                    return (
                      <button
                        key={hex}
                        type="button"
                        aria-label={t('nav.pickColor', { hex })}
                        aria-pressed={active}
                        disabled={creatingBusy}
                        onClick={() => setNewColor(hex)}
                        style={{ backgroundColor: hex }}
                        className={`w-4 h-4 rounded-full cursor-pointer transition-transform duration-120 shrink-0 ${
                          active
                            ? 'scale-115 ring-2 ring-offset-1 ring-offset-[var(--k-bg-elevated)] ring-[var(--k-ink-primary)]'
                            : 'opacity-80 hover:opacity-100 hover:scale-110'
                        }`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={creatingBusy}
                    onClick={cancelCreate}
                    aria-label={t('common.cancel')}
                    className="k-interactive w-6 h-6 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center justify-center cursor-pointer"
                  >
                    <X weight="bold" className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    data-testid="section-picker-create-submit"
                    disabled={!newName.trim() || creatingBusy}
                    onClick={() => void handleCreateSection()}
                    aria-label={t('common.create')}
                    className="k-interactive w-6 h-6 rounded-md bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] inline-flex items-center justify-center cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:cursor-default"
                  >
                    <Check weight="bold" className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </PopoverSurface>
  );
};
