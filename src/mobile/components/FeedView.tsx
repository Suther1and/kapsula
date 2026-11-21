import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowSquareOut,
  ArrowsDownUp,
  Check,
  CheckSquareOffset,
  Copy,
  DotsThree,
  FileText,
  FolderSimple,
  Globe,
  Image as ImageIcon,
  LinkSimple,
  Microphone,
  NotePencil,
  Paperclip,
  Plus,
  PushPin,
  Swatches,
  Trash,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import type { ContentDna, FocusBoard, OrbitDef, VaultItem } from '@shared/types';
import {
  formatDateCompact,
  formatFileSize,
  formatRelativeDate,
  getDnaHumanLabel,
  stripLeadingTitle,
} from '@renderer/lib/format';
import {
  filterItemsByQuery,
  isMediaItem,
  pluralRu,
  stripMobileInlineMarkdown,
} from '../lib/mobile-helpers';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { ItemActionSheet, type ActionSheetEntry } from './ItemActionSheet';
import { MobileAudioPlayer } from './MobileAudioPlayer';
import { MobileMediaImage } from './MobileMediaImage';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';
import { SwipeableRow } from './SwipeableRow';

interface FeedViewProps {
  items: VaultItem[];
  orbits: OrbitDef[];
  boards: FocusBoard[];
  isExpanded: boolean;
  hingeListWidthPx?: number | null;
  hingeRightOffsetPx?: number;
  searchQuery: string;
  selectedOrbitId: string | null;
  selectedBoardId: string | null;
  selectedItemId: string | null;
  onSelectOrbit: (id: string | null) => void;
  onSelectBoard: (id: string | null) => void;
  onSelectItem: (id: string | null) => void;
  onOpenInNotes: (itemId: string) => void;
  onOpenImage: (src: string, caption?: string) => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
  onCreateBoard?: (name: string, color: string) => Promise<string>;
  onUpdateItem: (
    id: string,
    patch: Partial<Pick<VaultItem, 'orbit' | 'focusBoardId' | 'isPinned' | 'title' | 'body'>>
  ) => Promise<void>;
  onToggleMarkdownTask?: (itemId: string, taskIndex: number, done: boolean) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
  onBulkDeleteItems?: (ids: string[]) => Promise<void>;
  onTranscribeVoice?: (item: VaultItem) => Promise<void>;
  onExtractTasks?: (item: VaultItem) => Promise<void>;
  onQuickCapture?: () => void;
  ensureMediaUrl: (localName?: string | null) => Promise<string | null>;
}

type FeedMode = 'feed' | 'media';
type DnaFilter = 'all' | 'link' | 'note' | 'shot' | 'voice' | 'doc';
type FeedSort = 'pinned_recent' | 'recent' | 'orbit';

const DNA_CHIPS: Array<{ id: DnaFilter; label: string }> = [
  { id: 'all', label: 'Всё' },
  { id: 'link', label: 'Ссылки' },
  { id: 'note', label: 'Заметки' },
  { id: 'shot', label: 'Фото' },
  { id: 'voice', label: 'Голос' },
  { id: 'doc', label: 'Файлы' },
];

const SORT_LABELS: Record<FeedSort, string> = {
  pinned_recent: 'Сначала закреплённые',
  recent: 'Сначала новые',
  orbit: 'По разделам',
};

