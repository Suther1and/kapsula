import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from '@phosphor-icons/react';

interface ModalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  subtitle?: string;
  maxWidthClass?: string;
  hideHeader?: boolean;
  topAligned?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const ModalDialog: React.FC<ModalDialogProps> = ({
  open,
  onOpenChange,
  title,
  subtitle,
  maxWidthClass = 'max-w-[680px]',
  hideHeader = false,
  topAligned = false,
  className = '',
  children,
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[90] bg-[var(--k-bg-backdrop)] backdrop-blur-[6px] transition-opacity duration-160 ease-[var(--k-ease-out)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
      <Dialog.Popup
        className={`fixed left-1/2 ${
          topAligned
            ? 'top-[10vh] translate-y-0 data-[starting-style]:translate-y-1.5 data-[ending-style]:translate-y-1'
            : 'top-1/2 -translate-y-1/2 data-[starting-style]:translate-y-[calc(-50%+6px)] data-[ending-style]:translate-y-[calc(-50%+4px)]'
        } z-[95] w-[calc(100vw-36px)] ${maxWidthClass} max-h-[calc(100vh-44px)] -translate-x-1/2 flex flex-col rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-sheet)] outline-none overflow-hidden transition-[opacity,transform,scale,translate] duration-[170ms] ease-[var(--k-ease-out)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.978] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.986] ${className}`}
      >
        {!hideHeader ? (
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-[var(--k-border-hairline)] shrink-0">
            <div className="min-w-0">
              {title ? (
                <Dialog.Title className="m-0 text-[16px] font-semibold tracking-[-0.01em] text-[var(--k-ink-primary)]">
                  {title}
                </Dialog.Title>
              ) : null}
              {subtitle ? (
                <Dialog.Description className="mt-0.5 mb-0 text-[12.5px] text-[var(--k-ink-secondary)]">
                  {subtitle}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="Закрыть"
              className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
            >
              <X weight="bold" className="w-4 h-4" />
            </Dialog.Close>
          </div>
        ) : null}
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
