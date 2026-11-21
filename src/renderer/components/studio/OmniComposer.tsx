import React, { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowCounterClockwise,
  ArrowUpRight,
  CalendarBlank,
  Microphone,
  NotePencil,
  Paperclip,
  PaperPlaneTilt,
  Plus,
  Sparkle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { CaptureInput, OrbitDef, TextTransformPreset, VaultItem } from '@shared/types';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { isMacPlatform } from '@shared/shortcuts';
import { friendlyErrorMessage } from '../../lib/format';
import { playTactileTick } from '../../lib/tactileSound';
import { ReminderPopover } from '../ui/ReminderPopover';
import { SelectMenu } from '../ui/SelectMenu';
import { VoiceRecorderStudio } from '../ui/VoiceRecorderStudio';

interface OmniComposerProps {
  orbits: OrbitDef[];
  activeOrbitId: string | null;
  activeFocusBoardId: string | null;
  soundEnabled: boolean;
  onCaptured: (item: VaultItem, openInStudio?: boolean) => void;
  onOpenBlankDraft?: () => void;
}

const GENERIC_CLIPBOARD_IMAGE_RE = /^image(?:\.[a-z0-9]+)?$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v)$/i;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

export const OmniComposer: React.FC<OmniComposerProps> = ({
  orbits,
  activeOrbitId,
  activeFocusBoardId,
  soundEnabled,
  onCaptured,
  onOpenBlankDraft,
}) => {
  const prefersReduced = useReducedMotion();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const [childMenuOpen, setChildMenuOpen] = useState(false);
  const [orbitOverride, setOrbitOverride] = useState('');
  const [remindAt, setRemindAt] = useState<number | null>(null);
  const [dismissedEventText, setDismissedEventText] = useState<string | null>(null);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [beautifying, setBeautifying] = useState(false);
  const [originalBeforeBeautify, setOriginalBeforeBeautify] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const effectiveOrbit = orbitOverride || activeOrbitId || '';
  const expanded =
    focused ||
    dragHover ||
    childMenuOpen ||
    text.trim().length > 0 ||
    recordingOpen ||
    remindAt !== null ||
    Boolean(orbitOverride);

  const activeParsedEvent = useMemo(() => {
    const clean = text.trim();
    if (clean.length < 5 || /^https?:\/\/\S+$/i.test(clean) || dismissedEventText === clean) {
      return null;
    }
    const parsed = parseRussianEvent(clean);
    return parsed?.isEventIntent ? parsed : null;
  }, [text, dismissedEventText]);

  const submitCapture = async (openInStudio = false) => {
    const trimmed = text.trim();
    if (!trimmed && !openInStudio) return;
    if (!trimmed && openInStudio) {
      playTactileTick(soundEnabled, 'soft');
      onOpenBlankDraft?.();
      return;
    }

    setSubmitting(true);
    try {
      const effectiveRemindAt = remindAt ?? activeParsedEvent?.startAt ?? null;
      const isSingleUrl = /^https?:\/\/\S+$/i.test(trimmed);
      const isDismissed = dismissedEventText === trimmed;
      const input: CaptureInput = {
        ...(isSingleUrl ? { url: trimmed } : { text: trimmed }),
        source: 'vault_ui',
        orbitOverride: effectiveOrbit || undefined,
        focusBoardId: activeFocusBoardId,
        remindAt: effectiveRemindAt,
        skipAutoCalendar: isDismissed || undefined,
        calendarEventOverride:
          activeParsedEvent && !isSingleUrl && !isDismissed ? activeParsedEvent : undefined,
      };
      const created = await window.kapsula.capture(input);
      if (activeParsedEvent && !isSingleUrl && !isDismissed && created.dna !== 'secret') {
        toast.success('Сохранено и добавлено в Календарь');
      }
      setText('');
      setRemindAt(null);
      setDismissedEventText(null);
      setOrbitOverride('');
      setOriginalBeforeBeautify(null);
      setFocused(false);
      playTactileTick(soundEnabled, 'success');
      onCaptured(created, openInStudio);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось сохранить запись'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const file of arr) {
      try {
        const nativePath = window.kapsula.getPathForFile(file);
        const safeName = GENERIC_CLIPBOARD_IMAGE_RE.test(file.name)
          ? ''
          : file.name.replace(/\.[^.]+$/, '');

        if (file.type.startsWith('image/')) {
          const b64 = nativePath ? undefined : await fileToBase64(file);
          const created = await window.kapsula.capture({
            ...(b64 ? { imageBase64: b64 } : {}),
            ...(nativePath ? { imageFilePath: nativePath } : {}),
            title: safeName,
            source: 'vault_ui',
            orbitOverride: effectiveOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        } else if (file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name)) {
          const b64 = nativePath ? undefined : await fileToBase64(file);
          const created = await window.kapsula.capture({
            ...(nativePath ? { videoPath: nativePath } : { videoBase64: b64 }),
            videoMime: file.type || 'video/mp4',
            fileName: file.name,
            title: safeName,
            source: 'vault_ui',
            orbitOverride: effectiveOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        } else if (file.type.startsWith('audio/')) {
          const b64 = await fileToBase64(file);
          const created = await window.kapsula.capture({
            audioBase64: b64,
            audioMime: file.type,
            fileName: file.name,
            source: 'vault_ui',
            orbitOverride: effectiveOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        } else {
          const b64 = nativePath ? undefined : await fileToBase64(file);
          const created = await window.kapsula.capture({
            ...(nativePath ? { filePath: nativePath } : {}),
            ...(b64 ? { fileBase64: b64 } : {}),
            fileName: file.name,
            fileMime: file.type || 'application/octet-stream',
            source: 'vault_ui',
            orbitOverride: effectiveOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        }
        playTactileTick(soundEnabled, 'success');
        toast.success(`Сохранено: ${safeName || 'скриншот'}`);
      } catch (err) {
        toast.error(friendlyErrorMessage(err, `Ошибка загрузки ${file.name}`));
      }
    }
  };

  const handleBeautifyDraft = async (preset: TextTransformPreset = 'structure') => {
    const raw = text.trim();
    if (!raw || beautifying) return;
    setBeautifying(true);
    try {
      const res = await window.kapsula.transformText({ text: raw, preset });
      if (res.formattedText && res.formattedText.trim()) {
        setOriginalBeforeBeautify((prev) => prev ?? raw);
        setText(res.formattedText);
        playTactileTick(soundEnabled, 'success');
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось оформить текст'));
    } finally {
      setBeautifying(false);
    }
  };

  const orbitOptions = [
    { value: '', label: 'Авто-раздел' },
    ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
  ];

  // Strictly driven by actual newline count — NEVER snaps rows on focus/blur!
  const rowCount = Math.min(8, Math.max(1, text.split('\n').length));

  return (
    <div
      ref={rootRef}
      data-testid="omni-composer"
      onBlur={(e) => {
        const next = e.relatedTarget as HTMLElement | null;
        if (next && rootRef.current?.contains(next)) return;
        if (next && next.closest('.k-popup-motion, [role="listbox"], [role="dialog"]')) return;
        if (!childMenuOpen) {
          setFocused(false);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragHover(true);
      }}
      onDragLeave={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
          setDragHover(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        if (e.dataTransfer.files?.length) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
      /* Constant px-3.5 py-2.5 prevents any 2-step padding snap during collapse */
      className={`rounded-2xl border px-3.5 py-2.5 transition-[border-color,box-shadow,background-color] duration-180 ease-[var(--k-ease-out)] bg-[var(--k-bg-surface-1)] ${
        focused || dragHover
          ? 'border-[var(--k-border-focus)] shadow-[0_0_0_3px_var(--k-accent-soft),var(--k-shadow-card)]'
          : 'border-[var(--k-border-hairline)] shadow-[var(--k-shadow-card)] hover:border-[var(--k-border-strong)]'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            void handleFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Exact 28px vertical center-aligned primary row (+ icon, single-line textarea, right triggers all share 14.0px centerline) */}
      <div className="relative flex items-start gap-2.5 min-h-[28px]">
        <span
          data-testid="omni-plus-icon"
          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-160 ${
            expanded
              ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
              : 'text-[var(--k-ink-muted)]'
          }`}
        >
          <Plus weight="bold" className="w-4 h-4" />
        </span>

        <textarea
          ref={textareaRef}
          data-testid="omni-composer-input"
          value={text}
          rows={rowCount}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            setText(e.target.value);
            if (originalBeforeBeautify && e.target.value === originalBeforeBeautify) {
              setOriginalBeforeBeautify(null);
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              void handleFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void submitCapture(false);
            } else if (e.key === 'Escape' && !text.trim() && !recordingOpen) {
              setFocused(false);
              textareaRef.current?.blur();
            }
          }}
          placeholder="Быстрая мысль, ссылка, скриншот, видео или задача…"
          className={`flex-1 min-w-0 resize-none bg-transparent border-none outline-none text-[13.5px] leading-[22px] py-[3px] min-h-[28px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] k-selectable ${
            !expanded ? 'pr-[156px]' : 'pr-0'
          }`}
        />

        {/* Compact right triggers cross-fade cleanly without overlapping the bottom tray */}
        <div
          aria-hidden={expanded}
          inert={expanded ? true : undefined}
          className={`absolute right-0 top-0 flex items-center gap-1 h-7 transition-[opacity,transform] ${
            prefersReduced
              ? 'duration-0'
              : expanded
                ? 'duration-[100ms] ease-out'
                : 'duration-[120ms] delay-[45ms] ease-out'
          } ${
            expanded
              ? 'opacity-0 scale-[0.96] pointer-events-none'
              : 'opacity-100 scale-100 pointer-events-auto'
          }`}
        >
          <button
            type="button"
            data-testid="omni-dictate-btn"
            title="Голосовая заметка"
            onClick={() => {
              setFocused(true);
              setRecordingOpen(true);
            }}
            className="k-interactive w-7 h-7 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-accent)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
          >
            <Microphone className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Прикрепить файл"
            onClick={() => fileInputRef.current?.click()}
            className="k-interactive w-7 h-7 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          {onOpenBlankDraft ? (
            <button
              type="button"
              data-testid="new-blank-note-btn"
              title={
                isMacPlatform(window.kapsula?.platform)
                  ? 'Открыть чистую заметку (⌘N)'
                  : 'Открыть чистую заметку (Ctrl+N)'
              }
              onClick={onOpenBlankDraft}
              className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer ml-0.5"
            >
              <NotePencil className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              <span>Заметка</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Smoothly Animated Recognized Date Chip */}
      <AnimatePresence initial={false}>
        {activeParsedEvent && !remindAt ? (
          <motion.div
            key="omni-parsed-date"
            initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-2">
              <div className="inline-flex items-center gap-2 rounded-lg border border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)] px-2.5 py-1 text-[11.5px] text-[var(--k-ink-primary)]">
                <CalendarBlank weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                <span>
                  Календарь: <strong>{activeParsedEvent.label}</strong>
                  {activeParsedEvent.location ? ` · ${activeParsedEvent.location}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setDismissedEventText(text.trim())}
                  aria-label="Не добавлять в календарь"
                  className="text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Smoothly Animated Voice Recorder Drawer */}
      <AnimatePresence initial={false}>
        {recordingOpen ? (
          <motion.div
            key="omni-voice-recorder"
            initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-2.5">
              <VoiceRecorderStudio
                mode="dictate"
                saveAsNewItem={!text.trim()}
                orbitOverride={effectiveOrbit || undefined}
                focusBoardId={activeFocusBoardId}
                onDictated={(res, wav) => {
                  setRecordingOpen(false);
                  playTactileTick(soundEnabled, 'success');
                  if (res.savedItem) {
                    onCaptured(res.savedItem);
                    toast.success('Голосовая заметка и аудио сохранены');
                    return;
                  }
                  const snippet = res.formattedText || res.transcript;
                  if (snippet) {
                    setText((prev) => (prev.trim() ? `${prev.trim()}\n\n${snippet}` : snippet));
                    toast.success('Голос расшифрован и аудио сохранено');
                  } else if (wav.wavBase64) {
                    void window.kapsula
                      .capture({
                        audioBase64: wav.wavBase64,
                        audioMime: wav.mime,
                        audioDurationSec: wav.durationSec,
                        orbitOverride: effectiveOrbit || undefined,
                        focusBoardId: activeFocusBoardId,
                        mediaMeta: { waveformPeaks: wav.peaks },
                        source: 'vault_ui',
                      })
                      .then((created) => {
                        onCaptured(created);
                        toast.success('Аудиозапись сохранена');
                      });
                  }
                }}
                onFallbackSaveAudio={async (wav) => {
                  setRecordingOpen(false);
                  const created = await window.kapsula.capture({
                    audioBase64: wav.wavBase64,
                    audioMime: wav.mime,
                    audioDurationSec: wav.durationSec,
                    source: 'vault_ui',
                    orbitOverride: effectiveOrbit || undefined,
                    focusBoardId: activeFocusBoardId,
                    mediaMeta: { waveformPeaks: wav.peaks },
                  });
                  onCaptured(created);
                  toast.success('Аудиозапись сохранена');
                }}
                onCancel={() => setRecordingOpen(false)}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Always-mounted CSS Grid Action Tray: zero mount stall on open, crisp symmetric curve with zero sticky tail on close */}
      <div
        data-testid="omni-expanded-bar"
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
        className={`grid transition-[grid-template-rows,opacity] ${
          prefersReduced
            ? 'duration-0'
            : expanded
              ? 'duration-[180ms] ease-[var(--k-ease-out)]'
              : 'duration-[155ms] ease-[var(--k-ease-out)]'
        } ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="overflow-hidden min-h-0">
          <div
            className={`pt-2.5 transition-transform ${
              prefersReduced
                ? 'duration-0'
                : expanded
                  ? 'duration-[180ms] ease-[var(--k-ease-out)]'
                  : 'duration-[155ms] ease-[var(--k-ease-out)]'
            } ${expanded ? 'translate-y-0' : '-translate-y-1'}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[var(--k-border-hairline)]">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="omni-dictate-btn"
                  onClick={() => setRecordingOpen((p) => !p)}
                  className={`k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] font-medium cursor-pointer ${
                    recordingOpen
                      ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                      : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                  }`}
                >
                  <Microphone weight={recordingOpen ? 'fill' : 'regular'} className="w-3.5 h-3.5" />
                  <span>Голос</span>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] text-[12px] font-medium cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Файл</span>
                </button>

                {text.trim().length > 0 ? (
                  <button
                    type="button"
                    data-testid="omni-beautify-btn"
                    disabled={beautifying}
                    onClick={() => void handleBeautifyDraft('structure')}
                    className={`k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[12px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer ${
                      beautifying ? 'k-beautify-shimmer' : ''
                    }`}
                  >
                    <Sparkle weight="fill" className="w-3.5 h-3.5" />
                    <span>{beautifying ? 'Оформляю…' : 'Украсить'}</span>
                  </button>
                ) : null}

                {originalBeforeBeautify !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      setText(originalBeforeBeautify);
                      setOriginalBeforeBeautify(null);
                    }}
                    className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                  >
                    <ArrowCounterClockwise className="w-3.5 h-3.5" />
                    <span>Вернуть</span>
                  </button>
                ) : null}

                {orbits.length > 0 ? (
                  <SelectMenu
                    size="sm"
                    value={orbitOverride}
                    options={orbitOptions}
                    onOpenChange={setChildMenuOpen}
                    onChange={setOrbitOverride}
                  />
                ) : null}

                <ReminderPopover
                  remindAt={remindAt}
                  onOpenChange={setChildMenuOpen}
                  onChange={setRemindAt}
                />
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="new-blank-note-btn"
                  disabled={submitting}
                  onClick={() => void submitCapture(true)}
                  className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  <span>В редактор</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  data-testid="omni-save-btn"
                  disabled={submitting || !text.trim()}
                  onClick={() => void submitCapture(false)}
                  className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                >
                  <PaperPlaneTilt weight="fill" className="w-3.5 h-3.5" />
                  <span>Сохранить</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
