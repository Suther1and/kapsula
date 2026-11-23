import React, { useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { CaretRight, Check } from '@phosphor-icons/react';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

export type ContextMenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      dotColor?: string;
      active?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'submenu';
      id: string;
      label: string;
      icon?: React.ReactNode;
      items: ContextMenuEntry[];
    }
  | {
      type: 'separator';
      id: string;
    }
  | {
      type: 'label';
      id: string;
      label: string;
    };

interface ContextMenuSurfaceProps {
  entries: ContextMenuEntry[] | (() => ContextMenuEntry[]);
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

const renderEntries = (
  entries: ContextMenuEntry[],
  scopedAccentStyle?: React.CSSProperties
): React.ReactNode =>
  entries.map((entry) => {
    if (entry.type === 'separator') {
      return (
        <ContextMenu.Separator
          key={entry.id}
          className="my-1 h-px bg-[var(--k-border-hairline)]"
        />
      );
    }
    if (entry.type === 'label') {
      return (
        <ContextMenu.GroupLabel
          key={entry.id}
          className="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--k-ink-muted)]"
        >
          {entry.label}
        </ContextMenu.GroupLabel>
      );
    }
    if (entry.type === 'submenu') {
      return (
        <ContextMenu.SubmenuRoot key={entry.id}>
          <ContextMenu.SubmenuTrigger className="k-interactive flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--k-ink-primary)] cursor-pointer outline-none select-none data-[highlighted]:bg-[var(--k-bg-surface-3)] data-[popup-open]:bg-[var(--k-bg-surface-3)]">
            <span className="inline-flex items-center gap-2 min-w-0 truncate">
              {entry.icon ? <span className="shrink-0 opacity-80">{entry.icon}</span> : null}
              <span className="truncate">{entry.label}</span>
            </span>
            <CaretRight weight="bold" className="w-3 h-3 shrink-0 text-[var(--k-ink-muted)]" />
          </ContextMenu.SubmenuTrigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner sideOffset={4} collisionPadding={10} className="z-[135]">
              <ContextMenu.Popup
                style={scopedAccentStyle}
                className="k-popup-motion min-w-[180px] max-w-[260px] max-h-[300px] overflow-y-auto rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl outline-none"
              >
                {renderEntries(entry.items, scopedAccentStyle)}
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.SubmenuRoot>
      );
    }
    return (
      <ContextMenu.Item
        key={entry.id}
        disabled={entry.disabled}
        onClick={() => entry.onSelect()}
        className={`k-interactive flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] cursor-pointer outline-none select-none ${
          entry.danger
            ? 'text-[var(--k-danger)] data-[highlighted]:bg-[var(--k-danger-soft)]'
            : 'text-[var(--k-ink-primary)] data-[highlighted]:bg-[var(--k-bg-surface-3)]'
        } ${entry.disabled ? 'opacity-45 pointer-events-none' : ''}`}
      >
        <span className="inline-flex items-center gap-2 min-w-0 truncate">
          {entry.dotColor ? (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: entry.dotColor }}
            />
          ) : entry.icon ? (
            <span className="shrink-0 opacity-80">{entry.icon}</span>
          ) : null}
          <span className="truncate">{entry.label}</span>
        </span>
        {entry.active ? (
          <Check weight="bold" className="w-3.5 h-3.5 shrink-0 text-[var(--k-accent)]" />
        ) : entry.shortcut ? (
          <span className="k-mono text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
            {entry.shortcut}
          </span>
        ) : null}
      </ContextMenu.Item>
    );
  });

export const ContextMenuSurface: React.FC<ContextMenuSurfaceProps> = ({
  entries,
  children,
  disabled = false,
  className = '',
  onOpenChange,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const scopedAccentStyle = useScopedAccentStyle();

  if (disabled || (Array.isArray(entries) && entries.length === 0)) {
    return <>{children}</>;
  }

  const resolvedEntries =
    menuOpen ? (typeof entries === 'function' ? entries() : entries) : [];

  return (
    <ContextMenu.Root
      onOpenChange={(nextOpen) => {
        setMenuOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <ContextMenu.Trigger className={className || 'contents'}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner collisionPadding={10} className="z-[130]">
          <ContextMenu.Popup
            style={scopedAccentStyle}
            data-testid="context-menu-popup"
            className="k-popup-motion min-w-[205px] max-w-[280px] rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl outline-none"
          >
            {menuOpen ? renderEntries(resolvedEntries, scopedAccentStyle) : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};
