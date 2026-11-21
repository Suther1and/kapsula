import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  Camera,
  FolderSimple,
  Image as ImageIcon,
  Microphone,
  NotePencil,
  Paperclip,
  ShieldCheck,
  Stop,
  Swatches,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { FocusBoard, OrbitDef } from '@shared/types';
import { formatDurationMmSs } from '@renderer/lib/format';
import { extractFirstUrlFromText, makeSafeUploadName } from '../lib/mobile-helpers';
import { mobileBridge, type PickedFilePayload } from '../native/bridge';
import { base64ToBytes } from '../sync/mobile-crypto';
import { BottomSheet } from './BottomSheet';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';

export type QuickCaptureTab = 'text' | 'voice' | 'photo' | 'file';

interface QuickCaptureSheetProps {
  open: boolean;
  initialTab?: QuickCaptureTab;
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  orbits: OrbitDef[];
  boards: FocusBoard[];
  onClose: () => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
  onCreateBoard?: (name: string, color: string) => Promise<string>;
  onSaveText: (data: {
    title: string;
    body: string;
    url: string | null;
    orbit: string;
    focusBoardId: string | null;
  }) => Promise<void>;
  onSaveMedia: (data: {
    kind: 'shot' | 'voice' | 'doc';
    title: string;
    body: string;
    fileName: string;
    mime: string;
    bytes: Uint8Array;
    durationSec?: number;
    peaks?: number[];
    orbit: string;
    focusBoardId: string | null;
  }) => Promise<void>;
  onOpenVaultAdd: () => void;
}

