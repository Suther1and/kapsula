import React from 'react';
import { BottomSheet } from './BottomSheet';

export interface ActionSheetEntry {
  id: string;
  label: string;
  subtitle?: string;
  icon: React.ReactNode;
  danger?: boolean;
  accent?: boolean;
  onSelect: () => void;
}

interface ItemActionSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  actions: ActionSheetEntry[];
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  onClose: () => void;
}

/**
 * Clean native-style mobile action sheet opened on long-press (~430ms) or `⋯` button.
 */
export const ItemActionSheet: React.FC<ItemActionSheetProps> = ({
  open,
  title,
  subtitle,
  actions,
  isExpanded,
  hingeRightOffsetPx = 0,
  onClose,
}) => {
  const regularActions = actions.filter((a) => !a.danger);
  const dangerActions = actions.filter((a) => a.danger);

  return (
    <BottomSheet
      open={open}
      title={title}
      subtitle={subtitle}
      isExpanded={isExpanded}
      hingeRightOffsetPx={hingeRightOffsetPx}
      maxWidthClass="max-w-sm"
      onClose={onClose}
    >
      <div data-testid="item-action-sheet" className="p-3.5 space-y-2.5">
        <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] overflow-hidden divide-y divide-[var(--k-border-hairline)]">
          {regularActions.map((act) => (
            <button
              key={act.id}
              type="button"
              data-testid={`action-sheet-${act.id}`}
              onClick={() => {
                onClose();
                act.onSelect();
              }}
              className="k-tap w-full flex items-center gap-3 px-4 min-h-[50px] py-2.5 text-left hover:bg-[var(--k-bg-surface-3)]/50 transition-colors"
            >
              <span
                className={`shrink-0 ${
                  act.accent ? 'text-[var(--k-accent)]' : 'text-[var(--k-ink-secondary)]'
                }`}
              >
                {act.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-medium text-[var(--k-ink-primary)] truncate">
                  {act.label}
                </div>
                {act.subtitle ? (
                  <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                    {act.subtitle}
                  </div>
                ) : null}
              </div>
            </button>
          ))}
        </div>

        {dangerActions.length > 0 ? (
          <div className="rounded-2xl bg-[var(--k-danger-soft)] border border-[var(--k-danger)]/25 overflow-hidden divide-y divide-[var(--k-danger)]/15">
            {dangerActions.map((act) => (
              <button
                key={act.id}
                type="button"
                data-testid={`action-sheet-${act.id}`}
                onClick={() => {
                  onClose();
                  act.onSelect();
                }}
                className="k-tap w-full flex items-center gap-3 px-4 min-h-[50px] py-2.5 text-left text-[var(--k-danger)]"
              >
                <span className="shrink-0">{act.icon}</span>
                <span className="text-[14.5px] font-semibold">{act.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
};
