import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { FolderSimple, Globe, Paperclip, ShareNetwork, Swatches, WarningCircle } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { FocusBoard, OrbitDef } from '@shared/types';
import { extractFirstUrlFromText } from '../lib/mobile-helpers';
import { useMobileI18n } from '../lib/mobile-i18n';
import { mobileBridge, type SharedIntentPayload } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';

interface ShareTargetSheetProps {
  share: SharedIntentPayload | null;
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  isCloudConnected: boolean;
  orbits: OrbitDef[];
  boards: FocusBoard[];
  onClose: () => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
  onCreateBoard?: (name: string, color: string) => Promise<string>;
  onConfirmSave: (data: {
    share: SharedIntentPayload;
    title: string;
    body: string;
    url: string | null;
    orbit: string;
    focusBoardId: string | null;
  }) => Promise<void>;
}

export const ShareTargetSheet: React.FC<ShareTargetSheetProps> = ({
  share,
  isExpanded,
  hingeRightOffsetPx = 0,
  isCloudConnected,
  orbits,
  boards,
  onClose,
  onCreateOrbit,
  onCreateBoard,
  onConfirmSave,
}) => {
  const { t, formatFileSize } = useMobileI18n();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [orbit, setOrbit] = useState('');
  const [boardId, setBoardId] = useState('');
  const [saving, setSaving] = useState(false);
  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const warnedShareIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!share) return;
    if ((share.truncatedCount ?? 0) > 0 && warnedShareIdRef.current !== share.id) {
      warnedShareIdRef.current = share.id;
      toast.warning(t('share.truncatedFiles', { count: share.truncatedCount ?? 0 }));
    }
    const rawText = (share.text || '').trim();
    const detectedUrl = share.url || extractFirstUrlFromText(rawText);
    const cleanedBody = rawText;
    const fallbackTitle =
      share.subject?.trim() ||
      (share.files?.[0]?.name ?? '') ||
      (detectedUrl
        ? (() => {
            try {
              return new URL(detectedUrl).hostname.replace(/^www\./i, '');
            } catch {
              return t('share.linkFallbackTitle');
            }
          })()
        : cleanedBody.split('\n')[0]?.slice(0, 80) || t('share.bodyFallbackTitle'));

    setTitle(fallbackTitle);
    setBody(cleanedBody);
    setUrl(detectedUrl);
    setOrbit('');
    setBoardId('');
  }, [share, t]);

  const selectedOrbit = useMemo(() => orbits.find((o) => o.id === orbit) ?? null, [orbits, orbit]);
  const selectedBoard = useMemo(
    () => boards.find((b) => b.id === boardId) ?? null,
    [boards, boardId]
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!share || saving) return;
    setSaving(true);
    try {
      await onConfirmSave({
        share,
        title: title.trim() || t('capture.savedToast'),
        body: body.trim(),
        url,
        orbit,
        focusBoardId: boardId || null,
      });
      mobileBridge.haptic('success');
      toast.success(isCloudConnected ? t('share.savedCloud') : t('share.savedLocal'));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const files = share?.files ?? [];

  return (
    <>
      <BottomSheet
        open={Boolean(share)}
        title={t('capture.saveToKapsula')}
        subtitle={t('share.subtitle')}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={onClose}
      >
        <form
          data-testid="share-target-sheet"
          onSubmit={(e) => void handleSave(e)}
          className="p-4 space-y-3.5"
        >
          {(share?.truncatedCount ?? 0) > 0 ? (
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl bg-[var(--k-danger-soft)] border border-[var(--k-danger)]/30 text-[12px] text-[var(--k-danger)]">
              <WarningCircle className="w-4 h-4 shrink-0" />
              <span>{t('share.truncatedFiles', { count: share?.truncatedCount ?? 0 })}</span>
            </div>
          ) : null}

          {url ? (
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl bg-[var(--k-accent-soft)] border border-[var(--k-border-focus)]">
              <Globe className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
              <span className="text-[12.5px] text-[var(--k-ink-primary)] truncate">{url}</span>
            </div>
          ) : null}

          {files.length > 0 ? (
            <div className="space-y-2">
              {files.map((f, idx) => (
                <div
                  key={`${f.name}-${idx}`}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]"
                >
                  {f.mime.startsWith('image/') && (f.stagedPath || f.base64) ? (
                    <img
                      src={
                        f.stagedPath
                          ? Capacitor.convertFileSrc(f.stagedPath)
                          : `data:${f.mime};base64,${f.base64 ?? ''}`
                      }
                      alt={f.name}
                      className="w-11 h-11 rounded-xl object-cover shrink-0"
                    />
                  ) : (
                    <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--k-bg-surface-1)] shrink-0">
                      <Paperclip className="w-5 h-5 text-[var(--k-accent)]" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                      {f.name}
                    </div>
                    <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                      {formatFileSize(f.size)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('share.titlePlaceholder')}
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] font-medium text-[var(--k-ink-primary)]"
          />

          <textarea
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('share.bodyPlaceholder')}
            className="w-full p-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)] resize-none"
          />

          <div className="grid grid-cols-2 gap-2">
            <PickerTriggerChip
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

          <button
            type="submit"
            data-testid="share-target-confirm"
            disabled={saving}
            className="k-tap w-full h-12 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14.5px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <ShareNetwork weight="bold" className="w-4 h-4" />
            {t('capture.saveToKapsula')}
          </button>
        </form>
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
