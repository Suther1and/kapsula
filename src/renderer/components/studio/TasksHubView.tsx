import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  BookmarkSimple,
  CalendarBlank,
  CheckCircle,
  CheckSquare,
  Clock,
  DotsSixVertical,
  DotsThree,
  Eye,
  EyeSlash,
  Flag,
  Flame,
  FolderSimple,
  Kanban,
  Lightning,
  ListBullets,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  Palette,
  PencilSimple,
  Plus,
  Shapes,
  SlidersHorizontal,
  Sparkle,
  Star,
  Trash,
  Tray,
  X,
} from '@phosphor-icons/react';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
import type {
  CreateTaskInput,
  OrbitDef,
  TaskBoardColumn,
  TaskPriority,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { parseRussianEvent } from '@shared/russian-event-parser';
import {
  type TaskColumnIconId,
  combineTaskDateAndTime,
  computeColumnDropOrder,
  formatTaskDateInputValue,
  formatTaskTimeInputValue,
  getDefaultTaskBoardColumns,
  getTaskColumnIcons,
  isDoneColumn,
  isStandaloneTaskSource,
  localizeTaskBoardColumnTitle,
  resolveColumnIconId,
  sortColumnTasks,
} from '@shared/task-helpers';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { formatReminderStamp, friendlyErrorMessage } from '../../lib/format';
import { playTactileSound } from '../../lib/tactileSound';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { ContextMenuSurface, type ContextMenuEntry } from '../ui/ContextMenuSurface';
import { PopoverSurface } from '../ui/PopoverSurface';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectMenu } from '../ui/SelectMenu';
import { TaskDetailSheet, type TaskMetaUpdatePatch } from './TaskDetailSheet';

export type TasksViewMode = 'list' | 'board';

interface TasksHubViewProps {
  tasks: VaultTaskEntry[];
  orbits: OrbitDef[];
  viewMode?: TasksViewMode;
  onViewModeChange?: (mode: TasksViewMode) => void;
  onToggleTask: (task: VaultTaskEntry) => Promise<void>;
  onScheduleTask?: (itemId: string, remindAt: number | null) => Promise<void>;
  onOpenItem: (itemId: string) => void;
  onAddQuickTask: (text: string, columnId?: string) => Promise<void>;
  onCreateTask?: (input: CreateTaskInput) => Promise<void>;
  scopedOrbitId?: string | null;
  scopedBoardId?: string | null;
  initialShowColumnIcons?: boolean;
  onTasksChanged?: (
    nextTasks?: VaultTaskEntry[],
    updatedItems?: VaultItem[],
    deletedItemIds?: string[]
  ) => void;
}

type GroupMode = 'due' | 'orbit' | 'note';

const TASKS_VIEW_STORAGE_KEY = 'kapsula.tasks.viewMode';
const TASKS_SHOW_COL_ICONS_STORAGE_KEY = 'kapsula.tasks.showColumnIcons';
const TASKS_COL_ICONS_STORAGE_KEY = 'kapsula.tasks.columnIcons';

