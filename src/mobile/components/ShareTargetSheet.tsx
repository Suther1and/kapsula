import React, { useEffect, useMemo, useState } from 'react';
import { FolderSimple, Globe, Paperclip, ShareNetwork, Swatches } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { FocusBoard, OrbitDef } from '@shared/types';
import { formatFileSize } from '@renderer/lib/format';
import { extractFirstUrlFromText } from '../lib/mobile-helpers';
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
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [orbit, setOrbit] = useState('');
  const [boardId, setBoardId] = useState('');
  const [saving, setSaving] = useState(false);
  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);

  useEffect(() => {
    if (!share) return;
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
              return 'Ссылка из другого приложения';
            }
          })()
        : cleanedBody.split('\n')[0]?.slice(0, 80) || 'Сохранено через «Поделиться»');

    setTitle(fallbackTitle);
    setBody(cleanedBody);
    setUrl(detectedUrl);
    setOrbit('');
    setBoardId('');
  }, [share]);

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
        title: title.trim() || 'Сохранено в Kapsula',
        body: body.trim(),
        url,
        orbit,
        focusBoardId: boardId || null,
      });
      mobileBridge.haptic('success');
      toast.success(
        isCloudConnected
          ? 'Сохранено в Kapsula и отправлено в облако'
          : 'Сохранено в Kapsula на устройстве'
      );
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
        title="Сохранить в Kapsula"
        subtitle="Получено через системное меню «Поделиться»"
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={onClose}
      >
        <form
          data-testid="share-target-sheet"
          onSubmit={(e) => void handleSave(e)}
          className="p-4 space-y-3.5"
        >
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
                  {f.mime.startsWith('image/') ? (
                    <img
                      src={`data:${f.mime};base64,${f.base64}`}
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
            placeholder="Заголовок"
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] font-medium text-[var(--k-ink-primary)]"
          />

          <textarea
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Текст или комментарий…"
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
              label={selectedOrbit?.name || 'Без раздела'}
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
              label={selectedBoard?.name || 'Без холста'}
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
            Сохранить в Kapsula
          </button>
        </form>
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
