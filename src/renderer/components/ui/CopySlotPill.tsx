import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, Copy } from '@phosphor-icons/react';
import { TooltipHint } from './TooltipHint';
import { playTactileSound } from '../../lib/tactileSound';
import { useI18n } from '@shared/i18n/react';

interface CopySlotPillProps {
  label: string;
  copiedLabel?: string;
  onCopy: () => Promise<boolean | number | void> | boolean | number | void;
  /** Fixed pixel width ensures zero layout shift regardless of copied countdown text */
  widthPx?: number;
  heightPx?: number;
  wipeSeconds?: number;
  tone?: 'default' | 'accent' | 'secret';
  className?: string;
  'data-testid'?: string;
}

export const CopySlotPill: React.FC<CopySlotPillProps> = ({
  label,
  copiedLabel,
  onCopy,
  widthPx = 112,
  heightPx = 30,
  wipeSeconds = 0,
  tone = 'default',
  className = '',
  'data-testid': testId,
}) => {
  const { t } = useI18n();
  const [remaining, setRemaining] = useState<number>(0);
  const [copiedJustNow, setCopiedJustNow] = useState(false);
  const prefersReduced = useReducedMotion();
  const resolvedCopiedLabel = copiedLabel ?? t('common.done');

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          setCopiedJustNow(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remaining]);

  useEffect(() => {
    if (!copiedJustNow || remaining > 0) return;
    const timer = window.setTimeout(() => setCopiedJustNow(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedJustNow, remaining]);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await onCopy();
    if (res === false) return;
    playTactileSound('copy');
    setCopiedJustNow(true);
    if (typeof res === 'number' && res > 0) {
      setRemaining(res);
    } else if (wipeSeconds > 0) {
      setRemaining(wipeSeconds);
    }
  };

  const isCopied = copiedJustNow || remaining > 0;
  const activeText =
    remaining > 0 ? `${resolvedCopiedLabel} ${remaining} ${t('common.secUnit')}` : resolvedCopiedLabel;

  const toneClasses = isCopied
    ? 'bg-[var(--k-emerald-soft)] border-[var(--k-emerald)]/40 text-[var(--k-emerald)]'
    : tone === 'secret'
      ? 'bg-white/[0.08] border-white/[0.14] text-[#f4f3ee] hover:bg-white/[0.14]'
      : tone === 'accent'
        ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/30 text-[var(--k-accent)] hover:bg-[var(--k-accent)]/20'
        : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]';

  const buttonEl = (
    <button
      type="button"
      data-testid={testId}
      onClick={handleClick}
      style={{ width: `${widthPx}px`, height: `${heightPx}px` }}
      className={`k-interactive k-focus-ring k-tabular shrink-0 inline-flex items-center justify-center gap-1 rounded-lg border px-1.5 text-[11.5px] font-medium leading-none whitespace-nowrap overflow-hidden cursor-pointer select-none ${toneClasses} ${className}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {isCopied ? (
          <motion.span
            key="check"
            initial={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.75)', opacity: 0 }}
            animate={prefersReduced ? { opacity: 1 } : { transform: 'scale(1)', opacity: 1 }}
            exit={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.8)', opacity: 0 }}
            transition={{ duration: 0.13, ease: [0.23, 1, 0.32, 1] }}
            className="inline-flex shrink-0"
          >
            <Check weight="bold" className="w-3.5 h-3.5" />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.8)', opacity: 0 }}
            animate={prefersReduced ? { opacity: 1 } : { transform: 'scale(1)', opacity: 1 }}
            exit={prefersReduced ? { opacity: 0 } : { transform: 'scale(0.8)', opacity: 0 }}
            transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
            className="inline-flex shrink-0 opacity-80"
          >
            <Copy weight="regular" className="w-3.5 h-3.5" />
          </motion.span>
        )}
      </AnimatePresence>
      <span className="truncate">{isCopied ? activeText : label}</span>
    </button>
  );

  return (
    <TooltipHint
      side="top"
      disabled={remaining <= 0}
      label={
        remaining > 0
          ? t('ui.clipboardWipeBanner', { seconds: remaining })
          : t('ui.clipboardWipeBannerIdle')
      }
    >
      {buttonEl}
    </TooltipHint>
  );
};
