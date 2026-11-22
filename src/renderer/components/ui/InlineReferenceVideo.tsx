import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowsOutSimple,
  Pause,
  Play,
  Repeat,
  SpeakerHigh,
  SpeakerSlash,
} from '@phosphor-icons/react';
import { formatDurationMmSs, getMediaUrl } from '../../lib/format';
import { useI18n } from '@shared/i18n/react';

interface InlineReferenceVideoProps {
  mediaPath: string;
  posterPath?: string | null;
  heightClass?: string;
  onOpenFull?: () => void;
}

const SPEEDS = [0.5, 1, 1.5] as const;

export const InlineReferenceVideo: React.FC<InlineReferenceVideoProps> = ({
  mediaPath,
  posterPath,
  heightClass = 'max-h-[210px]',
  onOpenFull,
}) => {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingPlayRef = useRef(false);
  const [videoActivated, setVideoActivated] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [loop, setLoop] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const src = getMediaUrl(mediaPath);
  const poster = posterPath ? (getMediaUrl(posterPath) ?? undefined) : undefined;
  const speed = SPEEDS[speedIdx] ?? 1;

  useEffect(() => {
    setVideoActivated(false);
    pendingPlayRef.current = false;
    setPlaying(false);
    setProgress(0);
    setDuration(0);
  }, [mediaPath]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.playbackRate = speed;
  }, [speed, videoActivated]);

  useEffect(() => {
    if (!videoActivated || !pendingPlayRef.current) return;
    const el = videoRef.current;
    if (!el) return;
    pendingPlayRef.current = false;
    el.playbackRate = speed;
    void Promise.resolve(el.play()).then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [videoActivated, speed]);

  const togglePlay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoActivated) {
      pendingPlayRef.current = true;
      setVideoActivated(true);
      return;
    }
    const el = videoRef.current;
    if (!el) {
      pendingPlayRef.current = true;
      return;
    }
    if (el.paused) {
      void Promise.resolve(el.play()).then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  if (!src) return null;

  return (
    <div
      className="group/vid relative rounded-xl overflow-hidden bg-black/80 border border-[var(--k-border-hairline)] select-none"
      onClick={togglePlay}
      onMouseEnter={() => {
        if (!poster && !videoActivated) setVideoActivated(true);
      }}
    >
      {poster && !videoActivated ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          className={`w-full ${heightClass} object-contain bg-black block`}
        />
      ) : (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          muted={muted}
          loop={loop}
          playsInline
          preload={videoActivated ? 'metadata' : 'none'}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => {
            const d = e.currentTarget.duration || 0;
            if (d > 0) setProgress((e.currentTarget.currentTime / d) * 100);
          }}
          onEnded={() => setPlaying(false)}
          className={`w-full ${heightClass} object-contain bg-black block`}
        />
      )}

      {/* Play/Pause badge */}
      {!playing ? (
        <button
          type="button"
          onClick={togglePlay}
          aria-label={t('ui.videoPlayAria')}
          className="k-interactive absolute inset-0 m-auto w-10 h-10 rounded-full bg-black/65 border border-white/25 text-white flex items-center justify-center backdrop-blur-sm hover:scale-105 cursor-pointer"
        >
          <Play weight="fill" className="w-4 h-4 ml-0.5" />
        </button>
      ) : null}

      {/* Bottom floating reference bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/75 border-t border-white/10 text-[11px] text-white/90"
      >
        <button
          type="button"
          onClick={togglePlay}
          className="k-interactive w-6 h-6 rounded-md hover:bg-white/15 inline-flex items-center justify-center cursor-pointer"
          title={playing ? t('ui.videoPause') : t('ui.videoPlay')}
        >
          {playing ? <Pause weight="fill" className="w-3.5 h-3.5" /> : <Play weight="fill" className="w-3.5 h-3.5" />}
        </button>

        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={progress}
          onChange={(e) => {
            const el = videoRef.current;
            const pct = Number(e.target.value);
            setProgress(pct);
            if (el && el.duration > 0) {
              el.currentTime = (pct / 100) * el.duration;
            }
          }}
          className="flex-1 h-1 accent-[var(--k-accent)] cursor-pointer"
          aria-label={t('ui.videoSeekAria')}
        />

        <span className="k-mono text-[10.5px] text-white/75 w-10 text-right shrink-0">
          {duration > 0 ? formatDurationMmSs(duration) : '0:00'}
        </span>

        <button
          type="button"
          onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          className="k-interactive k-mono px-1.5 h-5 rounded bg-white/10 hover:bg-white/20 text-[10.5px] cursor-pointer"
          title={t('ui.videoSpeed')}
        >
          {speed}x
        </button>

        <button
          type="button"
          onClick={() => setLoop((v) => !v)}
          className={`k-interactive w-6 h-5 rounded inline-flex items-center justify-center cursor-pointer ${
            loop ? 'bg-[var(--k-accent)]/30 text-[var(--k-accent)]' : 'hover:bg-white/15 text-white/70'
          }`}
          title={t('ui.videoLoop')}
        >
          <Repeat weight="bold" className="w-3 h-3" />
        </button>

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="k-interactive w-6 h-5 rounded hover:bg-white/15 inline-flex items-center justify-center cursor-pointer"
          title={muted ? t('ui.videoUnmute') : t('ui.videoMute')}
        >
          {muted ? <SpeakerSlash className="w-3.5 h-3.5" /> : <SpeakerHigh className="w-3.5 h-3.5" />}
        </button>

        {onOpenFull ? (
          <button
            type="button"
            onClick={() => onOpenFull()}
            className="k-interactive w-6 h-5 rounded hover:bg-white/15 inline-flex items-center justify-center cursor-pointer"
            title={t('ui.videoOpenSeparate')}
          >
            <ArrowsOutSimple className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
};
