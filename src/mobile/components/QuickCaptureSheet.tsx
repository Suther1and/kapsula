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
import { useMobileI18n } from '../lib/mobile-i18n';
import { mobileBridge, type PickedFilePayload } from '../native/bridge';
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
  const { t } = useMobileI18n();
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
      toast.success(t('capture.savedToast'));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleStartVoice = async () => {
    const res = await mobileBridge.startVoiceRecording();
    if (!res.ok) {
      toast.error(res.error || t('capture.micError'));
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
      if (!res.ok || (!res.base64 && !res.stagedPath)) {
        toast.error(res.error || t('capture.voiceSaveError'));
        return;
      }
      const bytes = await mobileBridge.readNativeFileBytes(res);
      const mime = res.mime || 'audio/mp4';
      const fileName = makeSafeUploadName('voice', 'voice', mime);
      await onSaveMedia({
        kind: 'voice',
        title:
          title.trim() ||
          t('capture.voiceTitleWithDuration', {
            duration: formatDurationMmSs(res.durationSec || recordSec),
          }),
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
      toast.success(t('capture.voiceSavedToast'));
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
      toast.warning(t('capture.filesSkippedLimit'));
    }
    if (files.length === 0) return;
    setSaving(true);
    try {
      for (const file of files) {
        const bytes = await mobileBridge.readNativeFileBytes(file);
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
      toast.success(
        files.length > 1
          ? t('capture.filesSavedCount', { count: files.length })
          : t('capture.fileSavedToast')
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const captureTabs = [
    { id: 'text' as const, label: t('capture.tabText'), icon: NotePencil },
    { id: 'voice' as const, label: t('capture.tabVoice'), icon: Microphone },
    { id: 'photo' as const, label: t('capture.tabPhoto'), icon: Camera },
    { id: 'file' as const, label: t('capture.tabFile'), icon: Paperclip },
  ];

  return (
    <>
      <BottomSheet
        open={open}
        title={t('capture.title')}
        subtitle={t('capture.subtitle')}
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
                {t('capture.saveToKapsula')}
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
              <span className="whitespace-nowrap leading-none">{t('nav.vault')}</span>
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
              label={selectedOrbit?.name || t('common.noOrbit')}
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
              label={selectedBoard?.name || t('common.noBoard')}
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
                placeholder={t('capture.titleOptional')}
                className="w-full h-10 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
              />
              <textarea
                ref={textAreaRef}
                rows={3}
                data-testid="capture-text-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('capture.bodyPlaceholder')}
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
                    aria-label={t('capture.cancelRecordAria')}
                  >
                    <Trash className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleStopVoice()}
                    className="k-tap inline-flex items-center gap-2 px-6 h-12 rounded-full bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold"
                  >
                    <Stop weight="fill" className="w-4 h-4" />
                    {t('capture.saveRecord')}
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
                  {t('capture.startVoice')}
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
                placeholder={t('capture.photoCaptionPlaceholder')}
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
                  <span>{t('common.camera')}</span>
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
                  <span>{t('common.gallery')}</span>
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
                placeholder={t('capture.fileCommentPlaceholder')}
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
                <span>{t('capture.pickFile')}</span>
                <span className="text-[12px] font-normal text-[var(--k-ink-muted)]">
                  {t('capture.pickFileHint')}
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </BottomSheet>

      <MobilePickerSheet
        open={orbitPickerOpen}
        title={t('common.pickOrbit')}
        value={orbit}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateOrbit)}
        createPlaceholder={t('common.orbitNamePlaceholder')}
        onCreateNew={onCreateOrbit}
        options={[
          { value: '', label: t('common.noOrbit') },
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
        title={t('common.pickBoard')}
        value={boardId}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateBoard)}
        createPlaceholder={t('common.boardNamePlaceholder')}
        onCreateNew={onCreateBoard}
        options={[
          { value: '', label: t('common.noBoard') },
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
