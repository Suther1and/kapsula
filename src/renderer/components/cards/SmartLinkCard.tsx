import React, { useMemo, useState } from 'react';
import {
  ArrowSquareOut,
  ArrowsClockwise,
  GlobeSimple,
  LockSimple,
  PaperPlaneTilt,
  PlayCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { CopySlotPill } from '../ui/CopySlotPill';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';

interface SmartLinkCardProps {
  item: VaultItem;
  compactList?: boolean;
}

const VIDEO_PATH_RE = /\.(?:mp4|webm|mov|m4v)$/i;
const PRIVATE_TG_URL_RE = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/(?:c\/\d+|\+|joinchat\/)/i;
const DEDICATED_VIDEO_URL_RE =
  /(?:instagram\.com\/(?:reel|reels|tv)\/|tiktok\.com\/|v\.redd\.it\/)/i;
const BARE_STUB_TITLE_RE =
  /^(?:ссылка(?:\s+из\s+другого\s+приложения)?|сохранённая\s+ссылка|link|saved\s+link|shared\s+link|x|twitter|telegram|instagram|youtube|github|reddit|tiktok|t\.me|x\.com|twitter\.com|instagram\.com)$/i;

export const SmartLinkCard: React.FC<SmartLinkCardProps> = React.memo(({
  item,
  compactList = false,
}) => {
  const { t } = useI18n();
  const [bannerError, setBannerError] = useState(false);
  const [extractingVideo, setExtractingVideo] = useState(false);
  const [refreshingPreview, setRefreshingPreview] = useState(false);

  // Use local cached kapsula-media:// paths (remote ogImageUrl is blocked by CSP)
  const localBannerSrc = getMediaUrl(item.thumbPath || item.imagePath);
  const cachedVideoFile = item.mediaMeta?.cachedVideoFile ?? null;
  const youtubeVideoId = item.mediaMeta?.youtubeVideoId ?? null;
  const hasDirectVideo = Boolean(item.mediaPath && VIDEO_PATH_RE.test(item.mediaPath));
  const hasAnyVideo = Boolean(hasDirectVideo || cachedVideoFile || youtubeVideoId);
  const isPrivateLink = Boolean(
    item.mediaMeta?.linkAccess === 'private' ||
      (item.url && PRIVATE_TG_URL_RE.test(item.url))
  );
  const canTryVideoFetch = Boolean(
    !hasAnyVideo &&
      !isPrivateLink &&
      item.mediaMeta?.hasVideo !== false &&
      item.mediaMeta?.videoExtractStatus !== 'unavailable' &&
      item.url &&
      (item.mediaMeta?.videoUrl ||
        item.mediaMeta?.hasVideo === true ||
        DEDICATED_VIDEO_URL_RE.test(item.url))
  );
  const showBanner = Boolean(localBannerSrc) && !hasAnyVideo && !bannerError && !compactList;

  const hostLabel = useMemo(
    () =>
      item.domain ||
      (item.url ? item.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : t('dna.link')),
    [item.domain, item.url, t]
  );

  const platformBadge =
    item.platform === 'telegram'
      ? 'Telegram'
      : item.platform === 'x'
        ? 'X'
        : item.platform === 'youtube'
          ? 'YouTube'
          : item.platform === 'github'
            ? 'GitHub'
            : item.platform === 'instagram'
              ? 'Instagram'
              : hostLabel;

  const { cleanTitle, cleanPreview, isBareStub } = useMemo(() => {
    const titleVal = cleanBrokenTextArtifacts(item.title || item.url || t('dna.savedLink'), true);
    const rawPreview = cleanBrokenTextArtifacts(
      stripMarkdownPreview(
        item.summary && item.summary !== item.title
          ? item.summary
          : item.body && item.body !== item.url
            ? item.body
            : ''
      ),
      true
    );
    const previewVal = stripLeadingTitle(rawPreview, titleVal);
    const normTitle = (item.title || '').trim().toLowerCase();
    const normHost = (hostLabel || '').trim().toLowerCase();
    const normUrl = (item.url || '').trim().toLowerCase();
    const stubTitle =
      !normTitle ||
      normTitle === normHost ||
      normTitle === normUrl ||
      BARE_STUB_TITLE_RE.test(normTitle);
    const bareStub = Boolean(
      !isPrivateLink &&
        !hasAnyVideo &&
        !localBannerSrc &&
        item.url &&
        stubTitle &&
        !previewVal
    );
    return { cleanTitle: titleVal, cleanPreview: previewVal, isBareStub: bareStub };
  }, [item.title, item.summary, item.body, item.url, hostLabel, isPrivateLink, hasAnyVideo, localBannerSrc, t]);

  const embeddedLinks = useMemo(() => {
    const m = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})/i.exec(item.url || '');
    const itemChannel = m?.[1]?.toLowerCase() ?? null;
    return (item.extractedActions ?? [])
      .filter((a) => {
        if (a.type !== 'url' || a.value === item.url) return false;
        const lbl = (a.label || '').toLowerCase();
        if (/подписаться|subscribe|прислать новость|наш канал|бот обратной/i.test(lbl)) return false;
        if (itemChannel && /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(a.value)) {
          const sub = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]{3,})(?:\/(\d+))?/i.exec(a.value);
          // Strip self-channel root links (`t.me/channel`) & invite links (`t.me/+...`)
          if (a.value.includes('t.me/+') || (sub && sub[1]?.toLowerCase() === itemChannel && !sub[2])) {
            return false;
          }
        }
        return true;
      })
      .slice(0, 2);
  }, [item.extractedActions, item.url]);

  const handleRefreshPreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshingPreview || !item.url || !window.kapsula.reprocessItem) return;
    setRefreshingPreview(true);
    try {
      const updated = await window.kapsula.reprocessItem(item.id);
      if (updated) {
        toast.success(t('cards.refreshPreviewDone'));
      } else {
        toast.error(t('cards.refreshPreviewFailed'));
      }
    } catch {
      toast.error(t('cards.refreshPreviewFailed'));
    } finally {
      setRefreshingPreview(false);
    }
  };

  if (compactList) {
    return (
      <div className="flex items-center justify-between gap-3 min-w-0 flex-1">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--k-ink-muted)]">
            {isPrivateLink ? (
              <LockSimple className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
            ) : (
              <GlobeSimple className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
            )}
            <span className="truncate">{platformBadge}</span>
          </div>
          <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] truncate">
            {cleanTitle}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {hasAnyVideo ? (
        <InlineReferenceVideo
          mediaPath={hasDirectVideo ? item.mediaPath : null}
          cachedVideoFile={cachedVideoFile}
          youtubeVideoId={youtubeVideoId}
          posterPath={item.thumbPath || item.imagePath}
          heightClass="max-h-[190px]"
        />
      ) : showBanner ? (
        <div className="rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] max-h-[168px]">
          <img
            src={localBannerSrc!}
            alt={cleanTitle}
            loading="lazy"
            decoding="async"
            onError={() => setBannerError(true)}
            className="w-full h-[156px] object-cover block"
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-[11.5px] font-medium text-[var(--k-ink-muted)]">
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {item.platform === 'telegram' ? (
            <PaperPlaneTilt weight="duotone" className="w-3.5 h-3.5 text-[var(--k-info)] shrink-0" />
          ) : (
            <GlobeSimple weight="duotone" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
          )}
          <span className="truncate">{platformBadge}</span>
          {isPrivateLink ? (
            <span
              data-testid={`smart-link-private-badge-${item.id}`}
              title={t('cards.privateLinkHint')}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[10.5px] text-[var(--k-ink-muted)] shrink-0"
            >
              <LockSimple className="w-2.5 h-2.5 shrink-0" />
              <span>{t('cards.privateLinkBadge')}</span>
            </span>
          ) : null}
        </span>
        {item.mediaMeta?.forwardAuthor ? (
          <span
            data-testid="smart-link-author"
            className="truncate text-[11px] max-w-[130px]"
          >
            {item.mediaMeta.forwardAuthor}
          </span>
        ) : null}
      </div>

      <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] leading-snug line-clamp-2">
        {cleanTitle}
      </div>

      {cleanPreview && cleanPreview !== cleanTitle ? (
        <p className="m-0 text-[12.5px] text-[var(--k-ink-secondary)] line-clamp-3 leading-relaxed">
          {cleanPreview}
        </p>
      ) : null}

      {embeddedLinks.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {embeddedLinks.map((act) => (
            <button
              key={act.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void window.kapsula.openExternal(act.value);
              }}
              className="k-interactive inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11px] text-[var(--k-accent)] hover:border-[var(--k-accent)]/60 cursor-pointer"
            >
              <span className="truncate">{act.label}</span>
              <ArrowSquareOut className="w-2.5 h-2.5 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}

      {item.url ? (
        <div className="flex flex-wrap items-center justify-start gap-2 pt-0.5">
          <CopySlotPill
            label={t('dna.link')}
            copiedLabel={t('common.done')}
            widthPx={88}
            heightPx={28}
            onCopy={() => window.kapsula.copyText(item.url!)}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void window.kapsula.openExternal(item.url!);
            }}
            className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-accent)] hover:text-[var(--k-accent)] cursor-pointer"
          >
            <span>{t('common.open')}</span>
            <ArrowSquareOut className="w-3.5 h-3.5" />
          </button>
          {isBareStub ? (
            <button
              type="button"
              data-testid={`smart-link-refresh-btn-${item.id}`}
              disabled={refreshingPreview}
              onClick={(e) => void handleRefreshPreview(e)}
              className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:border-[var(--k-accent)] hover:text-[var(--k-accent)] cursor-pointer disabled:opacity-55"
            >
              <ArrowsClockwise
                className={`w-3.5 h-3.5 shrink-0 ${refreshingPreview ? 'animate-spin' : ''}`}
              />
              <span>
                {refreshingPreview ? t('cards.refreshingPreview') : t('cards.refreshPreview')}
              </span>
            </button>
          ) : null}
          {canTryVideoFetch ? (
            item.mediaMeta?.videoExtractStatus === 'login_required' ? (
              <span
                title={t('video.loginRequired')}
                className="text-[11px] text-[var(--k-ink-muted)] truncate max-w-[190px]"
              >
                {t('video.loginRequired')}
              </span>
            ) : (
              <button
                type="button"
                data-testid={`ensure-link-video-${item.id}`}
                disabled={extractingVideo}
                onClick={async (e) => {
                  e.stopPropagation();
                  setExtractingVideo(true);
                  try {
                    await window.kapsula.ensureLinkVideo?.(item.id);
                  } finally {
                    setExtractingVideo(false);
                  }
                }}
                className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-accent)] hover:border-[var(--k-accent)] cursor-pointer disabled:opacity-55"
              >
                <PlayCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{extractingVideo ? t('video.loading') : t('video.retry')}</span>
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
