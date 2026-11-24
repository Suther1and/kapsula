import React from 'react';
import { Dialog } from '@animate-ui/react/primitives/base-ui/dialog';
import { useReducedMotion } from 'motion/react';
import { X } from '@phosphor-icons/react';
import { useI18n } from '@shared/i18n/react';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

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
}) => {
  const { t } = useI18n();
  const prefersReduced = useReducedMotion();
  const scopedAccentStyle = useScopedAccentStyle();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[90] bg-[var(--k-bg-backdrop)] backdrop-blur-[6px]" />
        <Dialog.Viewport
          className={`fixed inset-0 z-[95] flex justify-center p-4 pointer-events-none ${
            topAligned ? 'items-start pt-[10vh]' : 'items-center'
          }`}
        >
          <Dialog.Popup
            from="top"
            transition={
              prefersReduced
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 32, mass: 0.78 }
            }
            exitTransition={
              prefersReduced
                ? { duration: 0 }
                : { duration: 0.12, ease: [0.23, 1, 0.32, 1] }
            }
            style={scopedAccentStyle}
            className={`pointer-events-auto w-[calc(100vw-36px)] ${maxWidthClass} max-h-[calc(100vh-44px)] flex flex-col rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-sheet)] outline-none overflow-hidden ${className}`}
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
                  aria-label={t('common.close')}
                  className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                >
                  <X weight="bold" className="w-4 h-4" />
                </Dialog.Close>
              </div>
            ) : null}
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
