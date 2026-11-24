import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  Copy,
  PencilSimple,
  PushPin,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { OrbitDef, VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { formatRelativeDate, getDnaHumanLabel, getMediaUrl } from '../../lib/format';
import { hydrateFullVaultItem } from '../../lib/hydrate-item';
import { useScopedAccentStyle } from '../../lib/scoped-accent';
import { InlineReferenceVideo } from './InlineReferenceVideo';
import { SectionIcon } from './SectionIcon';
import { WaveformAudioPlayer } from './WaveformAudioPlayer';

interface QuickLookModalProps {
  item: VaultItem | null;
  itemsList: VaultItem[];
  orbit?: OrbitDef;
  onSelectItem: (item: VaultItem) => void;
  onClose: () => void;
  onEditInStudio: (item: VaultItem) => void;
  onTogglePin?: (item: VaultItem) => void;
  onExited?: () => void;
}

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v)$/i;

export const QuickLookModal: React.FC<QuickLookModalProps> = ({
  item,
  itemsList,
  orbit,
  onSelectItem,
  onClose,
  onEditInStudio,
  onTogglePin,
  onExited,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const scopedAccentStyle = useScopedAccentStyle();
  const [hydratedItem, setHydratedItem] = useState<VaultItem | null>(item);
  const hydrateSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++hydrateSeqRef.current;
    setHydratedItem(item);
    if (!item || !item.isCardProjection) {
      return () => {
        hydrateSeqRef.current += 1;
      };
    }
    void hydrateFullVaultItem(item).then((full) => {
      if (hydrateSeqRef.current !== seq) return;
      setHydratedItem(full);
    });
    return () => {
      hydrateSeqRef.current += 1;
    };
  }, [item]);

  const activeItem =
    item && hydratedItem && hydratedItem.id === item.id && !hydratedItem.isCardProjection
      ? hydratedItem
      : item;

  const navigable = itemsList.filter((x) => x.dna !== 'secret');
  const currentIndex = activeItem ? navigable.findIndex((x) => x.id === activeItem.id) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < navigable.length - 1;

  useEffect(() => {
    if (!activeItem) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        onSelectItem(navigable[currentIndex - 1]!);
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        onSelectItem(navigable[currentIndex + 1]!);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onClose();
        onEditInStudio(activeItem);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeItem, hasPrev, hasNext, currentIndex, navigable, onClose, onSelectItem, onEditInStudio]);

  if (typeof document === 'undefined') return null;

  const isVideo = Boolean(activeItem?.mediaPath && VIDEO_EXT_RE.test(activeItem.mediaPath));
  const imgUrl = activeItem ? getMediaUrl(activeItem.imagePath || activeItem.thumbPath) : null;
  const audioUrl = activeItem && activeItem.dna === 'voice' ? getMediaUrl(activeItem.mediaPath) : null;
  const cleanTitle = activeItem ? cleanBrokenTextArtifacts(activeItem.title || getDnaHumanLabel(activeItem), true) : '';
  const bodyText = activeItem
    ? cleanBrokenTextArtifacts(activeItem.body || activeItem.mediaMeta?.transcript || activeItem.summary || '', false)
    : '';
  const urlActions = (activeItem?.extractedActions ?? []).filter((a) => a.type === 'url').slice(0, 6);

  return createPortal(
    <AnimatePresence onExitComplete={onExited}>
      {activeItem ? (
        <motion.div
          key="quick-look-root"
          data-testid="quick-look-modal"
          style={scopedAccentStyle}
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 1 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-[105] flex items-center justify-center p-6"
        >
          <motion.div
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: prefersReduced
                ? { duration: 0.1 }
                : { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
            }}
            exit={{
              opacity: 0,
              transition: prefersReduced
                ? { duration: 0.08 }
                : { duration: 0.12, ease: [0.32, 0.72, 0, 1] },
            }}
            className={`fixed inset-0 bg-[var(--k-bg-backdrop)] ${
              prefersReduced ? 'backdrop-blur-[4px]' : 'backdrop-blur-[6px]'
            }`}
          />

          {/* Prev / Next floating arrows */}
          {hasPrev ? (
            <button
              type="button"
              onClick={() => onSelectItem(navigable[currentIndex - 1]!)}
              aria-label={t('ui.quickLook.prevAria')}
              className="k-interactive fixed left-6 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] inline-flex items-center justify-center cursor-pointer"
            >
              <CaretLeft weight="bold" className="w-5 h-5" />
            </button>
          ) : null}

          {hasNext ? (
            <button
              type="button"
              onClick={() => onSelectItem(navigable[currentIndex + 1]!)}
              aria-label={t('ui.quickLook.nextAria')}
              className="k-interactive fixed right-6 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] inline-flex items-center justify-center cursor-pointer"
            >
              <CaretRight weight="bold" className="w-5 h-5" />
            </button>
          ) : null}

          <motion.div
            key={activeItem.id}
            initial={
              prefersReduced
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    transform: 'perspective(1100px) translate3d(0, 12px, 0) rotateX(-5deg) scale(0.96)',
                  }
            }
            animate={
              prefersReduced
                ? { opacity: 1 }
                : {
                    opacity: 1,
                    transform: 'perspective(1100px) translate3d(0, 0px, 0) rotateX(0deg) scale(1)',
                    transition: {
                      type: 'spring',
                      stiffness: 500,
                      damping: 34,
                      mass: 0.66,
                      opacity: { duration: 0.14, ease: [0.22, 1, 0.36, 1] },
                    },
                  }
            }
            exit={
              prefersReduced
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    transform: 'perspective(1100px) translate3d(0, 6px, 0) rotateX(-2.5deg) scale(0.975)',
                    transition: { duration: 0.13, ease: [0.32, 0.72, 0, 1] },
                  }
            }
            style={{ transformOrigin: '50% 24%' }}
            className="relative z-10 w-full max-w-[780px] max-h-[84vh] rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] shadow-[var(--k-shadow-sheet)] flex flex-col overflow-hidden text-[var(--k-ink-primary)]"
          >
            {/* Clean Top Bar */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--k-border-hairline)] shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] shrink-0">
                  {getDnaHumanLabel(activeItem, locale)}
                </span>
                {orbit ? (
                  <span
                    style={{
                      backgroundColor: `color-mix(in srgb, ${orbit.color} 12%, transparent)`,
                      borderColor: `color-mix(in srgb, ${orbit.color} 26%, transparent)`,
                    }}
                    className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[7px] border text-[11.5px] font-medium text-[var(--k-ink-primary)] shrink-0"
                  >
                    <SectionIcon name={orbit.icon} color={orbit.color} className="w-3 h-3 shrink-0" />
                    {orbit.name}
                  </span>
                ) : null}
                <span className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                  {formatRelativeDate(activeItem.contentUpdatedAt || activeItem.createdAt, locale)}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {onTogglePin ? (
                  <button
                    type="button"
                    onClick={() => onTogglePin(activeItem)}
                    aria-label={activeItem.isPinned ? t('ui.quickLook.unpin') : t('ui.quickLook.pin')}
                    className={`k-interactive w-8 h-8 rounded-lg inline-flex items-center justify-center cursor-pointer ${
                      activeItem.isPinned
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <PushPin weight={activeItem.isPinned ? 'fill' : 'regular'} className="w-4 h-4" />
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      if (imgUrl && activeItem.dna === 'shot') {
                        await window.kapsula.copyImage(activeItem.imagePath || activeItem.thumbPath || '');
                        toast.success(t('ui.quickLook.imageCopied'));
                      } else {
                        let resolved = activeItem;
                        if (!resolved.url && resolved.isCardProjection && resolved.isBodyTruncated) {
                          resolved = await hydrateFullVaultItem(resolved);
                        }
                        const resolvedTitle = cleanBrokenTextArtifacts(
                          resolved.title || getDnaHumanLabel(resolved),
                          true
                        );
                        const resolvedBody = cleanBrokenTextArtifacts(
                          resolved.body || resolved.mediaMeta?.transcript || resolved.summary || '',
                          false
                        );
                        await window.kapsula.copyText(resolved.url || resolvedBody || resolvedTitle);
                        toast.success(t('common.copied'));
                      }
                    })();
                  }}
                  className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t('common.copy')}</span>
                </button>

                <button
                  type="button"
                  data-testid="quick-look-edit-btn"
                  onClick={() => {
                    onClose();
                    onEditInStudio(activeItem);
                  }}
                  className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <PencilSimple className="w-3.5 h-3.5" />
                  <span>{t('ui.quickLook.openEditor')}</span>
                </button>

                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t('ui.quickLook.closeAria')}
                  className="k-interactive w-8 h-8 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                >
                  <X weight="bold" className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
              {isVideo && activeItem.mediaPath ? (
                <InlineReferenceVideo
                  mediaPath={activeItem.mediaPath}
                  posterPath={activeItem.thumbPath || activeItem.imagePath}
                  heightClass="max-h-[420px]"
                  onOpenFull={() => void window.kapsula.openMediaFile(activeItem.mediaPath!)}
                />
              ) : (activeItem.mediaMeta?.cachedVideoFile || activeItem.mediaMeta?.youtubeVideoId) ? (
                <InlineReferenceVideo
                  cachedVideoFile={activeItem.mediaMeta?.cachedVideoFile}
                  youtubeVideoId={activeItem.mediaMeta?.youtubeVideoId}
                  posterPath={activeItem.thumbPath || activeItem.imagePath}
                  heightClass="max-h-[420px]"
                />
              ) : imgUrl ? (
                <div className="rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] flex items-center justify-center">
                  <img
                    src={imgUrl}
                    alt={cleanTitle}
                    className="max-h-[420px] w-auto object-contain block"
                  />
                </div>
              ) : null}

              {activeItem.colorPalette && activeItem.colorPalette.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--k-ink-muted)]">{t('ui.quickLook.palette')}</span>
                  {activeItem.colorPalette.slice(0, 6).map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      title={t('ui.quickLook.copyColor', { hex })}
                      onClick={() => {
                        void window.kapsula.copyText(hex);
                        toast.success(t('ui.quickLook.colorCopied', { hex }));
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-full border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[10.5px] k-mono text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-[var(--k-border-strong)]"
                        style={{ backgroundColor: hex }}
                      />
                      {hex}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="space-y-2">
                <h2 className="m-0 text-[20px] font-semibold tracking-[-0.02em] leading-snug text-[var(--k-ink-primary)] k-selectable">
                  {cleanTitle}
                </h2>
                {activeItem.url ? (
                  <button
                    type="button"
                    onClick={() => void window.kapsula.openExternal(activeItem.url!)}
                    className="k-interactive inline-flex items-center gap-1.5 text-[12.5px] text-[var(--k-accent)] hover:underline cursor-pointer max-w-full"
                  >
                    <span className="truncate">{activeItem.url}</span>
                    <ArrowSquareOut className="w-3.5 h-3.5 shrink-0" />
                  </button>
                ) : null}
              </div>

              {audioUrl ? (
                <WaveformAudioPlayer
                  src={audioUrl}
                  fallbackDurationSec={activeItem.mediaDurationSec}
                  peaks={activeItem.mediaMeta?.waveformPeaks}
                  seedKey={activeItem.id}
                />
              ) : null}

              {bodyText ? (
                <div className="k-selectable space-y-1.5 text-[14px] leading-[1.68] text-[var(--k-ink-secondary)]">
                  {bodyText.split(/\r?\n/).map((line, idx) => {
                    const trimmed = line.trim();
                    if (!trimmed) return <div key={idx} className="h-1.5" />;
                    const taskM = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(trimmed);
                    if (taskM) {
                      const checked = taskM[1]!.toLowerCase() === 'x';
                      return (
                        <div key={idx} className="flex items-start gap-2.5 py-0.5">
                          <span
                            className={`mt-1 w-4 h-4 rounded-[5px] border inline-flex items-center justify-center shrink-0 text-[10px] font-bold ${
                              checked
                                ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                                : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)]'
                            }`}
                          >
                            {checked ? '✓' : ''}
                          </span>
                          <span className={checked ? 'line-through text-[var(--k-ink-muted)]' : 'text-[var(--k-ink-primary)]'}>
                            {taskM[2]}
                          </span>
                        </div>
                      );
                    }
                    const headingM = /^(#{1,3})\s+(.+)$/.exec(trimmed);
                    if (headingM) {
                      return (
                        <div key={idx} className="k-display font-semibold text-[15.5px] text-[var(--k-ink-primary)] pt-1.5">
                          {headingM[2]}
                        </div>
                      );
                    }
                    const bulletM = /^[-*•]\s+(.+)$/.exec(trimmed);
                    if (bulletM) {
                      return (
                        <div key={idx} className="flex items-start gap-2 pl-1">
                          <span className="mt-2.5 w-1.5 h-1.5 rounded-full bg-[var(--k-accent)] shrink-0" />
                          <span className="text-[var(--k-ink-primary)]">{bulletM[1]}</span>
                        </div>
                      );
                    }
                    return (
                      <p key={idx} className="m-0 text-[var(--k-ink-secondary)]">
                        {line}
                      </p>
                    );
                  })}
                </div>
              ) : null}

              {urlActions.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {urlActions.map((act) => (
                    <button
                      key={act.value}
                      type="button"
                      onClick={() => void window.kapsula.openExternal(act.value)}
                      className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-accent)] hover:border-[var(--k-accent)]/60 cursor-pointer"
                    >
                      <span className="truncate max-w-[240px]">{act.label}</span>
                      <ArrowSquareOut className="w-3 h-3 shrink-0" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Footer hint */}
            <div className="px-5 py-2 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/40 flex items-center justify-between text-[11px] text-[var(--k-ink-muted)] shrink-0">
              <span>{t('ui.quickLook.footerHint')}</span>
              {navigable.length > 1 && currentIndex >= 0 ? (
                <span className="k-mono">
                  {currentIndex + 1} / {navigable.length} · ← →
                </span>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
};
