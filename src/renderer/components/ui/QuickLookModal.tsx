import React, { useEffect } from 'react';
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
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const scopedAccentStyle = useScopedAccentStyle();

  const navigable = itemsList.filter((x) => x.dna !== 'secret');
  const currentIndex = item ? navigable.findIndex((x) => x.id === item.id) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < navigable.length - 1;

  useEffect(() => {
    if (!item) return;
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
        onEditInStudio(item);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [item, hasPrev, hasNext, currentIndex, navigable, onClose, onSelectItem, onEditInStudio]);

  if (typeof document === 'undefined') return null;

  const isVideo = Boolean(item?.mediaPath && VIDEO_EXT_RE.test(item.mediaPath));
  const imgUrl = item ? getMediaUrl(item.imagePath || item.thumbPath) : null;
  const audioUrl = item && item.dna === 'voice' ? getMediaUrl(item.mediaPath) : null;
  const cleanTitle = item ? cleanBrokenTextArtifacts(item.title || getDnaHumanLabel(item), true) : '';
  const bodyText = item
    ? cleanBrokenTextArtifacts(item.body || item.mediaMeta?.transcript || item.summary || '', false)
    : '';
  const urlActions = (item?.extractedActions ?? []).filter((a) => a.type === 'url').slice(0, 6);

  return createPortal(
    <AnimatePresence>
      {item ? (
        <div
          key="quick-look-root"
          data-testid="quick-look-modal"
          style={scopedAccentStyle}
          className="fixed inset-0 z-[105] flex items-center justify-center p-6"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={onClose}
            className="fixed inset-0 bg-[var(--k-bg-backdrop)] backdrop-blur-[6px]"
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
            key={item.id}
            initial={
              prefersReduced
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    filter: 'blur(4px)',
                    transform: 'perspective(850px) rotateX(-12deg) scale(0.89)',
                  }
            }
            animate={
              prefersReduced
                ? { opacity: 1 }
                : {
                    opacity: 1,
                    filter: 'blur(0px)',
                    transform: 'perspective(850px) rotateX(0deg) scale(1)',
                    transition: {
                      type: 'spring',
                      stiffness: 410,
                      damping: 29,
                      mass: 0.76,
                      opacity: { duration: 0.16, ease: [0.23, 1, 0.32, 1] },
                    },
                  }
            }
            exit={
              prefersReduced
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    filter: 'blur(3px)',
                    transform: 'perspective(850px) rotateX(-8deg) scale(0.93)',
                    transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] },
                  }
            }
            className="relative z-10 w-full max-w-[780px] max-h-[84vh] rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] shadow-[var(--k-shadow-sheet)] flex flex-col overflow-hidden text-[var(--k-ink-primary)]"
          >
            {/* Clean Top Bar */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--k-border-hairline)] shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] shrink-0">
                  {getDnaHumanLabel(item, locale)}
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
                  {formatRelativeDate(item.contentUpdatedAt || item.createdAt, locale)}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {onTogglePin ? (
                  <button
                    type="button"
                    onClick={() => onTogglePin(item)}
                    aria-label={item.isPinned ? t('ui.quickLook.unpin') : t('ui.quickLook.pin')}
                    className={`k-interactive w-8 h-8 rounded-lg inline-flex items-center justify-center cursor-pointer ${
                      item.isPinned
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-4 h-4" />
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    if (imgUrl && item.dna === 'shot') {
                      void window.kapsula.copyImage(item.imagePath || item.thumbPath || '');
                      toast.success(t('ui.quickLook.imageCopied'));
                    } else {
                      void window.kapsula.copyText(item.url || bodyText || cleanTitle);
                      toast.success(t('common.copied'));
                    }
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
                    onEditInStudio(item);
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
              {isVideo && item.mediaPath ? (
                <InlineReferenceVideo
                  mediaPath={item.mediaPath}
                  posterPath={item.thumbPath || item.imagePath}
                  heightClass="max-h-[420px]"
                  onOpenFull={() => void window.kapsula.openMediaFile(item.mediaPath!)}
                />
              ) : (item.mediaMeta?.cachedVideoFile || item.mediaMeta?.youtubeVideoId) ? (
                <InlineReferenceVideo
                  cachedVideoFile={item.mediaMeta?.cachedVideoFile}
                  youtubeVideoId={item.mediaMeta?.youtubeVideoId}
                  posterPath={item.thumbPath || item.imagePath}
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

              {item.colorPalette && item.colorPalette.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--k-ink-muted)]">{t('ui.quickLook.palette')}</span>
                  {item.colorPalette.slice(0, 6).map((hex) => (
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
                {item.url ? (
                  <button
                    type="button"
                    onClick={() => void window.kapsula.openExternal(item.url!)}
                    className="k-interactive inline-flex items-center gap-1.5 text-[12.5px] text-[var(--k-accent)] hover:underline cursor-pointer max-w-full"
                  >
                    <span className="truncate">{item.url}</span>
                    <ArrowSquareOut className="w-3.5 h-3.5 shrink-0" />
                  </button>
                ) : null}
              </div>

              {audioUrl ? (
                <WaveformAudioPlayer
                  src={audioUrl}
                  fallbackDurationSec={item.mediaDurationSec}
                  peaks={item.mediaMeta?.waveformPeaks}
                  seedKey={item.id}
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
        </div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
};
