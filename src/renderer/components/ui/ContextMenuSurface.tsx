import React, { useCallback, useRef, useState } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { useReducedMotion } from 'motion/react';
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

interface HighlightBox {
  id: string;
  top: number;
  height: number;
  danger: boolean;
  visible: boolean;
  animatePosition: boolean;
}

/**
 * Single integer-snapped background highlight track behind static menu rows.
 * Avoids per-item Framer Motion `layoutId` reparenting so Chromium never re-promotes
 * sibling text/icon layers or blurs subpixel antialiasing while moving the pointer.
 */
const MenuEntryList: React.FC<{
  entries: ContextMenuEntry[];
  scopedAccentStyle?: React.CSSProperties;
}> = ({ entries, scopedAccentStyle }) => {
  const prefersReduced = useReducedMotion();
  const [hl, setHl] = useState<HighlightBox | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const focusRow = useCallback((id: string, danger = false) => {
    const el = itemRefs.current.get(id);
    if (!el) return;
    const top = Math.round(el.offsetTop);
    const height = Math.round(el.offsetHeight);
    setHl((prev) => ({
      id,
      top,
      height,
      danger,
      visible: true,
      animatePosition: Boolean(prev?.visible),
    }));
  }, []);

  const clearRow = useCallback(() => {
    setHl((prev) => (prev ? { ...prev, visible: false, animatePosition: false } : null));
  }, []);

  const registerRow = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) itemRefs.current.set(id, el);
      else itemRefs.current.delete(id);
    },
    []
  );

  return (
    <div
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
                ? 'transform 110ms cubic-bezier(0.22, 1, 0.36, 1), height 110ms cubic-bezier(0.22, 1, 0.36, 1), opacity 80ms ease-out, background-color 90ms ease-out'
                : 'opacity 80ms ease-out, background-color 90ms ease-out',
          }}
          className={`pointer-events-none absolute top-0 left-0 right-0 z-0 rounded-lg ${
            hl.danger ? 'bg-[var(--k-danger-soft)]' : 'bg-[var(--k-bg-surface-3)]'
          }`}
        />
      ) : null}

      {entries.map((entry) => {
        if (entry.type === 'separator') {
          return (
            <ContextMenu.Separator
              key={entry.id}
              className="relative z-[1] my-1 h-px bg-[var(--k-border-hairline)]"
            />
          );
        }
        if (entry.type === 'label') {
          return (
            <ContextMenu.GroupLabel
              key={entry.id}
              className="relative z-[1] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--k-ink-muted)]"
            >
              {entry.label}
            </ContextMenu.GroupLabel>
          );
        }
        if (entry.type === 'submenu') {
          return (
            <ContextMenu.SubmenuRoot key={entry.id}>
              <ContextMenu.SubmenuTrigger
                ref={registerRow(entry.id)}
                onMouseEnter={() => focusRow(entry.id, false)}
                onFocus={() => focusRow(entry.id, false)}
                className={`relative z-[1] flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--k-ink-primary)] transition-colors duration-[80ms] cursor-pointer outline-none select-none ${
                  !hl?.visible
                    ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)] data-[popup-open]:bg-[var(--k-bg-surface-3)]'
                    : 'data-[popup-open]:bg-[var(--k-bg-surface-3)]'
                }`}
              >
                <span className="inline-flex items-center gap-2 min-w-0 truncate">
                  {entry.icon ? <span className="shrink-0 opacity-80">{entry.icon}</span> : null}
                  <span className="truncate">{entry.label}</span>
                </span>
                <CaretRight weight="bold" className="w-3 h-3 shrink-0 text-[var(--k-ink-muted)]" />
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

        return (
          <ContextMenu.Item
            key={entry.id}
            ref={registerRow(entry.id)}
            disabled={entry.disabled}
            onMouseEnter={() => {
              if (!entry.disabled) focusRow(entry.id, Boolean(entry.danger));
            }}
            onFocus={() => {
              if (!entry.disabled) focusRow(entry.id, Boolean(entry.danger));
            }}
            onClick={() => entry.onSelect()}
            className={`relative z-[1] flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors duration-[80ms] cursor-pointer outline-none select-none ${
              entry.danger
                ? `text-[var(--k-danger)] ${!hl?.visible ? 'data-[highlighted]:bg-[var(--k-danger-soft)]' : ''}`
                : `text-[var(--k-ink-primary)] ${!hl?.visible ? 'data-[highlighted]:bg-[var(--k-bg-surface-3)]' : ''}`
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
      })}
    </div>
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
