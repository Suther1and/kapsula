import React, { useId, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
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

const HIGHLIGHT_SPRING = { type: 'spring' as const, stiffness: 860, damping: 46, mass: 0.36 };

const MenuEntryList: React.FC<{
  entries: ContextMenuEntry[];
  scopedAccentStyle?: React.CSSProperties;
}> = ({ entries, scopedAccentStyle }) => {
  const layoutId = useId();
  const prefersReduced = useReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <LayoutGroup id={layoutId}>
      <div
        className="flex flex-col gap-0.5"
        onMouseLeave={() => setHoveredId(null)}
      >
        {entries.map((entry) => {
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
            const isHovered = hoveredId === entry.id;
            return (
              <ContextMenu.SubmenuRoot key={entry.id}>
                <ContextMenu.SubmenuTrigger
                  onMouseEnter={() => setHoveredId(entry.id)}
                  onFocus={() => setHoveredId(entry.id)}
                  className={`relative flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--k-ink-primary)] transition-colors duration-[80ms] cursor-pointer outline-none select-none ${
                    hoveredId === null
                      ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)] data-[popup-open]:bg-[var(--k-bg-surface-3)]'
                      : 'data-[popup-open]:bg-[var(--k-bg-surface-3)]'
                  }`}
                >
                  {isHovered ? (
                    <motion.span
                      layoutId={`ctx-hl-${layoutId}`}
                      aria-hidden="true"
                      style={{ borderRadius: 8 }}
                      transition={prefersReduced ? { duration: 0 } : HIGHLIGHT_SPRING}
                      className="pointer-events-none absolute inset-0 bg-[var(--k-bg-surface-3)]"
                    />
                  ) : null}
                  <span className="relative z-10 inline-flex items-center gap-2 min-w-0 truncate">
                    {entry.icon ? <span className="shrink-0 opacity-80">{entry.icon}</span> : null}
                    <span className="truncate">{entry.label}</span>
                  </span>
                  <CaretRight weight="bold" className="relative z-10 w-3 h-3 shrink-0 text-[var(--k-ink-muted)]" />
                </ContextMenu.SubmenuTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.Positioner sideOffset={4} collisionPadding={10} className="z-[135]">
                    <ContextMenu.Popup
                      data-k-popup="true"
                      style={scopedAccentStyle}
                      className="k-popover-card k-menu-motion min-w-[180px] max-w-[260px] max-h-[300px] overflow-y-auto p-1.5 outline-none"
                    >
                      <MenuEntryList entries={entry.items} scopedAccentStyle={scopedAccentStyle} />
                    </ContextMenu.Popup>
                  </ContextMenu.Positioner>
                </ContextMenu.Portal>
              </ContextMenu.SubmenuRoot>
            );
          }

          const isHovered = hoveredId === entry.id && !entry.disabled;
          return (
            <ContextMenu.Item
              key={entry.id}
              disabled={entry.disabled}
              onMouseEnter={() => {
                if (!entry.disabled) setHoveredId(entry.id);
              }}
              onFocus={() => {
                if (!entry.disabled) setHoveredId(entry.id);
              }}
              onClick={() => entry.onSelect()}
              className={`relative flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors duration-[80ms] cursor-pointer outline-none select-none ${
                entry.danger
                  ? `text-[var(--k-danger)] ${hoveredId === null ? 'data-[highlighted]:bg-[var(--k-danger-soft)]' : ''}`
                  : `text-[var(--k-ink-primary)] ${hoveredId === null ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)]' : ''}`
              } ${entry.disabled ? 'opacity-45 pointer-events-none' : ''}`}
            >
              {isHovered ? (
                <motion.span
                  layoutId={`ctx-hl-${layoutId}`}
                  aria-hidden="true"
                  style={{ borderRadius: 8 }}
                  transition={prefersReduced ? { duration: 0 } : HIGHLIGHT_SPRING}
                  className={`pointer-events-none absolute inset-0 ${
                    entry.danger ? 'bg-[var(--k-danger-soft)]' : 'bg-[var(--k-bg-surface-3)]'
                  }`}
                />
              ) : null}
              <span className="relative z-10 inline-flex items-center gap-2 min-w-0 truncate">
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
                <Check weight="bold" className="relative z-10 w-3.5 h-3.5 shrink-0 text-[var(--k-accent)]" />
              ) : entry.shortcut ? (
                <span className="relative z-10 k-mono text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
                  {entry.shortcut}
                </span>
              ) : null}
            </ContextMenu.Item>
          );
        })}
      </div>
    </LayoutGroup>
  );
};

export const ContextMenuSurface: React.FC<ContextMenuSurfaceProps> = ({
  entries,
  children,
  disabled = false,
  className = '',
  onOpenChange,
}) => {
  const [cachedEntries, setCachedEntries] = useState<ContextMenuEntry[]>([]);
  const [hasOpened, setHasOpened] = useState(false);
  const scopedAccentStyle = useScopedAccentStyle();

  if (disabled || (Array.isArray(entries) && entries.length === 0)) {
    return <>{children}</>;
  }

  const resolvedEntries = Array.isArray(entries) ? entries : cachedEntries;

  return (
    <ContextMenu.Root
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setHasOpened(true);
          if (typeof entries === 'function') {
            setCachedEntries(entries());
          }
        }
        onOpenChange?.(nextOpen);
      }}
    >
      <ContextMenu.Trigger className={className || 'contents'}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner collisionPadding={10} className="z-[130]">
          <ContextMenu.Popup
            data-k-popup="true"
            style={scopedAccentStyle}
            data-testid="context-menu-popup"
            className="k-popover-card k-menu-motion min-w-[205px] max-w-[280px] p-1.5 outline-none"
          >
            {hasOpened ? (
              <MenuEntryList entries={resolvedEntries} scopedAccentStyle={scopedAccentStyle} />
            ) : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};
