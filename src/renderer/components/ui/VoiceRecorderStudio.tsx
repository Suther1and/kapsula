import React, { useEffect, useRef, useState } from 'react';
import { Microphone, PaperPlaneTilt, Sparkle, Stop, TextT, WarningCircle, X } from '@phosphor-icons/react';
import type { VoiceDictationResult } from '@shared/types';
import { formatDurationMmSs, friendlyErrorMessage } from '../../lib/format';
import {
  type LiveVoiceSession,
  type RecordedWavResult,
  startLiveVoiceRecording,
} from '../../lib/audioWav';

interface VoiceRecorderStudioProps {
  /** 'dictate' returns structured text into editor; 'capture_audio' yields raw WAV recording */
  mode?: 'dictate' | 'capture_audio';
  compact?: boolean;
  itemId?: string;
  saveAsNewItem?: boolean;
  orbitOverride?: string;
  focusBoardId?: string | null;
  onDictated?: (result: VoiceDictationResult, wav: RecordedWavResult) => void;
  onAudioCaptured?: (wav: RecordedWavResult, smartMode: 'smart' | 'raw') => Promise<void> | void;
  onFallbackSaveAudio?: (wav: RecordedWavResult) => Promise<void> | void;
  onCancel: () => void;
}

export const VoiceRecorderStudio: React.FC<VoiceRecorderStudioProps> = ({
  mode = 'dictate',
  compact = false,
  itemId,
  saveAsNewItem,
  orbitOverride,
  focusBoardId,
  onDictated,
  onAudioCaptured,
  onFallbackSaveAudio,
  onCancel,
}) => {
  const [phase, setPhase] = useState<'starting' | 'recording' | 'processing' | 'no_speech_fallback' | 'error'>('starting');
  const [dictateStyle, setDictateStyle] = useState<'smart' | 'raw'>('smart');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingWav, setPendingWav] = useState<RecordedWavResult | null>(null);

  const sessionRef = useRef<LiveVoiceSession | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef<number[]>(new Array(28).fill(0.16));
  const cancelledRef = useRef(false);
  const timerIdRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const startTsRef = useRef<number>(Date.now());
  const accentColorRef = useRef<string>('#e86a33');

  const stopTimers = () => {
    if (timerIdRef.current !== null) {
      window.clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  useEffect(() => {
    cancelledRef.current = false;
    startTsRef.current = Date.now();
    const resolvedAccent = getComputedStyle(document.documentElement)
      .getPropertyValue('--k-accent')
      .trim();
    if (resolvedAccent) accentColorRef.current = resolvedAccent;

    const drawBars = () => {
      const canvas = canvasRef.current;
      const session = sessionRef.current;
      if (canvas && session) {
        const lvl = session.sampleBarLevel();
        const arr = barsRef.current;
        arr.shift();
        arr.push(lvl);

        const ctx = canvas.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const rect = canvas.getBoundingClientRect();
          const w = Math.max(120, Math.round(rect.width * dpr));
          const h = Math.max(24, Math.round(rect.height * dpr));
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          ctx.clearRect(0, 0, w, h);
          const count = arr.length;
          const gap = Math.round(3 * dpr);
          const barW = Math.max(2 * dpr, (w - gap * (count - 1)) / count);
          ctx.fillStyle = accentColorRef.current;

          for (let i = 0; i < count; i += 1) {
            const val = arr[i] ?? 0.16;
            const barH = Math.max(4 * dpr, val * (h * 0.86));
            const x = i * (barW + gap);
            const y = (h - barH) / 2;
            ctx.globalAlpha = 0.42 + val * 0.58;
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, barW / 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
      rafIdRef.current = window.requestAnimationFrame(drawBars);
    };

    startLiveVoiceRecording()
      .then((sess) => {
        if (cancelledRef.current) {
          sess.cancel();
          return;
        }
        sessionRef.current = sess;
        startTsRef.current = Date.now();
        setPhase('recording');
        timerIdRef.current = window.setInterval(() => {
          setElapsedSec((Date.now() - startTsRef.current) / 1000);
        }, 200);
        rafIdRef.current = window.requestAnimationFrame(drawBars);
      })
      .catch((err) => {
        if (!cancelledRef.current) {
          setErrorText(friendlyErrorMessage(err, 'Не удалось подключиться к микрофону.'));
          setPhase('error');
        }
      });

    return () => {
      cancelledRef.current = true;
      stopTimers();
      sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  const handleFinish = async () => {
    // Freeze timer & visualizer immediately at the exact moment user clicks Finish
    stopTimers();
    const frozenElapsed = Math.max(0.4, (Date.now() - startTsRef.current) / 1000);
    setElapsedSec(frozenElapsed);

    const sess = sessionRef.current;
    if (!sess || phase !== 'recording') return;
    sessionRef.current = null;
    setPhase('processing');

    try {
      const wav = await sess.stopAndEncode();
      if (mode === 'capture_audio' && onAudioCaptured) {
        await onAudioCaptured(wav, dictateStyle);
        return;
      }

      const res = await window.kapsula.dictateAudio({
        audioBase64: wav.wavBase64,
        mime: wav.mime,
        durationSec: wav.durationSec,
        mode: dictateStyle,
        itemId,
        peaks: wav.peaks,
        saveAsNewItem,
        orbitOverride,
        focusBoardId,
      });

      const bestText = (res.formattedText || res.transcript || '').trim();
      if ((bestText || res.savedItem) && onDictated) {
        onDictated(res, wav);
        return;
      }

      setPendingWav(wav);
      setPhase('no_speech_fallback');
    } catch (err) {
      setErrorText(friendlyErrorMessage(err, 'Не удалось обработать голосовую запись.'));
      setPhase('error');
    }
  };

  if (phase === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-danger)]/35 bg-[var(--k-danger-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--k-ink-primary)]">
        <div className="flex items-center gap-2 min-w-0">
          <WarningCircle weight="fill" className="w-4 h-4 text-[var(--k-danger)] shrink-0" />
          <span className="truncate">{errorText || 'Микрофон недоступен.'}</span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="k-interactive px-2.5 py-1 rounded-lg bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12px] cursor-pointer shrink-0"
        >
          Закрыть
        </button>
      </div>
    );
  }

  if (phase === 'no_speech_fallback' && pendingWav) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] px-3.5 py-2.5 text-[12.5px]">
        <div className="flex items-center gap-2 min-w-0">
          <Microphone weight="duotone" className="w-4 h-4 text-[var(--k-amber)] shrink-0" />
          <span className="text-[var(--k-ink-primary)]">
            Речь не распознана (для автоматической расшифровки добавь ключ ИИ в Настройках). Аудио можно сохранить:
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onFallbackSaveAudio ? (
            <button
              type="button"
              onClick={() => void onFallbackSaveAudio(pendingWav)}
              className="k-interactive px-2.5 py-1 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
            >
              Сохранить аудио
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            className="k-interactive px-2.5 py-1 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] text-[12px] cursor-pointer"
          >
            Отмена
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="voice-recorder-studio"
      className={`flex ${compact ? 'flex-col gap-2 p-2.5' : 'flex-wrap items-center justify-between gap-3 px-3.5 py-2.5'} rounded-xl border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)]`}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span
          className={`w-2.5 h-2.5 rounded-full bg-[var(--k-accent)] shrink-0 ${
            phase === 'recording' ? 'k-pulse-dot' : 'opacity-60'
          }`}
        />
        <span
          data-testid="voice-recorder-timer"
          className="k-mono text-[12.5px] font-semibold text-[var(--k-ink-primary)] w-12 shrink-0"
        >
          {formatDurationMmSs(elapsedSec)}
        </span>
        {phase === 'processing' ? (
          <span className="text-[12.5px] text-[var(--k-ink-primary)] truncate">
            Сохраняю аудио и расшифровываю…
          </span>
        ) : (
          <canvas
            ref={canvasRef}
            className="h-7 flex-1 min-w-[96px] max-w-[260px]"
            aria-label="Индикатор громкости записи"
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 shrink-0">
        {!compact && phase === 'recording' ? (
          <div className="inline-flex items-center rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] p-0.5">
            <button
              type="button"
              onClick={() => setDictateStyle('smart')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium cursor-pointer ${
                dictateStyle === 'smart'
                  ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                  : 'text-[var(--k-ink-secondary)]'
              }`}
            >
              <Sparkle weight="fill" className="w-3 h-3" />
              Умно
            </button>
            <button
              type="button"
              onClick={() => setDictateStyle('raw')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium cursor-pointer ${
                dictateStyle === 'raw'
                  ? 'bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)]'
                  : 'text-[var(--k-ink-secondary)]'
              }`}
            >
              <TextT weight="bold" className="w-3 h-3" />
              Дословно
            </button>
          </div>
        ) : null}

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="voice-finish-btn"
            disabled={phase !== 'recording'}
            onClick={() => void handleFinish()}
            className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
          >
            {mode === 'dictate' && !saveAsNewItem ? (
              <PaperPlaneTilt weight="fill" className="w-3.5 h-3.5" />
            ) : (
              <Stop weight="fill" className="w-3.5 h-3.5" />
            )}
            <span>
              {phase === 'processing'
                ? 'Сохраняю…'
                : saveAsNewItem || mode !== 'dictate'
                  ? 'Сохранить'
                  : 'Готово'}
            </span>
          </button>

          <button
            type="button"
            onClick={onCancel}
            aria-label="Отменить запись"
            className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          >
            <X weight="bold" className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
