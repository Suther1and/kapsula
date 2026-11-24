import React from 'react';
import { ArrowSquareOut, ArrowsOutSimple, ImageSquare } from '@phosphor-icons/react';
import type { VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { CopySlotPill } from '../ui/CopySlotPill';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';

interface VisualShotCardProps {
  item: VaultItem;
  compactList?: boolean;
  onZoom: (item: VaultItem) => void;
}

export const VisualShotCard: React.FC<VisualShotCardProps> = React.memo(({
  item,
  compactList = false,
  onZoom,
}) => {
  const { t } = useI18n();
  const imgSrc = getMediaUrl(item.thumbPath || item.imagePath);
  const isVideoRef = item.subKind === 'video_ref' && Boolean(item.mediaPath);
  const cleanTitle = cleanBrokenTextArtifacts(
    item.title || (isVideoRef ? t('dna.videoRef') : t('dna.image')),
    true
  );
  const rawBodyPreview = stripLeadingTitle(
    cleanBrokenTextArtifacts(stripMarkdownPreview(item.body || ''), true),
    cleanTitle
  );
  const cleanSummary = rawBodyPreview
    ? rawBodyPreview
    : item.summary &&
        item.summary !== item.title &&
        !/^(?:Скриншот|Screenshot)\s/i.test(item.summary)
      ? cleanBrokenTextArtifacts(item.summary, true)
      : '';
  const urlActions = (item.extractedActions ?? []).filter((a) => a.type === 'url').slice(0, 3);

  if (compactList) {
    return (
      <div className="flex items-center gap-3 min-w-0">
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={cleanTitle}
            loading="lazy"
            decoding="async"
            onClick={(e) => {
              e.stopPropagation();
              onZoom(item);
            }}
            className="w-16 h-12 rounded-lg object-cover border border-[var(--k-border-hairline)] shrink-0 cursor-zoom-in"
          />
        ) : (
          <div className="w-16 h-12 rounded-lg bg-[var(--k-bg-surface-2)] flex items-center justify-center shrink-0">
            <ImageSquare className="w-5 h-5 text-[var(--k-ink-muted)]" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-[var(--k-ink-primary)] truncate">
            {cleanTitle}
          </div>
          {cleanSummary ? (
            <div className="text-[12px] text-[var(--k-ink-secondary)] truncate">
              {cleanSummary}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {isVideoRef && item.mediaPath ? (
        <InlineReferenceVideo
          mediaPath={item.mediaPath}
          posterPath={item.thumbPath || item.imagePath}
          heightClass="max-h-[240px]"
          onOpenFull={() => void window.kapsula.openMediaFile(item.mediaPath!)}
        />
      ) : imgSrc ? (
        <div className="group/shot relative aspect-[16/10] max-h-[260px] w-full rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]">
          <img
            src={imgSrc}
            alt={cleanTitle}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover block"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover/shot:opacity-100 transition-opacity duration-150 pointer-events-none" />
          <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 pointer-events-none group-hover/shot:opacity-100 group-hover/shot:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150">
            <CopySlotPill
              label={t('cards.photoLabel')}
              copiedLabel={t('common.done')}
              widthPx={84}
              heightPx={26}
              tone="secret"
              onCopy={() => window.kapsula.copyImage(item.imagePath || item.thumbPath || '')}
            />
            <button
              type="button"
              aria-label={t('cards.zoomAria')}
              onClick={(e) => {
                e.stopPropagation();
                onZoom(item);
              }}
              className="k-interactive inline-flex items-center justify-center w-6.5 h-6.5 rounded-lg border border-white/20 bg-black/60 text-white hover:bg-black/80 cursor-pointer"
            >
              <ArrowsOutSimple className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] leading-snug line-clamp-2">
          {cleanTitle}
        </div>
        {cleanSummary ? (
          <p className="m-0 text-[12px] text-[var(--k-ink-secondary)] line-clamp-3 leading-relaxed">
            {cleanSummary}
          </p>
        ) : null}

        {urlActions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {urlActions.map((act) => (
              <button
                key={act.value}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void window.kapsula.openExternal(act.value);
                }}
                className="k-interactive inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11px] text-[var(--k-accent)] hover:border-[var(--k-accent)] cursor-pointer"
              >
                <span className="truncate max-w-[140px]">{act.label}</span>
                <ArrowSquareOut className="w-2.5 h-2.5 shrink-0" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});