const FEED_TASK_RE = /^\s*[-*•]\s+(?:\\\[|\[)([ xX])(?:\\\]|\])\s+(.+)$/;
const FEED_FENCE_RE = /^\s*(```|~~~)/;

type ReadableBodyLine =
  | { kind: 'blank' }
  | { kind: 'text'; text: string }
  | { kind: 'task'; taskIndex: number; done: boolean; text: string };

function cleanReadableFragment(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/, '');
}

function parseReadableBodyLines(raw: string): ReadableBodyLine[] {
  const lines = (raw || '').split(/\r?\n/);
  const out: ReadableBodyLine[] = [];
  let activeFence: string | null = null;
  let taskIndex = 0;

  for (const line of lines) {
    const fenceMatch = FEED_FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!activeFence) activeFence = marker;
      else if (activeFence === marker) activeFence = null;
      continue;
    }

    if (!activeFence) {
      const taskMatch = FEED_TASK_RE.exec(line);
      if (taskMatch) {
        const rawText = (taskMatch[2] ?? '').trim();
        if (rawText) {
          out.push({
            kind: 'task',
            taskIndex,
            done: (taskMatch[1] ?? '').toLowerCase() === 'x',
            text: cleanReadableFragment(rawText).trim(),
          });
          taskIndex += 1;
          continue;
        }
      }
    }

    const cleaned = cleanReadableFragment(line);
    if (!cleaned.trim()) {
      if (out.length > 0 && out[out.length - 1]?.kind !== 'blank') {
        out.push({ kind: 'blank' });
      }
    } else {
      out.push({ kind: 'text', text: cleaned });
    }
  }

  while (out.length > 0 && out[out.length - 1]?.kind === 'blank') {
    out.pop();
  }
  return out;
}

export const FeedView: React.FC<FeedViewProps> = ({
  items,
  orbits,
  boards,
  isExpanded,
  hingeListWidthPx,
  hingeRightOffsetPx = 0,
  searchQuery,
  selectedOrbitId,
  selectedBoardId,
  selectedItemId,
  onSelectOrbit,
  onSelectBoard,
  onSelectItem,
  onOpenInNotes,
  onOpenImage,
  onCreateOrbit,
  onCreateBoard,
  onUpdateItem,
  onToggleMarkdownTask,
  onDeleteItem,
  onBulkDeleteItems,
  onTranscribeVoice,
  onExtractTasks,
  onQuickCapture,
  ensureMediaUrl,
}) => {
  const prefersReduced = useReducedMotion();
  const [feedMode, setFeedMode] = useState<FeedMode>('feed');
  const [dnaFilter, setDnaFilter] = useState<DnaFilter>('all');
  const [sortMode, setSortMode] = useState<FeedSort>('pinned_recent');
  const [sortPickerOpen, setSortPickerOpen] = useState(false);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  const runTranscribeVoice = async (item: VaultItem) => {
    if (!onTranscribeVoice || transcribingId) return;
    setTranscribingId(item.id);
    try {
      await onTranscribeVoice(item);
    } finally {
      setTranscribingId((cur) => (cur === item.id ? null : cur));
    }
  };

  const runExtractTasks = async (item: VaultItem) => {
    if (!onExtractTasks || extractingId) return;
    setExtractingId(item.id);
    try {
      await onExtractTasks(item);
    } finally {
      setExtractingId((cur) => (cur === item.id ? null : cur));
    }
  };

  // Action sheet & picker state
  const [actionItem, setActionItem] = useState<VaultItem | null>(null);
  const [orbitPickerTarget, setOrbitPickerTarget] = useState<{
    mode: 'single' | 'bulk';
    itemId?: string;
    currentValue: string;
  } | null>(null);
  const [boardPickerTarget, setBoardPickerTarget] = useState<{
    itemId: string;
    currentValue: string;
  } | null>(null);

  // Multi-select bulk mode
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedBulkIds, setSelectedBulkIds] = useState<Set<string>>(new Set());

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);
  const boardMap = useMemo(() => new Map(boards.map((b) => [b.id, b])), [boards]);
  const nonSecretItems = useMemo(() => items.filter((it) => it.dna !== 'secret'), [items]);

  const filteredItems = useMemo(() => {
    let list = nonSecretItems;
    if (feedMode === 'media') {
      list = list.filter(isMediaItem);
    }
    if (selectedOrbitId) {
      list = list.filter((it) => it.orbit === selectedOrbitId);
    }
    if (selectedBoardId) {
      list = list.filter((it) => it.focusBoardId === selectedBoardId);
    }
    if (dnaFilter !== 'all') {
      list = list.filter((it) => it.dna === (dnaFilter as ContentDna));
    }
    const queried = filterItemsByQuery(list, searchQuery);
    if (sortMode === 'recent') {
      return [...queried].sort(
        (a, b) => (b.contentUpdatedAt || b.updatedAt) - (a.contentUpdatedAt || a.updatedAt)
      );
    }
    if (sortMode === 'orbit') {
      return [...queried].sort((a, b) => {
        const oa = (a.orbit ? orbitMap.get(a.orbit)?.name : '') || 'яяя';
        const ob = (b.orbit ? orbitMap.get(b.orbit)?.name : '') || 'яяя';
        const cmp = oa.localeCompare(ob, 'ru');
        if (cmp !== 0) return cmp;
        return (b.contentUpdatedAt || b.updatedAt) - (a.contentUpdatedAt || a.updatedAt);
      });
    }
    return queried;
  }, [
    nonSecretItems,
    feedMode,
    selectedOrbitId,
    selectedBoardId,
    dnaFilter,
    searchQuery,
    sortMode,
    orbitMap,
  ]);

  const selectedItem = useMemo(() => {
    if (!selectedItemId) return null;
    return filteredItems.find((i) => i.id === selectedItemId) ?? null;
  }, [filteredItems, selectedItemId]);

  const toggleBulkSelection = (id: string) => {
    setSelectedBulkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitMultiSelect = () => {
    setMultiSelectMode(false);
    setSelectedBulkIds(new Set());
  };

  const buildItemActions = (item: VaultItem): ActionSheetEntry[] => [
    {
      id: 'pin',
      label: item.isPinned ? 'Открепить' : 'Закрепить сверху',
      icon: <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-5 h-5" />,
      accent: item.isPinned,
      onSelect: () => {
        void onUpdateItem(item.id, { isPinned: !item.isPinned });
        toast(item.isPinned ? 'Откреплено' : 'Закреплено сверху');
      },
    },
    {
      id: 'edit',
      label: 'Открыть в редакторе',
      icon: <NotePencil className="w-5 h-5" />,
      onSelect: () => onOpenInNotes(item.id),
    },
    {
      id: 'orbit',
      label: 'Перенести в раздел',
      subtitle: item.orbit ? orbitMap.get(item.orbit)?.name : 'Без раздела',
      icon: <FolderSimple className="w-5 h-5" />,
      onSelect: () =>
        setOrbitPickerTarget({ mode: 'single', itemId: item.id, currentValue: item.orbit || '' }),
    },
    {
      id: 'board',
      label: 'Перенести на холст',
      subtitle: item.focusBoardId ? boardMap.get(item.focusBoardId)?.name : 'Без холста',
      icon: <Swatches className="w-5 h-5" />,
      onSelect: () =>
        setBoardPickerTarget({ itemId: item.id, currentValue: item.focusBoardId || '' }),
    },
    {
      id: 'copy',
      label: item.url ? 'Скопировать ссылку' : 'Скопировать текст',
      icon: <Copy className="w-5 h-5" />,
      onSelect: () => {
        const txt = item.url || [item.title, item.body].filter(Boolean).join('\n\n');
        void mobileBridge.copyPlain(txt);
        toast.success('Скопировано');
      },
    },
    {
      id: 'multiselect',
      label: 'Выбрать несколько',
      icon: <CheckSquareOffset className="w-5 h-5" />,
      onSelect: () => {
        setMultiSelectMode(true);
        setSelectedBulkIds(new Set([item.id]));
      },
    },
    {
      id: 'delete',
      label: 'Удалить запись',
      icon: <Trash className="w-5 h-5" />,
      danger: true,
      onSelect: () => {
        if (selectedItemId === item.id) onSelectItem(null);
        void onDeleteItem(item.id);
      },
    },
  ];

  const renderDetailContent = (item: VaultItem) => {
    const orbit = item.orbit ? orbitMap.get(item.orbit) : null;
    const board = item.focusBoardId ? boardMap.get(item.focusBoardId) : null;
    const readableLines = parseReadableBodyLines(item.body || '');
    const inlineImages = extractInlineMediaFilenames(item.body || '').filter(
      (f) => f !== item.imagePath && f !== item.thumbPath
    );
    const hasVoiceTranscript = Boolean(
      (item.mediaMeta?.transcript || '').trim() || readableLines.length > 0
    );

    return (
      <div className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              {isExpanded ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-lg bg-[var(--k-bg-surface-2)] text-[11px] font-medium text-[var(--k-ink-secondary)]">
                  {getDnaHumanLabel(item)}
                </span>
              ) : null}
              {orbit ? (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-medium text-[var(--k-ink-primary)]"
                  style={{
                    background: `color-mix(in srgb, ${orbit.color} 13%, transparent)`,
                    borderColor: `color-mix(in srgb, ${orbit.color} 28%, transparent)`,
                  }}
                >
                  <FolderSimple weight="fill" className="w-3 h-3 shrink-0" style={{ color: orbit.color }} />
                  {orbit.name}
                </span>
              ) : null}
              <span className="text-[11.5px] text-[var(--k-ink-muted)]">
                {formatRelativeDate(item.contentUpdatedAt || item.updatedAt)}
              </span>
            </div>
            <h3 className="text-[18px] font-bold leading-snug text-[var(--k-ink-primary)] k-selectable">
              {item.title || 'Без названия'}
            </h3>
          </div>

          {isExpanded ? (
            <button
              type="button"
              onClick={() => onSelectItem(null)}
              aria-label="Закрыть панель"
              className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          ) : null}
        </div>

        <MobileMediaImage
          localName={item.imagePath || item.thumbPath}
          fallbackUrl={item.ogImageUrl}
          ensureMediaUrl={ensureMediaUrl}
          alt={item.title || 'Изображение'}
          onImageClick={(src) => onOpenImage(src, item.title || undefined)}
          wrapperClassName="rounded-2xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]"
          className="w-full max-h-72 object-cover block"
        />

        {item.dna === 'voice' || item.mediaType?.startsWith('audio/') ? (
          <MobileAudioPlayer
            mediaPath={item.mediaPath}
            ensureMediaUrl={ensureMediaUrl}
            durationSec={item.mediaDurationSec}
            peaks={item.mediaMeta?.waveformPeaks}
            hasTranscript={hasVoiceTranscript}
            transcribing={transcribingId === item.id}
            extractingTasks={extractingId === item.id}
            onTranscribe={onTranscribeVoice ? () => void runTranscribeVoice(item) : undefined}
            onExtractTasks={
              onExtractTasks && hasVoiceTranscript
                ? () => void runExtractTasks(item)
                : undefined
            }
          />
        ) : null}

        {inlineImages.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {inlineImages.slice(0, 6).map((file) => (
              <MobileMediaImage
                key={file}
                localName={file}
                ensureMediaUrl={ensureMediaUrl}
                alt={item.title || 'Фото в заметке'}
                onImageClick={(src) => onOpenImage(src, item.title || undefined)}
                wrapperClassName="rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] aspect-[4/3]"
                className="w-full h-full object-cover block"
              />
            ))}
          </div>
        ) : null}

        {item.url ? (
          <button
            type="button"
            onClick={() => void mobileBridge.openExternalUrl(item.url!)}
            className="k-tap w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-left"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Globe className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                  {item.domain || 'Открыть ссылку'}
                </div>
                <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">{item.url}</div>
              </div>
            </div>
            <ArrowSquareOut className="w-4 h-4 text-[var(--k-ink-secondary)] shrink-0" />
          </button>
        ) : null}

        {readableLines.length > 0 ? (
          <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] p-3.5 text-[14px] leading-relaxed text-[var(--k-ink-primary)] space-y-1.5 k-selectable">
            {readableLines.map((entry, idx) => {
              if (entry.kind === 'blank') return <div key={idx} className="h-1.5" />;
              if (entry.kind === 'task') {
                return (
                  <div key={idx} className="flex items-start gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={entry.done}
                      aria-label={entry.text}
                      onClick={(e) => {
                        e.stopPropagation();
                        mobileBridge.haptic(entry.done ? 'light' : 'success');
                        void onToggleMarkdownTask?.(item.id, entry.taskIndex, !entry.done);
                      }}
                      className={`mt-[3px] w-4 h-4 rounded-[5px] border inline-flex items-center justify-center shrink-0 transition-[background-color,border-color] duration-[80ms] ease-out cursor-pointer ${
                        entry.done
                          ? 'bg-[var(--k-emerald)] border-[var(--k-emerald)] text-white'
                          : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)]'
                      }`}
                    >
                      {entry.done ? <Check weight="bold" className="w-2.5 h-2.5" /> : null}
                    </button>
                    <span className={entry.done ? 'line-through text-[var(--k-ink-muted)]' : ''}>
                      {entry.text}
                    </span>
                  </div>
                );
              }
              return (
                <p key={idx} className="whitespace-pre-wrap">
                  {entry.text}
                </p>
              );
            })}
          </div>
        ) : item.summary?.trim() ? (
          <p className="text-[14px] leading-relaxed text-[var(--k-ink-secondary)] k-selectable">
            {item.summary.trim()}
          </p>
        ) : null}

        {item.mediaMeta?.fileName ? (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
            <Paperclip className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                {item.mediaMeta.fileName}
              </div>
              {item.mediaMeta.fileSize ? (
                <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                  {formatFileSize(item.mediaMeta.fileSize)}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Branded Picker Chips (NO ugly native <select>!) */}
        <div className="flex flex-wrap items-center gap-2">
          <PickerTriggerChip
            colorDot={orbit?.color}
            icon={
              <FolderSimple
                className="w-4 h-4 shrink-0"
                style={{ color: orbit?.color || 'var(--k-accent)' }}
              />
            }
            label={orbit?.name || 'Без раздела'}
            placeholder={!orbit}
            className="flex-auto min-w-0"
            onClick={() =>
              setOrbitPickerTarget({ mode: 'single', itemId: item.id, currentValue: item.orbit || '' })
            }
          />
          <PickerTriggerChip
            colorDot={board?.color}
            icon={
              <Swatches
                className="w-4 h-4 shrink-0"
                style={{ color: board?.color || 'var(--k-emerald)' }}
              />
            }
            label={board?.name || 'Без холста'}
            placeholder={!board}
            className="flex-auto min-w-0"
            onClick={() =>
              setBoardPickerTarget({ itemId: item.id, currentValue: item.focusBoardId || '' })
            }
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onOpenInNotes(item.id)}
            className="k-tap flex-1 inline-flex items-center justify-center gap-2 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13.5px] font-semibold"
          >
            <NotePencil className="w-4 h-4" />
            Открыть в редакторе
          </button>

          <button
            type="button"
            onClick={() => void onUpdateItem(item.id, { isPinned: !item.isPinned })}
            aria-label={item.isPinned ? 'Открепить' : 'Закрепить'}
            className={`k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl border ${
              item.isPinned
                ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
            }`}
          >
            <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              onSelectItem(null);
              void onDeleteItem(item.id);
            }}
            aria-label="Удалить"
            className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-danger)]"
          >
            <Trash className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const renderCard = (item: VaultItem) => {
    const orbit = item.orbit ? orbitMap.get(item.orbit) : null;
    const isSelected = selectedItemId === item.id;
    const isBulkChecked = selectedBulkIds.has(item.id);
    const hasVisual = Boolean(item.thumbPath || item.imagePath || item.ogImageUrl);
    const displayTitle =
      (item.title || '').trim() ||
      (item.body || '').trim().split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 80) ||
      'Без названия';
    const preview = stripLeadingTitle(
      stripMobileInlineMarkdown(item.body || item.summary || ''),
      displayTitle
    );
    const hasVoiceTranscript = Boolean(
      (item.mediaMeta?.transcript || '').trim() || preview.trim()
    );

    const DnaIcon =
      item.dna === 'link'
        ? LinkSimple
        : item.dna === 'shot'
          ? ImageIcon
          : item.dna === 'voice'
            ? Microphone
            : item.dna === 'doc'
              ? Paperclip
              : FileText;

    return (
      <SwipeableRow
        key={item.id}
        disabled={multiSelectMode}
        onLongPress={() => setActionItem(item)}
        leftAction={{
          label: item.isPinned ? 'Открепить' : 'Закрепить',
          icon: <PushPin weight="fill" className="w-4 h-4" />,
          bgClass: 'bg-[var(--k-accent)]',
          textClass: 'text-[var(--k-ink-on-accent)]',
          onTrigger: () => {
            void onUpdateItem(item.id, { isPinned: !item.isPinned });
            toast(item.isPinned ? 'Откреплено' : 'Закреплено сверху');
          },
        }}
        rightAction={{
          label: 'Удалить',
          icon: <Trash weight="fill" className="w-4 h-4" />,
          bgClass: 'bg-[var(--k-danger)]',
          onTrigger: () => {
            if (selectedItemId === item.id) onSelectItem(null);
            void onDeleteItem(item.id);
          },
        }}
      >
        <article
          data-testid={`feed-card-${item.id}`}
          onClick={() => {
            if (multiSelectMode) {
              toggleBulkSelection(item.id);
              return;
            }
            onSelectItem(item.id);
          }}
          className={`group rounded-2xl border overflow-hidden cursor-pointer transition-colors ${
            isBulkChecked
              ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)]'
              : isSelected && isExpanded
                ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-focus)] shadow-[var(--k-shadow-card-hover)]'
                : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] shadow-[var(--k-shadow-card)] hover:border-[var(--k-border-strong)]'
          }`}
        >
          {hasVisual ? (
            <MobileMediaImage
              localName={item.thumbPath || item.imagePath}
              fallbackUrl={item.ogImageUrl}
              ensureMediaUrl={ensureMediaUrl}
              alt={item.title || 'Вложение'}
              onImageClick={
                multiSelectMode
                  ? undefined
                  : (src) => onOpenImage(src, item.title || undefined)
              }
              wrapperClassName="relative w-full h-36 bg-[var(--k-bg-surface-2)] overflow-hidden"
              className="w-full h-full object-cover block"
            >
              {item.isPinned ? (
                <span className="absolute top-2 right-2 inline-flex items-center justify-center w-6 h-6 rounded-lg bg-black/55 text-[var(--k-accent)] backdrop-blur-sm">
                  <PushPin weight="fill" className="w-3.5 h-3.5" />
                </span>
              ) : null}
            </MobileMediaImage>
          ) : null}

          <div className="k-m-card space-y-2">
            <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--k-ink-muted)]">
              <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                {multiSelectMode ? (
                  <span
                    className={`inline-flex items-center justify-center w-4 h-4 rounded-md border shrink-0 ${
                      isBulkChecked
                        ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                        : 'border-[var(--k-border-strong)]'
                    }`}
                  >
                    {isBulkChecked ? <Check weight="bold" className="w-2.5 h-2.5" /> : null}
                  </span>
                ) : (
                  <DnaIcon
                    weight="duotone"
                    className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0"
                  />
                )}
                <span className="truncate">{item.domain || getDnaHumanLabel(item)}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 shrink-0">
                {item.isPinned && !hasVisual ? (
                  <PushPin weight="fill" className="w-3 h-3 text-[var(--k-accent)]" />
                ) : null}
                <span>{formatDateCompact(item.contentUpdatedAt || item.updatedAt)}</span>
                {!multiSelectMode ? (
                  <button
                    type="button"
                    data-testid={`feed-card-more-${item.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      mobileBridge.haptic('light');
                      setActionItem(item);
                    }}
                    aria-label="Действия с записью"
                    className="inline-flex items-center justify-center w-6 h-6 -mr-1 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]"
                  >
                    <DotsThree weight="bold" className="w-4 h-4" />
                  </button>
                ) : null}
              </span>
            </div>

            <h3 className="text-[14.5px] font-semibold leading-snug text-[var(--k-ink-primary)] line-clamp-2">
              {displayTitle}
            </h3>

            {/* Inline Voice Player right on the card! */}
            {item.dna === 'voice' || item.mediaType?.startsWith('audio/') ? (
              <div className="space-y-1.5">
                <MobileAudioPlayer
                  compact
                  mediaPath={item.mediaPath}
                  ensureMediaUrl={ensureMediaUrl}
                  durationSec={item.mediaDurationSec}
                  peaks={item.mediaMeta?.waveformPeaks}
                  hasTranscript={hasVoiceTranscript}
                  transcribing={transcribingId === item.id}
                  onTranscribe={
                    onTranscribeVoice ? () => void runTranscribeVoice(item) : undefined
                  }
                />
                {preview ? (
                  <p className="text-[12px] text-[var(--k-ink-secondary)] line-clamp-2">
                    {preview}
                  </p>
                ) : null}
              </div>
            ) : preview ? (
              <p className="text-[12.5px] leading-relaxed text-[var(--k-ink-secondary)] line-clamp-2">
                {preview}
              </p>
            ) : null}

            {orbit || item.tags.length > 0 ? (
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                {orbit ? (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[7px] border text-[10.5px] font-medium text-[var(--k-ink-primary)]"
                    style={{
                      background: `color-mix(in srgb, ${orbit.color} 13%, transparent)`,
                      borderColor: `color-mix(in srgb, ${orbit.color} 28%, transparent)`,
                    }}
                  >
                    <FolderSimple weight="fill" className="w-3 h-3 shrink-0" style={{ color: orbit.color }} />
                    {orbit.name}
                  </span>
                ) : null}
                {item.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full border border-[var(--k-border-hairline)] bg-transparent text-[10.5px] text-[var(--k-ink-muted)]"
                  >
                    <span className="opacity-65">#</span>
                    <span>{tag}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </article>
      </SwipeableRow>
    );
  };

  const masonryColumns = useMemo(() => {
    if (!isExpanded) return [filteredItems];
    const cols: [VaultItem[], VaultItem[]] = [[], []];
    const heights: [number, number] = [0, 0];
    for (const item of filteredItems) {
      const est =
        112 +
        (item.imagePath || item.thumbPath || item.ogImageUrl ? 175 : 0) +
        (item.dna === 'voice' || item.mediaType?.startsWith('audio/') ? 66 : 0) +
        Math.min(120, Math.round((item.body?.length || 0) * 0.42));
      const colIdx = heights[0] <= heights[1] ? 0 : 1;
      cols[colIdx].push(item);
      heights[colIdx] += est;
    }
    return cols;
  }, [filteredItems, isExpanded]);

  const useHingeSplit = Boolean(isExpanded && selectedItem && hingeListWidthPx && hingeListWidthPx >= 260);

  return (
    <div data-testid="mobile-feed-view" className="flex h-full min-h-0">
      <div
        style={useHingeSplit && hingeListWidthPx ? { width: hingeListWidthPx, flex: 'none' } : undefined}
        className={`${useHingeSplit ? '' : 'flex-1'} min-w-0 flex flex-col h-full min-h-0 relative`}
      >
        <div className="px-4 pt-2.5 pb-2 space-y-2 border-b border-[var(--k-border-hairline)] shrink-0">
          <div className="flex items-center justify-between gap-2">
            {/* Animated Segmented Toggle */}
            <div className="inline-flex p-0.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
              {(
                [
                  { id: 'feed', label: 'Лента', testId: 'feed-mode-all' },
                  { id: 'media', label: 'Медиа', testId: 'feed-mode-media' },
                ] as const
              ).map((m) => {
                const active = feedMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-testid={m.testId}
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setFeedMode(m.id);
                    }}
                    className={`relative px-3 py-1 rounded-[10px] text-[12.5px] font-medium transition-colors ${
                      active ? 'text-[var(--k-ink-primary)]' : 'text-[var(--k-ink-muted)]'
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="k-feed-mode-pill"
                        transition={
                          prefersReduced
                            ? { duration: 0.01 }
                            : { type: 'spring', stiffness: 480, damping: 35 }
                        }
                        className="absolute inset-0 rounded-[10px] bg-[var(--k-bg-surface-1)] shadow-xs"
                      />
                    ) : null}
                    <span className="relative z-10">{m.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[12px] text-[var(--k-ink-muted)] k-tabular">
                {pluralRu(filteredItems.length, 'запись', 'записи', 'записей')}
              </span>
              <button
                type="button"
                data-testid="feed-sort-btn"
                onClick={() => setSortPickerOpen(true)}
                aria-label="Сортировка ленты"
                className="k-tap inline-flex items-center gap-1 px-2 h-7 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[11.5px] font-medium text-[var(--k-ink-secondary)]"
              >
                <ArrowsDownUp className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                {isExpanded ? <span>{SORT_LABELS[sortMode]}</span> : null}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar k-scroll-fade-r pr-6 pb-0.5">
            {DNA_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => {
                  mobileBridge.haptic('light');
                  setDnaFilter(chip.id);
                }}
                className={`k-tap px-2.5 py-1 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                  dnaFilter === chip.id
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                }`}
              >
                {chip.label}
              </button>
            ))}

            {orbits.length > 0 ? (
              <span className="w-[1px] h-4 bg-[var(--k-border-hairline)] mx-1 shrink-0" />
            ) : null}

            {orbits.map((orbit) => {
              const active = selectedOrbitId === orbit.id;
              return (
                <button
                  key={orbit.id}
                  type="button"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    onSelectOrbit(active ? null : orbit.id);
                  }}
                  className={`k-tap inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                    active
                      ? 'border-[var(--k-border-focus)] text-[var(--k-ink-primary)] bg-[var(--k-bg-surface-2)]'
                      : 'border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] bg-[var(--k-bg-surface-1)]'
                  }`}
                >
                  <FolderSimple
                    weight="fill"
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: orbit.color }}
                  />
                  {orbit.name}
                </button>
              );
            })}

            {boards.map((board) => {
              const active = selectedBoardId === board.id;
              return (
                <button
                  key={board.id}
                  type="button"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    onSelectBoard(active ? null : board.id);
                  }}
                  className={`k-tap inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                    active
                      ? 'border-[var(--k-emerald)] text-[var(--k-emerald)] bg-[var(--k-emerald-soft)]'
                      : 'border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] bg-[var(--k-bg-surface-1)]'
                  }`}
                >
                  <Swatches
                    weight="duotone"
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: active ? undefined : board.color }}
                  />
                  {board.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Multi-Select Bulk Action Bar */}
        <AnimatePresence>
          {multiSelectMode ? (
            <motion.div
              initial={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: 'translate3d(0, -8px, 0)' }
              }
              animate={
                prefersReduced
                  ? { opacity: 1 }
                  : { opacity: 1, transform: 'translate3d(0, 0, 0)' }
              }
              exit={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: 'translate3d(0, -8px, 0)' }
              }
              transition={
                prefersReduced
                  ? { duration: 0.01 }
                  : { duration: 0.14, ease: [0.23, 1, 0.32, 1] }
              }
              className="px-4 py-2 bg-[var(--k-accent-soft)] border-b border-[var(--k-border-focus)] flex items-center justify-between gap-2 shrink-0"
            >
              <span className="text-[13px] font-semibold text-[var(--k-ink-primary)]">
                Выбрано: {selectedBulkIds.size}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={selectedBulkIds.size === 0}
                  onClick={() =>
                    setOrbitPickerTarget({ mode: 'bulk', currentValue: '' })
                  }
                  className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-xl bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-primary)] disabled:opacity-40"
                >
                  <FolderSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                  Раздел
                </button>
                <button
                  type="button"
                  disabled={selectedBulkIds.size === 0}
                  onClick={async () => {
                    const ids = Array.from(selectedBulkIds);
                    if (onBulkDeleteItems) {
                      await onBulkDeleteItems(ids);
                    } else {
                      for (const id of ids) await onDeleteItem(id);
                    }
                    exitMultiSelect();
                  }}
                  className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-xl bg-[var(--k-danger)] text-white text-[12px] font-semibold disabled:opacity-40"
                >
                  <Trash className="w-3.5 h-3.5" />
                  Удалить
                </button>
                <button
                  type="button"
                  onClick={exitMultiSelect}
                  aria-label="Завершить выбор"
                  className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Scrollable Grid (generous bottom padding clears floating dock completely!) */}
        <div className="flex-1 min-h-0 k-scroll p-3.5 pb-28">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16 px-6">
              <div className="w-12 h-12 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-center mb-3">
                <FileText weight="duotone" className="w-6 h-6 text-[var(--k-ink-muted)]" />
              </div>
              <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
                {searchQuery.trim() ? 'Ничего не нашлось' : 'Лента пока пуста'}
              </div>
              <p className="text-[13px] text-[var(--k-ink-muted)] mt-1 max-w-xs">
                {searchQuery.trim()
                  ? 'Попробуй другой запрос или сбрось фильтры сверху.'
                  : 'Нажми «+», чтобы сохранить мысль, голосовую заметку, фото или ссылку.'}
              </p>
              {!searchQuery.trim() && onQuickCapture ? (
                <button
                  type="button"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    onQuickCapture();
                  }}
                  className="k-tap mt-4 inline-flex items-center gap-1.5 px-4 h-10 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold"
                >
                  <Plus weight="bold" className="w-4 h-4" />
                  Создать запись
                </button>
              ) : null}
            </div>
          ) : isExpanded ? (
            <div data-testid="feed-grid" className="flex items-start gap-2.5">
              {masonryColumns.map((col, colIdx) => (
                <div key={colIdx} className="flex-1 min-w-0 flex flex-col gap-2.5">
                  {col.map(renderCard)}
                </div>
              ))}
            </div>
          ) : (
            <div data-testid="feed-grid" className="flex flex-col gap-2.5">
              {filteredItems.map(renderCard)}
            </div>
          )}
        </div>
      </div>

      {isExpanded && selectedItem ? (
        <aside
          data-testid="feed-detail-pane"
          className={`${
            useHingeSplit ? 'flex-1 min-w-0' : 'w-[330px] lg:w-[375px] shrink-0'
          } border-l border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] h-full min-h-0 k-scroll`}
        >
          {renderDetailContent(selectedItem)}
        </aside>
      ) : null}

      {!isExpanded ? (
        <BottomSheet
          open={Boolean(selectedItem)}
          title={selectedItem ? getDnaHumanLabel(selectedItem) : ''}
          isExpanded={false}
          onClose={() => onSelectItem(null)}
        >
          {selectedItem ? renderDetailContent(selectedItem) : null}
        </BottomSheet>
      ) : null}

      {/* Long-Press / More Action Sheet */}
      <ItemActionSheet
        open={Boolean(actionItem)}
        title={actionItem?.title || 'Запись'}
        subtitle={actionItem ? getDnaHumanLabel(actionItem) : undefined}
        actions={actionItem ? buildItemActions(actionItem) : []}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setActionItem(null)}
      />

      {/* Sort Picker Sheet */}
      <MobilePickerSheet
        open={sortPickerOpen}
        title="Сортировка ленты"
        value={sortMode}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        options={[
          { value: 'pinned_recent', label: SORT_LABELS.pinned_recent },
          { value: 'recent', label: SORT_LABELS.recent },
          { value: 'orbit', label: SORT_LABELS.orbit },
        ]}
        onSelect={(val) => setSortMode(val as FeedSort)}
        onClose={() => setSortPickerOpen(false)}
      />

      {/* Section Picker Sheet */}
      <MobilePickerSheet
        open={Boolean(orbitPickerTarget)}
        title="Выбрать раздел"
        value={orbitPickerTarget?.currentValue ?? ''}
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
        onSelect={(val) => {
          if (!orbitPickerTarget) return;
          if (orbitPickerTarget.mode === 'bulk') {
            const ids = Array.from(selectedBulkIds);
            void Promise.all(ids.map((id) => onUpdateItem(id, { orbit: val }))).then(() => {
              toast.success(`Перенесено записей: ${ids.length}`);
              exitMultiSelect();
            });
          } else if (orbitPickerTarget.itemId) {
            void onUpdateItem(orbitPickerTarget.itemId, { orbit: val });
            toast.success('Раздел обновлён');
          }
        }}
        onClose={() => setOrbitPickerTarget(null)}
      />

      {/* Canvas Picker Sheet */}
      <MobilePickerSheet
        open={Boolean(boardPickerTarget)}
        title="Выбрать холст"
        value={boardPickerTarget?.currentValue ?? ''}
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
        onSelect={(val) => {
          if (!boardPickerTarget) return;
          void onUpdateItem(boardPickerTarget.itemId, { focusBoardId: val || null });
          toast.success('Холст обновлён');
        }}
        onClose={() => setBoardPickerTarget(null)}
      />
    </div>
  );
};