function readPersistedShowColumnIcons(): boolean {
  try {
    const raw = localStorage.getItem(TASKS_SHOW_COL_ICONS_STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

function readPersistedColumnIcons(): Record<string, TaskColumnIconId> {
  try {
    const raw = localStorage.getItem(TASKS_COL_ICONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, TaskColumnIconId>) : {};
  } catch {
    return {};
  }
}

function writePersistedColumnIcons(map: Record<string, TaskColumnIconId>): void {
  try {
    localStorage.setItem(TASKS_COL_ICONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

function renderColumnGlyph(iconId: TaskColumnIconId, color: string, className = 'w-3.5 h-3.5') {
  const style = { color };
  switch (iconId) {
    case 'tray':
      return <Tray weight="duotone" className={className} style={style} />;
    case 'flame':
      return <Flame weight="duotone" className={className} style={style} />;
    case 'clock':
      return <Clock weight="duotone" className={className} style={style} />;
    case 'check':
      return <CheckCircle weight="duotone" className={className} style={style} />;
    case 'star':
      return <Star weight="duotone" className={className} style={style} />;
    case 'flag':
      return <Flag weight="duotone" className={className} style={style} />;
    case 'lightning':
      return <Lightning weight="duotone" className={className} style={style} />;
    case 'folder':
      return <FolderSimple weight="duotone" className={className} style={style} />;
    case 'bookmark':
      return <BookmarkSimple weight="duotone" className={className} style={style} />;
    case 'sparkles':
      return <Sparkle weight="duotone" className={className} style={style} />;
    case 'none':
    default:
      return <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />;
  }
}

const COLUMN_COLOR_SWATCHES = [
  { hex: '#94A3B8', labelKey: 'tasks.swatch.slate' },
  { hex: '#E86A33', labelKey: 'tasks.swatch.terracotta' },
  { hex: '#F5A524', labelKey: 'tasks.swatch.amber' },
  { hex: '#2EA06B', labelKey: 'tasks.swatch.emerald' },
  { hex: '#3B82F6', labelKey: 'tasks.swatch.cobalt' },
  { hex: '#8B5CF6', labelKey: 'tasks.swatch.violet' },
  { hex: '#EC4899', labelKey: 'tasks.swatch.rose' },
  { hex: '#14B8A6', labelKey: 'tasks.swatch.teal' },
] as const;

const PRIORITY_META = {
  none: {
    labelKey: 'tasks.priority.none',
    dotColor: 'var(--k-ink-muted)',
    textColor: 'var(--k-ink-muted)',
    bgColor: 'var(--k-bg-surface-2)',
  },
  low: {
    labelKey: 'tasks.priority.low',
    dotColor: 'var(--k-info)',
    textColor: 'var(--k-info)',
    bgColor: 'var(--k-info-soft)',
  },
  medium: {
    labelKey: 'tasks.priority.medium',
    dotColor: 'var(--k-amber)',
    textColor: 'var(--k-amber)',
    bgColor: 'var(--k-amber-soft)',
  },
  high: {
    labelKey: 'tasks.priority.high',
    dotColor: 'var(--k-accent)',
    textColor: 'var(--k-accent)',
    bgColor: 'var(--k-accent-soft)',
  },
  urgent: {
    labelKey: 'tasks.priority.urgent',
    dotColor: 'var(--k-danger)',
    textColor: 'var(--k-danger)',
    bgColor: 'var(--k-danger-soft)',
  },
} as const satisfies Record<
  TaskPriority,
  { labelKey: 'tasks.priority.none' | 'tasks.priority.low' | 'tasks.priority.medium' | 'tasks.priority.high' | 'tasks.priority.urgent'; dotColor: string; textColor: string; bgColor: string }
>;

function getCanonicalTaskKey(task: VaultTaskEntry): string {
  return task.taskKey || (task.sourceType === 'voice_action' ? `va:${task.taskIndex}` : `md:${task.taskIndex}`);
}

function getEffectiveDueAt(task: VaultTaskEntry): number | null {
  if (task.dueAt !== undefined) return task.dueAt;
  return task.remindAt ?? null;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function computeDueAtPreset(kind: 'today' | 'tomorrow' | 'week' | 'clear'): number | null {
  if (kind === 'clear') return null;
  const d = new Date();
  if (kind === 'today') {
    d.setHours(Math.max(d.getHours() + 2, 18), 0, 0, 0);
  } else if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 3);
    d.setHours(10, 0, 0, 0);
  }
  return d.getTime();
}

function readPersistedTasksViewMode(): TasksViewMode {
  try {
    return localStorage.getItem(TASKS_VIEW_STORAGE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

interface DragState {
  task: VaultTaskEntry;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  active: boolean;
  targetColumnId: string | null;
  insertIndex: number;
}

export const TasksHubView: React.FC<TasksHubViewProps> = ({
  tasks,
  orbits,
  viewMode: controlledViewMode,
  onViewModeChange,
  onToggleTask,
  onOpenItem,
  onAddQuickTask,
  onCreateTask,
  scopedOrbitId = null,
  scopedBoardId = null,
  initialShowColumnIcons,
  onTasksChanged,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const taskColumnIcons = useMemo(() => getTaskColumnIcons(locale), [locale]);
  const [internalViewMode, setInternalViewMode] = useState<TasksViewMode>(readPersistedTasksViewMode);
  const viewMode = controlledViewMode ?? internalViewMode;

  const setViewMode = (next: TasksViewMode) => {
    setInternalViewMode(next);
    try {
      localStorage.setItem(TASKS_VIEW_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    onViewModeChange?.(next);
  };

  // Board columns from backend (fallback getDefaultTaskBoardColumns(locale))
  const [columns, setColumns] = useState<TaskBoardColumn[]>(() => {
    const savedIcons = readPersistedColumnIcons();
    return getDefaultTaskBoardColumns(locale).map((c) => ({
      ...c,
      icon: savedIcons[c.id] ?? c.icon,
    }));
  });
  const [showColumnIcons, setShowColumnIcons] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(TASKS_SHOW_COL_ICONS_STORAGE_KEY);
      if (raw === '0' || raw === 'false') return false;
      if (raw === '1' || raw === 'true') return true;
    } catch {
      // ignore
    }
    return initialShowColumnIcons ?? readPersistedShowColumnIcons();
  });
  const initialShowColumnIconsRef = useRef(initialShowColumnIcons);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [newColColor, setNewColColor] = useState<string>(COLUMN_COLOR_SWATCHES[4]!.hex);
  const [newColIcon, setNewColIcon] = useState<TaskColumnIconId>('folder');
  const [openColMenuId, setOpenColMenuId] = useState<string | null>(null);
  const [renamingColId, setRenamingColId] = useState<string | null>(null);
  const [renameColDraft, setRenameColDraft] = useState('');

  const addColCardRef = useRef<HTMLDivElement | null>(null);
  const newColInputRef = useRef<HTMLInputElement | null>(null);

  const toggleShowColumnIcons = useCallback(() => {
    setShowColumnIcons((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TASKS_SHOW_COL_ICONS_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      window.kapsula?.updateSettings?.({ showBoardColumnIcons: next }).catch(() => {});
      return next;
    });
  }, []);

  // Quick-add per column & top list quick-add
  const [newTaskText, setNewTaskText] = useState('');
  const [creating, setCreating] = useState(false);
  const [colQuickAddId, setColQuickAddId] = useState<string | null>(null);
  const [colQuickAddText, setColQuickAddText] = useState('');
  const [colCreating, setColCreating] = useState(false);

  // Filters (shared across List & Board modes)
  const [searchFilter, setSearchFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [orbitFilter, setOrbitFilter] = useState<string>('all');
  const [showDone, setShowDone] = useState(true);
  const [listStatusFilter, setListStatusFilter] = useState<'active' | 'today' | 'upcoming' | 'done' | 'all'>('active');
  const [groupBy, setGroupBy] = useState<GroupMode>('due');
  const [openDateTaskId, setOpenDateTaskId] = useState<string | null>(null);
  const [rowCustomDateStr, setRowCustomDateStr] = useState('');
  const [rowCustomTimeStr, setRowCustomTimeStr] = useState('');

  // Quick-add enriched state (only applied when user explicitly picks options or scoped)
  const [quickOrbitOverride, setQuickOrbitOverride] = useState<string | null>(null);
  const [quickPriority, setQuickPriority] = useState<TaskPriority>('none');
  const [quickDueAt, setQuickDueAt] = useState<number | null>(null);
  const [quickColumnId, setQuickColumnId] = useState<string | null>(null);
  const [quickDatePopoverOpen, setQuickDatePopoverOpen] = useState(false);
  const [quickDateStr, setQuickDateStr] = useState('');
  const [quickTimeStr, setQuickTimeStr] = useState('');

  // Detail sheet & Bulk multi-select state
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Column drag-to-reorder state
  const [colDragVisual, setColDragVisual] = useState<{ colId: string; targetIndex: number } | null>(null);
  const colDragRef = useRef<{
    colId: string;
    startX: number;
    active: boolean;
    targetIndex: number;
  } | null>(null);
  const lastOpenColByTaskRef = useRef<Map<string, string>>(new Map());
  const clickDetailTimerRef = useRef<number | null>(null);

  // Inline task rename state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTaskDraft, setEditingTaskDraft] = useState('');

  // Optimistic patch map (keyed by task.id), reconciled per-task when parent `tasks` catches up
  const [optimisticMap, setOptimisticMap] = useState<
    Record<string, Partial<VaultTaskEntry> & { deleted?: boolean }>
  >({});
  const inFlightMutationSeqRef = useRef<Map<string, number>>(new Map());
  const mutationSeqCounterRef = useRef(0);
  useEffect(() => {
    setOptimisticMap((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, Partial<VaultTaskEntry> & { deleted?: boolean }> = {};
      for (const id of keys) {
        if (inFlightMutationSeqRef.current.has(id)) {
          next[id] = prev[id]!;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  // Smoothly scroll the new-column card into view without truncating «Входящие»
  useEffect(() => {
    if (!addingColumn) return;
    const raf = requestAnimationFrame(() => {
      addColCardRef.current?.scrollIntoView({
        behavior: prefersReduced ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'end',
      });
      newColInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [addingColumn, prefersReduced]);

  // Load Kanban columns + icon visibility preference on mount
  useEffect(() => {
    let cancelled = false;
    window.kapsula
      .listTaskBoardColumns()
      .then((cols) => {
        if (!cancelled && Array.isArray(cols) && cols.length > 0) {
          const savedIcons = readPersistedColumnIcons();
          const hydrated = [...cols]
            .sort((a, b) => a.order - b.order)
            .map((c) => ({
              ...c,
              icon: c.icon ?? savedIcons[c.id] ?? resolveColumnIconId(c.icon, c.id, c.isDone),
            }));
          setColumns(hydrated);
        }
      })
      .catch(() => {});

    if (initialShowColumnIconsRef.current === undefined) {
      window.kapsula
        ?.getSettings?.()
        .then((s) => {
          if (!cancelled && typeof s?.showBoardColumnIcons === 'boolean') {
            const hasLocalPref = (() => {
              try {
                return localStorage.getItem(TASKS_SHOW_COL_ICONS_STORAGE_KEY) !== null;
              } catch {
                return false;
              }
            })();
            if (!hasLocalPref) {
              setShowColumnIcons(s.showBoardColumnIcons);
            }
          }
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // Custom Pointer Events Drag-and-Drop refs & state
  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragVisual, setDragVisual] = useState<DragState | null>(null);
  const dragOverlayRef = useRef<HTMLDivElement | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const lastDragEndAtRef = useRef<number>(0);

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);

  const sortedColumns = useMemo(
    () => [...columns].sort((a, b) => a.order - b.order),
    [columns]
  );

  const inboxColId = useMemo(
    () => sortedColumns.find((c) => c.id === 'inbox')?.id ?? sortedColumns.find((c) => !isDoneColumn(c.id, sortedColumns))?.id ?? 'inbox',
    [sortedColumns]
  );
  const doneColId = useMemo(
    () => sortedColumns.find((c) => isDoneColumn(c.id, sortedColumns))?.id ?? 'done',
    [sortedColumns]
  );
  const validColIds = useMemo(() => new Set(sortedColumns.map((c) => c.id)), [sortedColumns]);

  const effectiveTasks = useMemo<VaultTaskEntry[]>(() => {
    const out: VaultTaskEntry[] = [];
    for (const raw of tasks) {
      const patch = optimisticMap[raw.id];
      if (patch?.deleted) continue;
      const merged: VaultTaskEntry = patch ? { ...raw, ...patch } : raw;
      const rawCol = merged.columnId && validColIds.has(merged.columnId) ? merged.columnId : undefined;
      let resolvedCol: string;
      if (merged.done) {
        resolvedCol = rawCol && isDoneColumn(rawCol, sortedColumns) ? rawCol : doneColId;
      } else {
        resolvedCol = rawCol && !isDoneColumn(rawCol, sortedColumns) ? rawCol : inboxColId;
      }
      out.push({
        ...merged,
        columnId: resolvedCol,
        priority: merged.priority ?? 'none',
        boardOrder: merged.boardOrder ?? merged.taskIndex * 1000,
      });
    }
    return out;
  }, [tasks, optimisticMap, validColIds, sortedColumns, doneColId, inboxColId]);

  const scopedTasks = useMemo(() => {
    return effectiveTasks.filter((task) => {
      if (scopedOrbitId && task.orbit !== scopedOrbitId) return false;
      if (scopedBoardId && task.focusBoardId !== scopedBoardId) return false;
      return true;
    });
  }, [effectiveTasks, scopedOrbitId, scopedBoardId]);

  const itemTaskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of effectiveTasks) {
      counts.set(task.itemId, (counts.get(task.itemId) ?? 0) + 1);
    }
    return counts;
  }, [effectiveTasks]);

  const filteredBaseTasks = useMemo(() => {
    const q = searchFilter.trim();
    return scopedTasks.filter((task) => {
      if (priorityFilter !== 'all' && (task.priority ?? 'none') !== priorityFilter) {
        return false;
      }
      if (!scopedOrbitId && !scopedBoardId) {
        if (orbitFilter === '__none__' && task.orbit) {
          return false;
        }
        if (orbitFilter !== 'all' && orbitFilter !== '__none__' && task.orbit !== orbitFilter) {
          return false;
        }
      }
      if (q) {
        const orb = task.orbit ? orbitMap.get(task.orbit) : undefined;
        const hay = [task.text, task.notes ?? '', task.itemTitle, orb?.name ?? ''].join('\n');
        if (!matchesBilingualHaystack(hay, q)) return false;
      }
      return true;
    });
  }, [scopedTasks, priorityFilter, orbitFilter, scopedOrbitId, scopedBoardId, searchFilter, orbitMap]);

  const filteredTasks = useMemo(() => {
    if (viewMode === 'board' && !showDone) {
      return filteredBaseTasks.filter((task) => !task.done);
    }
    return filteredBaseTasks;
  }, [filteredBaseTasks, viewMode, showDone]);

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, VaultTaskEntry[]>();
    for (const col of sortedColumns) {
      map.set(col.id, []);
    }
    for (const task of filteredTasks) {
      const colId = task.columnId && map.has(task.columnId) ? task.columnId : inboxColId;
      map.get(colId)?.push(task);
    }
    for (const [colId, list] of map.entries()) {
      map.set(colId, sortColumnTasks(list));
    }
    return map;
  }, [sortedColumns, filteredTasks, inboxColId]);

  // Ref for reading latest tasksByColumn inside pointerup listener
  const tasksByColumnRef = useRef(tasksByColumn);
  tasksByColumnRef.current = tasksByColumn;

  // Persist columns helper (also preserves per-column icon overrides locally)
  const persistColumns = useCallback(async (nextCols: TaskBoardColumn[]) => {
    const normalized = nextCols.map((c, i) => ({
      ...c,
      order: i,
      icon: resolveColumnIconId(c.icon, c.id, c.isDone),
    }));
    const iconMap: Record<string, TaskColumnIconId> = {};
    for (const col of normalized) {
      iconMap[col.id] = resolveColumnIconId(col.icon, col.id, col.isDone);
    }
    writePersistedColumnIcons(iconMap);
    setColumns(normalized);
    try {
      const saved = await window.kapsula.saveTaskBoardColumns(normalized);
      if (Array.isArray(saved) && saved.length > 0) {
        setColumns(
          [...saved]
            .sort((a, b) => a.order - b.order)
            .map((c) => ({
              ...c,
              icon: c.icon ?? iconMap[c.id] ?? resolveColumnIconId(c.icon, c.id, c.isDone),
            }))
        );
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('tasks.err.saveColumns'), locale));
    }
  }, [t, locale]);

  const handleMoveTaskToColumn = useCallback(
    async (task: VaultTaskEntry, targetColumnId: string, boardOrder?: number) => {
      const taskKey = getCanonicalTaskKey(task);
      const targetDone = isDoneColumn(targetColumnId, sortedColumns);
      const colCards = (tasksByColumnRef.current.get(targetColumnId) ?? []).filter((t) => t.id !== task.id);
      const resolvedOrder =
        typeof boardOrder === 'number'
          ? boardOrder
          : colCards.length > 0
            ? (colCards[colCards.length - 1]!.boardOrder ?? colCards.length * 1000) + 1000
            : 1000;

      const moveSeq = ++mutationSeqCounterRef.current;
      inFlightMutationSeqRef.current.set(task.id, moveSeq);
      setOptimisticMap((prev) => ({
        ...prev,
        [task.id]: {
          ...prev[task.id],
          columnId: targetColumnId,
          boardOrder: resolvedOrder,
          done: targetDone,
        },
      }));

      try {
        await window.kapsula.moveTaskOnBoard({
          itemId: task.itemId,
          taskKey,
          columnId: targetColumnId,
          boardOrder: resolvedOrder,
        });
        if (inFlightMutationSeqRef.current.get(task.id) === moveSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
        }
        onTasksChanged?.();
      } catch (err) {
        if (inFlightMutationSeqRef.current.get(task.id) === moveSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
          setOptimisticMap((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
        toast.error(friendlyErrorMessage(err, t('tasks.err.moveTask'), locale));
      }
    },
    [sortedColumns, onTasksChanged, t, locale]
  );

  const handleToggleWithUndo = useCallback(
    async (task: VaultTaskEntry) => {
      const wasDone = task.done;
      const nextDone = !wasDone;
      if (!wasDone && task.columnId && !isDoneColumn(task.columnId, sortedColumns)) {
        lastOpenColByTaskRef.current.set(task.id, task.columnId);
      }
      const prevColId =
        task.columnId && !isDoneColumn(task.columnId, sortedColumns)
          ? task.columnId
          : (lastOpenColByTaskRef.current.get(task.id) ?? inboxColId);
      const restoreOpenCol = lastOpenColByTaskRef.current.get(task.id) ?? inboxColId;
      const seq = ++mutationSeqCounterRef.current;

      inFlightMutationSeqRef.current.set(task.id, seq);
      setOptimisticMap((prev) => ({
        ...prev,
        [task.id]: {
          ...prev[task.id],
          done: nextDone,
          columnId: nextDone ? doneColId : restoreOpenCol,
        },
      }));

      try {
        await onToggleTask(task);
        if (inFlightMutationSeqRef.current.get(task.id) === seq) {
          inFlightMutationSeqRef.current.delete(task.id);
        }
        if (!wasDone) {
          toast(t('tasks.toast.done'), {
            action: {
              label: t('common.undo'),
              onClick: () => {
                const undoSeq = ++mutationSeqCounterRef.current;
                inFlightMutationSeqRef.current.set(task.id, undoSeq);
                setOptimisticMap((prev) => ({
                  ...prev,
                  [task.id]: {
                    ...prev[task.id],
                    done: false,
                    columnId: prevColId,
                  },
                }));
                void onToggleTask({ ...task, done: true })
                  .then(() => {
                    if (inFlightMutationSeqRef.current.get(task.id) === undoSeq) {
                      inFlightMutationSeqRef.current.delete(task.id);
                    }
                  })
                  .catch(() => {
                    if (inFlightMutationSeqRef.current.get(task.id) === undoSeq) {
                      inFlightMutationSeqRef.current.delete(task.id);
                      setOptimisticMap((prev) => {
                        const next = { ...prev };
                        delete next[task.id];
                        return next;
                      });
                    }
                  });
              },
            },
          });
        }
      } catch {
        if (inFlightMutationSeqRef.current.get(task.id) === seq) {
          inFlightMutationSeqRef.current.delete(task.id);
          setOptimisticMap((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
      }
    },
    [onToggleTask, doneColId, inboxColId, sortedColumns, t]
  );

  const applyTaskMetaMutation = useCallback(
    async (
      task: VaultTaskEntry,
      optimisticPatch: Partial<VaultTaskEntry>,
      apiPatch: TaskMetaUpdatePatch,
      errKey:
        | 'tasks.err.updatePriority'
        | 'tasks.err.updateDue'
        | 'tasks.err.updateOrbit'
        | 'tasks.err.updateNotes',
      successMsg?: string
    ) => {
      const taskKey = getCanonicalTaskKey(task);
      const seq = ++mutationSeqCounterRef.current;
      let prevSnapshot: (Partial<VaultTaskEntry> & { deleted?: boolean }) | undefined;
      inFlightMutationSeqRef.current.set(task.id, seq);
      setOptimisticMap((prev) => {
        prevSnapshot = prev[task.id];
        return {
          ...prev,
          [task.id]: { ...prev[task.id], ...optimisticPatch },
        };
      });
      try {
        await window.kapsula.updateTaskMeta({
          itemId: task.itemId,
          taskKey,
          ...apiPatch,
        });
        if (inFlightMutationSeqRef.current.get(task.id) === seq) {
          inFlightMutationSeqRef.current.delete(task.id);
        }
        if (successMsg) toast.success(successMsg);
        onTasksChanged?.();
      } catch (err) {
        if (inFlightMutationSeqRef.current.get(task.id) === seq) {
          inFlightMutationSeqRef.current.delete(task.id);
          setOptimisticMap((prev) => {
            const next = { ...prev };
            if (prevSnapshot) next[task.id] = prevSnapshot;
            else delete next[task.id];
            return next;
          });
        }
        toast.error(friendlyErrorMessage(err, t(errKey), locale));
      }
    },
    [onTasksChanged, t, locale]
  );

  const handleUpdatePriority = useCallback(
    (task: VaultTaskEntry, priority: TaskPriority) =>
      applyTaskMetaMutation(task, { priority }, { priority }, 'tasks.err.updatePriority'),
    [applyTaskMetaMutation]
  );

  const handleUpdateDueAt = useCallback(
    (task: VaultTaskEntry, target: 'today' | 'tomorrow' | 'week' | 'clear' | number | null) => {
      setOpenDateTaskId(null);
      const dueAt = typeof target === 'string' ? computeDueAtPreset(target) : target;
      return applyTaskMetaMutation(
        task,
        { dueAt },
        { dueAt },
        'tasks.err.updateDue',
        dueAt ? t('tasks.toast.dueUpdated') : t('tasks.toast.dueCleared')
      );
    },
    [applyTaskMetaMutation, t]
  );

  const handleUpdateOrbit = useCallback(
    (task: VaultTaskEntry, nextOrbit: string) =>
      applyTaskMetaMutation(
        task,
        { orbit: nextOrbit },
        { orbit: nextOrbit },
        'tasks.err.updateOrbit',
        t('tasks.toast.orbitUpdated')
      ),
    [applyTaskMetaMutation, t]
  );

  const handleCommitRenameText = useCallback(
    async (task: VaultTaskEntry, rawNextText: string) => {
      const clean = rawNextText.replace(/[\r\n]+/g, ' ').trim();
      setEditingTaskId(null);
      if (!clean || clean === task.text) return;
      const taskKey = getCanonicalTaskKey(task);
      const renameSeq = ++mutationSeqCounterRef.current;
      inFlightMutationSeqRef.current.set(task.id, renameSeq);
      setOptimisticMap((prev) => ({
        ...prev,
        [task.id]: { ...prev[task.id], text: clean },
      }));
      try {
        await window.kapsula.updateVaultTaskText({
          itemId: task.itemId,
          taskKey,
          text: clean,
        });
        if (inFlightMutationSeqRef.current.get(task.id) === renameSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
        }
        onTasksChanged?.();
      } catch (err) {
        if (inFlightMutationSeqRef.current.get(task.id) === renameSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
          setOptimisticMap((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
        toast.error(friendlyErrorMessage(err, t('tasks.err.rename'), locale));
      }
    },
    [onTasksChanged, t, locale]
  );

  const handleCommitRename = useCallback(
    (task: VaultTaskEntry) => handleCommitRenameText(task, editingTaskDraft),
    [editingTaskDraft, handleCommitRenameText]
  );

  const handleSheetUpdateMeta = useCallback(
    async (task: VaultTaskEntry, patch: TaskMetaUpdatePatch) => {
      if (patch.columnId && patch.columnId !== task.columnId) {
        await handleMoveTaskToColumn(task, patch.columnId);
        return;
      }
      const optPatch: Partial<VaultTaskEntry> = {};
      if (patch.priority !== undefined) optPatch.priority = patch.priority;
      if (patch.dueAt !== undefined) optPatch.dueAt = patch.dueAt;
      if (patch.orbit !== undefined) optPatch.orbit = patch.orbit ?? '';
      if (patch.notes !== undefined) optPatch.notes = patch.notes ?? undefined;
      const errKey =
        patch.notes !== undefined
          ? 'tasks.err.updateNotes'
          : patch.orbit !== undefined
            ? 'tasks.err.updateOrbit'
            : patch.dueAt !== undefined
              ? 'tasks.err.updateDue'
              : 'tasks.err.updatePriority';
      await applyTaskMetaMutation(task, optPatch, patch, errKey);
    },
    [applyTaskMetaMutation, handleMoveTaskToColumn]
  );

  const handleDeleteTask = useCallback(
    async (task: VaultTaskEntry) => {
      const taskKey = getCanonicalTaskKey(task);
      const deleteSeq = ++mutationSeqCounterRef.current;
      inFlightMutationSeqRef.current.set(task.id, deleteSeq);
      setOptimisticMap((prev) => ({
        ...prev,
        [task.id]: { deleted: true },
      }));
      try {
        await window.kapsula.deleteVaultTask({
          itemId: task.itemId,
          taskKey,
        });
        if (inFlightMutationSeqRef.current.get(task.id) === deleteSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
        }
        toast.success(t('tasks.toast.deleted'));
        onTasksChanged?.();
      } catch (err) {
        if (inFlightMutationSeqRef.current.get(task.id) === deleteSeq) {
          inFlightMutationSeqRef.current.delete(task.id);
          setOptimisticMap((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
        toast.error(friendlyErrorMessage(err, t('tasks.err.delete'), locale));
      }
    },
    [onTasksChanged, t, locale]
  );

  // Column CRUD handlers
  const handleAddColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newColTitle.trim();
    if (!title) return;
    const id = `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const nextCols: TaskBoardColumn[] = [
      ...sortedColumns,
      { id, title, color: newColColor, order: sortedColumns.length, icon: newColIcon },
    ];
    setAddingColumn(false);
    setNewColTitle('');
    setNewColIcon('folder');
    await persistColumns(nextCols);
    requestAnimationFrame(() => {
      const scroller = boardScrollRef.current;
      if (scroller) {
        scroller.scrollTo({
          left: scroller.scrollWidth,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      }
    });
    toast.success(t('tasks.toast.colAdded', { title }));
  };

  const handleCommitRenameColumn = async (colId: string) => {
    const clean = renameColDraft.trim();
    setRenamingColId(null);
    if (!clean) return;
    const nextCols = sortedColumns.map((c) => (c.id === colId ? { ...c, title: clean } : c));
    await persistColumns(nextCols);
  };

  const handleRecolorColumn = async (colId: string, color: string) => {
    const nextCols = sortedColumns.map((c) => (c.id === colId ? { ...c, color } : c));
    await persistColumns(nextCols);
  };

  const handleChangeColumnIcon = async (colId: string, icon: TaskColumnIconId) => {
    const nextCols = sortedColumns.map((c) => (c.id === colId ? { ...c, icon } : c));
    await persistColumns(nextCols);
  };

  const handleStepColumn = async (colId: string, delta: -1 | 1) => {
    const idx = sortedColumns.findIndex((c) => c.id === colId);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= sortedColumns.length) return;
    const copy = [...sortedColumns];
    const [moved] = copy.splice(idx, 1);
    if (!moved) return;
    copy.splice(target, 0, moved);
    setOpenColMenuId(null);
    await persistColumns(copy);
  };

  const handleDeleteColumn = async (col: TaskBoardColumn) => {
    if (col.id === 'inbox' || isDoneColumn(col.id, sortedColumns) || sortedColumns.length <= 2) {
      return;
    }
    setOpenColMenuId(null);
    const affected = tasksByColumn.get(col.id) ?? [];
    // Serialize moves sequentially so tasks sharing the same parent note never overwrite each other's media_meta_json
    for (let idx = 0; idx < affected.length; idx++) {
      const tEntry = affected[idx]!;
      await window.kapsula.moveTaskOnBoard({
        itemId: tEntry.itemId,
        taskKey: getCanonicalTaskKey(tEntry),
        columnId: inboxColId,
        boardOrder: Date.now() + idx * 10,
      });
    }
    const nextCols = sortedColumns.filter((c) => c.id !== col.id);
    await persistColumns(nextCols);
    onTasksChanged?.();
    toast.success(t('tasks.toast.colDeleted', { title: localizeTaskBoardColumnTitle(col, locale) }));
  };

  // Hit-testing columns and card midpoints during custom Pointer Events DnD
  const computeDropTarget = useCallback((clientX: number, clientY: number, draggedId: string) => {
    const colEls = document.querySelectorAll<HTMLElement>('[data-kanban-col-id]');
    let targetColumnId: string | null = null;
    let targetColEl: HTMLElement | null = null;

    for (const el of colEls) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top - 40 && clientY <= rect.bottom + 80) {
        targetColumnId = el.dataset.kanbanColId ?? null;
        targetColEl = el;
        break;
      }
    }

    if (!targetColumnId || !targetColEl) {
      return { targetColumnId: null, insertIndex: 0 };
    }

    const cardEls = Array.from(targetColEl.querySelectorAll<HTMLElement>('[data-kanban-card-id]')).filter(
      (el) => el.dataset.kanbanCardId !== draggedId
    );
    let insertIndex = cardEls.length;
    for (let i = 0; i < cardEls.length; i += 1) {
      const rect = cardEls[i]!.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) {
        insertIndex = i;
        break;
      }
    }
    return { targetColumnId, insertIndex };
  }, []);

  const stopMoveRaf = useCallback(() => {
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const startAutoScrollLoop = useCallback(() => {
    stopAutoScroll();
    const tick = () => {
      const st = dragRef.current;
      const scroller = boardScrollRef.current;
      if (!st || !st.active || !scroller) {
        autoScrollRafRef.current = null;
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const edgeZone = 76;
      const pointerX = st.x + st.offsetX;
      if (pointerX < rect.left + edgeZone) {
        const ratio = Math.max(0, (rect.left + edgeZone - pointerX) / edgeZone);
        scroller.scrollLeft -= Math.ceil(12 * ratio + 2);
      } else if (pointerX > rect.right - edgeZone) {
        const ratio = Math.max(0, (pointerX - (rect.right - edgeZone)) / edgeZone);
        scroller.scrollLeft += Math.ceil(12 * ratio + 2);
      }
      autoScrollRafRef.current = requestAnimationFrame(tick);
    };
    autoScrollRafRef.current = requestAnimationFrame(tick);
  }, [stopAutoScroll]);

  const handleCardPointerDown = (e: React.PointerEvent<HTMLDivElement>, task: VaultTaskEntry) => {
    if (e.button !== 0) return;
    if (editingTaskId === task.id) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, a, [role="checkbox"], [data-no-drag="true"]')) {
      return;
    }

    const cardEl = e.currentTarget;
    const rect = cardEl.getBoundingClientRect();
    const pointerId = e.pointerId;
    const initial: DragState = {
      task,
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: rect.left,
      y: rect.top,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      active: false,
      targetColumnId: task.columnId ?? inboxColId,
      insertIndex: 0,
    };
    dragRef.current = initial;

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || ev.pointerId !== cur.pointerId) return;
      const dx = ev.clientX - cur.startX;
      const dy = ev.clientY - cur.startY;
      const justActivated = !cur.active;
      if (justActivated) {
        if (Math.hypot(dx, dy) < 6) return;
        cur.active = true;
        try {
          cardEl.setPointerCapture(ev.pointerId);
        } catch {
          // ignore if capture unavailable
        }
        startAutoScrollLoop();
      }
      cur.x = ev.clientX - cur.offsetX;
      cur.y = ev.clientY - cur.offsetY;
      if (justActivated) {
        const hit = computeDropTarget(ev.clientX, ev.clientY, cur.task.id);
        cur.targetColumnId = hit.targetColumnId;
        cur.insertIndex = hit.insertIndex;
        setDragVisual({ ...cur });
      }
      if (moveRafRef.current === null) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = null;
          const active = dragRef.current;
          if (!active || !active.active) return;
          if (dragOverlayRef.current) {
            dragOverlayRef.current.style.transform = `translate3d(${active.x}px, ${active.y}px, 0) scale(1.02) rotate(0.5deg)`;
          }
          const hit = computeDropTarget(
            active.x + active.offsetX,
            active.y + active.offsetY,
            active.task.id
          );
          if (
            hit.targetColumnId !== active.targetColumnId ||
            hit.insertIndex !== active.insertIndex
          ) {
            active.targetColumnId = hit.targetColumnId;
            active.insertIndex = hit.insertIndex;
            setDragVisual({ ...active });
          }
        });
      }
    };

    const finishDrag = (ev: PointerEvent, cancelled: boolean) => {
      const cur = dragRef.current;
      if (!cur || ev.pointerId !== cur.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      stopMoveRaf();
      stopAutoScroll();
      try {
        if (cardEl.hasPointerCapture(ev.pointerId)) {
          cardEl.releasePointerCapture(ev.pointerId);
        }
      } catch {
        // ignore
      }

      const wasActive = cur.active;
      const targetColId = cur.targetColumnId;
      const insertIdx = cur.insertIndex;
      const draggedTask = cur.task;

      dragRef.current = null;
      setDragVisual(null);

      if (wasActive) {
        lastDragEndAtRef.current = Date.now();
      }

      if (!cancelled && wasActive && targetColId) {
        const siblings = (tasksByColumnRef.current.get(targetColId) ?? []).filter(
          (t) => t.id !== draggedTask.id
        );
        const nextOrder = computeColumnDropOrder(siblings, insertIdx);
        playTactileSound('soft');
        void handleMoveTaskToColumn(draggedTask, targetColId, nextOrder);
      }
    };

    const onUp = (ev: PointerEvent) => finishDrag(ev, false);
    const onCancel = (ev: PointerEvent) => finishDrag(ev, true);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  useEffect(
    () => () => {
      stopAutoScroll();
      stopMoveRaf();
    },
    [stopAutoScroll, stopMoveRaf]
  );

  // Task Right-Click Context Menu
  const buildTaskContextMenu = (task: VaultTaskEntry): ContextMenuEntry[] => [
    {
      type: 'item',
      id: 'open-details',
      label: t('tasks.ctx.openDetails'),
      icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
      onSelect: () => setSelectedTaskId(task.id),
    },
    {
      type: 'submenu',
      id: 'move-col',
      label: t('tasks.ctx.moveToColumn'),
      icon: <Kanban className="w-3.5 h-3.5" />,
      items: sortedColumns.map((col) => ({
        type: 'item',
        id: `col-${col.id}`,
        label: localizeTaskBoardColumnTitle(col, locale),
        dotColor: col.color,
        active: task.columnId === col.id,
        onSelect: () => void handleMoveTaskToColumn(task, col.id),
      })),
    },
    {
      type: 'submenu',
      id: 'move-section',
      label: t('tasks.ctx.moveToSection'),
      icon: <FolderSimple className="w-3.5 h-3.5" />,
      items: [
        {
          type: 'item',
          id: 'orbit-none',
          label: t('tasks.ctx.noSection'),
          active: !task.orbit,
          onSelect: () => void handleUpdateOrbit(task, ''),
        },
        ...orbits.map((orb) => ({
          type: 'item' as const,
          id: `orbit-${orb.id}`,
          label: orb.name,
          dotColor: orb.color,
          active: task.orbit === orb.id,
          onSelect: () => void handleUpdateOrbit(task, orb.id),
        })),
      ],
    },
    {
      type: 'submenu',
      id: 'priority',
      label: t('tasks.ctx.priority'),
      icon: <Flag className="w-3.5 h-3.5" />,
      items: (['urgent', 'high', 'medium', 'low', 'none'] as TaskPriority[]).map((p) => ({
        type: 'item',
        id: `prio-${p}`,
        label: t(PRIORITY_META[p].labelKey),
        dotColor: PRIORITY_META[p].dotColor,
        active: (task.priority ?? 'none') === p,
        onSelect: () => void handleUpdatePriority(task, p),
      })),
    },
    {
      type: 'submenu',
      id: 'due',
      label: t('tasks.ctx.due'),
      icon: <CalendarBlank className="w-3.5 h-3.5" />,
      items: [
        {
          type: 'item',
          id: 'due-today',
          label: t('tasks.ctx.tonight'),
          onSelect: () => void handleUpdateDueAt(task, 'today'),
        },
        {
          type: 'item',
          id: 'due-tomorrow',
          label: t('tasks.ctx.tomorrow10'),
          onSelect: () => void handleUpdateDueAt(task, 'tomorrow'),
        },
        {
          type: 'item',
          id: 'due-week',
          label: t('tasks.ctx.in3Days'),
          onSelect: () => void handleUpdateDueAt(task, 'week'),
        },
        ...(getEffectiveDueAt(task)
          ? [
              { type: 'separator' as const, id: 'due-sep' },
              {
                type: 'item' as const,
                id: 'due-clear',
                label: t('tasks.ctx.clearDue'),
                danger: true,
                onSelect: () => void handleUpdateDueAt(task, 'clear'),
              },
            ]
          : []),
      ],
    },
    { type: 'separator', id: 'sep-1' },
    {
      type: 'item',
      id: 'rename',
      label: t('common.rename'),
      icon: <PencilSimple className="w-3.5 h-3.5" />,
      onSelect: () => {
        setEditingTaskId(task.id);
        setEditingTaskDraft(task.text);
      },
    },
    {
      type: 'item',
      id: 'open-note',
      label: t('cards.openNote'),
      icon: <ArrowSquareOut className="w-3.5 h-3.5" />,
      onSelect: () => onOpenItem(task.itemId),
    },
    { type: 'separator', id: 'sep-2' },
    {
      type: 'item',
      id: 'delete',
      label: t('tasks.ctx.deleteTask'),
      icon: <Trash className="w-3.5 h-3.5" />,
      danger: true,
      onSelect: () => void handleDeleteTask(task),
    },
  ];

  // List view derived collections & filtered counters
  const activeFilteredTasks = useMemo(() => filteredBaseTasks.filter((t) => !t.done), [filteredBaseTasks]);
  const doneFilteredTasks = useMemo(() => filteredBaseTasks.filter((t) => t.done), [filteredBaseTasks]);

  const { todayFilteredTasks, upcomingFilteredTasks } = useMemo(() => {
    const todayEnd = startOfTodayMs() + 86_400_000;
    const todayArr: VaultTaskEntry[] = [];
    const upcomingArr: VaultTaskEntry[] = [];
    for (const task of activeFilteredTasks) {
      const due = getEffectiveDueAt(task);
      if (due === null) continue;
      if (due < todayEnd) todayArr.push(task);
      else upcomingArr.push(task);
    }
    return { todayFilteredTasks: todayArr, upcomingFilteredTasks: upcomingArr };
  }, [activeFilteredTasks]);

  const listDisplayed = useMemo(() => {
    if (!showDone) return activeFilteredTasks;
    if (listStatusFilter === 'active') return activeFilteredTasks;
    if (listStatusFilter === 'today') return todayFilteredTasks;
    if (listStatusFilter === 'upcoming') return upcomingFilteredTasks;
    if (listStatusFilter === 'done') return doneFilteredTasks;
    return [...activeFilteredTasks, ...doneFilteredTasks];
  }, [
    activeFilteredTasks,
    todayFilteredTasks,
    upcomingFilteredTasks,
    doneFilteredTasks,
    listStatusFilter,
    showDone,
  ]);

  const effectiveQuickOrbit =
    scopedOrbitId ??
    (quickOrbitOverride !== null
      ? quickOrbitOverride
      : orbitFilter !== 'all' && orbitFilter !== '__none__'
        ? orbitFilter
        : '');

  const handleCreateTopTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newTaskText.trim();
    if (!clean || creating) return;
    setCreating(true);
    try {
      const targetCol = quickColumnId ?? inboxColId;
      if (onCreateTask) {
        let resolvedDueAt = quickDueAt;
        let resolvedTitle = clean;
        if (resolvedDueAt === null) {
          const parsed = parseRussianEvent(clean);
          if (parsed && parsed.startAt > 0) {
            resolvedDueAt = parsed.startAt;
            if (parsed.title && parsed.title.trim().length >= 2) {
              resolvedTitle = parsed.title.trim();
            }
          }
        }
        await onCreateTask({
          text: resolvedTitle,
          orbit: effectiveQuickOrbit,
          focusBoardId: scopedBoardId ?? null,
          columnId: targetCol,
          priority: quickPriority,
          dueAt: resolvedDueAt,
        });
      } else {
        await onAddQuickTask(clean, targetCol);
      }
      setNewTaskText('');
      setQuickDueAt(null);
      setQuickDateStr('');
      setQuickTimeStr('');
      setQuickPriority('none');
      setQuickColumnId(null);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('tasks.create.error'), locale));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateColumnTask = async (e: React.FormEvent, columnId: string) => {
    e.preventDefault();
    const clean = colQuickAddText.trim();
    if (!clean || colCreating) return;
    setColCreating(true);
    try {
      if (onCreateTask) {
        await onCreateTask({
          text: clean,
          orbit: effectiveQuickOrbit,
          focusBoardId: scopedBoardId ?? null,
          columnId,
          priority: 'none',
          dueAt: null,
        });
      } else {
        await onAddQuickTask(clean, columnId);
      }
      setColQuickAddText('');
      setColQuickAddId(null);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('tasks.create.error'), locale));
    } finally {
      setColCreating(false);
    }
  };

  const toggleBulkSelect = (taskId: string) => {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const handleBulkToggleDone = async (markDone: boolean) => {
    const targets = listDisplayed.filter((tk) => selectedTaskIds.includes(tk.id) && tk.done !== markDone);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await window.kapsula.bulkToggleTasks(
        targets.map((taskItem) => ({
          itemId: taskItem.itemId,
          sourceType: taskItem.sourceType,
          taskIndex: taskItem.taskIndex,
          done: markDone,
        }))
      );
      setSelectedTaskIds([]);
      toast.success(
        t(markDone ? 'tasks.toast.bulkCompleted' : 'tasks.toast.bulkReopened', {
          count: targets.length,
        })
      );
      onTasksChanged?.(res.tasks, res.updatedItems);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkUpdateMeta = async (patch: { orbit?: string; priority?: TaskPriority }) => {
    const targets = listDisplayed.filter((tk) => selectedTaskIds.includes(tk.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await window.kapsula.bulkUpdateTasksMeta({
        tasks: targets.map((taskItem) => ({
          itemId: taskItem.itemId,
          taskKey: getCanonicalTaskKey(taskItem),
        })),
        ...patch,
      });
      setSelectedTaskIds([]);
      toast.success(t('tasks.toast.bulkMoved', { count: targets.length }));
      onTasksChanged?.(res.tasks, res.updatedItems);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    const targets = listDisplayed.filter((tk) => selectedTaskIds.includes(tk.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await window.kapsula.bulkDeleteTasks(
        targets.map((taskItem) => ({
          itemId: taskItem.itemId,
          taskKey: getCanonicalTaskKey(taskItem),
        }))
      );
      setSelectedTaskIds([]);
      toast.success(t('tasks.toast.bulkDeleted', { count: targets.length }));
      onTasksChanged?.(res.tasks, res.updatedItems, res.deletedItemIds);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('tasks.err.delete'), locale));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleColumnHeaderPointerDown = (e: React.PointerEvent<HTMLElement>, colId: string) => {
    if (e.button !== 0 || sortedColumns.length <= 1) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startIndex = sortedColumns.findIndex((c) => c.id === colId);
    if (startIndex < 0) return;
    colDragRef.current = { colId, startX, active: false, targetIndex: startIndex };

    const computeTargetColIndex = (clientX: number): number => {
      const container = boardScrollRef.current;
      if (!container) return startIndex;
      const colEls = Array.from(
        container.querySelectorAll<HTMLElement>('[data-kanban-col-id]')
      );
      let idx = 0;
      for (const el of colEls) {
        const id = el.dataset.kanbanColId;
        if (!id) continue;
        const rect = el.getBoundingClientRect();
        if (clientX > rect.left + rect.width / 2) {
          idx += 1;
        }
      }
      return Math.max(0, Math.min(sortedColumns.length - 1, idx));
    };

    const onMove = (ev: PointerEvent) => {
      const cur = colDragRef.current;
      if (!cur) return;
      if (!cur.active && Math.abs(ev.clientX - cur.startX) < 8) return;
      cur.active = true;
      const targetIndex = computeTargetColIndex(ev.clientX);
      if (!cur || cur.targetIndex !== targetIndex || !colDragVisual) {
        cur.targetIndex = targetIndex;
        setColDragVisual({ colId: cur.colId, targetIndex });
      }
    };

    const cleanup = (ev: PointerEvent, commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      const cur = colDragRef.current;
      colDragRef.current = null;
      setColDragVisual(null);
      if (!commit || !cur?.active) return;
      const fromIdx = sortedColumns.findIndex((c) => c.id === cur.colId);
      const toIdx = computeTargetColIndex(ev.clientX);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const next = [...sortedColumns];
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return;
      next.splice(toIdx, 0, moved);
      void persistColumns(next);
    };

    const onUp = (ev: PointerEvent) => cleanup(ev, true);
    const onCancel = (ev: PointerEvent) => cleanup(ev, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const listGrouped = useMemo<
    Array<{ key: string; label: string; accent?: string; color?: string; items: VaultTaskEntry[] }>
  >(() => {
    if (listStatusFilter === 'done' && showDone) {
      return listDisplayed.length > 0
        ? [{ key: 'done', label: t('tasks.group.done'), accent: 'var(--k-emerald)', items: listDisplayed }]
        : [];
    }

    if (groupBy === 'orbit') {
      const buckets = new Map<
        string,
        { key: string; label: string; accent?: string; color?: string; items: VaultTaskEntry[] }
      >();
      for (const taskItem of listDisplayed) {
        const orb = taskItem.orbit ? orbitMap.get(taskItem.orbit) : undefined;
        const key = orb ? orb.id : '__none__';
        if (!buckets.has(key)) {
          buckets.set(key, {
            key,
            label: orb ? orb.name : t('nav.noSection'),
            color: orb?.color,
            items: [],
          });
        }
        buckets.get(key)!.items.push(taskItem);
      }
      return Array.from(buckets.values());
    }

    if (groupBy === 'note') {
      const buckets = new Map<
        string,
        { key: string; label: string; accent?: string; color?: string; items: VaultTaskEntry[] }
      >();
      for (const taskItem of listDisplayed) {
        const orb = taskItem.orbit ? orbitMap.get(taskItem.orbit) : undefined;
        const key = taskItem.itemId || '__standalone__';
        if (!buckets.has(key)) {
          buckets.set(key, {
            key,
            label: taskItem.itemTitle || t('common.untitled'),
            color: orb?.color,
            items: [],
          });
        }
        buckets.get(key)!.items.push(taskItem);
      }
      return Array.from(buckets.values());
    }

    const todayStart = startOfTodayMs();
    const tomorrowStart = todayStart + 86_400_000;
    const overdue: VaultTaskEntry[] = [];
    const today: VaultTaskEntry[] = [];
    const upcoming: VaultTaskEntry[] = [];
    const nodate: VaultTaskEntry[] = [];

    for (const taskItem of listDisplayed) {
      const due = getEffectiveDueAt(taskItem);
      if (!due) {
        nodate.push(taskItem);
      } else if (due < todayStart && !taskItem.done) {
        overdue.push(taskItem);
      } else if (due < tomorrowStart) {
        today.push(taskItem);
      } else {
        upcoming.push(taskItem);
      }
    }

    const out: Array<{ key: string; label: string; accent?: string; color?: string; items: VaultTaskEntry[] }> = [];
    if (overdue.length > 0) out.push({ key: 'overdue', label: t('tasks.group.overdue'), accent: 'var(--k-danger)', items: overdue });
    if (today.length > 0) out.push({ key: 'today', label: t('tasks.group.today'), accent: 'var(--k-accent)', items: today });
    if (upcoming.length > 0) out.push({ key: 'upcoming', label: t('tasks.group.upcoming'), accent: 'var(--k-amber)', items: upcoming });
    if (nodate.length > 0) out.push({ key: 'nodate', label: t('tasks.group.nodate'), items: nodate });
    return out;
  }, [listDisplayed, listStatusFilter, showDone, groupBy, orbitMap, t]);

  // End of derived list & Kanban handlers

  const renderDueBadge = (task: VaultTaskEntry) => {
    const due = getEffectiveDueAt(task);
    if (!due) return null;
    const todayStart = startOfTodayMs();
    const tomorrowStart = todayStart + 86_400_000;
    const isOverdue = !task.done && due < todayStart;
    const isToday = !task.done && due >= todayStart && due < tomorrowStart;

    const toneClass = isOverdue
      ? 'bg-[var(--k-danger-soft)] text-[var(--k-danger)]'
      : isToday
        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
        : 'bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]';

    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium k-tabular ${toneClass}`}>
        <CalendarBlank weight={isOverdue || isToday ? 'fill' : 'regular'} className="w-3 h-3 shrink-0" />
        <span>{formatReminderStamp(due, locale)}</span>
      </span>
    );
  };

  const renderPriorityPill = (priority?: TaskPriority) => {
    if (!priority || priority === 'none') return null;
    const meta = PRIORITY_META[priority];
    return (
      <span
        style={{ backgroundColor: meta.bgColor, color: meta.textColor }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium shrink-0"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: meta.dotColor }} />
        <span>{t(meta.labelKey)}</span>
      </span>
    );
  };

  const renderKanbanCardBody = (task: VaultTaskEntry, isOverlay = false) => {
    const orbit = task.orbit ? orbitMap.get(task.orbit) : undefined;
    const isEditing = !isOverlay && editingTaskId === task.id;
    const priority = task.priority ?? 'none';
    const dueAt = getEffectiveDueAt(task);
    const tasksInItem = itemTaskCounts.get(task.itemId) ?? 1;
    const showSourceChip = !isStandaloneTaskSource(task, tasksInItem);
    const hasMetaRow = priority !== 'none' || Boolean(dueAt) || Boolean(orbit) || showSourceChip;

    return (
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-start gap-2.5 min-w-0">
          <div data-no-drag="true" className="mt-0.5 shrink-0">
            <AnimatedCheckbox
              size="sm"
              checked={task.done}
              onChange={() => void handleToggleWithUndo(task)}
              data-testid={`task-toggle-${task.id}`}
              label={task.done ? t('tasks.markUndone') : t('tasks.markDone')}
            />
          </div>

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <input
                autoFocus
                data-no-drag="true"
                value={editingTaskDraft}
                onChange={(e) => setEditingTaskDraft(e.target.value)}
                onBlur={() => void handleCommitRename(task)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCommitRename(task);
                  } else if (e.key === 'Escape') {
                    setEditingTaskId(null);
                  }
                }}
                className="w-full px-2 py-1 rounded-lg border border-[var(--k-border-focus)] bg-[var(--k-bg-surface-2)] text-[13px] text-[var(--k-ink-primary)] outline-none"
              />
            ) : (
              <div
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (Date.now() - lastDragEndAtRef.current < 250) return;
                  setEditingTaskId(task.id);
                  setEditingTaskDraft(task.text);
                }}
                title={t('tasks.dblClickRename')}
                className={`text-[13px] leading-[1.42] break-words select-none ${
                  task.done
                    ? 'line-through text-[var(--k-ink-muted)]'
                    : 'text-[var(--k-ink-primary)] font-medium'
                }`}
              >
                {task.text}
              </div>
            )}
          </div>
        </div>

        {/* Metadata Badges: Priority + Due Date + Orbit + Source Note Chip (clamped strictly inside card) */}
        {hasMetaRow ? (
          <div className="flex flex-wrap items-center gap-1.5 pl-[26px] min-w-0 max-w-full">
            {renderPriorityPill(priority)}
            {renderDueBadge(task)}
            {orbit ? (
              <span className="max-w-full min-w-0 inline-flex items-center gap-1 overflow-hidden px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[10.5px] text-[var(--k-ink-secondary)]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: orbit.color }} />
                <span className="truncate min-w-0">{orbit.name}</span>
              </span>
            ) : null}
            {showSourceChip ? (
              <button
                type="button"
                data-no-drag="true"
                data-testid={`task-source-chip-${task.id}`}
                title={`${t('cards.openNote')}: ${task.itemTitle}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenItem(task.itemId);
                }}
                className="k-interactive max-w-full min-w-0 inline-flex items-center gap-1 overflow-hidden px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)]/80 hover:bg-[var(--k-accent-soft)] text-[10.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)] cursor-pointer"
              >
                {task.sourceType === 'voice_action' ? (
                  <Microphone className="w-2.5 h-2.5 shrink-0 text-[var(--k-accent)]" />
                ) : (
                  <NotePencil className="w-2.5 h-2.5 shrink-0 opacity-75" />
                )}
                <span className="truncate min-w-0">{task.itemTitle}</span>
                <ArrowSquareOut className="w-2.5 h-2.5 shrink-0 opacity-70" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div data-testid="tasks-hub-view" className="w-full min-w-0 flex flex-col gap-3.5 @container">
      {/* Top Toolbar: compact single-row responsive layout (never wraps into 3 awkward rows at 1024px) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {/* Smooth layoutId pill for List | Board */}
          <div
            role="tablist"
            aria-label={t('tasks.viewModeAria')}
            className="inline-flex items-center gap-0.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-0.5 shrink-0"
          >
            {(
              [
                { value: 'list', label: t('tasks.view.list'), icon: <ListBullets className="w-3.5 h-3.5" /> },
                { value: 'board', label: t('tasks.view.board'), icon: <Kanban className="w-3.5 h-3.5" /> },
              ] as const
            ).map((opt) => {
              const active = viewMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setViewMode(opt.value)}
                  className={`relative inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-[9px] text-[12px] font-medium whitespace-nowrap cursor-pointer select-none transition-[color,transform] duration-[140ms] ease-[var(--k-ease-out)] ${
                    active
                      ? 'text-[var(--k-ink-primary)]'
                      : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] active:scale-[0.97]'
                  }`}
                >
                  {active ? (
                    <motion.span
                      layoutId="tasks-view-mode-pill"
                      transition={
                        prefersReduced
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }
                      }
                      className="pointer-events-none absolute inset-0 rounded-[9px] bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] shadow-[var(--k-shadow-thumb)]"
                    />
                  ) : null}
                  <span className="relative z-10 shrink-0">{opt.icon}</span>
                  <span className="relative z-10">{opt.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] focus-within:border-[var(--k-border-focus)] flex-1 min-w-[116px] max-w-[196px] transition-colors">
            <MagnifyingGlass className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
            <input
              type="text"
              data-testid="tasks-search-input"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder={t('tasks.searchPlaceholder')}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
            {searchFilter ? (
              <button
                type="button"
                onClick={() => setSearchFilter('')}
                className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                aria-label={t('common.clearSearch')}
              >
                <X weight="bold" className="w-3 h-3" />
              </button>
            ) : null}
          </div>

          <SelectMenu
            size="sm"
            value={priorityFilter}
            onChange={(v) => setPriorityFilter(v as 'all' | TaskPriority)}
            className="min-w-[120px] whitespace-nowrap shrink-0"
            data-testid="tasks-priority-filter"
            options={[
              { value: 'all', label: t('tasks.priority.filterLabel') },
              { value: 'urgent', label: t(PRIORITY_META.urgent.labelKey), dotColor: PRIORITY_META.urgent.dotColor },
              { value: 'high', label: t(PRIORITY_META.high.labelKey), dotColor: PRIORITY_META.high.dotColor },
              { value: 'medium', label: t(PRIORITY_META.medium.labelKey), dotColor: PRIORITY_META.medium.dotColor },
              { value: 'low', label: t(PRIORITY_META.low.labelKey), dotColor: PRIORITY_META.low.dotColor },
            ]}
          />

          {!scopedOrbitId && !scopedBoardId ? (
            <SelectMenu
              size="sm"
              value={orbitFilter}
              onChange={setOrbitFilter}
              className="min-w-[124px] max-w-[175px] whitespace-nowrap shrink-0"
              data-testid="tasks-orbit-filter"
              options={[
                { value: 'all', label: t('tasks.orbitFilterAll') },
                { value: '__none__', label: t('nav.noSection') },
                ...orbits.map((orb) => ({
                  value: orb.id,
                  label: orb.name,
                  dotColor: orb.color,
                })),
              ]}
            />
          ) : null}

          <button
            type="button"
            data-testid="tasks-toggle-done-visibility"
            onClick={() => setShowDone((v) => !v)}
            className={`k-interactive inline-flex items-center gap-1.5 h-8 px-2 rounded-xl border text-[12px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
              showDone
                ? 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                : 'border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
            }`}
          >
            {showDone ? <Eye className="w-3.5 h-3.5 shrink-0" /> : <EyeSlash className="w-3.5 h-3.5 shrink-0" />}
            <span>{showDone ? t('tasks.hideDone') : t('tasks.showDone')}</span>
          </button>

          {viewMode === 'board' ? (
            <button
              type="button"
              data-testid="tasks-toggle-col-icons"
              aria-pressed={showColumnIcons}
              title={showColumnIcons ? t('tasks.hideColIcons') : t('tasks.showColIcons')}
              onClick={toggleShowColumnIcons}
              className={`k-interactive inline-flex items-center gap-1.5 h-8 px-2 rounded-xl border text-[12px] font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                showColumnIcons
                  ? 'border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)]/70 text-[var(--k-accent)]'
                  : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              <Shapes weight={showColumnIcons ? 'duotone' : 'regular'} className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden @[720px]:inline">{t('tasks.iconsShort')}</span>
            </button>
          ) : null}
        </div>

        <div className="ml-auto text-[12px] text-[var(--k-ink-muted)] k-tabular whitespace-nowrap shrink-0">
          {t('tasks.openCountLabel')}{' '}
          <strong className="text-[var(--k-ink-primary)]">
            <NumberFlow value={activeFilteredTasks.length} />
          </strong>
        </div>
      </div>

      {/* Section Quick-Filter Pills (global hub only) */}
      {!scopedOrbitId && !scopedBoardId && orbits.length > 0 ? (
        <div
          data-testid="tasks-section-pills"
          className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar"
        >
          <button
            type="button"
            onClick={() => setOrbitFilter('all')}
            className={`k-interactive h-7 px-2.5 rounded-full text-[11.5px] font-medium whitespace-nowrap border cursor-pointer transition-colors ${
              orbitFilter === 'all'
                ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/40 text-[var(--k-accent)]'
                : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
            }`}
          >
            {t('tasks.orbitFilterAll')}
          </button>
          {orbits.map((orb) => {
            const active = orbitFilter === orb.id;
            return (
              <button
                key={orb.id}
                type="button"
                onClick={() => setOrbitFilter((prev) => (prev === orb.id ? 'all' : orb.id))}
                className={`k-interactive h-7 px-2.5 rounded-full text-[11.5px] font-medium whitespace-nowrap inline-flex items-center gap-1.5 border cursor-pointer transition-colors ${
                  active
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/40 text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: orb.color }} />
                <span>{orb.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* BOARD MODE (KANBAN) */}
      {viewMode === 'board' ? (
        <div
          key="tasks-board"
          ref={boardScrollRef}
          data-testid="tasks-kanban-board"
          className="w-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-3"
        >
          <div className="flex items-start gap-3 min-w-full pr-2">
            {sortedColumns.map((col, colIndex) => {
              const colCards = tasksByColumn.get(col.id) ?? [];
              const isDropTarget = dragVisual?.active && dragVisual.targetColumnId === col.id;
              const isProtectedCol =
                col.id === 'inbox' || isDoneColumn(col.id, sortedColumns) || sortedColumns.length <= 2;
              const resolvedColIcon = resolveColumnIconId(col.icon, col.id, col.isDone);
              const colTitle = localizeTaskBoardColumnTitle(col, locale);

              const colMenuEntries: ContextMenuEntry[] = [
                {
                  type: 'item',
                  id: 'rename-col',
                  label: t('common.rename'),
                  icon: <PencilSimple className="w-3.5 h-3.5" />,
                  onSelect: () => {
                    setRenamingColId(col.id);
                    setRenameColDraft(colTitle);
                  },
                },
                {
                  type: 'submenu',
                  id: 'icon-col',
                  label: t('tasks.col.changeIcon'),
                  icon: <Shapes className="w-3.5 h-3.5" />,
                  items: taskColumnIcons.map((iconOpt) => ({
                    type: 'item',
                    id: `col-icon-${iconOpt.id}`,
                    label: iconOpt.label,
                    icon: renderColumnGlyph(iconOpt.id, col.color, 'w-3.5 h-3.5'),
                    active: resolvedColIcon === iconOpt.id,
                    onSelect: () => void handleChangeColumnIcon(col.id, iconOpt.id),
                  })),
                },
                {
                  type: 'submenu',
                  id: 'color-col',
                  label: t('tasks.col.changeColor'),
                  icon: <Palette className="w-3.5 h-3.5" />,
                  items: COLUMN_COLOR_SWATCHES.map((swatch) => ({
                    type: 'item',
                    id: `col-color-${swatch.hex}`,
                    label: t(swatch.labelKey),
                    dotColor: swatch.hex,
                    active: col.color.toLowerCase() === swatch.hex.toLowerCase(),
                    onSelect: () => void handleRecolorColumn(col.id, swatch.hex),
                  })),
                },
                {
                  type: 'item',
                  id: 'move-left',
                  label: t('tasks.col.moveLeft'),
                  icon: <ArrowLeft className="w-3.5 h-3.5" />,
                  disabled: colIndex === 0,
                  onSelect: () => void handleStepColumn(col.id, -1),
                },
                {
                  type: 'item',
                  id: 'move-right',
                  label: t('tasks.col.moveRight'),
                  icon: <ArrowRight className="w-3.5 h-3.5" />,
                  disabled: colIndex === sortedColumns.length - 1,
                  onSelect: () => void handleStepColumn(col.id, 1),
                },
                { type: 'separator', id: 'col-sep' },
                {
                  type: 'item',
                  id: 'delete-col',
                  label: t('tasks.col.delete'),
                  icon: <Trash className="w-3.5 h-3.5" />,
                  danger: true,
                  disabled: isProtectedCol,
                  onSelect: () => void handleDeleteColumn(col),
                },
              ];

              const visibleCardsForDrop = dragVisual?.active
                ? colCards.filter((c) => c.id !== dragVisual.task.id)
                : colCards;

              return (
                <section
                  key={col.id}
                  data-kanban-col-id={col.id}
                  data-testid={`kanban-col-${col.id}`}
                  className={`flex-1 basis-[224px] min-w-[224px] max-w-[304px] shrink-0 rounded-2xl border transition-[border-color,background-color,box-shadow] duration-[120ms] ease-[var(--k-ease-out)] flex flex-col max-h-[calc(100vh-192px)] ${
                    colDragVisual && colDragVisual.targetIndex === colIndex && colDragVisual.colId !== col.id
                      ? 'ring-2 ring-[var(--k-accent)]/55 border-[var(--k-accent)]/70'
                      : colDragVisual?.colId === col.id
                        ? 'opacity-65 border-dashed border-[var(--k-accent)]/60'
                        : isDropTarget
                          ? 'border-[var(--k-accent)]/65 bg-[var(--k-accent-soft)]/18 ring-1 ring-[var(--k-accent)]/25'
                          : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)]/85'
                  }`}
                >
                  {/* Column Header */}
                  <ContextMenuSurface entries={colMenuEntries}>
                    <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[var(--k-border-hairline)] shrink-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {sortedColumns.length > 1 ? (
                          <button
                            type="button"
                            data-testid={`kanban-col-drag-${col.id}`}
                            aria-label={t('tasks.col.dragAria', { title: colTitle })}
                            onPointerDown={(e) => handleColumnHeaderPointerDown(e, col.id)}
                            className="w-4 h-5 -ml-1 flex items-center justify-center text-[var(--k-ink-subtle)] hover:text-[var(--k-ink-primary)] cursor-grab active:cursor-grabbing shrink-0"
                          >
                            <DotsSixVertical weight="bold" className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                        {showColumnIcons && resolvedColIcon !== 'none' ? (
                          <span
                            data-testid={`kanban-col-icon-${col.id}`}
                            className="inline-flex items-center justify-center w-5.5 h-5.5 rounded-lg shrink-0"
                            style={{ backgroundColor: `${col.color}1A` }}
                          >
                            {renderColumnGlyph(resolvedColIcon, col.color, 'w-3.5 h-3.5')}
                          </span>
                        ) : (
                          <span
                            data-testid={`kanban-col-dot-${col.id}`}
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: col.color }}
                          />
                        )}
                        {renamingColId === col.id ? (
                          <input
                            autoFocus
                            value={renameColDraft}
                            onChange={(e) => setRenameColDraft(e.target.value)}
                            onBlur={() => void handleCommitRenameColumn(col.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleCommitRenameColumn(col.id);
                              } else if (e.key === 'Escape') {
                                setRenamingColId(null);
                              }
                            }}
                            className="flex-1 min-w-0 h-6.5 px-2 rounded-md border border-[var(--k-border-focus)] bg-[var(--k-bg-surface-1)] text-[13px] font-semibold outline-none"
                          />
                        ) : (
                          <span className="text-[13px] font-semibold text-[var(--k-ink-primary)] truncate">
                            {colTitle}
                          </span>
                        )}
                        <span
                          data-testid={`kanban-col-count-${col.id}`}
                          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--k-bg-surface-2)] text-[11px] font-medium text-[var(--k-ink-muted)] k-tabular shrink-0"
                        >
                          <NumberFlow value={colCards.length} />
                        </span>
                      </div>

                      <PopoverSurface
                        open={openColMenuId === col.id}
                        onOpenChange={(open) => setOpenColMenuId(open ? col.id : null)}
                        align="end"
                        widthClass="w-56 !p-1.5"
                        trigger={
                          <button
                            type="button"
                            data-testid={`kanban-col-menu-${col.id}`}
                            aria-label={t('tasks.col.settingsAria', { title: colTitle })}
                            className="k-interactive w-6.5 h-6.5 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                          >
                            <DotsThree weight="bold" className="w-4 h-4" />
                          </button>
                        }
                      >
                        <div className="space-y-1 text-[12px]">
                          <button
                            type="button"
                            onClick={() => {
                              setOpenColMenuId(null);
                              setRenamingColId(col.id);
                              setRenameColDraft(colTitle);
                            }}
                            className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                          >
                            <PencilSimple className="w-3.5 h-3.5 opacity-80" />
                            <span>{t('common.rename')}</span>
                          </button>

                          <div className="px-2.5 py-1.5">
                            <div className="text-[10.5px] text-[var(--k-ink-muted)] mb-1.5">
                              {t('tasks.col.colorLabel')}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {COLUMN_COLOR_SWATCHES.map((swatch) => (
                                <button
                                  key={swatch.hex}
                                  type="button"
                                  title={t(swatch.labelKey)}
                                  onClick={() => {
                                    void handleRecolorColumn(col.id, swatch.hex);
                                    setOpenColMenuId(null);
                                  }}
                                  className={`w-4.5 h-4.5 rounded-full cursor-pointer transition-transform ${
                                    col.color.toLowerCase() === swatch.hex.toLowerCase()
                                      ? 'ring-[1.5px] ring-[var(--k-ink-primary)] ring-offset-[1.5px] ring-offset-[var(--k-bg-elevated)]'
                                      : 'hover:scale-105'
                                  }`}
                                  style={{ backgroundColor: swatch.hex }}
                                  aria-label={t(swatch.labelKey)}
                                />
                              ))}
                            </div>
                          </div>

                          <div className="px-2.5 py-1.5 border-t border-[var(--k-border-hairline)]">
                            <div className="text-[10.5px] text-[var(--k-ink-muted)] mb-1.5">
                              {t('tasks.col.iconLabel')}
                            </div>
                            <div className="grid grid-cols-6 gap-1">
                              {taskColumnIcons.map((iconOpt) => {
                                const active = resolvedColIcon === iconOpt.id;
                                return (
                                  <button
                                    key={iconOpt.id}
                                    type="button"
                                    title={iconOpt.label}
                                    aria-label={iconOpt.label}
                                    onClick={() => {
                                      void handleChangeColumnIcon(col.id, iconOpt.id);
                                      setOpenColMenuId(null);
                                    }}
                                    className={`k-interactive w-7 h-7 rounded-lg inline-flex items-center justify-center cursor-pointer border ${
                                      active
                                        ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)]'
                                        : 'border-transparent hover:bg-[var(--k-bg-surface-2)]'
                                    }`}
                                  >
                                    {renderColumnGlyph(iconOpt.id, col.color, 'w-3.5 h-3.5')}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-1 pt-0.5 border-t border-[var(--k-border-hairline)]">
                            <button
                              type="button"
                              disabled={colIndex === 0}
                              onClick={() => void handleStepColumn(col.id, -1)}
                              className="k-interactive flex items-center justify-center gap-1 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer disabled:opacity-40 disabled:cursor-default"
                            >
                              <ArrowLeft className="w-3 h-3" />
                              <span>{t('tasks.col.leftShort')}</span>
                            </button>
                            <button
                              type="button"
                              disabled={colIndex === sortedColumns.length - 1}
                              onClick={() => void handleStepColumn(col.id, 1)}
                              className="k-interactive flex items-center justify-center gap-1 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer disabled:opacity-40 disabled:cursor-default"
                            >
                              <span>{t('tasks.col.rightShort')}</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          </div>

                          {!isProtectedCol ? (
                            <button
                              type="button"
                              onClick={() => void handleDeleteColumn(col)}
                              className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer"
                            >
                              <Trash className="w-3.5 h-3.5" />
                              <span>{t('tasks.col.delete')}</span>
                            </button>
                          ) : null}
                        </div>
                      </PopoverSurface>
                    </div>
                  </ContextMenuSurface>

                  {/* Scrollable Column Cards */}
                  <div className="flex-1 min-h-[88px] overflow-y-auto p-2.5 pb-3.5 flex flex-col gap-2">
                    {colCards.length === 0 && !isDropTarget ? (
                      <div className="py-10 px-4 text-center text-[12px] text-[var(--k-ink-muted)]/75 select-none">
                        {!showDone && isDoneColumn(col.id, sortedColumns)
                          ? t('tasks.col.emptyFiltered')
                          : t('tasks.col.empty')}
                      </div>
                    ) : null}

                    {colCards.map((task) => {
                      const isBeingDragged = dragVisual?.active && dragVisual.task.id === task.id;
                      const nonDraggedIndex = visibleCardsForDrop.findIndex((c) => c.id === task.id);
                      const showIndicatorBefore =
                        isDropTarget &&
                        !isBeingDragged &&
                        nonDraggedIndex === dragVisual.insertIndex;

                      return (
                        <React.Fragment key={task.id}>
                          {showIndicatorBefore ? (
                            <div
                              data-testid="kanban-drop-indicator"
                              className="shrink-0 h-[3px] rounded-full bg-[var(--k-accent)] shadow-[0_0_8px_var(--k-accent-glow)] mx-1 my-0.5"
                            />
                          ) : null}
                          <ContextMenuSurface entries={buildTaskContextMenu(task)}>
                            <motion.div
                              layout={!prefersReduced && !dragVisual?.active}
                              transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.7 }}
                              data-kanban-card-id={task.id}
                              data-testid={`kanban-card-${task.id}`}
                              onPointerDown={(e) => handleCardPointerDown(e, task)}
                              onClick={(e) => {
                                if (Date.now() - lastDragEndAtRef.current < 260) return;
                                if ((e.target as HTMLElement).closest('button, input, textarea, [data-no-drag="true"]')) return;
                                setSelectedTaskId(task.id);
                              }}
                              className={`shrink-0 min-w-0 overflow-hidden rounded-xl border bg-[var(--k-bg-surface-1)] p-3 shadow-[var(--k-shadow-card)] transition-[border-color,background-color,box-shadow] duration-[145ms] ease-[var(--k-ease-out)] cursor-grab active:cursor-grabbing select-none ${
                                isBeingDragged
                                  ? 'opacity-30 border-dashed border-[var(--k-accent)]/60'
                                  : 'border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)]/45 active:border-[color-mix(in_srgb,var(--k-accent)_44%,var(--k-border-strong))] active:shadow-[0_0_0_1px_color-mix(in_srgb,var(--k-accent)_18%,transparent),var(--k-shadow-card)] active:duration-[75ms]'
                              }`}
                            >
                              {renderKanbanCardBody(task, false)}
                            </motion.div>
                          </ContextMenuSurface>
                        </React.Fragment>
                      );
                    })}

                    {isDropTarget && dragVisual.insertIndex >= visibleCardsForDrop.length ? (
                      <div
                        data-testid="kanban-drop-indicator"
                        className="shrink-0 h-[3px] rounded-full bg-[var(--k-accent)] shadow-[0_0_8px_var(--k-accent-glow)] mx-1 my-0.5"
                      />
                    ) : null}
                  </div>

                  {/* Quick-Add Input at Bottom of EVERY Column */}
                  <div className="p-2.5 pt-2 border-t border-[var(--k-border-hairline)] shrink-0">
                    {colQuickAddId === col.id ? (
                      <motion.form
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
                        onSubmit={(e) => void handleCreateColumnTask(e, col.id)}
                        className="flex flex-col gap-1.5"
                      >
                        <input
                          autoFocus
                          type="text"
                          data-testid={`kanban-quick-add-input-${col.id}`}
                          value={colQuickAddText}
                          onChange={(e) => setColQuickAddText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setColQuickAddId(null);
                              setColQuickAddText('');
                            }
                          }}
                          placeholder={t('tasks.col.addTaskPlaceholder')}
                          className="w-full h-8.5 px-2.5 rounded-lg border border-[var(--k-border-focus)] bg-[var(--k-bg-surface-1)] text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none"
                        />
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setColQuickAddId(null);
                              setColQuickAddText('');
                            }}
                            className="k-interactive h-7 px-2 rounded-lg text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="submit"
                            disabled={!colQuickAddText.trim() || colCreating}
                            className="k-interactive h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11.5px] font-medium cursor-pointer disabled:opacity-50"
                          >
                            {t('common.add')}
                          </button>
                        </div>
                      </motion.form>
                    ) : (
                      <button
                        type="button"
                        data-testid={`kanban-quick-add-btn-${col.id}`}
                        onClick={() => {
                          setColQuickAddId(col.id);
                          setColQuickAddText('');
                        }}
                        className="k-interactive w-full h-8 px-2.5 rounded-xl flex items-center gap-1.5 text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        <Plus weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                        <span>{t('tasks.col.addTaskBtn')}</span>
                      </button>
                    )}
                  </div>
                </section>
              );
            })}

            {/* + Column at Right Edge */}
            <div ref={addColCardRef} className={addingColumn ? 'w-[272px] shrink-0' : 'shrink-0'}>
              {addingColumn ? (
                <motion.form
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
                  onSubmit={(e) => void handleAddColumn(e)}
                  className="rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] p-3.5 flex flex-col gap-3 shadow-[var(--k-shadow-card)]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center justify-center w-6 h-6 rounded-lg shrink-0"
                      style={{ backgroundColor: `${newColColor}1A` }}
                    >
                      {renderColumnGlyph(newColIcon, newColColor, 'w-3.5 h-3.5')}
                    </span>
                    <input
                      ref={newColInputRef}
                      type="text"
                      data-testid="kanban-new-col-input"
                      value={newColTitle}
                      onChange={(e) => setNewColTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAddingColumn(false);
                          setNewColTitle('');
                        }
                      }}
                      placeholder={t('tasks.col.newColPlaceholder')}
                      className="flex-1 min-w-0 h-8.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12.5px] outline-none focus:border-[var(--k-border-focus)]"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-[10.5px] text-[var(--k-ink-muted)]">{t('nav.color')}</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {COLUMN_COLOR_SWATCHES.map((swatch) => (
                        <button
                          key={swatch.hex}
                          type="button"
                          title={t(swatch.labelKey)}
                          onClick={() => setNewColColor(swatch.hex)}
                          className={`w-4.5 h-4.5 rounded-full cursor-pointer transition-transform ${
                            newColColor === swatch.hex
                              ? 'ring-[1.5px] ring-[var(--k-ink-primary)] ring-offset-[1.5px] ring-offset-[var(--k-bg-surface-1)]'
                              : 'opacity-80 hover:opacity-100'
                          }`}
                          style={{ backgroundColor: swatch.hex }}
                          aria-label={t(swatch.labelKey)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-[10.5px] text-[var(--k-ink-muted)]">{t('nav.icon')}</div>
                    <div className="grid grid-cols-6 gap-1">
                      {taskColumnIcons.map((iconOpt) => {
                        const active = newColIcon === iconOpt.id;
                        return (
                          <button
                            key={iconOpt.id}
                            type="button"
                            title={iconOpt.label}
                            aria-label={iconOpt.label}
                            onClick={() => setNewColIcon(iconOpt.id)}
                            className={`k-interactive w-7 h-7 rounded-lg inline-flex items-center justify-center cursor-pointer border ${
                              active
                                ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)]'
                                : 'border-transparent hover:bg-[var(--k-bg-surface-2)]'
                            }`}
                          >
                            {renderColumnGlyph(iconOpt.id, newColColor, 'w-3.5 h-3.5')}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setAddingColumn(false);
                        setNewColTitle('');
                      }}
                      className="k-interactive h-7.5 px-2.5 rounded-lg text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={!newColTitle.trim()}
                      className="k-interactive h-7.5 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-50"
                    >
                      {t('common.create')}
                    </button>
                  </div>
                </motion.form>
              ) : (
                <button
                  type="button"
                  data-testid="kanban-add-col-btn"
                  title={t('tasks.col.addColTitle')}
                  onClick={() => setAddingColumn(true)}
                  className="k-interactive h-11 px-3.5 rounded-2xl border border-dashed border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)]/50 hover:bg-[var(--k-bg-surface-1)] text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Plus weight="bold" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                  <span>{t('tasks.col.addColShort')}</span>
                </button>
              )}
            </div>
          </div>

          {/* Floating Lifted Pointer Drag Overlay */}
          {dragVisual?.active ? (
            <div
              ref={dragOverlayRef}
              data-testid="kanban-drag-overlay"
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                width: `${dragVisual.width}px`,
                transform: `translate3d(${dragVisual.x}px, ${dragVisual.y}px, 0) scale(1.02) rotate(0.5deg)`,
                boxShadow: 'var(--k-shadow-sheet)',
                pointerEvents: 'none',
                zIndex: 120,
              }}
              className="rounded-xl border border-[var(--k-accent)]/60 bg-[var(--k-bg-surface-1)] p-3 overflow-hidden"
            >
              {renderKanbanCardBody(dragVisual.task, true)}
            </div>
          ) : null}
        </div>
      ) : (
        /* LIST MODE */
        <>
          {/* Unified Top Capture Slot with Quick Metadata Pickers */}
          <form
            onSubmit={handleCreateTopTask}
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3.5 py-2 shadow-[var(--k-shadow-card)] focus-within:border-[var(--k-border-focus)] transition-colors"
          >
            <Plus weight="bold" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
            <input
              type="text"
              data-testid="quick-task-input"
              value={newTaskText}
              onChange={(e) => setNewTaskText(e.target.value)}
              placeholder={t('tasks.list.quickAddPlaceholder')}
              className="flex-1 min-w-[180px] bg-transparent border-none outline-none text-[13.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
            {onCreateTask ? (
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {!scopedOrbitId && orbits.length > 0 ? (
                  <SelectMenu
                    size="sm"
                    value={effectiveQuickOrbit}
                    onChange={(val) => setQuickOrbitOverride(val)}
                    className="max-w-[130px]"
                    options={[
                      { value: '', label: t('tasks.ctx.noSection') },
                      ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
                    ]}
                  />
                ) : null}

                <PopoverSurface
                  open={quickDatePopoverOpen}
                  onOpenChange={(open) => {
                    if (open) {
                      setQuickDateStr(formatTaskDateInputValue(quickDueAt));
                      setQuickTimeStr(formatTaskTimeInputValue(quickDueAt));
                    }
                    setQuickDatePopoverOpen(open);
                  }}
                  align="end"
                  widthClass="w-56 !p-2"
                  trigger={
                    <button
                      type="button"
                      data-testid="quick-task-due-btn"
                      className={`k-interactive h-7 px-2 rounded-lg text-[11.5px] inline-flex items-center gap-1 border cursor-pointer ${
                        quickDueAt
                          ? 'border-[var(--k-accent)]/40 bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                          : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                      }`}
                    >
                      <CalendarBlank className="w-3.5 h-3.5" />
                      <span>
                        {quickDueAt
                          ? formatReminderStamp(quickDueAt, locale)
                          : t('tasks.quickAdd.dateLabel')}
                      </span>
                    </button>
                  }
                >
                  <div className="space-y-1.5 text-[12px]">
                    <div className="grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setQuickDueAt(computeDueAtPreset('today'));
                          setQuickDatePopoverOpen(false);
                        }}
                        className="px-2 py-1.5 rounded-lg bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-left cursor-pointer"
                      >
                        {t('tasks.ctx.tonight')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setQuickDueAt(computeDueAtPreset('tomorrow'));
                          setQuickDatePopoverOpen(false);
                        }}
                        className="px-2 py-1.5 rounded-lg bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-left cursor-pointer"
                      >
                        {t('tasks.ctx.tomorrow10')}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-[var(--k-border-hairline)]">
                      <input
                        type="date"
                        value={quickDateStr}
                        onChange={(e) => setQuickDateStr(e.target.value)}
                        className="h-7 px-1.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[11px]"
                      />
                      <input
                        type="time"
                        value={quickTimeStr}
                        onChange={(e) => setQuickTimeStr(e.target.value)}
                        className="h-7 px-1.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[11px]"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-1 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setQuickDueAt(null);
                          setQuickDateStr('');
                          setQuickTimeStr('');
                          setQuickDatePopoverOpen(false);
                        }}
                        className="text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] px-1.5 py-1 cursor-pointer"
                      >
                        {t('tasks.ctx.clearDue')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const ts = combineTaskDateAndTime(quickDateStr, quickTimeStr);
                          if (ts !== null) setQuickDueAt(ts);
                          setQuickDatePopoverOpen(false);
                        }}
                        className="h-6.5 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11px] font-medium cursor-pointer"
                      >
                        {t('tasks.quickAdd.applyDate')}
                      </button>
                    </div>
                  </div>
                </PopoverSurface>

                <SelectMenu
                  size="sm"
                  value={quickPriority}
                  onChange={(v) => setQuickPriority(v as TaskPriority)}
                  className="max-w-[116px]"
                  options={[
                    { value: 'none', label: t('tasks.priority.none') },
                    { value: 'urgent', label: t(PRIORITY_META.urgent.labelKey), dotColor: PRIORITY_META.urgent.dotColor },
                    { value: 'high', label: t(PRIORITY_META.high.labelKey), dotColor: PRIORITY_META.high.dotColor },
                    { value: 'medium', label: t(PRIORITY_META.medium.labelKey), dotColor: PRIORITY_META.medium.dotColor },
                    { value: 'low', label: t(PRIORITY_META.low.labelKey), dotColor: PRIORITY_META.low.dotColor },
                  ]}
                />

                {sortedColumns.length > 1 ? (
                  <SelectMenu
                    size="sm"
                    value={quickColumnId ?? inboxColId}
                    onChange={(val) => setQuickColumnId(val)}
                    className="max-w-[120px] hidden @[680px]:inline-flex"
                    options={sortedColumns.map((c) => ({
                      value: c.id,
                      label: localizeTaskBoardColumnTitle(c, locale),
                      dotColor: c.color,
                    }))}
                  />
                ) : null}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={!newTaskText.trim() || creating}
              className="k-interactive h-8 px-3.5 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default shrink-0"
            >
              {t('common.add')}
            </button>
          </form>

          {/* List Smart Focus & Grouping Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {showDone ? (
                <SegmentedControl<'active' | 'today' | 'upcoming' | 'done' | 'all'>
                  value={listStatusFilter}
                  onChange={setListStatusFilter}
                  options={[
                    { value: 'active', label: t('tasks.list.tabActive', { count: activeFilteredTasks.length }) },
                    { value: 'today', label: t('tasks.focus.today', { count: todayFilteredTasks.length }) },
                    { value: 'upcoming', label: t('tasks.focus.upcoming', { count: upcomingFilteredTasks.length }) },
                    { value: 'done', label: t('tasks.list.tabDone', { count: doneFilteredTasks.length }) },
                    { value: 'all', label: t('common.all') },
                  ]}
                />
              ) : null}
              {listStatusFilter !== 'done' ? (
                <SegmentedControl<GroupMode>
                  value={groupBy}
                  onChange={setGroupBy}
                  options={[
                    { value: 'due', label: t('tasks.list.groupByDue') },
                    { value: 'orbit', label: t('tasks.list.groupBySection') },
                    { value: 'note', label: t('tasks.list.groupByNote') },
                  ]}
                />
              ) : null}
            </div>
          </div>

          {/* Bulk Action Bar (List mode when >= 1 task selected) */}
          <AnimatePresence>
            {selectedTaskIds.length > 0 ? (
              <motion.div
                data-testid="tasks-bulk-bar"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: 0.14 }}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--k-accent)]/35 bg-[var(--k-bg-surface-1)] px-3 py-2 shadow-[var(--k-shadow-card)]"
              >
                <span className="text-[12px] font-semibold text-[var(--k-accent)]">
                  {t('tasks.bulk.selected', { count: selectedTaskIds.length })}
                </span>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => setSelectedTaskIds(listDisplayed.map((tItem) => tItem.id))}
                  className="k-interactive h-7 px-2 rounded-lg text-[11.5px] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer"
                >
                  {t('tasks.bulk.selectAll')}
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkToggleDone(true)}
                  className="k-interactive h-7 px-2.5 rounded-lg text-[11.5px] font-medium bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] cursor-pointer"
                >
                  {t('tasks.bulk.markDone')}
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkToggleDone(false)}
                  className="k-interactive h-7 px-2 rounded-lg text-[11.5px] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer"
                >
                  {t('tasks.bulk.reopen')}
                </button>
                {orbits.length > 0 ? (
                  <SelectMenu
                    size="sm"
                    value=""
                    placeholder={t('tasks.bulk.moveToSection')}
                    onChange={(orb) => void handleBulkUpdateMeta({ orbit: orb })}
                    options={[
                      { value: '', label: t('tasks.ctx.noSection') },
                      ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
                    ]}
                  />
                ) : null}
                <SelectMenu
                  size="sm"
                  value=""
                  placeholder={t('tasks.bulk.setPriority')}
                  onChange={(p) => void handleBulkUpdateMeta({ priority: p as TaskPriority })}
                  options={[
                    { value: 'urgent', label: t(PRIORITY_META.urgent.labelKey), dotColor: PRIORITY_META.urgent.dotColor },
                    { value: 'high', label: t(PRIORITY_META.high.labelKey), dotColor: PRIORITY_META.high.dotColor },
                    { value: 'medium', label: t(PRIORITY_META.medium.labelKey), dotColor: PRIORITY_META.medium.dotColor },
                    { value: 'low', label: t(PRIORITY_META.low.labelKey), dotColor: PRIORITY_META.low.dotColor },
                    { value: 'none', label: t('tasks.priority.none') },
                  ]}
                />
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void handleBulkDelete()}
                  className="k-interactive h-7 px-2.5 rounded-lg text-[11.5px] font-medium text-[var(--k-danger)] bg-[var(--k-danger-soft)] cursor-pointer"
                >
                  {t('tasks.bulk.delete')}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTaskIds([])}
                  className="ml-auto h-7 px-2 rounded-lg text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  {t('tasks.bulk.clear')}
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* Grouped Tasks List */}
          {listGrouped.length === 0 ? (
            <div key="tasks-list-empty" className="rounded-2xl border border-dashed border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)]/60 px-6 py-12 text-center space-y-2.5">
              <CheckSquare weight="duotone" className="w-10 h-10 text-[var(--k-accent)] mx-auto opacity-80" />
              <div className="text-[15px] font-medium text-[var(--k-ink-primary)]">
                {searchFilter.trim() || priorityFilter !== 'all' || orbitFilter !== 'all'
                  ? t('tasks.empty.filtered')
                  : listStatusFilter === 'done'
                    ? t('tasks.empty.done')
                    : t('tasks.empty.active')}
              </div>
              <p className="mt-1 mb-0 text-[13px] text-[var(--k-ink-secondary)] max-w-md mx-auto">
                {t('tasks.empty.desc')}
              </p>
              <div className="flex items-center justify-center gap-2 pt-1">
                {searchFilter.trim() || priorityFilter !== 'all' || orbitFilter !== 'all' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchFilter('');
                      setPriorityFilter('all');
                      setOrbitFilter('all');
                    }}
                    className="k-interactive h-8 px-3.5 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[12.5px] font-medium cursor-pointer"
                  >
                    {t('tasks.empty.resetFilters')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setViewMode('board')}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3.5 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer"
                  >
                    <Kanban className="w-3.5 h-3.5" />
                    <span>{t('tasks.empty.openKanban')}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div key="tasks-list-groups" className="space-y-5">
              {listGrouped.map((group) => (
                <section key={group.key} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    {group.color ? (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: group.color }}
                      />
                    ) : null}
                    <span
                      className="text-[11.5px] font-semibold uppercase tracking-wider"
                      style={{ color: group.accent || 'var(--k-ink-muted)' }}
                    >
                      {group.label}
                    </span>
                    <span className="text-[11px] k-mono text-[var(--k-ink-muted)]">
                      {group.items.length}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <AnimatePresence initial={false}>
                      {group.items.map((task) => {
                        const orbit = task.orbit ? orbitMap.get(task.orbit) : undefined;
                        const colObj = sortedColumns.find((c) => c.id === task.columnId);
                        const dueAt = getEffectiveDueAt(task);
                        const isEditing = editingTaskId === task.id;
                        const showListSourceChip = !isStandaloneTaskSource(
                          task,
                          itemTaskCounts.get(task.itemId) ?? 1
                        );
                        const isSelectedRow = selectedTaskIds.includes(task.id);
                        return (
                          <ContextMenuSurface key={task.id} entries={buildTaskContextMenu(task)}>
                            <motion.div
                              layout={!prefersReduced}
                              initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                              animate={prefersReduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
                              exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: 0 }}
                              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                              data-testid={`task-row-${task.id}`}
                              onClick={(e) => {
                                if ((e.target as HTMLElement).closest('button, input, textarea, [data-no-detail="true"]')) return;
                                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                  e.preventDefault();
                                  toggleBulkSelect(task.id);
                                  return;
                                }
                                if (selectedTaskIds.length > 0) {
                                  toggleBulkSelect(task.id);
                                  return;
                                }
                                if (!isEditing) {
                                  setSelectedTaskId(task.id);
                                }
                              }}
                              className={`group rounded-xl border transition-[border-color,background-color] duration-150 flex items-center justify-between gap-3 px-3.5 py-2.5 overflow-hidden cursor-pointer ${
                                isSelectedRow
                                  ? 'border-[var(--k-accent)]/60 bg-[var(--k-accent-soft)]/25 shadow-[var(--k-shadow-card)]'
                                  : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)]/45 shadow-[var(--k-shadow-card)]'
                              }`}
                            >
                              <div className="flex items-start gap-3 min-w-0 flex-1">
                                <AnimatedCheckbox
                                  size="md"
                                  checked={task.done}
                                  onChange={() => void handleToggleWithUndo(task)}
                                  data-testid={`task-toggle-${task.id}`}
                                  label={task.done ? t('tasks.markUndone') : t('tasks.markDone')}
                                  className="mt-0.5"
                                />

                                <div className="min-w-0 flex-1">
                                  {isEditing ? (
                                    <input
                                      autoFocus
                                      data-no-detail="true"
                                      value={editingTaskDraft}
                                      onChange={(e) => setEditingTaskDraft(e.target.value)}
                                      onBlur={() => void handleCommitRename(task)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void handleCommitRename(task);
                                        } else if (e.key === 'Escape') {
                                          setEditingTaskId(null);
                                        }
                                      }}
                                      className="w-full px-2 py-0.5 rounded-lg border border-[var(--k-border-focus)] bg-[var(--k-bg-surface-2)] text-[13.5px] outline-none"
                                    />
                                  ) : (
                                    <div
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (e.shiftKey || e.ctrlKey || e.metaKey || selectedTaskIds.length > 0) {
                                          toggleBulkSelect(task.id);
                                          return;
                                        }
                                        if (clickDetailTimerRef.current) {
                                          window.clearTimeout(clickDetailTimerRef.current);
                                        }
                                        clickDetailTimerRef.current = window.setTimeout(() => {
                                          clickDetailTimerRef.current = null;
                                          setSelectedTaskId(task.id);
                                        }, 190);
                                      }}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        if (clickDetailTimerRef.current) {
                                          window.clearTimeout(clickDetailTimerRef.current);
                                          clickDetailTimerRef.current = null;
                                        }
                                        setEditingTaskId(task.id);
                                        setEditingTaskDraft(task.text);
                                      }}
                                      className={`text-[13.5px] leading-snug transition-colors ${
                                        task.done
                                          ? 'line-through text-[var(--k-ink-muted)]'
                                          : 'text-[var(--k-ink-primary)] font-medium'
                                      }`}
                                    >
                                      {task.text}
                                    </div>
                                  )}

                                  <div className="flex flex-wrap items-center gap-2 mt-1 min-w-0">
                                    {showListSourceChip ? (
                                      <button
                                        type="button"
                                        onClick={() => onOpenItem(task.itemId)}
                                        className="k-interactive max-w-full min-w-0 inline-flex items-center gap-1 overflow-hidden text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)] cursor-pointer"
                                      >
                                        {task.sourceType === 'voice_action' ? (
                                          <Microphone className="w-3 h-3 shrink-0 text-[var(--k-accent)]" />
                                        ) : (
                                          <NotePencil className="w-3 h-3 shrink-0 text-[var(--k-ink-muted)]" />
                                        )}
                                        <span className="truncate max-w-[260px] min-w-0">{task.itemTitle}</span>
                                        <ArrowSquareOut className="w-3 h-3 shrink-0 opacity-70" />
                                      </button>
                                    ) : null}

                                    {colObj ? (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[10.5px] text-[var(--k-ink-secondary)]">
                                        {showColumnIcons &&
                                        resolveColumnIconId(colObj.icon, colObj.id, colObj.isDone) !== 'none' ? (
                                          renderColumnGlyph(
                                            resolveColumnIconId(colObj.icon, colObj.id, colObj.isDone),
                                            colObj.color,
                                            'w-3 h-3 shrink-0'
                                          )
                                        ) : (
                                          <span
                                            className="w-1.5 h-1.5 rounded-full"
                                            style={{ backgroundColor: colObj.color }}
                                          />
                                        )}
                                        <span>{localizeTaskBoardColumnTitle(colObj, locale)}</span>
                                      </span>
                                    ) : null}

                                    {renderPriorityPill(task.priority)}

                                    {orbit ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] text-[11px] text-[var(--k-ink-secondary)]">
                                        <span
                                          className="w-1.5 h-1.5 rounded-full"
                                          style={{ backgroundColor: orbit.color }}
                                        />
                                        {orbit.name}
                                      </span>
                                    ) : null}

                                    {renderDueBadge(task)}
                                  </div>
                                </div>
                              </div>

                              <div className="shrink-0 flex items-center gap-1" data-no-detail="true">
                                <button
                                  type="button"
                                  data-testid={`task-details-btn-${task.id}`}
                                  title={t('tasks.ctx.openDetails')}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedTaskId(task.id);
                                  }}
                                  className="k-interactive h-7 w-7 rounded-lg inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                                >
                                  <SlidersHorizontal className="w-3.5 h-3.5" />
                                </button>
                                <PopoverSurface
                                  open={openDateTaskId === task.id}
                                  onOpenChange={(isOpen) => {
                                    if (isOpen) {
                                      setRowCustomDateStr(formatTaskDateInputValue(dueAt));
                                      setRowCustomTimeStr(formatTaskTimeInputValue(dueAt));
                                    }
                                    setOpenDateTaskId(isOpen ? task.id : null);
                                  }}
                                  align="end"
                                  widthClass="w-56 !p-2"
                                  trigger={
                                    <button
                                      type="button"
                                      title={t('tasks.dueBtnTitle')}
                                      className={`k-interactive h-7 px-2 rounded-lg text-[11.5px] inline-flex items-center gap-1 cursor-pointer ${
                                        dueAt
                                          ? 'text-[var(--k-amber)] bg-[var(--k-amber-soft)]'
                                          : 'opacity-0 group-hover:opacity-100 text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]'
                                      }`}
                                    >
                                      <CalendarBlank className="w-3.5 h-3.5" />
                                      <span>{dueAt ? t('tasks.dueLabelShort') : t('tasks.dateLabelShort')}</span>
                                    </button>
                                  }
                                >
                                  <div className="space-y-1 text-[12px]">
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateDueAt(task, 'today')}
                                      className="k-interactive w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                                    >
                                      {t('tasks.ctx.tonight')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateDueAt(task, 'tomorrow')}
                                      className="k-interactive w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                                    >
                                      {t('tasks.ctx.tomorrow10')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateDueAt(task, 'week')}
                                      className="k-interactive w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                                    >
                                      {t('tasks.ctx.in3Days')}
                                    </button>
                                    <div className="grid grid-cols-2 gap-1.5 pt-1.5 mt-1 border-t border-[var(--k-border-hairline)]">
                                      <input
                                        type="date"
                                        value={rowCustomDateStr}
                                        onChange={(e) => setRowCustomDateStr(e.target.value)}
                                        className="h-7 px-1.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[11px]"
                                      />
                                      <input
                                        type="time"
                                        value={rowCustomTimeStr}
                                        onChange={(e) => setRowCustomTimeStr(e.target.value)}
                                        className="h-7 px-1.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[11px]"
                                      />
                                    </div>
                                    <div className="flex items-center justify-between gap-1 pt-1">
                                      {dueAt ? (
                                        <button
                                          type="button"
                                          onClick={() => void handleUpdateDueAt(task, 'clear')}
                                          className="k-interactive text-left px-2 py-1 rounded-lg text-[11px] text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer"
                                        >
                                          {t('tasks.ctx.clearDue')}
                                        </button>
                                      ) : <span />}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const ts = combineTaskDateAndTime(rowCustomDateStr, rowCustomTimeStr);
                                          if (ts !== null) {
                                            void handleUpdateDueAt(task, ts);
                                          }
                                        }}
                                        className="k-interactive h-6.5 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11px] font-medium cursor-pointer"
                                      >
                                        {t('tasks.quickAdd.applyDate')}
                                      </button>
                                    </div>
                                  </div>
                                </PopoverSurface>
                              </div>
                            </motion.div>
                          </ContextMenuSurface>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <TaskDetailSheet
        task={effectiveTasks.find((tItem) => tItem.id === selectedTaskId) ?? null}
        orbits={orbits}
        columns={sortedColumns}
        onClose={() => setSelectedTaskId(null)}
        onToggleDone={handleToggleWithUndo}
        onUpdateText={handleCommitRenameText}
        onUpdateMeta={handleSheetUpdateMeta}
        onOpenItem={onOpenItem}
        onDelete={handleDeleteTask}
      />
    </div>
  );
};
