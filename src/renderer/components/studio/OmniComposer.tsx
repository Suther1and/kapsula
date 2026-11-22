import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { CaptureInput, OrbitDef, TextTransformPreset, VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { isMacPlatform } from '@shared/shortcuts';
import { friendlyErrorMessage } from '../../lib/format';
import { playTactileTick } from '../../lib/tactileSound';
import { ReminderPopover } from '../ui/ReminderPopover';
import { SectionPickerPopover } from '../ui/SectionPickerPopover';
import { VoiceRecorderStudio } from '../ui/VoiceRecorderStudio';

interface OmniComposerProps {
  orbits: OrbitDef[];
  activeOrbitId: string | null;
  activeFocusBoardId: string | null;
  soundEnabled: boolean;
  onCaptured: (item: VaultItem, openInStudio?: boolean) => void;
  onOpenBlankDraft?: () => void;
}

interface PendingImageDraft {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  nativePath?: string;
}

const GENERIC_CLIPBOARD_IMAGE_RE = /^image(?:\.[a-z0-9]+)?$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v)$/i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|heic|svg)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || (!file.type && IMAGE_EXT_RE.test(file.name || ''));
}

function extractClipboardImages(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<string>();

  const pushUnique = (file: File | null | undefined) => {
    if (!file || !isImageFile(file)) return;
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };

  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item && item.kind === 'file' && (item.type.startsWith('image/') || !item.type)) {
        pushUnique(item.getAsFile());
      }
    }
  }
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i += 1) {
      pushUnique(dt.files[i]);
    }
  }
  return out;
}

