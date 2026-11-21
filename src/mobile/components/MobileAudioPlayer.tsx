import React, { useEffect, useRef, useState } from 'react';
import { CheckSquare, Pause, Play, Sparkle, SpinnerGap, Waveform } from '@phosphor-icons/react';
import { formatDurationMmSs } from '@renderer/lib/format';
import { useMobileI18n } from '../lib/mobile-i18n';
import { mobileBridge } from '../native/bridge';

interface MobileAudioPlayerProps {
  src?: string | null;
  mediaPath?: string | null;
  ensureMediaUrl?: (localName?: string | null) => Promise<string | null>;
  durationSec?: number | null;
  peaks?: number[];
  compact?: boolean;
  hasTranscript?: boolean;
  transcribing?: boolean;
  extractingTasks?: boolean;
  onTranscribe?: () => void;
  onExtractTasks?: () => void;
}

const DEFAULT_PEAKS = [
  0.22, 0.45, 0.68, 0.35, 0.82, 0.56, 0.42, 0.75, 0.9, 0.6, 0.38, 0.65, 0.48, 0.72, 0.3, 0.54, 0.4,
  0.28,
];

export const MobileAudioPlayer: React.FC<MobileAudioPlayerProps> = ({
  src: externalSrc,
  mediaPath,
  ensureMediaUrl,
  durationSec,
  peaks,
  compact = false,
  hasTranscript = false,
  transcribing = false,
  extractingTasks = false,
  onTranscribe,
  onExtractTasks,
}) => {
  const { t } = useMobileI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(externalSrc ?? null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSec ?? 0);
  const pendingPlayRef = useRef(false);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(durationSec ?? 0);
    if (externalSrc !== undefined) {
      setResolvedSrc(externalSrc ?? null);
    }
  }, [externalSrc, durationSec]);

  useEffect(() => {
    if (externalSrc !== undefined || !mediaPath || !ensureMediaUrl) return;
    let cancelled = false;
    void ensureMediaUrl(mediaPath).then((url) => {
      if (!cancelled) setResolvedSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [externalSrc, mediaPath, ensureMediaUrl]);

  useEffect(() => {
    if (pendingPlayRef.current && resolvedSrc && audioRef.current) {
      pendingPlayRef.current = false;
      void audioRef.current.play().catch(() => setPlaying(false));
    }
  }, [resolvedSrc]);

  const rawBars = peaks && peaks.length >= 6 ? peaks : DEFAULT_PEAKS;
  const targetCount = compact ? 14 : 24;
  const bars = Array.from({ length: targetCount }, (_, i) => {
    const srcIdx = Math.min(rawBars.length - 1, Math.floor((i / targetCount) * rawBars.length));
    return rawBars[srcIdx] ?? 0.4;
  });
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const togglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    mobileBridge.haptic('light');

    if (!resolvedSrc && mediaPath && ensureMediaUrl) {
      setLoading(true);
      try {
        const url = await ensureMediaUrl(mediaPath);
        if (url) {
          pendingPlayRef.current = true;
          setResolvedSrc(url);
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio || !resolvedSrc) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play().catch(() => setPlaying(false));
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !resolvedSrc || !(duration > 0)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
  };

  const canPlay = Boolean(resolvedSrc || (mediaPath && ensureMediaUrl));
  const showTranscribeBtn = Boolean(onTranscribe && (!hasTranscript || !compact));
  const showExtractTasksBtn = Boolean(!compact && hasTranscript && onExtractTasks);

  return (
    <div onClick={(e) => e.stopPropagation()} className="space-y-1.5 min-w-0 max-w-full">
      <div
        data-testid="mobile-audio-player"
        className={`flex items-center min-w-0 max-w-full overflow-hidden rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] ${
          compact ? 'gap-2 px-2 py-1.5' : 'gap-2.5 px-3.5 py-2.5'
        }`}
      >
        {resolvedSrc ? (
          <audio
            ref={audioRef}
            src={resolvedSrc}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setCurrentTime(0);
            }}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
        ) : null}

        <button
          type="button"
          disabled={!canPlay || loading}
          onClick={(e) => void togglePlay(e)}
          aria-label={playing ? t('audio.pause') : t('audio.play')}
          className={`k-tap inline-flex items-center justify-center rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] disabled:opacity-40 shrink-0 ${
            compact ? 'w-7 h-7' : 'w-9 h-9'
          }`}
        >
          {playing ? (
            <Pause weight="fill" className="w-3.5 h-3.5" />
          ) : (
            <Play weight="fill" className="w-3.5 h-3.5 translate-x-[1px]" />
          )}
        </button>

        <div
          onClick={handleSeek}
          role="slider"
          aria-label={t('audio.seekAria')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration || durationSec || 0)}
          aria-valuenow={Math.round(currentTime)}
          className={`flex-1 min-w-0 overflow-hidden flex items-center justify-between gap-[2px] cursor-pointer ${
            compact ? 'h-6' : 'h-7'
          }`}
        >
          {bars.map((amp, i) => {
            const filled = progress > 0 && i / bars.length <= progress;
            const pct = Math.max(22, Math.min(96, Math.round(amp * 100)));
            return (
              <span
                key={i}
                style={{ height: `${pct}%` }}
                className={`w-[2.5px] shrink-0 rounded-full transition-colors duration-150 ${
                  filled ? 'bg-[var(--k-accent)]' : 'bg-[var(--k-border-strong)]'
                }`}
              />
            );
          })}
        </div>

        <span className="k-mono text-[11px] text-[var(--k-ink-secondary)] shrink-0 inline-flex items-center gap-1 pr-0.5">
          {!compact && !canPlay ? (
            <Waveform className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
          ) : null}
          {formatDurationMmSs(playing ? currentTime : duration || durationSec)}
        </span>
      </div>

      {showTranscribeBtn || showExtractTasksBtn ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {showTranscribeBtn ? (
            <button
              type="button"
              data-testid="mobile-voice-transcribe-btn"
              disabled={transcribing}
              onClick={(e) => {
                e.stopPropagation();
                mobileBridge.haptic('light');
                onTranscribe?.();
              }}
              className={`k-tap inline-flex items-center gap-1.5 rounded-xl border font-semibold leading-tight whitespace-nowrap max-w-full transition-colors disabled:opacity-50 ${
                compact ? 'px-2.5 min-h-7 py-1 text-[11.5px]' : 'px-3 min-h-8 py-1 text-[12px]'
              } ${
                !hasTranscript
                  ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                  : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
              }`}
            >
              {transcribing ? (
                <SpinnerGap className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <Sparkle weight="duotone" className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="truncate">
                {transcribing
                  ? t('audio.transcribing')
                  : hasTranscript
                    ? t('audio.retranscribe')
                    : compact
                      ? t('audio.transcribeShort')
                      : t('audio.transcribeFull')}
              </span>
            </button>
          ) : null}

          {showExtractTasksBtn ? (
            <button
              type="button"
              data-testid="mobile-voice-extract-tasks-btn"
              disabled={extractingTasks}
              onClick={(e) => {
                e.stopPropagation();
                mobileBridge.haptic('light');
                onExtractTasks?.();
              }}
              className="k-tap inline-flex items-center gap-1.5 px-3 min-h-8 py-1 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] font-medium leading-tight whitespace-nowrap text-[var(--k-ink-primary)] disabled:opacity-50"
            >
              {extractingTasks ? (
                <SpinnerGap className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <CheckSquare className="w-3.5 h-3.5 text-[var(--k-emerald)] shrink-0" />
              )}
              <span>{extractingTasks ? t('audio.extractingTasks') : t('audio.extractTasks')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
