import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Pause, Play } from '@phosphor-icons/react';
import { formatDurationMmSs } from '../../lib/format';
import { useI18n } from '@shared/i18n/react';

interface WaveformAudioPlayerProps {
  src: string | null;
  fallbackDurationSec?: number | null;
  peaks?: number[];
  seedKey: string;
  compact?: boolean;
}

const SPEEDS = [1, 1.5, 2] as const;

export const WaveformAudioPlayer: React.FC<WaveformAudioPlayerProps> = ({
  src,
  fallbackDurationSec,
  peaks,
  seedKey,
  compact = false,
}) => {
  const { t } = useI18n();
  const prefersReduced = useReducedMotion();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioActivated, setAudioActivated] = useState(false);
  const pendingAutoPlayRef = useRef(false);
  const pendingSeekRatioRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [duration, setDuration] = useState<number>(
    fallbackDurationSec && Number.isFinite(fallbackDurationSec) ? fallbackDurationSec : 0
  );
  const [speedIdx, setSpeedIdx] = useState(0);

  const bars = useMemo(() => {
    const count = compact ? 18 : 32;
    if (Array.isArray(peaks) && peaks.length > 0) {
      const resampled: number[] = [];
      for (let i = 0; i < count; i++) {
        const srcIdx = Math.min(peaks.length - 1, Math.floor((i / count) * peaks.length));
        const val = Number(peaks[srcIdx] ?? 0.25);
        resampled.push(Math.max(0.18, Math.min(1, Number.isFinite(val) ? val : 0.25)));
      }
      return resampled;
    }

    let hash = 2166136261;
    for (let i = 0; i < seedKey.length; i += 1) {
      hash ^= seedKey.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      hash = Math.imul(hash ^ (i + 17), 16777619);
      const norm = ((hash >>> 0) % 100) / 100;
      const arch = Math.sin(((i + 0.5) / count) * Math.PI);
      out.push(0.24 + norm * 0.56 * (0.55 + arch * 0.45));
    }
    return out;
  }, [peaks, seedKey, compact]);

  useEffect(() => {
    setAudioActivated(false);
    pendingAutoPlayRef.current = false;
    pendingSeekRatioRef.current = null;
    setPlaying(false);
    setCurrentTime(0);
    setDuration(fallbackDurationSec && Number.isFinite(fallbackDurationSec) ? fallbackDurationSec : 0);
  }, [src, fallbackDurationSec]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = SPEEDS[speedIdx] ?? 1;
  }, [speedIdx, audioActivated]);

  useEffect(() => {
    if (!audioActivated || !src || !pendingAutoPlayRef.current) return;
    const el = audioRef.current;
    if (!el) return;
    pendingAutoPlayRef.current = false;
    el.playbackRate = SPEEDS[speedIdx] ?? 1;
    void Promise.resolve(el.play())
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  }, [audioActivated, src, speedIdx]);

  const togglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!src) return;
    if (!audioActivated) {
      pendingAutoPlayRef.current = true;
      setAudioActivated(true);
      return;
    }
    const el = audioRef.current;
    if (!el) {
      pendingAutoPlayRef.current = true;
      return;
    }
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      try {
        await el.play();
        setPlaying(true);
      } catch {
        setPlaying(false);
      }
    }
  };

  const handleSeekBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!src) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    if (!audioActivated) {
      pendingSeekRatioRef.current = ratio;
      if (duration > 0) {
        setCurrentTime(ratio * duration);
      }
      setAudioActivated(true);
      return;
    }
    const el = audioRef.current;
    if (!el || duration <= 0) return;
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  const handleBarMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / Math.max(1, rect.width)));
    setHoverIdx(Math.floor(ratio * bars.length));
  };

  const cycleSpeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedIdx((prev) => (prev + 1) % SPEEDS.length);
  };

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const hoverTimeSec =
    hoverIdx !== null && duration > 0 ? ((hoverIdx + 0.5) / bars.length) * duration : null;

  return (
    <div
      data-testid="waveform-audio-player"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => {
        if (src && !audioActivated) setAudioActivated(true);
      }}
      className="min-w-0 w-full overflow-hidden flex items-center gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 py-2"
    >
      {src && audioActivated ? (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) {
              setDuration(d);
              if (pendingSeekRatioRef.current !== null) {
                const targetTime = pendingSeekRatioRef.current * d;
                pendingSeekRatioRef.current = null;
                e.currentTarget.currentTime = targetTime;
                setCurrentTime(targetTime);
              }
            }
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false);
            setCurrentTime(0);
          }}
        />
      ) : null}

      <button
        type="button"
        disabled={!src}
        onFocus={() => {
          if (src && !audioActivated) setAudioActivated(true);
        }}
        onClick={(e) => void togglePlay(e)}
        aria-label={playing ? t('ui.videoPause') : t('ui.audioPlay')}
        className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] shrink-0 cursor-pointer disabled:opacity-45"
      >
        <AnimatePresence mode="wait" initial={false}>
          {playing ? (
            <motion.span
              key="pause"
              initial={prefersReduced ? { opacity: 0 } : { scale: 0.72, opacity: 0 }}
              animate={prefersReduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
              exit={prefersReduced ? { opacity: 0 } : { scale: 0.72, opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="inline-flex"
            >
              <Pause weight="fill" className="w-3.5 h-3.5" />
            </motion.span>
          ) : (
            <motion.span
              key="play"
              initial={prefersReduced ? { opacity: 0 } : { scale: 0.72, opacity: 0 }}
              animate={prefersReduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
              exit={prefersReduced ? { opacity: 0 } : { scale: 0.72, opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="inline-flex"
            >
              <Play weight="fill" className="w-3.5 h-3.5 translate-x-[0.5px]" />
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <div
        role="slider"
        aria-label={t('ui.audioSeekAria')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
        onClick={handleSeekBarClick}
        onMouseMove={handleBarMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="flex-1 min-w-0 overflow-hidden flex items-center gap-[2px] h-7 cursor-pointer"
      >
        {bars.map((amp, idx) => {
          const filled = progress > 0 && idx / bars.length <= progress;
          const dist = hoverIdx === null ? 99 : Math.abs(idx - hoverIdx);
          const hoverBoost = !prefersReduced && dist <= 2 ? (dist === 0 ? 1.24 : dist === 1 ? 1.12 : 1.05) : 1;
          const inHoverRange = hoverIdx !== null && idx <= hoverIdx && !filled;
          return (
            <span
              key={idx}
              className={`flex-1 min-w-[2px] rounded-full transition-[background-color,transform] duration-120 ease-[var(--k-ease-out)] ${
                filled
                  ? 'bg-[var(--k-accent)]'
                  : inHoverRange
                    ? 'bg-[var(--k-ink-secondary)]/55'
                    : 'bg-[var(--k-ink-muted)]/35'
              }`}
              style={{
                height: `${Math.round(amp * 22)}px`,
                transform: hoverBoost > 1 ? `scaleY(${hoverBoost})` : undefined,
              }}
            />
          );
        })}
      </div>

      {/* Fixed-width numeric slot guarantees 0.0px layout shift on Play/Pause or scrub hover */}
      <span className="k-mono text-[11px] text-[var(--k-ink-secondary)] w-[74px] text-right shrink-0 whitespace-nowrap">
        {hoverTimeSec !== null
          ? `${formatDurationMmSs(hoverTimeSec)} / ${formatDurationMmSs(duration)}`
          : playing || currentTime > 0
            ? `${formatDurationMmSs(currentTime)} / ${formatDurationMmSs(duration)}`
            : formatDurationMmSs(duration)}
      </span>

      {!compact ? (
        <button
          type="button"
          onClick={cycleSpeed}
          className="k-interactive k-mono h-6 px-1.5 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[10.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
        >
          {SPEEDS[speedIdx]}x
        </button>
      ) : null}
    </div>
  );
};