function fileToBase64(file: File, readErrorMsg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error(readErrorMsg));
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
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const [childMenuOpen, setChildMenuOpen] = useState(false);
  const [orbitOverride, setOrbitOverride] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImageDraft[]>([]);
  const [remindAt, setRemindAt] = useState<number | null>(null);
  const [dismissedEventText, setDismissedEventText] = useState<string | null>(null);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [beautifying, setBeautifying] = useState(false);
  const [originalBeforeBeautify, setOriginalBeforeBeautify] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingImagesRef = useRef<PendingImageDraft[]>([]);

  useEffect(() => {
    setOrbitOverride(null);
  }, [activeOrbitId]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    return () => {
      for (const img of pendingImagesRef.current) {
        URL.revokeObjectURL(img.previewUrl);
      }
    };
  }, []);

  const selectedOrbit = orbitOverride !== null ? orbitOverride : (activeOrbitId || '');
  const expanded =
    focused ||
    dragHover ||
    childMenuOpen ||
    text.trim().length > 0 ||
    pendingImages.length > 0 ||
    recordingOpen ||
    remindAt !== null ||
    (orbitOverride !== null && orbitOverride !== (activeOrbitId || ''));

  const syncTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (el.value === '') {
      el.style.height = '28px';
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = '28px';
    const scrollH = el.scrollHeight;
    const nextH = Math.max(28, Math.min(240, scrollH));
    el.style.height = `${nextH}px`;
    el.style.overflowY = scrollH > 240 ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [text, expanded, syncTextareaHeight]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      syncTextareaHeight();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncTextareaHeight]);

  const activeParsedEvent = useMemo(() => {
    const clean = text.trim();
    if (clean.length < 5 || /^https?:\/\/\S+$/i.test(clean) || dismissedEventText === clean) {
      return null;
    }
    const parsed = parseRussianEvent(clean, Date.now(), undefined, locale);
    return parsed?.isEventIntent ? parsed : null;
  }, [text, dismissedEventText, locale]);

  const appendPendingImages = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const nextDrafts: PendingImageDraft[] = files.map((file) => {
      const nativePath = window.kapsula.getPathForFile(file) || undefined;
      const safeName = GENERIC_CLIPBOARD_IMAGE_RE.test(file.name)
        ? ''
        : file.name.replace(/\.[^.]+$/, '');
      return {
        id:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        name: safeName,
        nativePath,
      };
    });
    setPendingImages((prev) => [...prev, ...nextDrafts]);
    setFocused(true);
  }, []);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  const submitCapture = async (openInStudio = false) => {
    if (submitting) return;
    const trimmed = text.trim();
    const hasImages = pendingImages.length > 0;
    if (!trimmed && !hasImages && !openInStudio) return;
    if (!trimmed && !hasImages && openInStudio) {
      playTactileTick(soundEnabled, 'soft');
      onOpenBlankDraft?.();
      return;
    }

    setSubmitting(true);
    try {
      const readErr = t('error.readFileFailed');
      const effectiveRemindAt = remindAt ?? activeParsedEvent?.startAt ?? null;
      const isSingleUrl = !hasImages && /^https?:\/\/\S+$/i.test(trimmed);
      const isDismissed = dismissedEventText === trimmed;

      let captureInput: CaptureInput;
      if (!hasImages) {
        captureInput = {
          ...(isSingleUrl ? { url: trimmed } : { text: trimmed }),
          source: 'vault_ui',
          orbitOverride: selectedOrbit || undefined,
          focusBoardId: activeFocusBoardId,
          remindAt: effectiveRemindAt,
          skipAutoCalendar: isDismissed || undefined,
          calendarEventOverride:
            activeParsedEvent && !isSingleUrl && !isDismissed ? activeParsedEvent : undefined,
          ...(openInStudio ? { mediaMeta: { inNotesHub: true } } : {}),
        };
      } else {
        const firstImg = pendingImages[0]!;
        const firstPath = firstImg.nativePath;
        const firstBase64 = firstPath ? undefined : await fileToBase64(firstImg.file, readErr);

        let bodyText = trimmed;
        let galleryPaths: string[] | undefined;

        if (pendingImages.length > 1) {
          const extraFilenames: string[] = [];
          const markdownImages: string[] = [];
          for (const extraImg of pendingImages.slice(1)) {
            const extraPath = extraImg.nativePath;
            const extraB64 = extraPath ? undefined : await fileToBase64(extraImg.file, readErr);
            const saved = await window.kapsula.saveNoteImage({
              ...(extraPath ? { filePath: extraPath } : { base64: extraB64 }),
              mimeType: extraImg.file.type || 'image/png',
              fileName: extraImg.file.name,
            });
            extraFilenames.push(saved.filename);
            markdownImages.push(`![](kapsula-media://local/${saved.filename})`);
          }
          galleryPaths = extraFilenames;
          const galleryBlock = markdownImages.join('\n\n');
          bodyText = trimmed ? `${trimmed}\n\n${galleryBlock}` : galleryBlock;
        }

        const captionTitle =
          pendingImages.length > 1
            ? trimmed
              ? trimmed
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .find(Boolean)
                  ?.slice(0, 96)
              : firstImg.name || t('composer.pendingImagesCount', { count: pendingImages.length })
            : trimmed
              ? undefined
              : firstImg.name || undefined;

        const mediaMeta =
          galleryPaths || openInStudio
            ? {
                ...(galleryPaths ? { galleryPaths } : {}),
                ...(openInStudio ? { inNotesHub: true } : {}),
              }
            : undefined;

        captureInput = {
          ...(bodyText ? { text: bodyText } : {}),
          ...(firstPath ? { imageFilePath: firstPath } : { imageBase64: firstBase64 }),
          ...(captionTitle ? { title: captionTitle } : {}),
          source: 'vault_ui',
          orbitOverride: selectedOrbit || undefined,
          focusBoardId: activeFocusBoardId,
          remindAt: effectiveRemindAt,
          skipAutoCalendar: isDismissed || undefined,
          calendarEventOverride:
            activeParsedEvent && !isDismissed ? activeParsedEvent : undefined,
          ...(mediaMeta ? { mediaMeta } : {}),
        };
      }

      const created = await window.kapsula.capture(captureInput);
      if (activeParsedEvent && !isSingleUrl && !isDismissed && created.dna !== 'secret') {
        toast.success(t('composer.savedWithCalendar'));
      } else if (hasImages) {
        toast.success(t('composer.savedWithImages'));
      }

      for (const img of pendingImages) {
        URL.revokeObjectURL(img.previewUrl);
      }
      setPendingImages([]);
      setText('');
      setRemindAt(null);
      setDismissedEventText(null);
      setOrbitOverride(null);
      setOriginalBeforeBeautify(null);
      setFocused(false);
      playTactileTick(soundEnabled, 'success');
      onCaptured(created, openInStudio);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('composer.saveFailed'), locale));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const imageFiles = arr.filter((f) => isImageFile(f));
    const otherFiles = arr.filter((f) => !isImageFile(f));

    if (imageFiles.length > 0) {
      appendPendingImages(imageFiles);
    }

    const readErr = t('error.readFileFailed');
    let attachedText = text.trim();
    for (const file of otherFiles) {
      try {
        const nativePath = window.kapsula.getPathForFile(file);
        const safeName = GENERIC_CLIPBOARD_IMAGE_RE.test(file.name)
          ? ''
          : file.name.replace(/\.[^.]+$/, '');
        const noteText = attachedText || undefined;

        if (file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name)) {
          const b64 = nativePath ? undefined : await fileToBase64(file, readErr);
          const created = await window.kapsula.capture({
            ...(nativePath ? { videoPath: nativePath } : { videoBase64: b64 }),
            ...(noteText ? { text: noteText } : {}),
            videoMime: file.type || 'video/mp4',
            fileName: file.name,
            title: safeName,
            source: 'vault_ui',
            orbitOverride: selectedOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        } else if (file.type.startsWith('audio/')) {
          const b64 = await fileToBase64(file, readErr);
          const created = await window.kapsula.capture({
            audioBase64: b64,
            audioMime: file.type,
            fileName: file.name,
            ...(noteText ? { text: noteText } : {}),
            source: 'vault_ui',
            orbitOverride: selectedOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        } else {
          const b64 = nativePath ? undefined : await fileToBase64(file, readErr);
          const created = await window.kapsula.capture({
            ...(nativePath ? { filePath: nativePath } : {}),
            ...(b64 ? { fileBase64: b64 } : {}),
            ...(noteText ? { text: noteText } : {}),
            fileName: file.name,
            fileMime: file.type || 'application/octet-stream',
            source: 'vault_ui',
            orbitOverride: selectedOrbit || undefined,
            focusBoardId: activeFocusBoardId,
          });
          onCaptured(created);
        }
        if (attachedText) {
          attachedText = '';
          setText('');
          setOriginalBeforeBeautify(null);
        }
        playTactileTick(soundEnabled, 'success');
        toast.success(t('composer.savedNamed', { name: safeName || file.name }));
      } catch (err) {
        toast.error(friendlyErrorMessage(err, t('error.uploadFileFailed', { name: file.name }), locale));
      }
    }
  };

  const handleBeautifyDraft = async (preset: TextTransformPreset = 'structure') => {
    const raw = text.trim();
    if (!raw || beautifying) return;
    setBeautifying(true);
    try {
      const res = await window.kapsula.transformText({ text: raw, preset });
      const didChange =
        res.changed !== undefined
          ? res.changed
          : Boolean(res.formattedText && res.formattedText.trim() !== raw);
      if (!didChange || !res.formattedText?.trim()) {
        const reason = res.fallbackReason;
        if (reason === 'no_ai_key' || reason === 'budget_limit') {
          toast.info(t('note.studio.ai.noChangesLocal'));
        } else if (reason === 'cloud_error') {
          toast.info(t('note.studio.ai.noChangesError'));
        } else if (reason === 'secret_detected') {
          toast.info(t('note.studio.ai.noChangesSecret'));
        } else {
          toast.info(t('note.studio.ai.noChanges'));
        }
        return;
      }
      setOriginalBeforeBeautify((prev) => prev ?? text);
      setText(res.formattedText);
      playTactileTick(soundEnabled, 'success');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('composer.beautifyFailed'), locale));
    } finally {
      setBeautifying(false);
    }
  };

  const canSave = Boolean(text.trim() || pendingImages.length > 0);

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
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.files?.length) {
          e.preventDefault();
          setDragHover(true);
        }
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
          rows={1}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            setText(e.target.value);
            if (originalBeforeBeautify && e.target.value === originalBeforeBeautify) {
              setOriginalBeforeBeautify(null);
            }
          }}
          onPaste={(e) => {
            const pastedImages = extractClipboardImages(e.clipboardData);
            if (pastedImages.length > 0) {
              e.preventDefault();
              appendPendingImages(pastedImages);
              return;
            }
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              void handleFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submitCapture(false);
              return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void submitCapture(false);
              return;
            }
            if (e.key === 'Escape' && !text.trim() && pendingImages.length === 0 && !recordingOpen) {
              setFocused(false);
              textareaRef.current?.blur();
            }
          }}
          placeholder={t('composer.placeholder')}
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
            title={t('composer.voiceTitle')}
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
            title={t('composer.attachFile')}
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
                  ? t('composer.openBlankMac')
                  : t('composer.openBlankWin')
              }
              onClick={onOpenBlankDraft}
              className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer ml-0.5"
            >
              <NotePencil className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              <span>{t('dna.note')}</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Pending Pasted / Attached Image Preview Strip */}
      <AnimatePresence initial={false}>
        {pendingImages.length > 0 ? (
          <motion.div
            key="omni-pending-attachments-wrap"
            initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div
              data-testid="omni-pending-attachments"
              className="pt-2.5 pl-[38px] flex flex-wrap items-center gap-2"
            >
              {pendingImages.map((img) => (
                <div
                  key={img.id}
                  className="relative group w-[60px] h-[60px] rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] shrink-0 shadow-[var(--k-shadow-thumb)]"
                >
                  <img
                    src={img.previewUrl}
                    alt={img.name || t('composer.screenshot')}
                    className="w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    data-testid="omni-remove-attachment-btn"
                    aria-label={t('composer.removeAttachment')}
                    title={t('composer.removeAttachment')}
                    onClick={() => removePendingImage(img.id)}
                    className="k-interactive absolute top-1 right-1 w-4.5 h-4.5 rounded-full bg-black/70 text-white hover:bg-[var(--k-danger)] inline-flex items-center justify-center shadow-sm cursor-pointer"
                  >
                    <X weight="bold" className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
              {pendingImages.length > 1 ? (
                <span className="text-[11.5px] text-[var(--k-ink-muted)] pl-1">
                  {t('composer.pendingImagesCount', { count: pendingImages.length })}
                </span>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

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
                  {t('composer.calendarDetected')} <strong>{activeParsedEvent.label}</strong>
                  {activeParsedEvent.location ? ` · ${activeParsedEvent.location}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setDismissedEventText(text.trim())}
                  aria-label={t('composer.calendarSkipAria')}
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
                saveAsNewItem={!text.trim() && pendingImages.length === 0}
                orbitOverride={selectedOrbit || undefined}
                focusBoardId={activeFocusBoardId}
                onDictated={(res, wav) => {
                  setRecordingOpen(false);
                  playTactileTick(soundEnabled, 'success');
                  if (res.savedItem) {
                    onCaptured(res.savedItem);
                    toast.success(t('composer.voiceAndAudioSaved'));
                    return;
                  }
                  const snippet = res.formattedText || res.transcript;
                  if (snippet) {
                    setText((prev) => (prev.trim() ? `${prev.trim()}\n\n${snippet}` : snippet));
                    toast.success(t('composer.voiceTranscribedSaved'));
                  } else if (wav.wavBase64) {
                    void window.kapsula
                      .capture({
                        audioBase64: wav.wavBase64,
                        audioMime: wav.mime,
                        audioDurationSec: wav.durationSec,
                        orbitOverride: selectedOrbit || undefined,
                        focusBoardId: activeFocusBoardId,
                        mediaMeta: { waveformPeaks: wav.peaks },
                        source: 'vault_ui',
                      })
                      .then((created) => {
                        onCaptured(created);
                        toast.success(t('note.studio.audioSaved'));
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
                    orbitOverride: selectedOrbit || undefined,
                    focusBoardId: activeFocusBoardId,
                    mediaMeta: { waveformPeaks: wav.peaks },
                  });
                  onCaptured(created);
                  toast.success(t('note.studio.audioSaved'));
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
                  <span>{t('workspace.filter.voice')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] text-[12px] font-medium cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>{t('dna.doc')}</span>
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
                    <span>{beautifying ? t('composer.beautifying') : t('composer.beautify')}</span>
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
                    <span>{t('composer.revert')}</span>
                  </button>
                ) : null}

                <SectionPickerPopover
                  orbits={orbits}
                  value={selectedOrbit}
                  onChange={(val) => setOrbitOverride(val)}
                  emptyOptionLabel={t('nav.autoSection')}
                  emptyOptionKind="auto"
                  size="sm"
                  onOpenChange={setChildMenuOpen}
                  data-testid="omni-section-picker"
                />

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
                  <span>{t('composer.toEditor')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  data-testid="omni-save-btn"
                  title={t('composer.enterHint')}
                  disabled={submitting || !canSave}
                  onClick={() => void submitCapture(false)}
                  className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                >
                  <PaperPlaneTilt weight="fill" className="w-3.5 h-3.5" />
                  <span>{t('common.save')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
