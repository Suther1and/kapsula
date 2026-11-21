import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ArrowSquareOut,
  Bell,
  BookmarkSimple,
  CalendarBlank,
  Check,
  CheckCircle,
  CheckSquare,
  Clock,
  Columns,
  DotsThree,
  Flag,
  Flame,
  FolderSimple,
  Lightning,
  ListBullets,
  Microphone,
  NotePencil,
  PencilSimple,
  Plus,
  Sparkle,
  Star,
  Trash,
  Tray,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { SECTION_COLOR_PALETTE } from '@shared/constants';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { isDoneColumn } from '@shared/task-helpers';
import type {
  OrbitDef,
  TaskBoardColumn,
  TaskPriority,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { formatReminderStamp } from '@renderer/lib/format';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { ItemActionSheet, type ActionSheetEntry } from './ItemActionSheet';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';
import { SwipeableRow } from './SwipeableRow';

interface TasksViewProps {
  tasks: VaultTaskEntry[];
  items: VaultItem[];
  orbits: OrbitDef[];
  columns: TaskBoardColumn[];
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  searchQuery: string;
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onToggleTask: (task: VaultTaskEntry) => Promise<void>;
  onAddQuickTask: (
    text: string,
    orbit?: string,
    dueAt?: number | null,
    columnId?: string,
    priority?: TaskPriority
  ) => Promise<void>;
  onEditTaskText: (task: VaultTaskEntry, nextText: string) => Promise<void>;
  onDeleteTask: (task: VaultTaskEntry) => Promise<void>;
  onMoveTaskOnBoard: (input: {
    itemId: string;
    taskKey: string;
    columnId: string;
    boardOrder: number;
  }) => Promise<void>;
  onUpdateTaskMeta: (input: {
    itemId: string;
    taskKey: string;
    priority?: TaskPriority;
    dueAt?: number | null;
    columnId?: string;
  }) => Promise<void>;
  onSaveColumns: (columns: TaskBoardColumn[]) => Promise<void>;
  onOpenNote: (itemId: string) => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
}

const TASKS_VIEW_MODE_KEY = 'kapsula_mobile_tasks_mode';
const BOARD_COL_ICONS_KEY = 'kapsula_mobile_board_col_icons';

type ColumnWithIcon = TaskBoardColumn & { icon?: string };

const COLUMN_ICON_MAP: Record<string, React.ComponentType<{ className?: string; weight?: 'regular' | 'duotone' | 'bold' | 'fill'; style?: React.CSSProperties }>> = {
  tray: Tray,
  flame: Flame,
  clock: Clock,
  check: CheckCircle,
  star: Star,
  flag: Flag,
  lightning: Lightning,
  folder: FolderSimple,
  bookmark: BookmarkSimple,
  sparkles: Sparkle,
};

const COLUMN_ICON_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'tray', label: 'Входящие' },
  { id: 'flame', label: 'В работе' },
  { id: 'clock', label: 'Ожидание' },
  { id: 'check', label: 'Готово' },
  { id: 'star', label: 'Важно' },
  { id: 'flag', label: 'Приоритет' },
  { id: 'lightning', label: 'Срочно' },
  { id: 'folder', label: 'Проект' },
  { id: 'bookmark', label: 'Идея' },
  { id: 'sparkles', label: 'Фокус' },
  { id: 'none', label: 'Точка' },
];

