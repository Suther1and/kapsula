import React, { useMemo, useState } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { filterDistinctKeyPoints } from '@shared/item-helpers';
import type { VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import {
  friendlyErrorMessage,
  getMediaUrl,
  stripMarkdownPreview,
  transcribeItemWithWavFallback,
} from '../../lib/format';
import { BorderTrail } from '../motion-primitives/border-trail';
import { TextShimmer } from '../motion-primitives/text-shimmer';
import { MicIcon } from '../icons/mic';
import { SparklesIcon } from '../icons/sparkles';
import { LiveIcon } from '../icons/LiveIcon';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { WaveformAudioPlayer } from '../ui/WaveformAudioPlayer';

interface VoiceMemoCardProps {
  item: VaultItem;
  compactList?: boolean;
  onToggleVoiceAction?: (itemId: string, actionIdx: number, done: boolean) => void;
  onItemUpdated?: (updated: VaultItem) => void;
}

export const VoiceMemoCard: React.FC<VoiceMemoCardProps> = React.memo(({
  item,
  compactList = false,
  onToggleVoiceAction,
  onItemUpdated,
}) => {
  const { t, locale } = useI18n();
  const [transcribing, setTranscribing] = useState(false);

  const mediaUrl = getMediaUrl(item.mediaPath);
  const actions = useMemo(() => item.mediaMeta?.actionItems ?? [], [item.mediaMeta?.actionItems]);
  const checkedSet = useMemo(
    () => new Set(item.mediaMeta?.checkedActionIndices ?? []),
    [item.mediaMeta?.checkedActionIndices]
  );
  const keyPoints = useMemo(
    () => filterDistinctKeyPoints(item.mediaMeta?.keyPoints, item.title, item.summary),
    [item.mediaMeta?.keyPoints, item.title, item.summary]
  );
  const rawTranscriptText =
    item.body?.trim() || item.mediaMeta?.transcript?.trim() || '';
  const hasTranscript = rawTranscriptText.length > 0;
  const previewText = useMemo(
    () => stripMarkdownPreview(rawTranscriptText || item.summary || ''),
    [rawTranscriptText, item.summary]
  );

  const handleTranscribe = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (transcribing || !item.mediaPath) return;
    setTranscribing(true);
    try {
      const res = await transcribeItemWithWavFallback(item);
      if (res.ok && res.item) {
        onItemUpdated?.(res.item);
        toast.success(t('cards.transcribed'));
      } else if (res.ok && res.transcript) {
        toast.success(t('cards.transcribed'));
      } else {
        toast.error(
          res.error || t('cards.transcribeFailed')
        );
      }
    } catch (err) {
      toast.error(
        friendlyErrorMessage(err, t('cards.transcribeFailed'), locale)
      );
    } finally {
      setTranscribing(false);
    }
  };

  if (compactList) {
    return (
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <LiveIcon icon={MicIcon} size={15} className="text-[var(--k-accent)] shrink-0" />
            <span className="text-[13.5px] font-semibold truncate">
              {item.title || t('dna.voiceMemo')}
            </span>
          </div>
          {!hasTranscript && item.mediaPath ? (
            <button
              type="button"
              data-testid="voice-card-transcribe-btn"
              disabled={transcribing}
              onClick={(e) => void handleTranscribe(e)}
              className={`relative k-interactive shrink-0 inline-flex items-center gap-1 h-6.5 px-2.5 rounded-full border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[11px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer disabled:opacity-75 ${
                transcribing ? 'k-beautify-shimmer' : ''
              }`}
            >
              {transcribing ? (
                <BorderTrail
                  size={44}
                  transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
                  className="bg-[radial-gradient(circle_at_center,var(--k-accent),transparent_70%)]"
                />
              ) : null}
              {transcribing ? (
                <CircleNotch weight="bold" className="w-3 h-3 animate-spin shrink-0" />
              ) : (
                <LiveIcon icon={SparklesIcon} size={13} />
              )}
              {transcribing ? (
                <TextShimmer as="span" duration={1.1} className="[--base-color:var(--k-accent)] [--base-gradient-color:var(--k-ink-primary)]">
                  {t('cards.transcribing')}
                </TextShimmer>
              ) : (
                <span>{t('cards.transcribeBtn')}</span>
              )}
            </button>
          ) : null}
        </div>
        {mediaUrl ? (
          <WaveformAudioPlayer
            compact
            src={mediaUrl}
            fallbackDurationSec={item.mediaDurationSec}
            peaks={item.mediaMeta?.waveformPeaks}
            seedKey={item.id}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center w-6.5 h-6.5 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
          <LiveIcon icon={MicIcon} size={14} />
        </span>
        <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] leading-snug truncate">
          {item.title || t('dna.voiceMemo')}
        </div>
      </div>

      {mediaUrl ? (
        <WaveformAudioPlayer
          compact
          src={mediaUrl}
          fallbackDurationSec={item.mediaDurationSec}
          peaks={item.mediaMeta?.waveformPeaks}
          seedKey={item.id}
        />
      ) : null}

      {!hasTranscript && item.mediaPath ? (
        <div className="flex items-center">
          <button
            type="button"
            data-testid="voice-card-transcribe-btn"
            disabled={transcribing}
            onClick={(e) => void handleTranscribe(e)}
            className={`relative k-interactive inline-flex items-center gap-1.5 h-7.5 px-3 rounded-full border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[12px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer disabled:opacity-75 ${
              transcribing ? 'k-beautify-shimmer' : ''
            }`}
          >
            {transcribing ? (
              <BorderTrail
                size={84}
                borderRadius={999}
                thickness={18}
                glow
                transition={{ repeat: Infinity, duration: 2.1, ease: 'linear' }}
                className="opacity-90"
              />
            ) : null}
            {transcribing ? (
              <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : (
              <LiveIcon icon={SparklesIcon} size={14} />
            )}
            {transcribing ? (
              <TextShimmer as="span" duration={1.1} className="[--base-color:var(--k-accent)] [--base-gradient-color:var(--k-ink-primary)]">
                {t('cards.transcribing')}
              </TextShimmer>
            ) : (
              <span>{t('cards.transcribeBtn')}</span>
            )}
          </button>
        </div>
      ) : null}

      {previewText && previewText !== item.title ? (
        <p className="m-0 text-[12.5px] text-[var(--k-ink-secondary)] leading-relaxed line-clamp-3">
          {previewText}
        </p>
      ) : null}

      {keyPoints.length >= 2 && actions.length === 0 ? (
        <ul className="m-0 list-none p-0 text-[12px] text-[var(--k-ink-secondary)] space-y-1">
          {keyPoints.slice(0, 3).map((pt, i) => (
            <li key={i} className="flex items-start gap-2 min-w-0">
              <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--k-accent)] shrink-0" />
              <span className="line-clamp-1">{pt}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          {actions.slice(0, 3).map((act, idx) => {
            const done = checkedSet.has(idx);
            return (
              <div
                key={idx}
                className="flex items-start gap-2 text-left text-[12px]"
              >
                <span
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="w-5 h-5 -ml-0.5 -mt-0.5 inline-flex items-center justify-center shrink-0"
                >
                  <AnimatedCheckbox
                    size="sm"
                    checked={done}
                    label={act}
                    onChange={(next) => onToggleVoiceAction?.(item.id, idx, next)}
                  />
                </span>
                <span className={done ? 'line-through text-[var(--k-ink-muted)]' : 'text-[var(--k-ink-primary)]'}>
                  {act}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