export const QuickCaptureSheet: React.FC<QuickCaptureSheetProps> = ({
  open,
  initialTab = 'text',
  isExpanded,
  hingeRightOffsetPx = 0,
  orbits,
  boards,
  onClose,
  onCreateOrbit,
  onCreateBoard,
  onSaveText,
  onSaveMedia,
  onOpenVaultAdd,
}) => {
  const prefersReduced = useReducedMotion();
  const [tab, setTab] = useState<QuickCaptureTab>(initialTab);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [orbit, setOrbit] = useState('');
  const [boardId, setBoardId] = useState('');
  const [saving, setSaving] = useState(false);

  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(20).fill(0.15));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const recordingRef = useRef(false);
  recordingRef.current = recording;

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setText('');
      setTitle('');
      setRecording(false);
      setRecordSec(0);
    } else if (recordingRef.current) {
      void mobileBridge.cancelVoiceRecording();
      setRecording(false);
    }
  }, [open, initialTab]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        void mobileBridge.cancelVoiceRecording();
      }
    };
  }, []);

  const handleSelectTab = (next: QuickCaptureTab) => {
    mobileBridge.haptic('light');
    if (tab === 'voice' && next !== 'voice' && recordingRef.current) {
      void mobileBridge.cancelVoiceRecording();
      setRecording(false);
      setRecordSec(0);
    }
    setTab(next);
  };

  useEffect(() => {
    if (!recording) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    const offAmp = mobileBridge.onVoiceAmplitude((lvl) => {
      setLevels((prev) => [...prev.slice(1), Math.max(0.12, Math.min(1, lvl))]);
    });
    timerRef.current = setInterval(() => {
      setRecordSec((s) => s + 1);
    }, 1000);
    return () => {
      offAmp();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [recording]);

  const selectedOrbit = useMemo(() => orbits.find((o) => o.id === orbit) ?? null, [orbits, orbit]);
  const selectedBoard = useMemo(
    () => boards.find((b) => b.id === boardId) ?? null,
    [boards, boardId]
  );

  const handleSaveThought = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      const url = extractFirstUrlFromText(clean);
      await onSaveText({
        title: title.trim() || (url ? '' : clean.split('\n')[0]!.slice(0, 80)),
        body: clean,
        url,
        orbit,
        focusBoardId: boardId || null,
      });
      mobileBridge.haptic('success');
      toast.success('Сохранено в Kapsula');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleStartVoice = async () => {
    const res = await mobileBridge.startVoiceRecording();
    if (!res.ok) {
      toast.error(res.error || 'Не удалось включить микрофон');
      return;
    }
    mobileBridge.haptic('medium');
    setRecordSec(0);
    setLevels(Array(20).fill(0.18));
    setRecording(true);
  };

  const handleStopVoice = async () => {
    setRecording(false);
    setSaving(true);
    try {
      const res = await mobileBridge.stopVoiceRecording();
      if (!res.ok || !res.base64) {
        toast.error(res.error || 'Не удалось сохранить голосовую заметку');
        return;
      }
      const bytes = base64ToBytes(res.base64);
      const mime = res.mime || 'audio/mp4';
      const fileName = makeSafeUploadName('voice', 'voice', mime);
      await onSaveMedia({
        kind: 'voice',
        title:
          title.trim() ||
          `Голосовая заметка (${formatDurationMmSs(res.durationSec || recordSec)})`,
        body: text.trim(),
        fileName,
        mime,
        bytes,
        durationSec: res.durationSec || recordSec || 1,
        peaks: res.peaks,
        orbit,
        focusBoardId: boardId || null,
      });
      mobileBridge.haptic('success');
      toast.success('Голосовая заметка сохранена');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const persistPickedFiles = async (
    files: PickedFilePayload[],
    forceKind: 'shot' | 'doc',
    truncated = false
  ) => {
    if (truncated) {
      toast.warning('Часть файлов пропущена: лимит 24 МБ за один выбор');
    }
    if (files.length === 0) return;
    setSaving(true);
    try {
      for (const file of files) {
        const bytes = base64ToBytes(file.base64);
        const isImg = file.mime.startsWith('image/');
        const kind = isImg ? 'shot' : forceKind;
        const safeName = makeSafeUploadName(kind, file.name, file.mime);
        await onSaveMedia({
          kind,
          title: title.trim() || file.name,
          body: text.trim(),
          fileName: safeName,
          mime: file.mime,
          bytes,
          orbit,
          focusBoardId: boardId || null,
        });
      }
      mobileBridge.haptic('success');
      toast.success(files.length > 1 ? `Сохранено файлов: ${files.length}` : 'Файл сохранён');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const captureTabs = [
    { id: 'text' as const, label: 'Мысль', icon: NotePencil },
    { id: 'voice' as const, label: 'Голос', icon: Microphone },
    { id: 'photo' as const, label: 'Фото', icon: Camera },
    { id: 'file' as const, label: 'Файл', icon: Paperclip },
  ];

  return (
    <>
      <BottomSheet
        open={open}
        title="Быстрый захват"
        subtitle="Мысль, голос, фото, файл или Сейф"
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={onClose}
        footer={
          tab === 'text' ? (
            <div className="px-4 py-2.5">
              <button
                type="submit"
                form="k-quick-capture-text-form"
                data-testid="capture-text-submit"
                disabled={!text.trim() || saving}
                className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14.5px] font-semibold disabled:bg-[var(--k-bg-surface-2)] disabled:text-[var(--k-ink-muted)] disabled:border disabled:border-[var(--k-border-hairline)]"
              >
                Сохранить в Kapsula
              </button>
            </div>
          ) : undefined
        }
      >
        <div data-testid="quick-capture-sheet" className="p-3.5 space-y-3">
          {/* 5-column flagship mode selector: ALL 5 modes fit on 360px Fold with zero clipping */}
          <div className="grid grid-cols-5 gap-1.5">
            {captureTabs.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`capture-tab-${item.id}`}
                  onClick={() => handleSelectTab(item.id)}
                  className={`k-tap relative flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-2xl border text-[11px] font-semibold min-w-0 transition-colors ${
                    active
                      ? 'border-[var(--k-border-focus)] text-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  {active ? (
                    <motion.span
                      layoutId="k-capture-mode-pill"
                      transition={
                        prefersReduced
                          ? { duration: 0.01 }
                          : { type: 'spring', stiffness: 480, damping: 35 }
                      }
                      className="absolute inset-0 rounded-2xl bg-[var(--k-accent-soft)]"
                    />
                  ) : null}
                  <Icon
                    weight={active ? 'duotone' : 'regular'}
                    className="relative z-10 w-[18px] h-[18px] shrink-0"
                  />
                  <span className="relative z-10 whitespace-nowrap leading-none">{item.label}</span>
                </button>
              );
            })}

            <button
              type="button"
              data-testid="capture-tab-secret"
              onClick={() => {
                mobileBridge.haptic('light');
                onClose();
                onOpenVaultAdd();
              }}
              className="k-tap flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-2xl border bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] text-[11px] font-semibold min-w-0"
            >
              <ShieldCheck
                weight="duotone"
                className="w-[18px] h-[18px] text-[var(--k-emerald)] shrink-0"
              />
              <span className="whitespace-nowrap leading-none">Сейф</span>
            </button>
          </div>

          {/* Branded Picker Chips for Section & Canvas (NO ugly native <select>!) */}
          <div className="grid grid-cols-2 gap-2">
            <PickerTriggerChip
              testId="capture-orbit-picker"
              colorDot={selectedOrbit?.color}
              icon={
                <FolderSimple
                  className="w-4 h-4 shrink-0"
                  style={{ color: selectedOrbit?.color || 'var(--k-accent)' }}
                />
              }
              label={selectedOrbit?.name || 'Без раздела'}
              placeholder={!selectedOrbit}
              onClick={() => setOrbitPickerOpen(true)}
            />
            <PickerTriggerChip
              testId="capture-board-picker"
              colorDot={selectedBoard?.color}
              icon={
                <Swatches
                  className="w-4 h-4 shrink-0"
                  style={{ color: selectedBoard?.color || 'var(--k-emerald)' }}
                />
              }
              label={selectedBoard?.name || 'Без холста'}
              placeholder={!selectedBoard}
              onClick={() => setBoardPickerOpen(true)}
            />
          </div>

          {tab === 'text' ? (
            <form
              id="k-quick-capture-text-form"
              onSubmit={(e) => void handleSaveThought(e)}
              className="space-y-2.5"
            >
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Заголовок (необязательно)"
                className="w-full h-10 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
              />
              <textarea
                ref={textAreaRef}
                rows={3}
                data-testid="capture-text-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Запиши мысль, идею, задачу «- [ ] …» или вставь ссылку…"
                className="w-full p-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14.5px] leading-relaxed text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] resize-none"
              />
            </form>
          ) : null}

          {tab === 'voice' ? (
            <div className="rounded-3xl p-5 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-center space-y-4">
              <div className="h-14 flex items-end justify-center gap-1 px-4">
                {levels.map((lvl, idx) => (
                  <span
                    key={idx}
                    style={{ transform: `scaleY(${Math.max(0.12, lvl).toFixed(3)})` }}
                    className={`w-1.5 h-full origin-bottom rounded-full transition-[transform,background-color] duration-100 ${
                      recording ? 'bg-[var(--k-accent)]' : 'bg-[var(--k-border-strong)]'
                    }`}
                  />
                ))}
              </div>

              <div className="k-mono text-[22px] font-semibold text-[var(--k-ink-primary)]">
                {formatDurationMmSs(recordSec)}
              </div>

              {recording ? (
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      void mobileBridge.cancelVoiceRecording();
                      setRecording(false);
                      setRecordSec(0);
                    }}
                    className="k-tap inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] text-[var(--k-danger)]"
                    aria-label="Отменить запись"
                  >
                    <Trash className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleStopVoice()}
                    className="k-tap inline-flex items-center gap-2 px-6 h-12 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold"
                  >
                    <Stop weight="fill" className="w-4 h-4" />
                    Сохранить запись
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleStartVoice()}
                  className="k-tap inline-flex items-center gap-2 px-6 h-12 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14.5px] font-semibold"
                >
                  <Microphone weight="fill" className="w-5 h-5" />
                  Начать запись голоса
                </button>
              )}
            </div>
          ) : null}

          {tab === 'photo' ? (
            <div className="space-y-3">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Подпись к фото (необязательно)"
                className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    const file = await mobileBridge.capturePhoto();
                    if (file) await persistPickedFiles([file], 'shot');
                  }}
                  className="k-tap flex flex-col items-center justify-center gap-2 py-6 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] font-semibold text-[14px]"
                >
                  <Camera weight="duotone" className="w-7 h-7" />
                  <span>Камера</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    const res = await mobileBridge.pickFileWithMeta('image/*', true);
                    await persistPickedFiles(res.files, 'shot', res.truncated);
                  }}
                  className="k-tap flex flex-col items-center justify-center gap-2 py-6 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-strong)] text-[var(--k-ink-primary)] font-semibold text-[14px]"
                >
                  <ImageIcon weight="duotone" className="w-7 h-7 text-[var(--k-accent)]" />
                  <span>Галерея</span>
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'file' ? (
            <div className="space-y-3">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Название или комментарий к файлу"
                className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
              />
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  const res = await mobileBridge.pickFileWithMeta('*/*', true);
                  await persistPickedFiles(res.files, 'doc', res.truncated);
                }}
                className="k-tap w-full flex flex-col items-center justify-center gap-2 py-7 rounded-2xl bg-[var(--k-bg-surface-2)] border border-dashed border-[var(--k-border-strong)] text-[var(--k-ink-primary)] font-semibold text-[14px]"
              >
                <Paperclip weight="duotone" className="w-7 h-7 text-[var(--k-accent)]" />
                <span>Выбрать документ или файл на телефоне</span>
                <span className="text-[12px] font-normal text-[var(--k-ink-muted)]">
                  PDF, фото, аудио, видео — зашифруется и уйдёт в облако
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </BottomSheet>

      <MobilePickerSheet
        open={orbitPickerOpen}
        title="Выбрать раздел"
        value={orbit}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateOrbit)}
        createPlaceholder="Название раздела…"
        onCreateNew={onCreateOrbit}
        options={[
          { value: '', label: 'Без раздела' },
          ...orbits.map((o) => ({
            value: o.id,
            label: o.name,
            color: o.color,
            count: o.itemCount,
          })),
        ]}
        onSelect={setOrbit}
        onClose={() => setOrbitPickerOpen(false)}
      />

      <MobilePickerSheet
        open={boardPickerOpen}
        title="Выбрать холст"
        value={boardId}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateBoard)}
        createPlaceholder="Название холста…"
        onCreateNew={onCreateBoard}
        options={[
          { value: '', label: 'Без холста' },
          ...boards.map((b) => ({
            value: b.id,
            label: b.name,
            color: b.color,
            count: b.itemCount,
          })),
        ]}
        onSelect={setBoardId}
        onClose={() => setBoardPickerOpen(false)}
      />
    </>
  );
};