function readInitialViewMode(): 'list' | 'board' {
  try {
    return localStorage.getItem(TASKS_VIEW_MODE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

function readInitialShowColumnIcons(): boolean {
  try {
    return localStorage.getItem(BOARD_COL_ICONS_KEY) !== '0';
  } catch {
    return true;
  }
}

function resolveColumnIconId(col: ColumnWithIcon): string {
  const explicit = typeof col.icon === 'string' ? col.icon.trim() : '';
  if (explicit) return explicit;
  if (col.id === 'inbox') return 'tray';
  if (col.id === 'in_progress') return 'flame';
  if (col.id === 'waiting') return 'clock';
  if (col.id === 'done' || col.isDone) return 'check';
  return 'folder';
}

function normalizeTaskCompare(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/^[-*•]\s+\[[ xX]\]\s+/, '')
    .replace(/[«»"'`.,!?;:()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRIORITY_META: Record<
  TaskPriority,
  { label: string; short: string; color: string; bg: string }
> = {
  none: { label: 'Без приоритета', short: '', color: 'var(--k-ink-muted)', bg: 'transparent' },
  low: {
    label: 'Низкий',
    short: 'Низкий',
    color: 'var(--k-ink-secondary)',
    bg: 'color-mix(in srgb, var(--k-ink-secondary) 13%, transparent)',
  },
  medium: {
    label: 'Средний',
    short: 'Средний',
    color: 'var(--k-info)',
    bg: 'var(--k-info-soft)',
  },
  high: {
    label: 'Высокий',
    short: 'Высокий',
    color: 'var(--k-amber)',
    bg: 'var(--k-amber-soft)',
  },
  urgent: {
    label: 'Срочно',
    short: 'Срочно',
    color: 'var(--k-danger)',
    bg: 'var(--k-danger-soft)',
  },
};

const PRIORITY_OPTIONS: TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

function getTaskKey(task: VaultTaskEntry): string {
  return task.taskKey ?? (task.sourceType === 'markdown' ? `md:${task.taskIndex}` : `va:${task.taskIndex}`);
}

function getEffectiveDueAt(task: VaultTaskEntry): number | null {
  return task.dueAt ?? task.remindAt ?? null;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildPresetReminder(preset: 'none' | 'today' | 'tomorrow' | 'week'): number | null {
  if (preset === 'none') return null;
  const d = new Date();
  if (preset === 'today') {
    d.setHours(Math.max(d.getHours() + 2, 18), 0, 0, 0);
  } else if (preset === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 3);
    d.setHours(10, 0, 0, 0);
  }
  return d.getTime();
}

const AnimatedTaskCheck: React.FC<{ done: boolean; compact?: boolean }> = ({ done, compact = false }) => {
  const prefersReduced = useReducedMotion();
  return (
    <span
      className={`${compact ? 'w-5 h-5 rounded-md' : 'w-6 h-6 rounded-lg'} border flex items-center justify-center shrink-0 transition-[background-color,border-color,color] duration-[80ms] ease-out ${
        done
          ? 'bg-[var(--k-emerald)] border-[var(--k-emerald)] text-white'
          : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)]'
      }`}
    >
      <svg viewBox="0 0 16 16" className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} fill="none">
        <motion.path
          d="M3.2 8.4L6.6 11.6L12.8 4.6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
          transition={
            prefersReduced
              ? { duration: 0.01 }
              : { duration: 0.11, delay: 0, ease: [0.23, 1, 0.32, 1] }
          }
        />
      </svg>
    </span>
  );
};

export const TasksView: React.FC<TasksViewProps> = ({
  tasks,
  items,
  orbits,
  columns,
  isExpanded,
  hingeRightOffsetPx = 0,
  searchQuery,
  selectedTaskId,
  onSelectTask,
  onToggleTask,
  onAddQuickTask,
  onEditTaskText,
  onDeleteTask,
  onMoveTaskOnBoard,
  onUpdateTaskMeta,
  onSaveColumns,
  onOpenNote,
  onCreateOrbit,
}) => {
  const prefersReduced = useReducedMotion();
  const [viewMode, setViewMode] = useState<'list' | 'board'>(readInitialViewMode);
  const [filter, setFilter] = useState<'active' | 'all' | 'done'>('active');
  const [newTaskText, setNewTaskText] = useState('');
  const [quickDue, setQuickDue] = useState<'none' | 'today' | 'tomorrow'>('none');
  const [quickOrbit, setQuickOrbit] = useState('');
  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  // Board state
  const [showColumnIcons, setShowColumnIcons] = useState<boolean>(readInitialShowColumnIcons);
  const [activeBoardColId, setActiveBoardColId] = useState<string>(columns[0]?.id ?? 'inbox');
  const [inlineAddColId, setInlineAddColId] = useState<string | null>(null);
  const [inlineAddText, setInlineAddText] = useState('');
  const [moveColumnTask, setMoveColumnTask] = useState<VaultTaskEntry | null>(null);
  const [columnSheetOpen, setColumnSheetOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<ColumnWithIcon | null>(null);
  const [colTitleDraft, setColTitleDraft] = useState('');
  const [colColorDraft, setColColorDraft] = useState(SECTION_COLOR_PALETTE[0]!);
  const [colIconDraft, setColIconDraft] = useState<string>('folder');

  // Expanded long-press pointer drag state
  const [draggingTask, setDraggingTask] = useState<{
    task: VaultTaskEntry;
    x: number;
    y: number;
    overColumnId: string | null;
  } | null>(null);
  const dragStateRef = useRef<{
    task: VaultTaskEntry;
    x: number;
    y: number;
    overColumnId: string | null;
  } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const columnRefs = useRef<Map<string, HTMLElement>>(new Map());
  const carouselRef = useRef<HTMLDivElement | null>(null);

  const [actionTask, setActionTask] = useState<VaultTaskEntry | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [editDraft, setEditDraft] = useState('');

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const colMap = useMemo(() => new Map(columns.map((c) => [c.id, c as ColumnWithIcon])), [columns]);
  const taskCountByItemId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      counts.set(t.itemId, (counts.get(t.itemId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);
  const selectedQuickOrbit = quickOrbit ? orbitMap.get(quickOrbit) ?? null : null;

  const isStandaloneSelfTask = (task: VaultTaskEntry): boolean => {
    if (task.sourceType !== 'markdown') return false;
    if ((taskCountByItemId.get(task.itemId) ?? 1) > 1) return false;
    const normTitle = normalizeTaskCompare(task.itemTitle || '');
    const normText = normalizeTaskCompare(task.text || '');
    if (!normTitle) return true;
    if (normTitle === normText) return true;
    if (normTitle.length >= 16 && normText.startsWith(normTitle)) return true;
    if (normText.length >= 16 && normTitle.startsWith(normText)) return true;
    if (
      normTitle.length >= 24 &&
      normText.length >= 24 &&
      normTitle.slice(0, 24) === normText.slice(0, 24)
    ) {
      return true;
    }
    const parent = itemMap.get(task.itemId);
    if (parent?.body) {
      const nonEmptyLines = parent.body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (nonEmptyLines.length === 1 && /^[-*•]\s+\[[ xX]\]\s+/.test(nonEmptyLines[0]!)) {
        return true;
      }
    }
    return false;
  };

  const toggleShowColumnIcons = () => {
    setShowColumnIcons((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(BOARD_COL_ICONS_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  const renderColumnGlyph = (col: ColumnWithIcon, sizeClass = 'w-4 h-4') => {
    const iconId = resolveColumnIconId(col);
    const IconComp = showColumnIcons && iconId !== 'none' ? COLUMN_ICON_MAP[iconId] : undefined;
    if (IconComp) {
      return <IconComp weight="duotone" className={`${sizeClass} shrink-0`} style={{ color: col.color }} />;
    }
    return <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: col.color }} />;
  };

  const setPersistedViewMode = (next: 'list' | 'board') => {
    setViewMode(next);
    try {
      localStorage.setItem(TASKS_VIEW_MODE_KEY, next);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (columns.length > 0 && !columns.some((c) => c.id === activeBoardColId)) {
      setActiveBoardColId(columns[0]!.id);
    }
  }, [columns, activeBoardColId]);

  useEffect(() => {
    return () => {
      if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    };
  }, []);

  const [optimisticToggleMap, setOptimisticToggleMap] = useState<
    Record<string, { done: boolean; columnId?: string }>
  >({});
  const inFlightToggleSeqRef = useRef<Map<string, number>>(new Map());
  const toggleSeqCounterRef = useRef(0);

  useEffect(() => {
    setOptimisticToggleMap((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, { done: boolean; columnId?: string }> = {};
      for (const id of keys) {
        if (inFlightToggleSeqRef.current.has(id)) {
          next[id] = prev[id]!;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const effectiveTasks = useMemo(() => {
    if (Object.keys(optimisticToggleMap).length === 0) return tasks;
    return tasks.map((t) => {
      const patch = optimisticToggleMap[t.id];
      return patch ? { ...t, ...patch } : t;
    });
  }, [tasks, optimisticToggleMap]);

  const searchFilteredTasks = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return effectiveTasks;
    return effectiveTasks.filter((t) => matchesBilingualHaystack(`${t.text} ${t.itemTitle}`, q));
  }, [effectiveTasks, searchQuery]);

  const filteredTasks = useMemo(() => {
    return searchFilteredTasks.filter((t) => {
      if (filter === 'active' && t.done) return false;
      if (filter === 'done' && !t.done) return false;
      return true;
    });
  }, [searchFilteredTasks, filter]);

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, VaultTaskEntry[]>();
    for (const col of columns) {
      map.set(col.id, []);
    }
    const defaultColId = columns.find((c) => !c.isDone && c.id !== 'done')?.id ?? columns[0]?.id ?? 'inbox';
    const doneColId = columns.find((c) => c.isDone || c.id === 'done')?.id ?? 'done';

    for (const task of searchFilteredTasks) {
      let colId = task.columnId;
      if (!colId || !map.has(colId)) {
        colId = task.done ? doneColId : defaultColId;
      }
      if (!map.has(colId)) {
        map.set(colId, []);
      }
      map.get(colId)!.push(task);
    }

    map.forEach((arr) => {
      arr.sort((a, b) => (a.boardOrder ?? 0) - (b.boardOrder ?? 0) || b.updatedAt - a.updatedAt);
    });
    return map;
  }, [searchFilteredTasks, columns]);

  const groups = useMemo(() => {
    if (filter === 'done') {
      return filteredTasks.length > 0
        ? [{ key: 'done', label: 'Выполненные', color: 'var(--k-emerald)', items: filteredTasks }]
        : [];
    }
    const todayStart = startOfTodayMs();
    const tomorrowStart = todayStart + 86_400_000;
    const overdue: VaultTaskEntry[] = [];
    const today: VaultTaskEntry[] = [];
    const upcoming: VaultTaskEntry[] = [];
    const nodate: VaultTaskEntry[] = [];

    for (const t of filteredTasks) {
      const due = getEffectiveDueAt(t);
      if (!due) nodate.push(t);
      else if (due < todayStart && !t.done) overdue.push(t);
      else if (due < tomorrowStart) today.push(t);
      else upcoming.push(t);
    }

    const out: Array<{ key: string; label: string; color?: string; items: VaultTaskEntry[] }> = [];
    if (overdue.length > 0)
      out.push({ key: 'overdue', label: 'Просрочено', color: 'var(--k-danger)', items: overdue });
    if (today.length > 0)
      out.push({ key: 'today', label: 'Сегодня', color: 'var(--k-accent)', items: today });
    if (upcoming.length > 0)
      out.push({ key: 'upcoming', label: 'Скоро', color: 'var(--k-amber)', items: upcoming });
    if (nodate.length > 0) out.push({ key: 'nodate', label: 'Без срока', items: nodate });
    return out;
  }, [filteredTasks, filter]);

  const selectedTask = useMemo(() => {
    if (selectedTaskId) {
      return effectiveTasks.find((t) => t.id === selectedTaskId) ?? null;
    }
    return isExpanded && viewMode === 'list' ? filteredTasks[0] ?? null : null;
  }, [effectiveTasks, selectedTaskId, isExpanded, viewMode, filteredTasks]);

  useEffect(() => {
    setEditingText(false);
    setEditDraft(selectedTask?.text ?? '');
  }, [selectedTask?.id, selectedTask?.text]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newTaskText.trim();
    if (!clean || adding) return;
    setAdding(true);
    try {
      await onAddQuickTask(
        clean,
        quickOrbit,
        buildPresetReminder(quickDue),
        viewMode === 'board' ? activeBoardColId : undefined
      );
      setNewTaskText('');
      mobileBridge.haptic('success');
      toast.success('Задача добавлена');
    } finally {
      setAdding(false);
    }
  };

  const handleInlineAddInColumn = async (e: React.FormEvent, colId: string) => {
    e.preventDefault();
    const clean = inlineAddText.trim();
    if (!clean || adding) return;
    setAdding(true);
    try {
      await onAddQuickTask(clean, quickOrbit, null, colId);
      setInlineAddText('');
      setInlineAddColId(null);
      mobileBridge.haptic('success');
      toast.success('Задача добавлена в колонку');
    } finally {
      setAdding(false);
    }
  };

  const handleToggleWithToast = (task: VaultTaskEntry) => {
    const wasDone = task.done;
    const nextDone = !wasDone;
    const doneColId = columns.find((c) => c.isDone || c.id === 'done')?.id ?? 'done';
    const defaultColId = columns.find((c) => !c.isDone && c.id !== 'done')?.id ?? columns[0]?.id ?? 'inbox';
    const prevColId =
      task.columnId && task.columnId !== doneColId ? task.columnId : defaultColId;
    const seq = ++toggleSeqCounterRef.current;

    inFlightToggleSeqRef.current.set(task.id, seq);
    setOptimisticToggleMap((prev) => ({
      ...prev,
      [task.id]: {
        done: nextDone,
        columnId: nextDone ? doneColId : prevColId,
      },
    }));

    mobileBridge.haptic(wasDone ? 'light' : 'success');
    void onToggleTask(task)
      .then(() => {
        if (inFlightToggleSeqRef.current.get(task.id) === seq) {
          inFlightToggleSeqRef.current.delete(task.id);
        }
      })
      .catch(() => {
        if (inFlightToggleSeqRef.current.get(task.id) === seq) {
          inFlightToggleSeqRef.current.delete(task.id);
          setOptimisticToggleMap((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
      });

    if (!wasDone) {
      toast('Задача выполнена', {
        duration: 4500,
        action: {
          label: 'Отменить',
          onClick: () => {
            const undoSeq = ++toggleSeqCounterRef.current;
            inFlightToggleSeqRef.current.set(task.id, undoSeq);
            setOptimisticToggleMap((prev) => ({
              ...prev,
              [task.id]: {
                done: false,
                columnId: prevColId,
              },
            }));
            void onToggleTask({ ...task, done: true })
              .then(() => {
                if (inFlightToggleSeqRef.current.get(task.id) === undoSeq) {
                  inFlightToggleSeqRef.current.delete(task.id);
                }
              })
              .catch(() => {
                if (inFlightToggleSeqRef.current.get(task.id) === undoSeq) {
                  inFlightToggleSeqRef.current.delete(task.id);
                  setOptimisticToggleMap((prev) => {
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
  };

  const handleQuickSchedule = async (
    task: VaultTaskEntry,
    preset: 'today' | 'tomorrow' | 'week' | 'clear'
  ) => {
    const nextDue = preset === 'clear' ? null : buildPresetReminder(preset);
    await onUpdateTaskMeta({
      itemId: task.itemId,
      taskKey: getTaskKey(task),
      dueAt: nextDue,
    });
    mobileBridge.haptic('light');
    toast(nextDue ? 'Срок задачи обновлён' : 'Срок снят');
  };

  const handleMoveToColumn = async (task: VaultTaskEntry, targetColId: string) => {
    const colTasks = tasksByColumn.get(targetColId) ?? [];
    const maxOrder = colTasks.reduce((m, t) => Math.max(m, t.boardOrder ?? 0), 0);
    await onMoveTaskOnBoard({
      itemId: task.itemId,
      taskKey: getTaskKey(task),
      columnId: targetColId,
      boardOrder: maxOrder + 1000,
    });
    mobileBridge.haptic('success');
    const colName = colMap.get(targetColId)?.title ?? 'колонку';
    toast.success(`Перенесено: ${colName}`);
  };

  const getNextColumnId = (currentColId?: string): string | null => {
    if (columns.length <= 1) return null;
    const idx = columns.findIndex((c) => c.id === currentColId);
    const nextIdx = idx < 0 ? 1 : (idx + 1) % columns.length;
    return columns[nextIdx]?.id ?? null;
  };

  const scrollToBoardColumn = (colId: string) => {
    setActiveBoardColId(colId);
    const el = columnRefs.current.get(colId);
    if (el) {
      el.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', inline: 'start', block: 'nearest' });
    }
  };

  const handleMoveToColumnRef = useRef(handleMoveToColumn);
  handleMoveToColumnRef.current = handleMoveToColumn;

  // Expanded Fold pointer long-press drag & drop
  const startBoardCardPointerDown = (e: React.PointerEvent, task: VaultTaskEntry) => {
    if (!isExpanded || e.button !== 0) return;
    if ((e.target as HTMLElement)?.closest('button, input')) return;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    const startX = e.clientX;
    const startY = e.clientY;
    dragTimerRef.current = setTimeout(() => {
      mobileBridge.haptic('medium');
      const nextDrag = {
        task,
        x: startX,
        y: startY,
        overColumnId: task.columnId ?? columns[0]?.id ?? null,
      };
      dragStateRef.current = nextDrag;
      setDraggingTask(nextDrag);
    }, 260);
  };

  const isDraggingTask = Boolean(draggingTask);

  useEffect(() => {
    if (!isDraggingTask) return;
    const prevTouchAction = document.body.style.touchAction;
    document.body.style.touchAction = 'none';
    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault();
    };
    const onMove = (ev: PointerEvent) => {
      const current = dragStateRef.current;
      if (!current) return;
      let overId: string | null = null;
      columnRefs.current.forEach((el, colId) => {
        const rect = el.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          overId = colId;
        }
      });
      current.x = ev.clientX;
      current.y = ev.clientY;
      if (dragGhostRef.current) {
        dragGhostRef.current.style.transform = `translate3d(${ev.clientX - 120}px, ${ev.clientY - 24}px, 0) scale(1.02)`;
      }
      if (current.overColumnId !== overId) {
        current.overColumnId = overId;
        setDraggingTask({ ...current });
      }
    };
    const onUp = () => {
      const currentDrag = dragStateRef.current;
      dragStateRef.current = null;
      setDraggingTask(null);
      if (currentDrag?.overColumnId && currentDrag.overColumnId !== currentDrag.task.columnId) {
        void handleMoveToColumnRef.current(currentDrag.task, currentDrag.overColumnId);
      }
    };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      document.body.style.touchAction = prevTouchAction;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isDraggingTask]);

  const cancelPendingDrag = (e?: React.PointerEvent) => {
    if (!dragTimerRef.current) return;
    if (e && dragOriginRef.current) {
      const dx = Math.abs(e.clientX - dragOriginRef.current.x);
      const dy = Math.abs(e.clientY - dragOriginRef.current.y);
      if (dx < 8 && dy < 8) return;
    }
    clearTimeout(dragTimerRef.current);
    dragTimerRef.current = null;
  };

  const openColumnCreate = () => {
    setEditingColumn(null);
    setColTitleDraft('');
    setColColorDraft(SECTION_COLOR_PALETTE[columns.length % SECTION_COLOR_PALETTE.length]!);
    setColIconDraft('folder');
    setColumnSheetOpen(true);
  };

  const openColumnEdit = (col: ColumnWithIcon) => {
    setEditingColumn(col);
    setColTitleDraft(col.title);
    setColColorDraft(col.color);
    setColIconDraft(resolveColumnIconId(col));
    setColumnSheetOpen(true);
  };

  const handleSaveColumnForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = colTitleDraft.trim();
    if (!clean) return;
    if (editingColumn) {
      const next = columns.map((c) =>
        c.id === editingColumn.id
          ? ({ ...c, title: clean, color: colColorDraft, icon: colIconDraft } as TaskBoardColumn)
          : c
      );
      await onSaveColumns(next);
      toast.success('Колонка обновлена');
    } else {
      const id = `col_${Date.now().toString(36)}`;
      const doneIdx = columns.findIndex((c) => c.isDone || c.id === 'done');
      const newCol: ColumnWithIcon = {
        id,
        title: clean,
        color: colColorDraft,
        icon: colIconDraft,
        order: doneIdx >= 0 ? doneIdx : columns.length,
      };
      const next = [...columns];
      if (doneIdx >= 0) next.splice(doneIdx, 0, newCol as TaskBoardColumn);
      else next.push(newCol as TaskBoardColumn);
      await onSaveColumns(next.map((c, idx) => ({ ...c, order: idx })));
      setActiveBoardColId(id);
      toast.success('Колонка добавлена');
    }
    setColumnSheetOpen(false);
  };

  const handleDeleteColumn = async (col: TaskBoardColumn) => {
    if (col.isDone || col.id === 'done' || columns.length <= 2) {
      toast.error('Нельзя удалить эту базовую колонку');
      return;
    }
    const next = columns.filter((c) => c.id !== col.id).map((c, idx) => ({ ...c, order: idx }));
    await onSaveColumns(next);
    setColumnSheetOpen(false);
    toast('Колонка удалена · задачи перенесены во «Входящие»');
  };

  const buildTaskActions = (task: VaultTaskEntry): ActionSheetEntry[] => [
    {
      id: 'toggle',
      label: task.done ? 'Вернуть в активные' : 'Отметить выполненной',
      icon: <Check weight="bold" className="w-5 h-5" />,
      accent: !task.done,
      onSelect: () => handleToggleWithToast(task),
    },
    {
      id: 'move-column',
      label: 'Перенести в колонку',
      subtitle: colMap.get(task.columnId ?? '')?.title || 'Входящие',
      icon: <Columns className="w-5 h-5" />,
      onSelect: () => setMoveColumnTask(task),
    },
    {
      id: 'edit',
      label: 'Редактировать текст',
      icon: <PencilSimple className="w-5 h-5" />,
      onSelect: () => {
        onSelectTask(task.id);
        setEditDraft(task.text);
        setEditingText(true);
      },
    },
    {
      id: 'today',
      label: 'Перенести на сегодня',
      icon: <CalendarBlank className="w-5 h-5" />,
      onSelect: () => void handleQuickSchedule(task, 'today'),
    },
    {
      id: 'tomorrow',
      label: 'Перенести на завтра',
      icon: <Bell className="w-5 h-5" />,
      onSelect: () => void handleQuickSchedule(task, 'tomorrow'),
    },
    {
      id: 'open-note',
      label: 'Открыть заметку',
      subtitle: task.itemTitle,
      icon: <ArrowSquareOut className="w-5 h-5" />,
      onSelect: () => onOpenNote(task.itemId),
    },
    {
      id: 'delete',
      label: 'Удалить задачу',
      icon: <Trash className="w-5 h-5" />,
      danger: true,
      onSelect: () => {
        if (selectedTaskId === task.id) onSelectTask(null);
        void onDeleteTask(task);
      },
    },
  ];

  const renderTaskDetail = (task: VaultTaskEntry) => {
    const parentItem = itemMap.get(task.itemId);
    const orbit = task.orbit ? orbitMap.get(task.orbit) : null;
    const due = getEffectiveDueAt(task);
    const currentCol = colMap.get(task.columnId ?? '') ?? columns[0];
    const priority = task.priority ?? 'none';

    return (
      <div className="p-4 space-y-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => handleToggleWithToast(task)}
            className="inline-flex items-center justify-center w-9 h-9 -m-1.5 shrink-0"
            aria-label={task.done ? 'Снять отметку' : 'Отметить выполненной'}
          >
            <AnimatedTaskCheck done={task.done} />
          </button>
          <div className="min-w-0 flex-1">
            {editingText ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const clean = editDraft.trim();
                  if (!clean) return;
                  await onEditTaskText(task, clean);
                  setEditingText(false);
                  toast.success('Задача обновлена');
                }}
                className="space-y-2"
              >
                <input
                  type="text"
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-focus)] outline-none text-[14.5px] text-[var(--k-ink-primary)]"
                />
                <div className="flex items-center gap-1.5">
                  <button
                    type="submit"
                    className="k-tap px-3 h-8 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold"
                  >
                    Сохранить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditDraft(task.text);
                      setEditingText(false);
                    }}
                    className="k-tap px-3 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[12.5px] text-[var(--k-ink-secondary)]"
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <h3
                  className={`text-[16.5px] font-semibold leading-snug ${
                    task.done
                      ? 'line-through text-[var(--k-ink-muted)]'
                      : 'text-[var(--k-ink-primary)]'
                  }`}
                >
                  {task.text}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setEditDraft(task.text);
                    setEditingText(true);
                  }}
                  aria-label="Редактировать текст задачи"
                  className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] shrink-0"
                >
                  <PencilSimple className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 mt-1.5 flex-wrap min-w-0">
              {!isStandaloneSelfTask(task) ? (
                <button
                  type="button"
                  onClick={() => onOpenNote(task.itemId)}
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--k-accent)] max-w-full min-w-0 overflow-hidden"
                >
                  {task.sourceType === 'voice_action' ? (
                    <Microphone className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <NotePencil className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">{task.itemTitle}</span>
                </button>
              ) : null}
              {orbit ? (
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-medium text-[var(--k-ink-primary)]"
                  style={{ background: `color-mix(in srgb, ${orbit.color} 13%, transparent)` }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: orbit.color }}
                  />
                  {orbit.name}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Column Selector */}
        <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] p-3.5 space-y-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[var(--k-ink-secondary)] inline-flex items-center gap-1.5">
              <Columns className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              Колонка доски
            </span>
            <span className="text-[var(--k-ink-primary)] font-medium">
              {currentCol?.title || 'Входящие'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {columns.map((col) => {
              const active = (task.columnId ?? columns[0]?.id) === col.id;
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => void handleMoveToColumn(task, col.id)}
                  className={`k-tap inline-flex items-center gap-1.5 px-2.5 h-8 rounded-xl text-[12px] font-medium border ${
                    active
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  {renderColumnGlyph(col as ColumnWithIcon, 'w-3.5 h-3.5')}
                  {col.title}
                </button>
              );
            })}
          </div>
        </div>

        {/* Priority Picker */}
        <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] p-3.5 space-y-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[var(--k-ink-secondary)] inline-flex items-center gap-1.5">
              <Flag className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              Приоритет
            </span>
            <span className="text-[var(--k-ink-primary)] font-medium">
              {PRIORITY_META[priority].label}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {PRIORITY_OPTIONS.map((p) => {
              const meta = PRIORITY_META[p];
              const active = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={async () => {
                    await onUpdateTaskMeta({
                      itemId: task.itemId,
                      taskKey: getTaskKey(task),
                      priority: p,
                    });
                    mobileBridge.haptic('light');
                  }}
                  className={`k-tap px-2.5 h-8 rounded-xl text-[12px] font-medium border ${
                    active
                      ? 'border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                  style={active && p !== 'none' ? { background: meta.bg, color: meta.color } : undefined}
                >
                  {p === 'none' ? 'Нет' : meta.short}
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-Task Due Date Controls (fixes shared parent remindAt collision!) */}
        <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] p-3.5 space-y-2.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[var(--k-ink-secondary)] inline-flex items-center gap-1.5">
              <Bell className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              Срок этой задачи
            </span>
            <span className="text-[var(--k-ink-primary)] font-medium">
              {due ? formatReminderStamp(due) : 'Не задан'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { id: 'today', label: 'Сегодня' },
                { id: 'tomorrow', label: 'Завтра' },
                { id: 'week', label: 'Через 3 дня' },
                { id: 'clear', label: 'Снять срок' },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => void handleQuickSchedule(task, btn.id)}
                className="k-tap h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]"
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        {parentItem?.body ? (
          <div className="rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] p-3.5 space-y-1.5">
            <div className="text-[11.5px] font-medium text-[var(--k-ink-muted)]">
              Контекст заметки
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--k-ink-secondary)] whitespace-pre-wrap line-clamp-6">
              {parentItem.body
                .replace(/^#{1,6}\s+/gm, '')
                .replace(/^(\s*)[-*•]\s+\[x\]\s+/gim, '$1☑ ')
                .replace(/^(\s*)[-*•]\s+\[\s\]\s+/gim, '$1☐ ')
                .trim()}
            </p>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenNote(task.itemId)}
            className="k-tap flex-1 inline-flex items-center justify-center gap-2 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13.5px] font-semibold"
          >
            <ArrowSquareOut className="w-4 h-4" />
            Открыть заметку
          </button>
          <button
            type="button"
            onClick={() => {
              onSelectTask(null);
              void onDeleteTask(task);
            }}
            aria-label="Удалить задачу"
            className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-danger)]"
          >
            <Trash className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const renderBoardCard = (task: VaultTaskEntry, col: TaskBoardColumn) => {
    const orbit = task.orbit ? orbitMap.get(task.orbit) : null;
    const due = getEffectiveDueAt(task);
    const priority = task.priority ?? 'none';
    const priMeta = PRIORITY_META[priority];
    const nextColId = getNextColumnId(col.id);
    const nextCol = nextColId ? colMap.get(nextColId) : null;
    const isDraggingThis = draggingTask?.task.id === task.id;

    return (
      <SwipeableRow
        key={task.id}
        disabled={Boolean(draggingTask)}
        onLongPress={isExpanded ? undefined : () => setActionTask(task)}
        leftAction={
          nextCol
            ? {
                label: nextCol.title,
                icon: <ArrowRight weight="bold" className="w-4 h-4" />,
                bgClass: 'bg-[var(--k-accent)]',
                textClass: 'text-[var(--k-ink-on-accent)]',
                onTrigger: () => void handleMoveToColumn(task, nextCol.id),
              }
            : undefined
        }
        rightAction={{
          label: 'Удалить',
          icon: <Trash weight="fill" className="w-4 h-4" />,
          bgClass: 'bg-[var(--k-danger)]',
          onTrigger: () => {
            if (selectedTaskId === task.id) onSelectTask(null);
            void onDeleteTask(task);
          },
        }}
      >
        <div
          data-testid={`kanban-card-${task.id}`}
          onPointerDown={(e) => startBoardCardPointerDown(e, task)}
          onPointerMove={(e) => cancelPendingDrag(e)}
          onPointerUp={() => cancelPendingDrag()}
          onPointerCancel={() => cancelPendingDrag()}
          onClick={() => onSelectTask(task.id)}
          className={`rounded-2xl p-3 border bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] space-y-2 cursor-pointer transition-opacity ${
            isDraggingThis ? 'opacity-40' : 'opacity-100'
          }`}
        >
          <div className="flex items-start gap-2">
            <button
              type="button"
              data-testid={`task-check-${task.id}`}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleWithToast(task);
              }}
              aria-label={task.done ? 'Снять отметку' : 'Отметить выполненной'}
              className="inline-flex items-center justify-center w-9 h-9 -ml-2 -my-1.5 shrink-0"
            >
              <AnimatedTaskCheck done={task.done} compact />
            </button>
            <div
              className={`flex-1 min-w-0 text-[13.5px] leading-snug ${
                task.done
                  ? 'line-through text-[var(--k-ink-muted)]'
                  : 'text-[var(--k-ink-primary)] font-medium'
              }`}
            >
              {task.text}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                mobileBridge.haptic('light');
                setActionTask(task);
              }}
              aria-label="Действия с задачей"
              className="inline-flex items-center justify-center w-9 h-9 -mr-2 -my-1.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] shrink-0"
            >
              <DotsThree weight="bold" className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            {priority !== 'none' ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-semibold"
                style={{ background: priMeta.bg, color: priMeta.color }}
              >
                <Flag weight="fill" className="w-2.5 h-2.5" />
                {priMeta.short}
              </span>
            ) : null}

            {due ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium">
                <CalendarBlank className="w-3 h-3" />
                {formatReminderStamp(due)}
              </span>
            ) : null}

            {orbit ? (
              <span
                className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md font-medium text-[var(--k-ink-primary)]"
                style={{ background: `color-mix(in srgb, ${orbit.color} 13%, transparent)` }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: orbit.color }}
                />
                {orbit.name}
              </span>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--k-border-hairline)] min-w-0">
            {!isStandaloneSelfTask(task) ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenNote(task.itemId);
                }}
                className="flex-1 min-w-0 max-w-full inline-flex items-center gap-1 text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-accent)] overflow-hidden text-left"
              >
                <NotePencil className="w-3 h-3 shrink-0" />
                <span className="truncate">{task.itemTitle}</span>
              </button>
            ) : (
              <span className="flex-1 min-w-0" />
            )}

            <button
              type="button"
              data-testid={`kanban-move-chip-${task.id}`}
              onClick={(e) => {
                e.stopPropagation();
                mobileBridge.haptic('light');
                setMoveColumnTask(task);
              }}
              className="k-tap inline-flex items-center gap-1 px-2 h-6 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[10.5px] font-medium text-[var(--k-ink-secondary)] shrink-0"
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: col.color }} />
              <span>Перенести</span>
            </button>
          </div>
        </div>
      </SwipeableRow>
    );
  };

  const activeCount = tasks.filter((t) => !t.done).length;
  const doneCount = tasks.length - activeCount;

  return (
    <div data-testid="mobile-tasks-view" className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col h-full min-h-0">
        {/* Top Controls: View Mode Toggle (Список | Доска) + Quick Add + Filters */}
        <div className="px-4 pt-3 pb-2.5 space-y-2 border-b border-[var(--k-border-hairline)] shrink-0">
          <div className="flex items-center justify-between gap-1.5 flex-wrap">
            {/* Persisted List | Board Segmented Toggle */}
            <div className="inline-flex p-0.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] shrink-0">
              {(
                [
                  { id: 'list', label: 'Список', icon: ListBullets, testId: 'tasks-view-list' },
                  { id: 'board', label: 'Доска', icon: Columns, testId: 'tasks-view-board' },
                ] as const
              ).map((m) => {
                const active = viewMode === m.id;
                const Icon = m.icon;
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-testid={m.testId}
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setPersistedViewMode(m.id);
                    }}
                    className={`relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[10px] text-[12px] font-semibold transition-colors ${
                      active ? 'text-[var(--k-ink-primary)]' : 'text-[var(--k-ink-muted)]'
                    }`}
                  >
                    {active ? (
                      <motion.span
                        layoutId="k-tasks-viewmode-pill"
                        transition={
                          prefersReduced
                            ? { duration: 0.01 }
                            : { type: 'spring', stiffness: 480, damping: 35 }
                        }
                        className="absolute inset-0 rounded-[10px] bg-[var(--k-bg-surface-1)] shadow-xs"
                      />
                    ) : null}
                    <Icon className="w-3.5 h-3.5 relative z-10" />
                    <span className="relative z-10">{m.label}</span>
                  </button>
                );
              })}
            </div>

            {viewMode === 'board' ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="kanban-toggle-icons-btn"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    toggleShowColumnIcons();
                  }}
                  aria-pressed={showColumnIcons}
                  aria-label="Иконки колонок"
                  title="Иконки колонок"
                  className={`k-tap inline-flex items-center justify-center gap-1 px-2 min-[390px]:px-2.5 h-8 rounded-xl border text-[11.5px] font-medium transition-colors ${
                    showColumnIcons
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-muted)]'
                  }`}
                >
                  <Sparkle weight={showColumnIcons ? 'duotone' : 'regular'} className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden min-[390px]:inline">Иконки</span>
                </button>
                <button
                  type="button"
                  data-testid="kanban-add-column-btn"
                  onClick={openColumnCreate}
                  className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-primary)] whitespace-nowrap"
                >
                  <Plus weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                  Колонка
                </button>
              </div>
            ) : (
              <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular">
                Активных: {activeCount}
              </span>
            )}
          </div>

          <form onSubmit={(e) => void handleAdd(e)} className="flex items-center gap-2">
            <input
              type="text"
              data-testid="tasks-quick-add-input"
              value={newTaskText}
              onChange={(e) => setNewTaskText(e.target.value)}
              placeholder={
                viewMode === 'board'
                  ? `Новая задача в «${colMap.get(activeBoardColId)?.title ?? 'Входящие'}»…`
                  : 'Новая задача…'
              }
              className="flex-1 h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
            <button
              type="submit"
              data-testid="tasks-quick-add-submit"
              disabled={!newTaskText.trim() || adding}
              aria-label="Добавить задачу"
              className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] disabled:opacity-40 shrink-0"
            >
              <Plus weight="bold" className="w-5 h-5" />
            </button>
          </form>

          {viewMode === 'list' ? (
            <>
              {/* Inline quick schedule + section chips */}
              <div className="flex items-center gap-1 flex-wrap">
                {(
                  [
                    { id: 'none', label: 'Без срока' },
                    { id: 'today', label: 'Сегодня' },
                    { id: 'tomorrow', label: 'Завтра' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setQuickDue(opt.id)}
                    className={`k-tap px-2 h-7 rounded-lg text-[11px] font-medium shrink-0 border transition-colors ${
                      quickDue === opt.id
                        ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                        : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-muted)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}

                <PickerTriggerChip
                  compact
                  colorDot={selectedQuickOrbit?.color}
                  icon={<FolderSimple className="w-3 h-3 text-[var(--k-accent)] shrink-0" />}
                  label={selectedQuickOrbit?.name || 'Раздел'}
                  placeholder={!selectedQuickOrbit}
                  onClick={() => setOrbitPickerOpen(true)}
                  className="shrink-0 max-w-[124px]"
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex p-0.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
                  {(
                    [
                      { id: 'active', label: `Активные · ${activeCount}` },
                      { id: 'all', label: `Все · ${tasks.length}` },
                      { id: 'done', label: `Готовые · ${doneCount}` },
                    ] as const
                  ).map((tab) => {
                    const active = filter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          mobileBridge.haptic('light');
                          setFilter(tab.id);
                        }}
                        className={`relative px-2.5 py-1 rounded-[10px] text-[12px] font-medium transition-colors ${
                          active ? 'text-[var(--k-ink-primary)]' : 'text-[var(--k-ink-muted)]'
                        }`}
                      >
                        {active ? (
                          <motion.span
                            layoutId="k-tasks-filter-pill"
                            transition={
                              prefersReduced
                                ? { duration: 0.01 }
                                : { type: 'spring', stiffness: 480, damping: 35 }
                            }
                            className="absolute inset-0 rounded-[10px] bg-[var(--k-bg-surface-1)] shadow-xs"
                          />
                        ) : null}
                        <span className="relative z-10">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            /* Board Column Chip Strip with live counts */
            <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar k-scroll-fade-r pr-4 pb-0.5">
              {columns.map((col) => {
                const count = tasksByColumn.get(col.id)?.length ?? 0;
                const active = activeBoardColId === col.id;
                return (
                  <button
                    key={col.id}
                    type="button"
                    data-testid={`kanban-col-chip-${col.id}`}
                    onClick={() => {
                      mobileBridge.haptic('light');
                      scrollToBoardColumn(col.id);
                    }}
                    className={`k-tap inline-flex items-center gap-1.5 px-2.5 h-8 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                      active
                        ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                        : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                    }`}
                  >
                    {renderColumnGlyph(col as ColumnWithIcon, 'w-3.5 h-3.5')}
                    <span>{col.title}</span>
                    <span className="text-[11px] text-[var(--k-ink-muted)] k-tabular">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ==================== BOARD VIEW (COMPACT SNAP CAROUSEL / EXPANDED MULTI-COLUMN) ==================== */}
        {viewMode === 'board' ? (
          <div
            ref={carouselRef}
            data-testid="mobile-kanban-board"
            style={draggingTask ? { touchAction: 'none' } : undefined}
            className={`flex-1 min-h-0 flex gap-3 overflow-x-auto overflow-y-hidden px-3.5 py-3 pb-24 k-no-scrollbar ${
              draggingTask ? 'touch-none select-none' : ''
            } ${
              isExpanded ? '' : 'snap-x snap-mandatory scroll-px-3.5'
            }`}
          >
            {columns.map((col) => {
              const colTasks = tasksByColumn.get(col.id) ?? [];
              const isDropTarget = draggingTask?.overColumnId === col.id;
              return (
                <section
                  key={col.id}
                  ref={(node) => {
                    if (node) columnRefs.current.set(col.id, node);
                    else columnRefs.current.delete(col.id);
                  }}
                  data-testid={`kanban-column-${col.id}`}
                  className={`flex flex-col h-full min-h-0 rounded-2xl border transition-colors shrink-0 ${
                    isExpanded ? 'w-[290px] lg:w-[310px]' : 'w-[84vw] snap-start'
                  } ${
                    isDropTarget
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-rail)] border-[var(--k-border-hairline)]'
                  }`}
                >
                  {/* Column Header */}
                  <div className="px-3 py-2.5 border-b border-[var(--k-border-hairline)] flex items-center justify-between gap-2 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {renderColumnGlyph(col as ColumnWithIcon, 'w-4 h-4')}
                      <h3 className="text-[13.5px] font-bold text-[var(--k-ink-primary)] truncate">
                        {col.title}
                      </h3>
                      <span className="px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[11px] font-semibold text-[var(--k-ink-muted)] k-tabular">
                        {colTasks.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setInlineAddColId(col.id);
                          setInlineAddText('');
                        }}
                        aria-label={`Добавить задачу в ${col.title}`}
                        className="k-tap inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)]"
                      >
                        <Plus weight="bold" className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openColumnEdit(col)}
                        aria-label={`Настроить колонку ${col.title}`}
                        className="k-tap inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)]"
                      >
                        <DotsThree weight="bold" className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Column Cards */}
                  <div className="flex-1 min-h-0 k-scroll p-2.5 space-y-2">
                    {inlineAddColId === col.id ? (
                      <form
                        onSubmit={(e) => void handleInlineAddInColumn(e, col.id)}
                        className="p-2.5 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] space-y-2"
                      >
                        <input
                          type="text"
                          autoFocus
                          value={inlineAddText}
                          onChange={(e) => setInlineAddText(e.target.value)}
                          placeholder="Текст задачи…"
                          className="w-full h-9 px-2.5 rounded-xl bg-[var(--k-bg-surface-2)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="submit"
                            disabled={!inlineAddText.trim() || adding}
                            className="k-tap px-3 h-8 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-semibold disabled:opacity-40"
                          >
                            Добавить
                          </button>
                          <button
                            type="button"
                            onClick={() => setInlineAddColId(null)}
                            className="k-tap px-2.5 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-secondary)]"
                          >
                            Отмена
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {colTasks.length === 0 && inlineAddColId !== col.id ? (
                      <div className="py-10 px-4 text-center text-[12.5px] text-[var(--k-ink-muted)]">
                        {isDoneColumn(col.id, columns)
                          ? 'Выполненные задачи появятся здесь'
                          : 'Пока пусто — добавь задачу или перенеси сюда'}
                      </div>
                    ) : (
                      colTasks.map((task) => renderBoardCard(task, col))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          /* ==================== LIST VIEW ==================== */
          <div className="flex-1 min-h-0 k-scroll p-3.5 pb-28 space-y-5">
            {groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-14 px-6">
                <CheckSquare weight="duotone" className="w-9 h-9 text-[var(--k-ink-muted)] mb-2.5" />
                <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
                  {filter === 'done' ? 'Завершённых задач пока нет' : 'Все задачи выполнены'}
                </div>
                <p className="text-[13px] text-[var(--k-ink-muted)] mt-1">
                  Сюда автоматически попадают все чек-листы из заметок и голосовых записей.
                </p>
              </div>
            ) : (
              groups.map((group) => (
                <section key={group.key} className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    {group.color ? (
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: group.color }}
                      />
                    ) : null}
                    <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      {group.label}
                    </h3>
                    <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular">
                      {group.items.length}
                    </span>
                  </div>

                  <div className="k-m-list">
                    {group.items.map((task) => {
                      const orbit = task.orbit ? orbitMap.get(task.orbit) : null;
                      const col = colMap.get(task.columnId ?? '');
                      const due = getEffectiveDueAt(task);
                      const priority = task.priority ?? 'none';
                      const priMeta = PRIORITY_META[priority];
                      const selected = selectedTask?.id === task.id;
                      return (
                        <SwipeableRow
                          key={task.id}
                          onLongPress={() => setActionTask(task)}
                          leftAction={{
                            label: task.done ? 'Вернуть' : 'Готово',
                            icon: <Check weight="bold" className="w-4 h-4" />,
                            bgClass: 'bg-[var(--k-emerald)]',
                            onTrigger: () => handleToggleWithToast(task),
                          }}
                          rightAction={{
                            label: 'Удалить',
                            icon: <Trash weight="fill" className="w-4 h-4" />,
                            bgClass: 'bg-[var(--k-danger)]',
                            onTrigger: () => {
                              if (selectedTaskId === task.id) onSelectTask(null);
                              void onDeleteTask(task);
                            },
                          }}
                        >
                          <div
                            data-testid={`task-row-${task.id}`}
                            onClick={() => onSelectTask(task.id)}
                            className={`flex items-start gap-3 k-m-card rounded-2xl border cursor-pointer transition-colors ${
                              selected && isExpanded
                                ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-focus)]'
                                : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)]'
                            }`}
                          >
                            <button
                              type="button"
                              data-testid={`task-check-${task.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleWithToast(task);
                              }}
                              aria-label={task.done ? 'Снять отметку' : 'Отметить выполненной'}
                              className="inline-flex items-center justify-center w-9 h-9 -ml-1.5 -my-1.5 shrink-0"
                            >
                              <AnimatedTaskCheck done={task.done} />
                            </button>

                            <div className="flex-1 min-w-0">
                              <div
                                className={`text-[14px] leading-snug ${
                                  task.done
                                    ? 'line-through text-[var(--k-ink-muted)]'
                                    : 'text-[var(--k-ink-primary)] font-medium'
                                }`}
                              >
                                {task.text}
                              </div>
                              <div className="flex items-center gap-2 mt-1 text-[11.5px] text-[var(--k-ink-muted)] flex-wrap min-w-0">
                                {!isStandaloneSelfTask(task) ? (
                                  <span className="max-w-full truncate">{task.itemTitle}</span>
                                ) : null}
                                {col ? (
                                  <span className="inline-flex items-center gap-1 text-[11px]">
                                    <span
                                      className="w-1.5 h-1.5 rounded-full"
                                      style={{ background: col.color }}
                                    />
                                    {col.title}
                                  </span>
                                ) : null}
                                {priority !== 'none' ? (
                                  <span
                                    className="px-1.5 py-0.5 rounded font-semibold text-[10.5px]"
                                    style={{ background: priMeta.bg, color: priMeta.color }}
                                  >
                                    {priMeta.short}
                                  </span>
                                ) : null}
                                {due ? (
                                  <span className="inline-flex items-center gap-1 text-[var(--k-accent)]">
                                    <CalendarBlank className="w-3 h-3" />
                                    {formatReminderStamp(due)}
                                  </span>
                                ) : null}
                                {orbit ? (
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-medium text-[var(--k-ink-primary)]"
                                    style={{
                                      background: `color-mix(in srgb, ${orbit.color} 13%, transparent)`,
                                    }}
                                  >
                                    <span
                                      className="w-1.5 h-1.5 rounded-full shrink-0"
                                      style={{ background: orbit.color }}
                                    />
                                    {orbit.name}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                mobileBridge.haptic('light');
                                setActionTask(task);
                              }}
                              aria-label="Действия с задачей"
                              className="inline-flex items-center justify-center w-9 h-9 -mr-2 -my-1.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] shrink-0"
                            >
                              <DotsThree weight="bold" className="w-4 h-4" />
                            </button>
                          </div>
                        </SwipeableRow>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
      </div>

      {/* Expanded Fold Floating Drag Ghost */}
      {draggingTask ? (
        <div
          ref={dragGhostRef}
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            transform: `translate3d(${draggingTask.x - 120}px, ${draggingTask.y - 24}px, 0) scale(1.02)`,
            width: 240,
            zIndex: 80,
            pointerEvents: 'none',
            willChange: 'transform',
          }}
          className="rounded-2xl p-3 bg-[var(--k-bg-surface-1)] border-2 border-[var(--k-accent)] shadow-[var(--k-shadow-sheet)]"
        >
          <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] line-clamp-2">
            {draggingTask.task.text}
          </div>
          {draggingTask.overColumnId ? (
            <div className="text-[11px] text-[var(--k-accent)] mt-1">
              → {colMap.get(draggingTask.overColumnId)?.title}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Expanded Fold Right Details Pane */}
      {isExpanded && (viewMode === 'list' || selectedTaskId) ? (
        <aside
          data-testid="tasks-detail-pane"
          className="w-[320px] lg:w-[360px] shrink-0 border-l border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] h-full min-h-0 k-scroll"
        >
          {selectedTask ? (
            <div>
              {viewMode === 'board' ? (
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--k-border-hairline)]">
                  <span className="text-[13px] font-semibold text-[var(--k-ink-secondary)]">
                    Детали задачи
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectTask(null)}
                    aria-label="Закрыть панель"
                    className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : null}
              {renderTaskDetail(selectedTask)}
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[var(--k-ink-muted)]">
              <CheckSquare weight="duotone" className="w-8 h-8 mb-2 opacity-60" />
              <div className="text-[14px]">Выбери задачу слева для настройки срока и приоритета</div>
            </div>
          )}
        </aside>
      ) : null}

      {!isExpanded ? (
        <BottomSheet
          open={Boolean(selectedTaskId && selectedTask)}
          title="Детали задачи"
          isExpanded={false}
          onClose={() => onSelectTask(null)}
        >
          {selectedTask ? renderTaskDetail(selectedTask) : null}
        </BottomSheet>
      ) : null}

      {/* Move to Column Picker Sheet */}
      <MobilePickerSheet
        open={Boolean(moveColumnTask)}
        title="Перенести в колонку"
        value={moveColumnTask?.columnId || columns[0]?.id || 'inbox'}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        options={columns.map((c) => ({
          value: c.id,
          label: c.title,
          color: c.color,
          count: tasksByColumn.get(c.id)?.length ?? 0,
        }))}
        onSelect={(colId) => {
          if (moveColumnTask) {
            void handleMoveToColumn(moveColumnTask, colId);
          }
        }}
        onClose={() => setMoveColumnTask(null)}
      />

      {/* Create / Edit Column Sheet */}
      <BottomSheet
        open={columnSheetOpen}
        title={editingColumn ? 'Настройка колонки' : 'Новая колонка доски'}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        maxWidthClass="max-w-sm"
        onClose={() => setColumnSheetOpen(false)}
      >
        <form onSubmit={(e) => void handleSaveColumnForm(e)} className="p-4 space-y-4">
          <input
            type="text"
            autoFocus
            required
            data-testid="kanban-column-title-input"
            value={colTitleDraft}
            onChange={(e) => setColTitleDraft(e.target.value)}
            placeholder="Название колонки (напр. Проверка)…"
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)]"
          />

          <div className="grid grid-cols-8 gap-2 justify-items-center">
            {SECTION_COLOR_PALETTE.slice(0, 16).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColColorDraft(c)}
                style={{ background: c }}
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  colColorDraft === c
                    ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                    : 'opacity-80'
                }`}
              >
                {colColorDraft === c ? <Check weight="bold" className="w-3 h-3 text-white" /> : null}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <div className="text-[12px] font-medium text-[var(--k-ink-secondary)]">Иконка колонки</div>
            <div className="grid grid-cols-6 gap-1.5" data-testid="kanban-column-icon-picker">
              {COLUMN_ICON_OPTIONS.map((opt) => {
                const active = colIconDraft === opt.id;
                const IconComp = opt.id !== 'none' ? COLUMN_ICON_MAP[opt.id] : undefined;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={opt.label}
                    aria-label={opt.label}
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setColIconDraft(opt.id);
                    }}
                    className={`k-tap h-10 rounded-xl border flex items-center justify-center transition-colors ${
                      active
                        ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)]'
                        : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)]'
                    }`}
                  >
                    {IconComp ? (
                      <IconComp
                        weight="duotone"
                        className="w-4.5 h-4.5"
                        style={{ color: active ? colColorDraft : 'var(--k-ink-secondary)' }}
                      />
                    ) : (
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ background: colColorDraft }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="k-tap flex-1 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold"
            >
              {editingColumn ? 'Сохранить' : 'Создать колонку'}
            </button>
            {editingColumn && !editingColumn.isDone && editingColumn.id !== 'done' && columns.length > 2 ? (
              <button
                type="button"
                onClick={() => void handleDeleteColumn(editingColumn)}
                aria-label="Удалить колонку"
                className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-danger-soft)] text-[var(--k-danger)]"
              >
                <Trash className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </form>
      </BottomSheet>

      {/* Long-Press Action Sheet */}
      <ItemActionSheet
        open={Boolean(actionTask)}
        title={actionTask?.text || 'Задача'}
        subtitle={actionTask?.itemTitle}
        actions={actionTask ? buildTaskActions(actionTask) : []}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setActionTask(null)}
      />

      {/* Quick-add Orbit Picker */}
      <MobilePickerSheet
        open={orbitPickerOpen}
        title="Раздел для задачи"
        value={quickOrbit}
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
        onSelect={setQuickOrbit}
        onClose={() => setOrbitPickerOpen(false)}
      />
    </div>
  );
};
