import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
import {
  ArrowSquareOut,
  ArrowsOutSimple,
  CircleNotch,
  FilmStrip,
  FolderSimple,
  GlobeSimple,
  Image as ImageIcon,
  Microphone,
  PencilSimple,
  Play,
  PushPin,
  Sparkle,
  SquaresFour,
  Swatches,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import type { FocusBoard, OrbitDef, VaultItem } from '@shared/types';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { getMediaCategory, isMediaItem, type MediaCategory } from '@shared/item-helpers';
import {
  formatRelativeDate,
  friendlyErrorMessage,
  getMediaUrl,
  transcribeItemWithWavFallback,
} from '../../lib/format';
import { playTactileTick } from '../../lib/tactileSound';
import { ContextMenuSurface, type ContextMenuEntry } from '../ui/ContextMenuSurface';
import { CopySlotPill } from '../ui/CopySlotPill';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';
import { SegmentedControl } from '../ui/SegmentedControl';
import { WaveformAudioPlayer } from '../ui/WaveformAudioPlayer';
import { ReferenceBoardCanvas } from './ReferenceBoardCanvas';

type MediaFilter = 'all' | MediaCategory;
type MediaViewMode = 'gallery' | 'board';
type MediaDensity = 'comfortable' | 'compact';

interface MediaHubViewProps {
  items: VaultItem[];
  orbits: OrbitDef[];
  focusBoards: FocusBoard[];
  searchQuery: string;
  serverSearchIds: string[] | null;
  soundEnabled: boolean;
  onOpenStudio: (item: VaultItem) => void;
  onOpenLightbox: (item: VaultItem) => void;
  onQuickLook?: (item: VaultItem) => void;
  onHoverItem?: (item: VaultItem | null) => void;
  onTogglePin: (item: VaultItem) => void;
  onMoveToOrbit: (itemId: string, orbitId: string) => void;
  onMoveToBoard: (itemId: string, boardId: string | null) => void;
  onDelete: (id: string) => void;
  onUpdateCanvasPosition: (itemId: string, x: number, y: number) => void;
}

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

export const MediaHubView: React.FC<MediaHubViewProps> = ({
  items,
  orbits,
  focusBoards,
  searchQuery,
  serverSearchIds,
  soundEnabled,
  onOpenStudio,
  onOpenLightbox,
  onQuickLook,
  onHoverItem,
  onTogglePin,
  onMoveToOrbit,
  onMoveToBoard,
  onDelete,
  onUpdateCanvasPosition,
}) => {
  const prefersReduced = useReducedMotion();
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [viewMode, setViewMode] = useState<MediaViewMode>('gallery');
  const [density, setDensity] = useState<MediaDensity>('comfortable');
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [failedImgIds, setFailedImgIds] = useState<Record<string, true>>({});
  const [transcribingIds, setTranscribingIds] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleTranscribeAudio = async (e: React.MouseEvent, item: VaultItem) => {
    e.stopPropagation();
    if (transcribingIds[item.id] || !item.mediaPath) return;
    setTranscribingIds((prev) => ({ ...prev, [item.id]: true }));
    try {
      const res = await transcribeItemWithWavFallback(item);
      if (res.ok && (res.item || res.transcript)) {
        playTactileTick(soundEnabled, 'success');
        toast.success('Голосовая заметка расшифрована');
      } else {
        toast.error(res.error || 'Не удалось расшифровать запись. Проверь настройки ИИ.');
      }
    } catch (err) {
      toast.error(
        friendlyErrorMessage(err, 'Не удалось расшифровать запись. Проверь настройки ИИ.')
      );
    } finally {
      setTranscribingIds((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
    }
  };

  useEffect(() => {
    if (!dragActive) return;
    const clearDrag = () => setDragActive(false);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('blur', clearDrag);
    };
  }, [dragActive]);

  const orbitMap = useMemo(() => {
    const map = new Map<string, OrbitDef>();
    for (const o of orbits) map.set(o.id, o);
    return map;
  }, [orbits]);

  const allMediaItems = useMemo(() => {
    const q = searchQuery.trim();
    const serverSet = serverSearchIds ? new Set(serverSearchIds) : null;
    return items
      .filter((item) => {
        if (!isMediaItem(item)) return false;
        if (!q) return true;
        if (serverSet && serverSet.has(item.id)) return true;
        const hay = [
          item.title,
          item.summary,
          item.body,
          item.ocrText,
          item.domain,
          item.mediaMeta?.transcript,
          item.tags.join(' '),
        ]
          .filter(Boolean)
          .join('\n');
        return matchesBilingualHaystack(hay, q);
      })
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (b.contentUpdatedAt || b.createdAt) - (a.contentUpdatedAt || a.createdAt);
      });
  }, [items, searchQuery, serverSearchIds]);

  const categoryCounts = useMemo(() => {
    const counts: Record<MediaFilter, number> = {
      all: allMediaItems.length,
      photo: 0,
      video: 0,
      audio: 0,
      link_visual: 0,
    };
    for (const item of allMediaItems) {
      const cat = getMediaCategory(item);
      if (cat) counts[cat] += 1;
    }
    return counts;
  }, [allMediaItems]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return allMediaItems;
    return allMediaItems.filter((item) => getMediaCategory(item) === filter);
  }, [allMediaItems, filter]);

  const visualTiles = useMemo(
    () => filteredItems.filter((item) => getMediaCategory(item) !== 'audio'),
    [filteredItems]
  );

  const audioItems = useMemo(
    () => filteredItems.filter((item) => getMediaCategory(item) === 'audio'),
    [filteredItems]
  );

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setUploading(true);
    let addedCount = 0;
    try {
      for (const file of files) {
        try {
          const nativePath = window.kapsula.getPathForFile(file);
          if (file.type.startsWith('image/')) {
            const b64 = await fileToBase64(file);
            await window.kapsula.capture({
              imageBase64: b64,
              ...(nativePath ? { imageFilePath: nativePath } : {}),
              title: file.name.replace(/\.[^.]+$/, ''),
              source: 'vault_ui',
            });
            addedCount += 1;
          } else if (file.type.startsWith('audio/')) {
            const b64 = await fileToBase64(file);
            await window.kapsula.capture({
              audioBase64: b64,
              audioMime: file.type,
              fileName: file.name,
              source: 'vault_ui',
            });
            addedCount += 1;
          } else {
            const b64 = await fileToBase64(file);
            await window.kapsula.capture({
              ...(nativePath ? { filePath: nativePath } : {}),
              fileBase64: b64,
              fileName: file.name,
              fileMime: file.type || 'application/octet-stream',
              source: 'vault_ui',
            });
            addedCount += 1;
          }
        } catch (err) {
          toast.error(friendlyErrorMessage(err, `Не удалось загрузить ${file.name}`));
        }
      }
      if (addedCount > 0) {
        playTactileTick(soundEnabled, 'success');
        toast.success(addedCount === 1 ? 'Медиафайл добавлен' : `Добавлено файлов: ${addedCount}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const buildTileContextMenu = (item: VaultItem, cat: MediaCategory): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [];
    if (cat === 'photo' || cat === 'link_visual') {
      entries.push({
        type: 'item',
        id: 'lightbox',
        label: 'Открыть на весь экран',
        icon: <ArrowsOutSimple className="w-3.5 h-3.5" />,
        onSelect: () => onOpenLightbox(item),
      });
    } else if (cat === 'video' && item.mediaPath) {
      entries.push({
        type: 'item',
        id: 'open-video',
        label: 'Открыть видеофайл',
        icon: <FilmStrip className="w-3.5 h-3.5" />,
        onSelect: () => void window.kapsula.openMediaFile(item.mediaPath!),
      });
    }

    entries.push(
      {
        type: 'item',
        id: 'open-note',
        label: 'Открыть описание и заметку',
        icon: <PencilSimple className="w-3.5 h-3.5" />,
        onSelect: () => onOpenStudio(item),
      },
      {
        type: 'item',
        id: 'pin',
        label: item.isPinned ? 'Открепить' : 'Закрепить сверху',
        icon: <PushPin weight={item.isPinned ? 'fill' : 'regular'} className="w-3.5 h-3.5" />,
        onSelect: () => onTogglePin(item),
      }
    );

    if (item.url) {
      entries.push({
        type: 'item',
        id: 'open-url',
        label: 'Открыть оригинал в браузере',
        icon: <ArrowSquareOut className="w-3.5 h-3.5" />,
        onSelect: () => void window.kapsula.openExternal(item.url!),
      });
    }

    if (orbits.length > 0) {
      entries.push({
        type: 'submenu',
        id: 'orbit',
        label: 'Переместить в раздел',
        icon: <FolderSimple className="w-3.5 h-3.5" />,
        items: orbits.map((o) => ({
          type: 'item',
          id: `orbit-${o.id}`,
          label: o.name,
          dotColor: o.color,
          active: item.orbit === o.id,
          onSelect: () => onMoveToOrbit(item.id, o.id),
        })),
      });
    }

    if (focusBoards.length > 0) {
      entries.push({
        type: 'submenu',
        id: 'board',
        label: 'Добавить на холст',
        icon: <Swatches className="w-3.5 h-3.5" />,
        items: [
          {
            type: 'item',
            id: 'board-none',
            label: 'Убрать с холста',
            active: !item.focusBoardId,
            onSelect: () => onMoveToBoard(item.id, null),
          },
          ...focusBoards.map((b) => ({
            type: 'item' as const,
            id: `board-${b.id}`,
            label: b.name,
            dotColor: b.color,
            active: item.focusBoardId === b.id,
            onSelect: () => onMoveToBoard(item.id, b.id),
          })),
        ],
      });
    }

    entries.push(
      { type: 'separator', id: 'sep' },
      {
        type: 'item',
        id: 'delete',
        label: 'В корзину',
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: () => onDelete(item.id),
      }
    );

    return entries;
  };

  const tabs: Array<{ id: MediaFilter; label: string; count: number; icon: React.ReactNode }> = [
    { id: 'all', label: 'Все медиа', count: categoryCounts.all, icon: <SquaresFour className="w-3.5 h-3.5" /> },
    { id: 'photo', label: 'Фото и скрины', count: categoryCounts.photo, icon: <ImageIcon className="w-3.5 h-3.5" /> },
    { id: 'video', label: 'Видео', count: categoryCounts.video, icon: <FilmStrip className="w-3.5 h-3.5" /> },
    { id: 'audio', label: 'Аудио и голос', count: categoryCounts.audio, icon: <Microphone className="w-3.5 h-3.5" /> },
    { id: 'link_visual', label: 'Из ссылок', count: categoryCounts.link_visual, icon: <GlobeSimple className="w-3.5 h-3.5" /> },
  ];

  const gridColumnsClass =
    density === 'compact'
      ? 'grid-cols-2 @[640px]:grid-cols-3 @[940px]:grid-cols-4 @[1240px]:grid-cols-5'
      : 'grid-cols-1 @[560px]:grid-cols-2 @[880px]:grid-cols-3 @[1220px]:grid-cols-4';

  return (
    <div
      data-testid="media-hub-view"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragActive(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer?.files?.length) {
          void handleUploadFiles(e.dataTransfer.files);
        }
      }}
      className="relative w-full space-y-5 @container"
    >
      {/* Drag-and-drop overlay */}
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--k-bg-backdrop)] backdrop-blur-xs">
          <div className="rounded-2xl border-2 border-dashed border-[var(--k-accent)] bg-[var(--k-bg-elevated)] px-8 py-6 text-center shadow-[var(--k-shadow-modal)]">
            <UploadSimple className="w-8 h-8 text-[var(--k-accent)] mx-auto mb-2" />
            <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
              Отпусти файлы, чтобы добавить в Галерею
            </div>
            <div className="text-[12px] text-[var(--k-ink-muted)] mt-1">
              Фото, скриншоты, видео и аудиофайлы
            </div>
          </div>
        </div>
      ) : null}

      {/* Unified Single-Row Media Controls + Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          data-testid="media-category-tabs"
          className="flex flex-wrap items-center gap-1"
        >
          {tabs.map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`media-filter-${tab.id}`}
                onClick={() => setFilter(tab.id)}
                className={`k-interactive relative inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium cursor-pointer ${
                  active
                    ? 'text-[var(--k-accent)]'
                    : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]/70'
                }`}
              >
                {active ? (
                  <motion.span
                    layoutId="media-filter-pill"
                    transition={
                      prefersReduced
                        ? { duration: 0.08 }
                        : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }
                    }
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-full bg-[var(--k-accent-soft)] border border-[var(--k-accent)]/35"
                  />
                ) : null}
                <span className="relative z-10 inline-flex items-center gap-1.5">
                  {tab.icon}
                  <span>{tab.label}</span>
                  <span className="text-[11px] opacity-70 k-tabular"><NumberFlow value={tab.count} /></span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {viewMode === 'gallery' && visualTiles.length > 0 ? (
            <SegmentedControl<MediaDensity>
              size="sm"
              value={density}
              onChange={setDensity}
              options={[
                { value: 'comfortable', label: 'Крупно' },
                { value: 'compact', label: 'Плотно' },
              ]}
            />
          ) : null}

          <SegmentedControl<MediaViewMode>
            size="sm"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'gallery', label: 'Галерея', icon: <SquaresFour className="w-3.5 h-3.5" /> },
              { value: 'board', label: 'Холст', icon: <Swatches className="w-3.5 h-3.5" /> },
            ]}
          />

          <button
            type="button"
            data-testid="media-upload-btn"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-8 px-3 rounded-[9px] bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:opacity-55"
          >
            <UploadSimple weight="bold" className="w-3.5 h-3.5" />
            <span>{uploading ? 'Загрузка…' : 'Добавить'}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                void handleUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
        </div>
      </div>

      {/* Main Content: Board or Visual Gallery */}
      {viewMode === 'board' ? (
        <ReferenceBoardCanvas
          boardKey="media-hub"
          items={filteredItems}
          orbits={orbits}
          focusBoards={focusBoards}
          onOpenItem={onOpenStudio}
          onQuickLook={onQuickLook}
          onUpdatePosition={onUpdateCanvasPosition}
          onTogglePin={onTogglePin}
          onMoveToOrbit={onMoveToOrbit}
          onMoveToBoard={onMoveToBoard}
          onDelete={onDelete}
        />
      ) : filteredItems.length === 0 ? (
        <div
          data-testid="media-empty-state"
          className="rounded-2xl border border-dashed border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)]/55 px-6 py-16 text-center space-y-3"
        >
          <div className="w-12 h-12 mx-auto rounded-2xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center">
            <ImageIcon weight="duotone" className="w-6 h-6" />
          </div>
          <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
            {searchQuery.trim()
              ? 'По этому запросу медиа не нашлось'
              : filter === 'all'
                ? 'Галерея пока пуста'
                : 'В этой категории пока нет файлов'}
          </div>
          <p className="m-0 text-[12.5px] text-[var(--k-ink-secondary)] max-w-[420px] mx-auto">
            Перетащи сюда фото, скриншоты, видео или голосовые записи — они соберутся в удобную галерею с быстрым просмотром и палитрой цветов.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer"
          >
            <UploadSimple weight="bold" className="w-3.5 h-3.5" />
            <span>Выбрать файлы</span>
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Visual Photo / Video / Link-Preview Grid */}
          {visualTiles.length > 0 ? (
            <div
              data-testid="media-visual-grid"
              className={`grid gap-3.5 items-stretch ${gridColumnsClass}`}
            >
              {visualTiles.map((item) => {
                const cat = getMediaCategory(item) || 'photo';
                const localImg = getMediaUrl(item.thumbPath || item.imagePath);
                const imgSrc = localImg || item.ogImageUrl || null;
                const orbit = item.orbit ? orbitMap.get(item.orbit) : undefined;
                const cleanTitle = cleanBrokenTextArtifacts(
                  item.title ||
                    (cat === 'video' ? 'Видеореференс' : cat === 'link_visual' ? item.domain || 'Ссылка' : 'Изображение'),
                  true
                );
                const swatches = (item.colorPalette ?? []).slice(0, 4);

                return (
                  <ContextMenuSurface key={item.id} entries={buildTileContextMenu(item, cat)}>
                    <motion.article
                      layout={prefersReduced ? undefined : 'position'}
                      data-testid={`media-tile-${item.id}`}
                      onMouseEnter={() => onHoverItem?.(item)}
                      onMouseLeave={() => onHoverItem?.(null)}
                      className="group relative flex flex-col rounded-[16px] overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] shadow-[var(--k-shadow-card)] k-card-lift transition-[border-color,box-shadow] duration-170"
                    >
                      {/* Visual Surface */}
                      {cat === 'video' && item.mediaPath ? (
                        <div className="relative bg-[var(--k-bg-surface-2)]">
                          <InlineReferenceVideo
                            mediaPath={item.mediaPath}
                            posterPath={item.thumbPath || item.imagePath}
                            heightClass={density === 'compact' ? 'h-[172px]' : 'h-[214px]'}
                            onOpenFull={() => void window.kapsula.openMediaFile(item.mediaPath!)}
                          />
                        </div>
                      ) : (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenLightbox(item)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpenLightbox(item);
                            }
                          }}
                          className={`relative overflow-hidden bg-[var(--k-bg-surface-2)] cursor-zoom-in ${
                            density === 'compact' ? 'aspect-[4/3]' : 'aspect-[16/11]'
                          }`}
                        >
                          {imgSrc && !failedImgIds[item.id] ? (
                            <img
                              src={imgSrc}
                              alt={cleanTitle}
                              loading="lazy"
                              onError={() =>
                                setFailedImgIds((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: true }))
                              }
                              className="w-full h-full object-cover block transition-transform duration-200 ease-out group-hover:scale-[1.025]"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[var(--k-ink-muted)]">
                              {cat === 'video' ? (
                                <FilmStrip className="w-8 h-8 opacity-50" />
                              ) : (
                                <ImageIcon className="w-8 h-8 opacity-45" />
                              )}
                            </div>
                          )}

                          {cat === 'video' && !item.mediaPath ? (
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-black/65 text-white border border-white/25 backdrop-blur-xs">
                                <Play weight="fill" className="w-4 h-4 ml-0.5" />
                              </span>
                            </span>
                          ) : null}

                          {/* Subtle hover scrim */}
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-150" />

                          {/* Top-left subtle badge for pinned or link source */}
                          <div className="absolute top-2 left-2 flex items-center gap-1">
                            {item.isPinned ? (
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-black/60 text-[var(--k-accent)] backdrop-blur-xs">
                                <PushPin weight="fill" className="w-3 h-3" />
                              </span>
                            ) : null}
                            {cat === 'link_visual' && item.domain ? (
                              <span className="inline-flex items-center gap-1 h-5.5 px-2 rounded-md bg-black/60 text-[10.5px] font-medium text-white/90 backdrop-blur-xs max-w-[140px] truncate">
                                <GlobeSimple className="w-3 h-3 shrink-0" />
                                <span className="truncate">{item.domain}</span>
                              </span>
                            ) : null}
                          </div>

                          {/* Bottom hover controls: color swatches + Copy / Zoom / Open Note */}
                          <div className="absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150">
                            <div className="flex items-center gap-1">
                              {swatches.map((hex) => (
                                <button
                                  key={hex}
                                  type="button"
                                  title={`Скопировать цвет ${hex}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void window.kapsula.copyText(hex);
                                    toast.success(`Цвет ${hex} скопирован`);
                                  }}
                                  className="k-interactive w-4 h-4 rounded-full border border-white/50 shadow-xs cursor-pointer"
                                  style={{ backgroundColor: hex }}
                                />
                              ))}
                            </div>

                            <div className="flex items-center gap-1">
                              {localImg ? (
                                <CopySlotPill
                                  label="Фото"
                                  copiedLabel="Готово"
                                  widthPx={84}
                                  heightPx={26}
                                  tone="secret"
                                  onCopy={() =>
                                    window.kapsula.copyImage(item.imagePath || item.thumbPath || '')
                                  }
                                />
                              ) : null}
                              <button
                                type="button"
                                aria-label="Открыть заметку"
                                title="Открыть заметку"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenStudio(item);
                                }}
                                className="k-interactive inline-flex items-center justify-center w-6.5 h-6.5 rounded-lg border border-white/20 bg-black/65 text-white hover:bg-black/85 cursor-pointer"
                              >
                                <PencilSimple className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label="Увеличить"
                                title="На весь экран"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenLightbox(item);
                                }}
                                className="k-interactive inline-flex items-center justify-center w-6.5 h-6.5 rounded-lg border border-white/20 bg-black/65 text-white hover:bg-black/85 cursor-pointer"
                              >
                                <ArrowsOutSimple className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Compact visual caption footer */}
                      <div
                        onClick={() => onOpenStudio(item)}
                        className="px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--k-bg-surface-2)]/45 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)] truncate">
                            {cleanTitle}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-[var(--k-ink-muted)]">
                            {orbit ? (
                              <span className="inline-flex items-center gap-1 truncate max-w-[110px]">
                                <span
                                  className="w-1.5 h-1.5 rounded-full shrink-0"
                                  style={{ backgroundColor: orbit.color }}
                                />
                                <span className="truncate">{orbit.name}</span>
                              </span>
                            ) : null}
                            <span className="k-tabular shrink-0">
                              {formatRelativeDate(item.contentUpdatedAt || item.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </motion.article>
                  </ContextMenuSurface>
                );
              })}
            </div>
          ) : null}

          {/* Dedicated Audio & Voice Shelf (so audio memos have real waveform players instead of empty image tiles) */}
          {audioItems.length > 0 ? (
            <section data-testid="media-audio-section" className="space-y-2.5">
              {filter === 'all' ? (
                <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  <Microphone className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                  <span>Аудио и голосовые записи ({audioItems.length})</span>
                </div>
              ) : null}

              <div className="grid grid-cols-1 @[700px]:grid-cols-2 gap-3">
                {audioItems.map((item) => {
                  const mediaUrl = getMediaUrl(item.mediaPath);
                  const orbit = item.orbit ? orbitMap.get(item.orbit) : undefined;
                  const rawTranscript =
                    item.body?.trim() || item.mediaMeta?.transcript?.trim() || '';
                  const hasTranscript = rawTranscript.length > 0;
                  const transcriptPreview = rawTranscript || item.summary || '';
                  const isTranscribing = Boolean(transcribingIds[item.id]);

                  return (
                    <ContextMenuSurface key={item.id} entries={buildTileContextMenu(item, 'audio')}>
                      <div
                        data-testid={`media-audio-card-${item.id}`}
                        onClick={() => onOpenStudio(item)}
                        className="k-card-surface rounded-[16px] p-3.5 flex flex-col gap-2.5 cursor-pointer hover:border-[var(--k-border-strong)] transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
                              <Microphone weight="duotone" className="w-4 h-4" />
                            </span>
                            <span className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] truncate">
                              {item.title || 'Голосовая заметка'}
                            </span>
                          </div>
                          <span className="text-[11px] text-[var(--k-ink-muted)] k-tabular shrink-0">
                            {formatRelativeDate(item.contentUpdatedAt || item.createdAt)}
                          </span>
                        </div>

                        {mediaUrl ? (
                          <div onClick={(e) => e.stopPropagation()}>
                            <WaveformAudioPlayer
                              compact
                              src={mediaUrl}
                              fallbackDurationSec={item.mediaDurationSec}
                              peaks={item.mediaMeta?.waveformPeaks}
                              seedKey={item.id}
                            />
                          </div>
                        ) : null}

                        {!hasTranscript && item.mediaPath ? (
                          <div className="flex items-center">
                            <button
                              type="button"
                              data-testid={`media-audio-transcribe-btn-${item.id}`}
                              disabled={isTranscribing}
                              onClick={(e) => void handleTranscribeAudio(e, item)}
                              className={`k-interactive inline-flex items-center gap-1.5 h-7.5 px-3 rounded-full border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[12px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer disabled:opacity-65 ${
                                isTranscribing ? 'k-beautify-shimmer' : ''
                              }`}
                            >
                              {isTranscribing ? (
                                <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin shrink-0" />
                              ) : (
                                <Sparkle weight="fill" className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <span>{isTranscribing ? 'Расшифровываю…' : 'Расшифровать через ИИ'}</span>
                            </button>
                          </div>
                        ) : null}

                        {transcriptPreview && transcriptPreview !== item.title ? (
                          <p className="m-0 text-[12px] text-[var(--k-ink-secondary)] line-clamp-2 leading-relaxed">
                            {transcriptPreview}
                          </p>
                        ) : null}

                        {orbit ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-[var(--k-ink-muted)]">
                            <span
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: orbit.color }}
                            />
                            <span>{orbit.name}</span>
                          </div>
                        ) : null}
                      </div>
                    </ContextMenuSurface>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
};
