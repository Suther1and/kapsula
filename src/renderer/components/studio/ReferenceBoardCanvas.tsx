import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsOutCardinal,
  DotsSix,
  Eye,
  FolderOpen,
  FrameCorners,
  GridFour,
  LinkSimple,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Plus,
  PushPin,
  SquaresFour,
  Swatches,
  Trash,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { FocusBoard, OrbitDef, VaultItem } from '@shared/types';
import { cleanBrokenTextArtifacts } from '@shared/html-entities';
import { isMacPlatform } from '@shared/shortcuts';
import { getDnaHumanLabel, getMediaUrl, stripLeadingTitle, stripMarkdownPreview } from '../../lib/format';
import { ContextMenuSurface, type ContextMenuEntry } from '../ui/ContextMenuSurface';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';

interface BoardFrame {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

interface ReferenceBoardCanvasProps {
  boardKey?: string;
  items: VaultItem[];
  orbits?: OrbitDef[];
  focusBoards?: FocusBoard[];
  onOpenItem: (item: VaultItem) => void;
  onQuickLook?: (item: VaultItem) => void;
  onUpdatePosition: (itemId: string, x: number, y: number) => void;
  onUpdateSize?: (itemId: string, w: number, h: number) => void;
  onUpdateLinks?: (itemId: string, linksOut: string[]) => void;
  onTogglePin?: (item: VaultItem) => void;
  onMoveToOrbit?: (itemId: string, orbit: string) => void;
  onMoveToBoard?: (itemId: string, boardId: string | null) => void;
  onDelete?: (id: string) => void;
  onCreateBoardNote?: () => void;
}

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v)$/i;
const FRAME_COLORS = ['#e86a33', '#4f86f7', '#2db57d', '#9a75f5', '#e59f30', '#e65d78'];

