import React, { useEffect, useId, useRef, useState } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { X } from '@phosphor-icons/react';
import { pushBackHandler } from '../lib/back-stack';

// Module-level open-sheet stack so stacked sheets (e.g. MobilePickerSheet over QuickCaptureSheet)
// receive monotonically increasing z-indexes, single-backdrop deduplication, and strict LIFO dismissal.
const openSheetStack: string[] = [];
const stackListeners = new Set<() => void>();
let lastNestedDismissAt = 0;

function notifySheetStack() {
  for (const listener of stackListeners) {
    listener();
  }
}

function registerSheetInStack(id: string) {
  if (!openSheetStack.includes(id)) {
    openSheetStack.push(id);
    notifySheetStack();
  }
}

function unregisterSheetFromStack(id: string) {
  const idx = openSheetStack.indexOf(id);
  if (idx !== -1) {
    if (idx > 0) {
      lastNestedDismissAt = performance.now();
    }
    openSheetStack.splice(idx, 1);
    notifySheetStack();
  }
}

function getSheetStackIndex(id: string): number {
  return openSheetStack.indexOf(id);
}

function isTopmostSheet(id: string): boolean {
  return openSheetStack.length > 0 && openSheetStack[openSheetStack.length - 1] === id;
}

interface BottomSheetProps {
  open: boolean;
  title?: string;
  subtitle?: string;
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  maxWidthClass?: string;
  onClose: () => void;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Production mobile sheet powered by @base-ui/react Drawer:
 * - Keeps a single unified Drawer.Root across Compact <-> Expanded Fold transitions so folding or
 *   unfolding NEVER drops input focus, scroll position, or unsaved form state.
 * - Compact Fold (< 600dp): native swipe-down-to-dismiss with rubber-band drag, nested-scroll
 *   preservation, and `%`-based max-height that fits cleanly above Android IME.
 * - Expanded Fold (>= 600dp): centered modal card respecting vertical hinge offset, swipe disabled.
 * - Stacked sheets (e.g. pickers inside forms): automatic z-index elevation, lightweight scrim
 *   (zero double-darkening/blur), and strict topmost-only Escape / CloseWatcher handling.
 */
export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  title,
  subtitle,
  isExpanded,
  hingeRightOffsetPx = 0,
  maxWidthClass = 'max-w-lg',
  onClose,
  headerRight,
  footer,
  children,
}) => {
  const sheetId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [stackIndex, setStackIndex] = useState(0);

  // Track sheet stack position synchronously while open
  useEffect(() => {
    if (!open) return;
    registerSheetInStack(sheetId);
    const sync = () => {
      const idx = getSheetStackIndex(sheetId);
      setStackIndex(idx >= 0 ? idx : 0);
    };
    sync();
    stackListeners.add(sync);
    return () => {
      stackListeners.delete(sync);
      unregisterSheetFromStack(sheetId);
    };
  }, [open, sheetId]);

  // Register on LIFO Android hardware/gesture Back stack
  useEffect(() => {
    if (!open) return;
    return pushBackHandler(() => onCloseRef.current());
  }, [open]);

  const isNested = stackIndex > 0;
  const backdropZ = 50 + stackIndex * 10;
  const viewportZ = 51 + stackIndex * 10;

  const handleOpenChange: React.ComponentProps<typeof Drawer.Root>['onOpenChange'] = (
    nextOpen,
    eventDetails
  ) => {
    if (nextOpen) return;
    // Block swipe-to-dismiss on centered expanded modal
    if (isExpanded && eventDetails.reason === 'swipe') {
      eventDetails.cancel();
      return;
    }
    // Strict topmost guard: never let Escape / CloseWatcher / outside-press dismiss a parent
    // sheet when a child picker sheet is open or just closed in the same event tick.
    const isAutoDismiss =
      eventDetails.reason === 'escape-key' ||
      eventDetails.reason === 'close-watcher' ||
      eventDetails.reason === 'outside-press';
    if (
      !isTopmostSheet(sheetId) ||
      (!isNested && isAutoDismiss && performance.now() - lastNestedDismissAt < 140)
    ) {
      eventDetails.cancel();
      return;
    }
    if (isNested) {
      lastNestedDismissAt = performance.now();
    }
    onCloseRef.current();
  };

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      swipeDirection="down"
      modal={isNested ? 'trap-focus' : true}
    >
      <Drawer.Portal>
        <Drawer.Backdrop
          style={{ zIndex: backdropZ }}
          className={
            isNested
              ? 'k-drawer-backdrop k-drawer-backdrop--nested'
              : isExpanded
                ? 'k-dialog-backdrop'
                : 'k-drawer-backdrop'
          }
        />
        <Drawer.Viewport
          style={{
            zIndex: viewportZ,
            ...(isExpanded && hingeRightOffsetPx > 0 ? { paddingLeft: hingeRightOffsetPx } : {}),
          }}
          className={isExpanded ? 'k-drawer-viewport k-drawer-viewport--expanded' : 'k-drawer-viewport'}
        >
          <Drawer.Popup
            data-base-ui-swipe-ignore={isExpanded ? '' : undefined}
            className={
              isExpanded
                ? `k-drawer-popup k-drawer-popup--expanded w-full ${maxWidthClass}`
                : 'k-drawer-popup'
            }
          >
            <Drawer.Content className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {/* Drag Handle (compact bottom drawer only) */}
              {!isExpanded ? (
                <div
                  className="flex justify-center pt-2.5 pb-1.5 shrink-0 touch-none cursor-grab active:cursor-grabbing"
                  aria-hidden="true"
                >
                  <div className="w-10 h-1 rounded-full bg-[var(--k-border-strong)]" />
                </div>
              ) : null}

              {title || headerRight ? (
                <div
                  className={`flex items-center justify-between gap-3 px-4 border-b border-[var(--k-border-hairline)] shrink-0 ${
                    isExpanded ? 'py-3' : 'pb-3 pt-0.5 touch-none'
                  }`}
                >
                  <div className="min-w-0">
                    {title ? (
                      <Drawer.Title className="text-[16px] font-semibold leading-tight text-[var(--k-ink-primary)] truncate">
                        {title}
                      </Drawer.Title>
                    ) : null}
                    {subtitle ? (
                      <Drawer.Description className="text-[12px] leading-snug text-[var(--k-ink-muted)] whitespace-normal mt-0.5">
                        {subtitle}
                      </Drawer.Description>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {headerRight}
                    <Drawer.Close
                      aria-label="Закрыть"
                      className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
                    >
                      <X className="w-4 h-4" />
                    </Drawer.Close>
                  </div>
                </div>
              ) : null}

              <div className="flex-1 min-h-0 k-scroll">{children}</div>
              {footer ? (
                <div className="shrink-0 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]">
                  {footer}
                </div>
              ) : null}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
};
