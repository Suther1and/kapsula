import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from '@phosphor-icons/react';
import { formatDurationMmSs } from '../../lib/format';

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
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
    setPlaying(false);
    setCurrentTime(0);
    setDuration(fallbackDurationSec && Number.isFinite(fallbackDurationSec) ? fallbackDurationSec : 0);
  }, [src, fallbackDurationSec]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = SPEEDS[speedIdx] ?? 1;
  }, [speedIdx]);

  const togglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el || !src) return;
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
    const el = audioRef.current;
    if (!el || !src || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  const cycleSpeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedIdx((prev) => (prev + 1) % SPEEDS.length);
  };

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div
      data-testid="waveform-audio-player"
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 w-full overflow-hidden flex items-center gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 py-2"
    >
      {src ? (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
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
        onClick={(e) => void togglePlay(e)}
        aria-label={playing ? 'Пауза' : 'Воспроизвести'}
        className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] shrink-0 cursor-pointer disabled:opacity-45"
      >
        {playing ? (
          <Pause weight="fill" className="w-3.5 h-3.5" />
        ) : (
          <Play weight="fill" className="w-3.5 h-3.5 translate-x-[0.5px]" />
        )}
      </button>

      <div
        role="slider"
        aria-label="Позиция воспроизведения"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
        onClick={handleSeekBarClick}
        className="flex-1 min-w-0 overflow-hidden flex items-center gap-[2px] h-7 cursor-pointer"
      >
        {bars.map((amp, idx) => {
          const filled = progress > 0 && idx / bars.length <= progress;
          return (
            <span
              key={idx}
              className={`flex-1 min-w-[2px] rounded-full transition-colors duration-100 ${
                filled ? 'bg-[var(--k-accent)]' : 'bg-[var(--k-ink-muted)]/35'
              }`}
              style={{ height: `${Math.round(amp * 24)}px` }}
            />
          );
        })}
      </div>

      {/* Fixed-width numeric slot guarantees 0.0px layout shift on Play/Pause */}
      <span className="k-mono text-[11px] text-[var(--k-ink-secondary)] w-[74px] text-right shrink-0 whitespace-nowrap">
        {playing || currentTime > 0
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