function loadFrames(storageKey: string): BoardFrame[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const ReferenceBoardCanvas: React.FC<ReferenceBoardCanvasProps> = ({
  boardKey = 'default',
  items,
  orbits = [],
  focusBoards = [],
  onOpenItem,
  onQuickLook,
  onUpdatePosition,
  onUpdateSize,
  onUpdateLinks,
  onTogglePin,
  onMoveToOrbit,
  onMoveToBoard,
  onDelete,
  onCreateBoardNote,
}) => {
  const framesStorageKey = `kapsula.boardFrames.v7.${boardKey}`;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 32, y: 60 });
  const [localCoords, setLocalCoords] = useState<Record<string, { x: number; y: number }>>({});
  const [localSizes, setLocalSizes] = useState<Record<string, { w: number; h?: number }>>({});
  const [localLinks, setLocalLinks] = useState<Record<string, string[]>>({});
  const [frames, setFrames] = useState<BoardFrame[]>(() => loadFrames(framesStorageKey));
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFromId, setConnectFromId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFrames(loadFrames(framesStorageKey));
  }, [framesStorageKey]);

  const persistFrames = (next: BoardFrame[]) => {
    setFrames(next);
    try {
      localStorage.setItem(framesStorageKey, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const cardDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const cardResizeRef = useRef<{
    id: string;
    startX: number;
    origW: number;
  } | null>(null);
  const frameDragRef = useRef<{
    id: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const visibleItems = useMemo(
    () => items.filter((i) => i.dna !== 'secret').slice(0, 80),
    [items]
  );

  const getCoords = (item: VaultItem, idx: number) => {
    if (localCoords[item.id]) return localCoords[item.id]!;
    if (typeof item.canvasX === 'number' && typeof item.canvasY === 'number') {
      return { x: item.canvasX, y: item.canvasY };
    }
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    return { x: col * 316, y: row * 196 };
  };

  const getWidth = (item: VaultItem) => {
    return localSizes[item.id]?.w ?? item.canvasW ?? 276;
  };

  const getLinks = (item: VaultItem) => {
    return localLinks[item.id] ?? item.linksOut ?? [];
  };

  const handleAutoArrange = () => {
    const next: Record<string, { x: number; y: number }> = {};
    visibleItems.forEach((item, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const x = col * 316;
      const y = row * 196;
      next[item.id] = { x, y };
      onUpdatePosition(item.id, x, y);
    });
    setLocalCoords(next);
    setPan({ x: 32, y: 60 });
    setZoom(1);
    toast.success('Карточки аккуратно разложены по сетке');
  };

  const handleAddFrame = () => {
    const color = FRAME_COLORS[frames.length % FRAME_COLORS.length]!;
    const offset = frames.length * 32;

    // Compute clear space below all existing cards so the new frame header (title + drag bar + delete X)
    // is NEVER buried behind row-0 cards and NEVER collides with the top-right floating toolbar.
    let maxCardBottom = 0;
    visibleItems.forEach((item, idx) => {
      const pos = getCoords(item, idx);
      const estimatedH = Math.max(
        item.thumbPath || item.imagePath ? 250 : 196,
        localSizes[item.id]?.h ?? 0
      );
      maxCardBottom = Math.max(maxCardBottom, pos.y + estimatedH);
    });

    if (canvasRef.current && visibleItems.length > 0) {
      const layerEl = canvasRef.current.querySelector('[data-board-layer="true"]');
      const cardEls = canvasRef.current.querySelectorAll('[data-board-card="true"]');
      if (layerEl && cardEls.length > 0) {
        const layerRect = layerEl.getBoundingClientRect();
        cardEls.forEach((el) => {
          const r = el.getBoundingClientRect();
          const canvasBottom = Math.ceil((r.bottom - layerRect.top) / zoom);
          if (Number.isFinite(canvasBottom)) {
            maxCardBottom = Math.max(maxCardBottom, canvasBottom);
          }
        });
      }
    }

    const baseY = visibleItems.length > 0 ? Math.round(maxCardBottom + 24) : 76;
    const newFrame: BoardFrame = {
      id: `frame-${Date.now().toString(36)}`,
      title: `Группа ${frames.length + 1}`,
      x: Math.round(24 + offset),
      y: Math.round(baseY + offset),
      w: 520,
      h: 280,
      color,
    };
    persistFrames([...frames, newFrame]);
    setEditingFrameId(newFrame.id);

    // Gently ensure the newly spawned frame header is inside the visible viewport
    if (canvasRef.current) {
      const viewH = canvasRef.current.clientHeight;
      const frameTopInView = pan.y + newFrame.y * zoom;
      if (frameTopInView > viewH - 120) {
        const targetPanY = Math.round(viewH - (newFrame.y + 180) * zoom);
        setPan((prev) => ({ ...prev, y: Math.min(prev.y, targetPanY) }));
      }
    }
  };

  const handleToggleConnection = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const source = visibleItems.find((i) => i.id === fromId);
    if (!source) return;
    const existing = getLinks(source);
    const next = existing.includes(toId)
      ? existing.filter((x) => x !== toId)
      : [...existing, toId];
    setLocalLinks((prev) => ({ ...prev, [fromId]: next }));
    if (onUpdateLinks) {
      onUpdateLinks(fromId, next);
    } else {
      void window.kapsula.updateItem(fromId, { linksOut: next });
    }
    toast.success(existing.includes(toId) ? 'Связь удалена' : 'Карточки связаны');
  };

  const itemPositionsById = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    visibleItems.forEach((item, idx) => {
      const pos = getCoords(item, idx);
      const w = getWidth(item);
      const h = item.thumbPath || item.imagePath ? 230 : 140;
      map.set(item.id, { x: pos.x, y: pos.y, w, h });
    });
    return map;
  }, [visibleItems, localCoords, localSizes]);

  const connectorEdges = useMemo(() => {
    const edges: Array<{ fromId: string; toId: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const item of visibleItems) {
      const fromPos = itemPositionsById.get(item.id);
      if (!fromPos) continue;
      for (const targetId of getLinks(item)) {
        const toPos = itemPositionsById.get(targetId);
        if (!toPos) continue;
        const x1 = fromPos.x + fromPos.w / 2;
        const y1 = fromPos.y + fromPos.h / 2;
        const x2 = toPos.x + toPos.w / 2;
        const y2 = toPos.y + toPos.h / 2;
        edges.push({ fromId: item.id, toId: targetId, x1, y1, x2, y2 });
      }
    }
    return edges;
  }, [visibleItems, itemPositionsById, localLinks]);

  // Native non-passive wheel listener so macOS trackpad pinch (ctrlKey) zooms only the canvas, not the whole Electron window
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const isMac = isMacPlatform(window.kapsula?.platform);
    const onWheel = (e: WheelEvent) => {
      const shouldZoom = isMac
        ? e.ctrlKey || e.metaKey
        : e.ctrlKey || (Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 40);
      if (shouldZoom) {
        e.preventDefault();
        const delta =
          isMac && e.ctrlKey
            ? Math.max(-0.08, Math.min(0.08, -e.deltaY * 0.01))
            : e.deltaY < 0
              ? 0.08
              : -0.08;
        setZoom((z) => Math.max(0.45, Math.min(1.65, Math.round((z + delta) * 100) / 100)));
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={canvasRef}
      data-testid="reference-board-canvas"
      className="relative w-full h-[calc(100vh-210px)] min-h-[460px] rounded-2xl border border-[var(--k-border-hairline)] overflow-hidden bg-[var(--k-bg-canvas)] select-none"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (connectFromId) setConnectFromId(null);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        panDragRef.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
      }}
      onPointerMove={(e) => {
        if (cardResizeRef.current) {
          const r = cardResizeRef.current;
          const nextW = Math.max(210, Math.min(520, Math.round(r.origW + (e.clientX - r.startX) / zoom)));
          setLocalSizes((prev) => ({ ...prev, [r.id]: { ...prev[r.id], w: nextW } }));
          return;
        }
        if (cardDragRef.current) {
          const d = cardDragRef.current;
          const x = Math.round(d.origX + (e.clientX - d.startX) / zoom);
          const y = Math.round(d.origY + (e.clientY - d.startY) / zoom);
          setLocalCoords((prev) => ({ ...prev, [d.id]: { x, y } }));
          return;
        }
        if (frameDragRef.current) {
          const f = frameDragRef.current;
          const dx = Math.round((e.clientX - f.startX) / zoom);
          const dy = Math.round((e.clientY - f.startY) / zoom);
          setFrames((prev) =>
            prev.map((item) => {
              if (item.id !== f.id) return item;
              if (f.mode === 'move') {
                return { ...item, x: f.origX + dx, y: f.origY + dy };
              }
              return {
                ...item,
                w: Math.max(240, f.origW + dx),
                h: Math.max(180, f.origH + dy),
              };
            })
          );
          return;
        }
        if (panDragRef.current) {
          const p = panDragRef.current;
          setPan({ x: p.origX + (e.clientX - p.startX), y: p.origY + (e.clientY - p.startY) });
        }
      }}
      onPointerUp={(e) => {
        try {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        } catch {
          // ignore
        }
        if (cardResizeRef.current) {
          const id = cardResizeRef.current.id;
          const sz = localSizes[id];
          if (sz) {
            if (onUpdateSize) onUpdateSize(id, sz.w, sz.h ?? 0);
            else void window.kapsula.updateItem(id, { canvasW: sz.w });
          }
          cardResizeRef.current = null;
        }
        if (cardDragRef.current) {
          const id = cardDragRef.current.id;
          const pos = localCoords[id];
          if (pos) onUpdatePosition(id, pos.x, pos.y);
          cardDragRef.current = null;
        }
        if (frameDragRef.current) {
          frameDragRef.current = null;
          persistFrames(frames);
        }
        panDragRef.current = null;
      }}
      onPointerCancel={() => {
        cardDragRef.current = null;
        cardResizeRef.current = null;
        frameDragRef.current = null;
        panDragRef.current = null;
      }}
    >
      {/* Subtle dotted grid background */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage: 'radial-gradient(var(--k-ink-muted) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      {/* Board Floating Toolbar */}
      <div className="absolute top-3 right-3 z-20 flex flex-wrap items-center gap-1 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1 shadow-[var(--k-shadow-popover)] backdrop-blur-md">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.45, Math.round((z - 0.1) * 100) / 100))}
          className="k-interactive w-7 h-7 rounded-lg hover:bg-[var(--k-bg-surface-2)] inline-flex items-center justify-center cursor-pointer"
          title="Уменьшить"
        >
          <MagnifyingGlassMinus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 32, y: 60 });
          }}
          title="Сбросить масштаб"
          className="k-mono k-tabular text-[11px] px-1.5 min-w-[42px] text-center hover:text-[var(--k-accent)] cursor-pointer"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.65, Math.round((z + 0.1) * 100) / 100))}
          className="k-interactive w-7 h-7 rounded-lg hover:bg-[var(--k-bg-surface-2)] inline-flex items-center justify-center cursor-pointer"
          title="Увеличить"
        >
          <MagnifyingGlassPlus className="w-3.5 h-3.5" />
        </button>

        <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-0.5" />

        <button
          type="button"
          data-testid="board-add-frame-btn"
          onClick={handleAddFrame}
          className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          title="Добавить визуальную рамку-группу"
        >
          <FrameCorners className="w-3.5 h-3.5 text-[var(--k-accent)]" />
          <span>Группа</span>
        </button>

        <button
          type="button"
          data-testid="board-connect-mode-btn"
          onClick={() => {
            setConnectMode((v) => !v);
            setConnectFromId(null);
          }}
          className={`k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium cursor-pointer ${
            connectMode
              ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
              : 'hover:bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
          }`}
          title="Кликай по двум карточкам подряд, чтобы соединить их стрелкой"
        >
          <LinkSimple className="w-3.5 h-3.5" />
          <span>{connectMode ? (connectFromId ? 'Выбери цель…' : 'Связывание') : 'Связать'}</span>
        </button>

        <button
          type="button"
          onClick={handleAutoArrange}
          className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-medium cursor-pointer"
        >
          <GridFour className="w-3.5 h-3.5" />
          <span>По сетке</span>
        </button>

        {onCreateBoardNote ? (
          <button
            type="button"
            onClick={onCreateBoardNote}
            className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11.5px] font-medium cursor-pointer"
          >
            <Plus weight="bold" className="w-3.5 h-3.5" />
            <span>Заметка</span>
          </button>
        ) : null}
      </div>

      {connectMode ? (
        <div className="absolute top-3 left-3 z-20 px-3 py-1.5 rounded-xl border border-[var(--k-accent)]/40 bg-[var(--k-bg-elevated)] text-[11.5px] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] backdrop-blur-md">
          {connectFromId
            ? 'Теперь нажми на вторую карточку, чтобы провести или убрать стрелку'
            : 'Нажми на первую карточку, от которой провести связь'}
        </div>
      ) : null}

      {/* Transformed Canvas Layer */}
      <div
        data-board-layer="true"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
        className="relative w-full h-full"
      >
        {/* Background Group Frames */}
        {frames.map((frame) => (
          <div
            key={frame.id}
            data-testid={`board-frame-${frame.id}`}
            style={{
              left: `${frame.x}px`,
              top: `${frame.y}px`,
              width: `${frame.w}px`,
              height: `${frame.h}px`,
              borderColor: `${frame.color}55`,
              backgroundColor: `${frame.color}12`,
            }}
            className="absolute rounded-2xl border-2 border-dashed flex flex-col"
          >
            <div
              onPointerDown={(e) => {
                if (e.button !== 0 || editingFrameId === frame.id) return;
                e.stopPropagation();
                try {
                  canvasRef.current?.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                frameDragRef.current = {
                  id: frame.id,
                  mode: 'move',
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: frame.x,
                  origY: frame.y,
                  origW: frame.w,
                  origH: frame.h,
                };
              }}
              className="flex items-center justify-between gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing"
            >
              {editingFrameId === frame.id ? (
                <input
                  type="text"
                  autoFocus
                  value={frame.title}
                  onChange={(e) =>
                    setFrames((prev) =>
                      prev.map((f) => (f.id === frame.id ? { ...f, title: e.target.value } : f))
                    )
                  }
                  onBlur={() => {
                    setEditingFrameId(null);
                    persistFrames(frames);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      setEditingFrameId(null);
                      persistFrames(frames);
                    }
                  }}
                  className="bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] rounded-md px-2 py-0.5 text-[12px] font-semibold text-[var(--k-ink-primary)] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onDoubleClick={() => setEditingFrameId(frame.id)}
                  style={{ color: frame.color }}
                  className="text-[12px] font-semibold tracking-tight cursor-text"
                  title="Двойной клик, чтобы переименовать группу"
                >
                  {frame.title}
                </button>
              )}

              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => persistFrames(frames.filter((f) => f.id !== frame.id))}
                aria-label="Удалить группу"
                className="w-5 h-5 rounded-md inline-flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] hover:bg-[var(--k-bg-surface-1)]/80 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* Frame Resize Handle */}
            <div
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                try {
                  canvasRef.current?.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                frameDragRef.current = {
                  id: frame.id,
                  mode: 'resize',
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: frame.x,
                  origY: frame.y,
                  origW: frame.w,
                  origH: frame.h,
                };
              }}
              className="absolute right-1 bottom-1 w-4 h-4 cursor-nwse-resize opacity-40 hover:opacity-100 flex items-center justify-center"
              title="Потяни, чтобы изменить размер группы"
            >
              <ArrowsOutCardinal className="w-3 h-3 text-[var(--k-ink-muted)]" />
            </div>
          </div>
        ))}

        {/* SVG Curved Connector Arrows */}
        {connectorEdges.length > 0 ? (
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width="1"
            height="1"
          >
            <defs>
              <marker
                id="kapsula-board-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--k-accent)" />
              </marker>
            </defs>
            {connectorEdges.map((edge) => {
              const dx = Math.abs(edge.x2 - edge.x1) * 0.4;
              const d = `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2} ${edge.y2}`;
              return (
                <path
                  key={`${edge.fromId}->${edge.toId}`}
                  d={d}
                  fill="none"
                  stroke="var(--k-accent)"
                  strokeOpacity="0.6"
                  strokeWidth="2"
                  strokeDasharray="4 3"
                  markerEnd="url(#kapsula-board-arrow)"
                />
              );
            })}
          </svg>
        ) : null}

        {/* Board Cards */}
        {visibleItems.map((item, idx) => {
          const pos = getCoords(item, idx);
          const cardW = getWidth(item);
          const imgSrc = getMediaUrl(item.thumbPath || item.imagePath);
          const isVideo = Boolean(
            item.mediaPath && (item.subKind === 'video_ref' || VIDEO_EXT_RE.test(item.mediaPath))
          );
          const isConnectSource = connectFromId === item.id;

          return (
            <ContextMenuSurface
              key={item.id}
              entries={(() => {
                const menu: ContextMenuEntry[] = [
                  {
                    type: 'item',
                    id: 'open',
                    label: 'Открыть',
                    icon: <FolderOpen className="w-3.5 h-3.5" />,
                    onSelect: () => onOpenItem(item),
                  },
                ];
                if (onQuickLook) {
                  menu.push({
                    type: 'item',
                    id: 'ql',
                    label: 'Быстрый просмотр',
                    icon: <Eye className="w-3.5 h-3.5" />,
                    onSelect: () => onQuickLook(item),
                  });
                }
                menu.push({
                  type: 'item',
                  id: 'connect',
                  label: 'Провести связь от этой карточки',
                  icon: <LinkSimple className="w-3.5 h-3.5" />,
                  onSelect: () => {
                    setConnectMode(true);
                    setConnectFromId(item.id);
                  },
                });
                if (onTogglePin) {
                  menu.push({
                    type: 'item',
                    id: 'pin',
                    label: item.isPinned ? 'Открепить' : 'Закрепить',
                    icon: <PushPin className="w-3.5 h-3.5" />,
                    onSelect: () => onTogglePin(item),
                  });
                }
                if (onMoveToOrbit && orbits.length > 0) {
                  menu.push({
                    type: 'submenu',
                    id: 'orbit',
                    label: 'В раздел',
                    icon: <SquaresFour className="w-3.5 h-3.5" />,
                    items: [
                      {
                        type: 'item',
                        id: 'orb-none',
                        label: 'Без раздела',
                        active: !item.orbit,
                        onSelect: () => onMoveToOrbit(item.id, ''),
                      },
                      ...orbits.map((o) => ({
                        type: 'item' as const,
                        id: `orb-${o.id}`,
                        label: o.name,
                        dotColor: o.color,
                        active: item.orbit === o.id,
                        onSelect: () => onMoveToOrbit(item.id, o.id),
                      })),
                    ],
                  });
                }
                if (onMoveToBoard && focusBoards.length > 0) {
                  menu.push({
                    type: 'submenu',
                    id: 'board',
                    label: 'На холст',
                    icon: <Swatches className="w-3.5 h-3.5" />,
                    items: [
                      {
                        type: 'item',
                        id: 'brd-none',
                        label: 'Убрать с холста',
                        active: !item.focusBoardId,
                        onSelect: () => onMoveToBoard(item.id, null),
                      },
                      ...focusBoards.map((b) => ({
                        type: 'item' as const,
                        id: `brd-${b.id}`,
                        label: b.name,
                        dotColor: b.color,
                        active: item.focusBoardId === b.id,
                        onSelect: () => onMoveToBoard(item.id, b.id),
                      })),
                    ],
                  });
                }
                if (onDelete) {
                  menu.push({ type: 'separator', id: 'sep' });
                  menu.push({
                    type: 'item',
                    id: 'del',
                    label: 'Удалить',
                    icon: <Trash className="w-3.5 h-3.5" />,
                    danger: true,
                    onSelect: () => onDelete(item.id),
                  });
                }
                return menu;
              })()}
            >
              <div
                data-board-card="true"
                data-testid={`board-card-${item.id}`}
                style={{
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  width: `${cardW}px`,
                }}
                onClick={(e) => {
                  if (!connectMode) return;
                  e.stopPropagation();
                  if (!connectFromId) {
                    setConnectFromId(item.id);
                  } else if (connectFromId === item.id) {
                    setConnectFromId(null);
                  } else {
                    handleToggleConnection(connectFromId, item.id);
                    setConnectFromId(null);
                  }
                }}
                onDoubleClick={() => {
                  if (!connectMode) onOpenItem(item);
                }}
                className={`group/bcard absolute rounded-2xl border bg-[var(--k-bg-surface-1)] shadow-[var(--k-shadow-card)] overflow-hidden flex flex-col transition-[border-color,box-shadow] duration-150 ${
                  isConnectSource
                    ? 'border-[var(--k-accent)] ring-2 ring-[var(--k-accent)]/40'
                    : connectMode
                      ? 'border-[var(--k-border-strong)] hover:border-[var(--k-accent)] cursor-crosshair'
                      : 'border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)]'
                }`}
              >
                {/* Drag Handle Bar */}
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0 || connectMode) return;
                    e.stopPropagation();
                    try {
                      canvasRef.current?.setPointerCapture(e.pointerId);
                    } catch {
                      // ignore
                    }
                    cardDragRef.current = {
                      id: item.id,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: pos.x,
                      origY: pos.y,
                    };
                  }}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[var(--k-bg-surface-2)]/70 border-b border-[var(--k-border-hairline)] cursor-grab active:cursor-grabbing"
                >
                  <span className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] shrink-0">
                    {getDnaHumanLabel(item)}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    {onQuickLook ? (
                      <button
                        type="button"
                        title="Быстрый просмотр"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onQuickLook(item);
                        }}
                        className="opacity-0 group-hover/bcard:opacity-100 text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] transition-opacity cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenItem(item);
                      }}
                      className="text-[10.5px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer shrink-0"
                    >
                      Открыть
                    </button>
                    <DotsSix weight="bold" className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                  </div>
                </div>

                {isVideo && item.mediaPath ? (
                  <div className="p-2">
                    <InlineReferenceVideo
                      mediaPath={item.mediaPath}
                      posterPath={item.thumbPath || item.imagePath}
                      heightClass="max-h-[170px]"
                    />
                  </div>
                ) : imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={cleanBrokenTextArtifacts(item.title, true)}
                    className="w-full max-h-[180px] object-cover block"
                  />
                ) : null}

                <div className="p-2.5 flex flex-col gap-1.5">
                  <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)] leading-snug line-clamp-2">
                    {cleanBrokenTextArtifacts(item.title || getDnaHumanLabel(item), true)}
                  </div>
                  {(() => {
                    const cleanBody = cleanBrokenTextArtifacts(
                      stripLeadingTitle(
                        stripMarkdownPreview(item.summary || item.body),
                        item.title,
                      ),
                      true,
                    );
                    return cleanBody ? (
                      <p className="m-0 text-[11.5px] text-[var(--k-ink-secondary)] line-clamp-3 leading-relaxed">
                        {cleanBody}
                      </p>
                    ) : null;
                  })()}

                  {item.colorPalette.length > 0 ? (
                    <div className="flex items-center gap-1">
                      {item.colorPalette.slice(0, 5).map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          title={hex}
                          onClick={(e) => {
                            e.stopPropagation();
                            void window.kapsula.copyText(hex);
                            toast.success(`Цвет ${hex} скопирован`);
                          }}
                          className="w-4 h-4 rounded-full border border-[var(--k-border-strong)] cursor-pointer"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>

                {/* Bottom-right Card Width Resize Handle */}
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0 || connectMode) return;
                    e.stopPropagation();
                    try {
                      canvasRef.current?.setPointerCapture(e.pointerId);
                    } catch {
                      // ignore
                    }
                    cardResizeRef.current = {
                      id: item.id,
                      startX: e.clientX,
                      origW: cardW,
                    };
                  }}
                  title="Потяни, чтобы изменить ширину карточки"
                  className="absolute right-0.5 bottom-0.5 w-3.5 h-3.5 cursor-ew-resize opacity-0 group-hover/bcard:opacity-80 transition-opacity flex items-end justify-end p-0.5"
                >
                  <span className="w-2 h-2 border-r-2 border-b-2 border-[var(--k-ink-muted)] rounded-br-[2px]" />
                </div>
              </div>
            </ContextMenuSurface>
          );
        })}
      </div>
    </div>
  );
};
