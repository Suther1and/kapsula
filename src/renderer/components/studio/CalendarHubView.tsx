import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ArrowsClockwise,
  Bell,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  DownloadSimple,
  LinkSimple,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarSyncStatus,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import {
  buildDstSafeAllDayEnd,
  expandCalendarEventOccurrences,
} from '@shared/calendar-recurrence';
import {
  layoutOverlappingEvents,
  partitionAllDayEntries,
} from '@shared/calendar-layout';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { friendlyErrorMessage } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { ContextMenuSurface, type ContextMenuEntry } from '../ui/ContextMenuSurface';
import { PopoverSurface } from '../ui/PopoverSurface';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CalendarEventSheet, type CalendarEventSheetSeed } from './CalendarEventSheet';

interface CalendarHubViewProps {
  tasks: VaultTaskEntry[];
  items: VaultItem[];
  initialEvents?: CalendarEvent[];
  focusEventId?: string | null;
  openCreateTrigger?: number;
  onFocusEventHandled?: () => void;
  onOpenItem: (itemId: string) => void;
  onOpenIntegrations: () => void;
  onTasksChanged?: () => void;
}

type CalendarMode = 'month' | 'week' | 'day' | 'agenda';

interface CalendarDisplayEntry {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  hasEndTime: boolean;
  color: string;
  isReminderOnly: boolean;
  isDone: boolean;
  isRecurringInstance?: boolean;
  location: string;
  checklistDone: number;
  checklistTotal: number;
  attachmentsCount: number;
  linkedItemId?: string | null;
  sourceEvent?: CalendarEvent;
  sourceTask?: VaultTaskEntry;
}

const DAY_HOURS = Array.from({ length: 24 }, (_, i) => i); // 00:00 .. 23:00
const HOUR_ROW_PX = 48;

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toLocalDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimeShort(ms: number, dateLocale: string): string {
  return new Date(ms).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
}

function formatEntryTimeLabel(
  entry: Pick<CalendarDisplayEntry, 'allDay' | 'hasEndTime' | 'startAt' | 'endAt'>,
  dateLocale: string,
  allDayText: string
): string {
  if (entry.allDay) return allDayText;
  const start = formatTimeShort(entry.startAt, dateLocale);
  if (!entry.hasEndTime) return start;
  return `${start}–${formatTimeShort(entry.endAt, dateLocale)}`;
}

function expandRecurringEvents(
  events: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number
): CalendarDisplayEntry[] {
  const out: CalendarDisplayEntry[] = [];

  for (const ev of events) {
    const checklist = ev.checklist ?? [];
    const attIds = new Set<string>(ev.attachments ?? []);
    if (ev.linkedItemId) attIds.add(ev.linkedItemId);
    const baseEntry = {
      title: ev.title,
      allDay: ev.allDay,
      hasEndTime: Boolean(ev.hasEndTime),
      color: ev.color || '#E86A33',
      isReminderOnly: false,
      isDone: Boolean(ev.isDone),
      location: ev.location || '',
      checklistDone: checklist.filter((c) => c.done).length,
      checklistTotal: checklist.length,
      attachmentsCount: attIds.size,
      linkedItemId: ev.linkedItemId ?? null,
      sourceEvent: ev,
    };

    const rec = ev.recurrence ?? 'none';
    if (rec === 'none') {
      out.push({
        id: ev.id,
        startAt: ev.startAt,
        endAt: ev.endAt,
        ...baseEntry,
      });
      continue;
    }

    const occs = expandCalendarEventOccurrences([ev], windowStartMs, windowEndMs);
    for (const occ of occs) {
      out.push({
        id: occ.occurrenceId,
        startAt: occ.startAt,
        endAt: occ.endAt,
        isRecurringInstance: occ.isRecurringInstance,
        ...baseEntry,
      });
    }
  }

  return out;
}

export const CalendarHubView: React.FC<CalendarHubViewProps> = ({
  tasks,
  items,
  initialEvents,
  focusEventId,
  openCreateTrigger = 0,
  onFocusEventHandled,
  onOpenItem,
  onOpenIntegrations,
  onTasksChanged,
}) => {
  const { t, locale, dateLocale } = useI18n();
  const weekdaysShort = useMemo(() => t('cal.weekdaysShort').split(','), [t]);
  const prefersReduced = useReducedMotion();
  const [nowTickMs, setNowTickMs] = useState(() => Date.now());
  const [cursorDate, setCursorDate] = useState(() => startOfDay(new Date()));
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [mode, setMode] = useState<CalendarMode>('month');
  const [events, setEvents] = useState<CalendarEvent[]>(initialEvents ?? []);
  const [syncStatus, setSyncStatus] = useState<CalendarSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncPopoverOpen, setSyncPopoverOpen] = useState(false);
  const [dragOverDayKey, setDragOverDayKey] = useState<string | null>(null);
  const [openOverflowDayKey, setOpenOverflowDayKey] = useState<string | null>(null);
  const [hidePastAgenda, setHidePastAgenda] = useState(false);
  const [unscheduledQuery, setUnscheduledQuery] = useState('');
  const [taskDoneOverrides, setTaskDoneOverrides] = useState<Record<string, boolean>>({});
  const [taskDueOverrides, setTaskDueOverrides] = useState<Record<string, number>>({});

  const [quickLine, setQuickLine] = useState('');
  const quickAddingRef = useRef(false);
  const schedulingTaskRef = useRef(false);
  const timeGridScrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledModeRef = useRef<CalendarMode | null>(null);
  const suppressNextSlotClickRef = useRef(false);
  const suppressNextEventClickRef = useRef(false);
  const pendingDragMoveRef = useRef<{ clientY: number } | null>(null);
  const dragMoveRafRef = useRef<number | null>(null);

  const [dragCreateDraft, setDragCreateDraft] = useState<{
    dayKey: string;
    anchorMin: number;
    currentMin: number;
  } | null>(null);
  const dragCreateMetaRef = useRef<{
    dayKey: string;
    day: Date;
    startY: number;
    anchorMin: number;
    currentMin: number;
    columnTop: number;
  } | null>(null);

  const [resizingDraft, setResizingDraft] = useState<{
    entryId: string;
    endMin: number;
  } | null>(null);
  const resizeMetaRef = useRef<{
    entryId: string;
    sourceEvent: CalendarEvent;
    dayStartMs: number;
    startY: number;
    initialEndMin: number;
    currentEndMin: number;
    minEndMin: number;
  } | null>(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null>(null);
  const [sheetSeed, setSheetSeed] = useState<CalendarEventSheetSeed | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowTickMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setTaskDoneOverrides({});
    setTaskDueOverrides({});
  }, [tasks]);

  useEffect(() => {
    if (initialEvents) {
      setEvents(initialEvents);
    }
  }, [initialEvents]);

  const initialEventsHydratedRef = useRef(Boolean(initialEvents));
  const loadCalendar = useCallback(
    async (opts?: { skipEventsIfInitial?: boolean }) => {
      try {
        if (opts?.skipEventsIfInitial && initialEventsHydratedRef.current) {
          initialEventsHydratedRef.current = false;
          const status = await window.kapsula.getCalendarStatus();
          setSyncStatus(status);
          return;
        }
        const from = new Date(cursorDate.getFullYear(), cursorDate.getMonth() - 1, 1).getTime();
        const to = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 2, 15).getTime();
        const [evList, status] = await Promise.all([
          mode === 'agenda'
            ? window.kapsula.listCalendarEvents()
            : window.kapsula.listCalendarEvents({ startAt: from, endAt: to }),
          window.kapsula.getCalendarStatus(),
        ]);
        setEvents(evList);
        setSyncStatus(status);
      } catch {
        // ignore transient errors
      }
    },
    [cursorDate, mode]
  );

  useEffect(() => {
    void loadCalendar({ skipEventsIfInitial: true });
  }, [loadCalendar]);

  useEffect(() => {
    const unsub = window.kapsula.onCalendarChanged(() => {
      void loadCalendar();
    });
    return unsub;
  }, [loadCalendar]);

  // Open specific event when jumped from Global Search
  useEffect(() => {
    if (!focusEventId) return;
    const found = events.find((e) => e.id === focusEventId);
    if (found) {
      const d = startOfDay(new Date(found.startAt));
      setSelectedDay(d);
      setCursorDate(new Date(d.getFullYear(), d.getMonth(), 1));
      setActiveEvent(found);
      setSheetSeed(null);
      setSheetOpen(true);
      onFocusEventHandled?.();
    }
  }, [focusEventId, events, onFocusEventHandled]);

  // External trigger for creating a new event (e.g. from Global Search command)
  useEffect(() => {
    if (openCreateTrigger > 0) {
      openCreateSheetForDay(selectedDay);
    }
  }, [openCreateTrigger]);

  const itemMap = useMemo(() => {
    const map = new Map<string, VaultItem>();
    for (const i of items) map.set(i.id, i);
    return map;
  }, [items]);

  const parsedQuick = useMemo(() => {
    const clean = quickLine.trim();
    if (clean.length < 3) return null;
    const parsed = parseRussianEvent(clean, Date.now(), selectedDay.getTime(), locale);
    return parsed?.isEventIntent ? parsed : null;
  }, [quickLine, selectedDay, locale]);

  const windowRange = useMemo(() => {
    const start = new Date(cursorDate.getFullYear(), cursorDate.getMonth() - 1, 1).getTime();
    const end = new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 2, 15).getTime();
    return { start, end };
  }, [cursorDate]);

  const combinedEntries = useMemo(() => {
    const linkedIdsInEvents = new Set(
      events.map((ev) => ev.linkedItemId).filter((id): id is string => Boolean(id))
    );
    const tasksCountByItem = new Map<string, number>();
    for (const t of tasks) {
      tasksCountByItem.set(t.itemId, (tasksCountByItem.get(t.itemId) ?? 0) + 1);
    }

    const normalizeLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const titlesMatchTask = (eventTitle: string, taskText: string, itemId: string) => {
      const evNorm = normalizeLabel(eventTitle);
      const taskNorm = normalizeLabel(taskText);
      if (!evNorm || !taskNorm) return (tasksCountByItem.get(itemId) ?? 0) <= 1;
      if (evNorm === taskNorm || taskNorm.includes(evNorm) || evNorm.includes(taskNorm)) {
        return true;
      }
      return (tasksCountByItem.get(itemId) ?? 0) <= 1;
    };

    // Index tasks that have an explicit Kanban dueAt so we prefer the explicit timed entry
    // over an auto-parsed all-day event on the same calendar day for the same itemId.
    const explicitDueTasksByItemDay = new Map<string, VaultTaskEntry[]>();
    for (const task of tasks) {
      if (task.dueAt == null) continue;
      const key = `${task.itemId}:${toLocalDateInput(task.dueAt)}`;
      const list = explicitDueTasksByItemDay.get(key) ?? [];
      list.push(task);
      explicitDueTasksByItemDay.set(key, list);
    }

    const expandedEvents = expandRecurringEvents(events, windowRange.start, windowRange.end);
    const out: CalendarDisplayEntry[] = [];
    const keptEventEntriesByItemDay = new Map<string, CalendarDisplayEntry[]>();

    for (const entry of expandedEvents) {
      if (entry.linkedItemId) {
        const dayKey = `${entry.linkedItemId}:${toLocalDateInput(entry.startAt)}`;
        const matchingDueTasks = explicitDueTasksByItemDay.get(dayKey);
        const supersededByExplicitDue = Boolean(
          matchingDueTasks?.some(
            (task) =>
              (entry.allDay || (!entry.hasEndTime && entry.checklistTotal === 0 && !entry.location)) &&
              titlesMatchTask(entry.title, task.text, task.itemId)
          )
        );
        if (supersededByExplicitDue) {
          continue;
        }
        const kept = keptEventEntriesByItemDay.get(dayKey) ?? [];
        kept.push(entry);
        keptEventEntriesByItemDay.set(dayKey, kept);
      }
      out.push(entry);
    }

    const taskCoveredRemindKeys = new Set<string>();

    for (const task of tasks) {
      const parentItem = itemMap.get(task.itemId);
      const effectiveDueAt = taskDueOverrides[task.id] ?? task.dueAt ?? parentItem?.remindAt ?? null;
      if (effectiveDueAt === null) continue;

      const dayKey = `${task.itemId}:${toLocalDateInput(effectiveDueAt)}`;
      const keptSameDayEvents = keptEventEntriesByItemDay.get(dayKey);
      if (
        keptSameDayEvents?.some((ev) => titlesMatchTask(ev.title, task.text, task.itemId))
      ) {
        continue;
      }

      if (parentItem?.remindAt != null && effectiveDueAt === parentItem.remindAt) {
        taskCoveredRemindKeys.add(task.itemId);
      }
      out.push({
        id: `task-${task.id}`,
        title: task.text || parentItem?.title || t('cal.kind.task'),
        startAt: effectiveDueAt,
        endAt: effectiveDueAt + 1_800_000,
        allDay: false,
        hasEndTime: false,
        color: 'var(--k-info)',
        isReminderOnly: true,
        isDone: taskDoneOverrides[task.id] ?? task.done,
        location: '',
        checklistDone: 0,
        checklistTotal: 0,
        attachmentsCount: 1,
        linkedItemId: task.itemId,
        sourceTask: task,
      });
    }

    for (const item of items) {
      if (
        item.remindAt !== null &&
        !linkedIdsInEvents.has(item.id) &&
        !taskCoveredRemindKeys.has(item.id)
      ) {
        out.push({
          id: `rem-${item.id}`,
          title: item.title || t('cal.kind.reminder'),
          startAt: item.remindAt,
          endAt: item.remindAt + 1_800_000,
          allDay: false,
          hasEndTime: false,
          color: 'var(--k-amber)',
          isReminderOnly: true,
          isDone: Boolean(item.remindedAt),
          location: '',
          checklistDone: 0,
          checklistTotal: 0,
          attachmentsCount: 1,
          linkedItemId: item.id,
        });
      }
    }
    return out.sort((a, b) => a.startAt - b.startAt);
  }, [events, items, tasks, itemMap, windowRange, t, taskDoneOverrides, taskDueOverrides]);

  const monthCells = useMemo(() => {
    const year = cursorDate.getFullYear();
    const month = cursorDate.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - offset);
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    }
    return cells;
  }, [cursorDate]);

  const weekDays = useMemo(() => {
    const base = startOfDay(cursorDate);
    const offset = (base.getDay() + 6) % 7;
    const mon = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
    return Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
  }, [cursorDate]);

  const entriesByDayMap = useMemo(() => {
    const map = new Map<string, CalendarDisplayEntry[]>();
    const minMs = windowRange.start;
    const maxMs = windowRange.end;
    for (const entry of combinedEntries) {
      if (entry.endAt < minMs || entry.startAt > maxMs) continue;
      if (entry.endAt === entry.startAt) {
        const key = toLocalDateInput(entry.startAt);
        let list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        list.push(entry);
        continue;
      }
      const clampedStart = Math.max(minMs, entry.startAt);
      const clampedEnd = Math.min(maxMs, entry.endAt);
      if (clampedEnd <= clampedStart) continue;
      const firstDay = startOfDay(new Date(clampedStart));
      const lastDayMs = startOfDay(new Date(clampedEnd - 1)).getTime();
      let d = firstDay;
      while (d.getTime() <= lastDayMs) {
        const key = toLocalDateInput(d.getTime());
        let list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        list.push(entry);
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      }
    }
    return map;
  }, [combinedEntries, windowRange]);

  const entriesForDay = useCallback(
    (day: Date): CalendarDisplayEntry[] => {
      const ds = startOfDay(day).getTime();
      if (ds >= windowRange.start && ds < windowRange.end) {
        return entriesByDayMap.get(toLocalDateInput(ds)) ?? [];
      }
      const de = ds + 86_400_000 - 1;
      return combinedEntries.filter(
        (e) => e.startAt <= de && (e.endAt > ds || (e.endAt === e.startAt && e.startAt >= ds))
      );
    },
    [entriesByDayMap, combinedEntries, windowRange]
  );

  const selectedDayEntries = useMemo(
    () => entriesForDay(selectedDay),
    [entriesForDay, selectedDay]
  );

  const upcomingEntries = useMemo(() => {
    const nowStart = startOfDay(new Date()).getTime();
    const selStart = startOfDay(selectedDay).getTime();
    const selEnd = selStart + 86_400_000 - 1;
    const horizonEnd = nowStart + 14 * 86_400_000;
    return combinedEntries
      .filter(
        (e) =>
          !e.isDone &&
          e.startAt >= nowStart &&
          e.startAt <= horizonEnd &&
          !(e.startAt <= selEnd && e.endAt >= selStart)
      )
      .slice(0, 8);
  }, [combinedEntries, selectedDay]);

  const allUnscheduledTasks = useMemo(() => {
    const scheduledTaskKeys = new Set(
      events
        .filter((ev) => ev.linkedItemId)
        .map((ev) => `${ev.linkedItemId}:${ev.title.trim().toLowerCase()}`)
    );
    return tasks.filter((task) => {
      if (taskDoneOverrides[task.id] ?? task.done) return false;
      if ((taskDueOverrides[task.id] ?? task.dueAt) != null) return false;
      if (itemMap.get(task.itemId)?.remindAt != null) return false;
      return !scheduledTaskKeys.has(`${task.itemId}:${task.text.trim().toLowerCase()}`);
    });
  }, [tasks, events, itemMap, taskDoneOverrides, taskDueOverrides]);

  const unscheduledTasks = useMemo(() => {
    const q = unscheduledQuery.trim().toLowerCase();
    const list = q
      ? allUnscheduledTasks.filter(
          (task) =>
            task.text.toLowerCase().includes(q) ||
            (task.itemTitle || '').toLowerCase().includes(q)
        )
      : allUnscheduledTasks;
    return list.slice(0, 20);
  }, [allUnscheduledTasks, unscheduledQuery]);

  const openCreateSheetForDay = (day: Date, seed?: CalendarEventSheetSeed) => {
    setActiveEvent(null);
    setSheetSeed({
      dateStr: toLocalDateInput(day.getTime()),
      startTime: '10:00',
      hasEndTime: false,
      kind: 'event',
      ...seed,
    });
    setSheetOpen(true);
  };

  const openViewSheet = (ev: CalendarEvent) => {
    setActiveEvent(ev);
    setSheetSeed(null);
    setSheetOpen(true);
  };

  const handleSaveSheet = async (input: CalendarEventInput) => {
    const saved = await window.kapsula.upsertCalendarEvent(input);
    if (activeEvent && saved.id === activeEvent.id) {
      setActiveEvent(saved);
    }
    toast.success(input.id ? t('cal.toast.updated') : t('cal.toast.added'));
    await loadCalendar();
  };

  const handleQuickPatchEvent = async (input: CalendarEventInput) => {
    const saved = await window.kapsula.upsertCalendarEvent(input);
    if (activeEvent && saved.id === activeEvent.id) {
      setActiveEvent(saved);
    }
    await loadCalendar();
  };

  const handleDeleteEvent = async (id: string) => {
    await window.kapsula.deleteCalendarEvent(id);
    setSheetOpen(false);
    setActiveEvent(null);
    toast.success(t('cal.toast.deleted'));
    await loadCalendar();
  };

  const buildEventUpsertPayload = useCallback(
    (ev: CalendarEvent, overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
      id: ev.id,
      title: ev.title,
      notes: ev.notes,
      location: ev.location,
      startAt: ev.startAt,
      endAt: ev.endAt,
      allDay: ev.allDay,
      hasEndTime: ev.hasEndTime,
      kind: ev.kind,
      recurrence: ev.recurrence ?? 'none',
      color: ev.color,
      linkedItemId: ev.linkedItemId,
      checklist: ev.checklist,
      attachments: ev.attachments,
      isDone: ev.isDone,
      externalSource: ev.externalSource ?? null,
      externalId: ev.externalId ?? null,
      etag: ev.etag ?? null,
      ...overrides,
    }),
    []
  );

  const handleToggleVaultTaskEntry = async (task: VaultTaskEntry) => {
    const prevDone = taskDoneOverrides[task.id] ?? task.done;
    const nextDone = !prevDone;
    setTaskDoneOverrides((prev) => ({ ...prev, [task.id]: nextDone }));
    try {
      await window.kapsula.toggleTask({
        itemId: task.itemId,
        sourceType: task.sourceType,
        taskIndex: task.taskIndex,
        done: nextDone,
      });
      onTasksChanged?.();
    } catch (err) {
      setTaskDoneOverrides((prev) => ({ ...prev, [task.id]: prevDone }));
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleToggleEventDone = async (ev: CalendarEvent) => {
    const prevDone = ev.isDone;
    const nextDone = !prevDone;
    // Instant 0ms optimistic update in calendar list & open sheet before awaiting IPC
    setEvents((prev) =>
      prev.map((row) => (row.id === ev.id ? { ...row, isDone: nextDone } : row))
    );
    setActiveEvent((prev) => (prev && prev.id === ev.id ? { ...prev, isDone: nextDone } : prev));

    try {
      const updated = await window.kapsula.upsertCalendarEvent(
        buildEventUpsertPayload(ev, { isDone: nextDone })
      );
      if (ev.kind === 'task' && ev.linkedItemId) {
        const matchingTask = tasks.find(
          (taskItem) =>
            taskItem.itemId === ev.linkedItemId &&
            taskItem.text.trim().toLowerCase() === ev.title.trim().toLowerCase()
        );
        if (matchingTask && matchingTask.done !== nextDone) {
          await window.kapsula.toggleTask({
            itemId: matchingTask.itemId,
            sourceType: matchingTask.sourceType,
            taskIndex: matchingTask.taskIndex,
            done: nextDone,
          });
          onTasksChanged?.();
        }
      }
      if (activeEvent?.id === ev.id) {
        setActiveEvent(updated);
      }
      await loadCalendar();
    } catch (err) {
      setEvents((prev) =>
        prev.map((row) => (row.id === ev.id ? { ...row, isDone: prevDone } : row))
      );
      setActiveEvent((prev) => (prev && prev.id === ev.id ? { ...prev, isDone: prevDone } : prev));
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleMoveEventByDays = async (ev: CalendarEvent, deltaDays: number) => {
    const targetDay = new Date(ev.startAt);
    targetDay.setDate(targetDay.getDate() + deltaDays);
    try {
      const origStart = new Date(ev.startAt);
      const origEnd = new Date(ev.endAt);
      const nextStart = new Date(targetDay);
      nextStart.setHours(
        ev.allDay ? 0 : origStart.getHours(),
        ev.allDay ? 0 : origStart.getMinutes(),
        0,
        0
      );
      let nextEndMs: number;
      if (ev.allDay) {
        nextEndMs = buildDstSafeAllDayEnd(nextStart);
      } else {
        const dayDelta = Math.round(
          (startOfDay(origEnd).getTime() - startOfDay(origStart).getTime()) / 86_400_000
        );
        const nextEnd = new Date(nextStart);
        nextEnd.setDate(nextEnd.getDate() + Math.max(0, dayDelta));
        nextEnd.setHours(origEnd.getHours(), origEnd.getMinutes(), 0, 0);
        nextEndMs =
          nextEnd.getTime() > nextStart.getTime()
            ? nextEnd.getTime()
            : nextStart.getTime() + Math.max(0, ev.endAt - ev.startAt);
      }
      await window.kapsula.upsertCalendarEvent(
        buildEventUpsertPayload(ev, { startAt: nextStart.getTime(), endAt: nextEndMs })
      );
      setSelectedDay(startOfDay(targetDay));
      toast.success(
        t('cal.toast.movedTo', {
          date: targetDay.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }),
        })
      );
      await loadCalendar();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleDuplicateEvent = async (ev: CalendarEvent) => {
    const shiftMs = ev.allDay ? 86_400_000 : 3_600_000;
    try {
      await window.kapsula.upsertCalendarEvent({
        title: ev.title,
        notes: ev.notes,
        location: ev.location,
        startAt: ev.startAt + shiftMs,
        endAt: ev.endAt + shiftMs,
        allDay: ev.allDay,
        hasEndTime: ev.hasEndTime,
        kind: ev.kind,
        recurrence: ev.recurrence ?? 'none',
        color: ev.color,
        linkedItemId: ev.linkedItemId,
        checklist: ev.checklist,
        attachments: ev.attachments,
        isDone: false,
      });
      toast.success(t('cal.toast.duplicated'));
      await loadCalendar();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const buildEntryContextMenu = (entry: CalendarDisplayEntry): ContextMenuEntry[] => {
    if (entry.sourceEvent) {
      const ev = entry.sourceEvent;
      const itemsList: ContextMenuEntry[] = [
        {
          type: 'item',
          id: 'open',
          label: t('cal.ctx.open'),
          icon: <CalendarBlank className="w-3.5 h-3.5" />,
          onSelect: () => openViewSheet(ev),
        },
        {
          type: 'item',
          id: 'toggle-done',
          label: ev.isDone ? t('cal.ctx.markUndone') : t('cal.ctx.markDone'),
          icon: <Check className="w-3.5 h-3.5" />,
          onSelect: () => void handleToggleEventDone(ev),
        },
      ];
      if (!entry.isRecurringInstance) {
        itemsList.push({
          type: 'item',
          id: 'move-tomorrow',
          label: t('cal.ctx.moveTomorrow'),
          icon: <ArrowRight className="w-3.5 h-3.5" />,
          onSelect: () => void handleMoveEventByDays(ev, 1),
        });
      }
      itemsList.push(
        {
          type: 'item',
          id: 'duplicate',
          label: t('cal.ctx.duplicate'),
          icon: <Copy className="w-3.5 h-3.5" />,
          onSelect: () => void handleDuplicateEvent(ev),
        },
        { type: 'separator', id: 'sep-delete' },
        {
          type: 'item',
          id: 'delete',
          label: t('cal.ctx.delete'),
          icon: <Trash className="w-3.5 h-3.5" />,
          danger: true,
          onSelect: () => void handleDeleteEvent(ev.id),
        }
      );
      return itemsList;
    }

    if (entry.sourceTask) {
      const task = entry.sourceTask;
      const taskDone = taskDoneOverrides[task.id] ?? task.done;
      return [
        {
          type: 'item',
          id: 'open-item',
          label: t('cal.openItem'),
          icon: <LinkSimple className="w-3.5 h-3.5" />,
          onSelect: () => onOpenItem(task.itemId),
        },
        {
          type: 'item',
          id: 'toggle-task',
          label: taskDone ? t('cal.ctx.markUndone') : t('cal.ctx.markDone'),
          icon: <Check className="w-3.5 h-3.5" />,
          onSelect: () => void handleToggleVaultTaskEntry(task),
        },
      ];
    }

    return [];
  };

  const scheduleVaultTaskAt = useCallback(
    async (
      task: {
        id?: string;
        itemId: string;
        sourceType?: 'markdown' | 'voice_action';
        taskIndex?: number;
        taskKey?: string;
        text: string;
      },
      dueAtMs: number,
      hasEndTime: boolean
    ) => {
      if (task.sourceType && typeof task.taskIndex === 'number') {
        if (task.id) {
          setTaskDueOverrides((prev) => ({ ...prev, [task.id!]: dueAtMs }));
        }
        const resolvedTaskKey =
          task.taskKey ||
          (task.sourceType === 'voice_action' ? `va:${task.taskIndex}` : `md:${task.taskIndex}`);
        await window.kapsula.updateTaskMeta({
          itemId: task.itemId,
          taskKey: resolvedTaskKey,
          dueAt: dueAtMs,
        });
        onTasksChanged?.();
      } else {
        await window.kapsula.upsertCalendarEvent({
          title: task.text,
          startAt: dueAtMs,
          endAt: dueAtMs + 1_800_000,
          hasEndTime,
          linkedItemId: task.itemId,
          kind: 'task',
          color: '#3B82F6',
        });
      }
    },
    [onTasksChanged]
  );

  // Drag & Drop: move event or schedule task onto a target day (or 30-min time slot)
  const handleDropOnDay = async (
    targetDay: Date,
    dataTransfer: DataTransfer,
    overrideSlotTime?: { hour: number; minute: number }
  ) => {
    setDragOverDayKey(null);
    const eventId = dataTransfer.getData('text/kapsula-cal-event-id');
    if (eventId) {
      const ev = events.find((e) => e.id === eventId);
      if (!ev) return;
      try {
        const origStart = new Date(ev.startAt);
        const origEnd = new Date(ev.endAt);
        const nextStart = new Date(targetDay);
        let nextAllDay = ev.allDay;
        let nextHasEndTime = ev.hasEndTime;
        let nextEndMs: number;

        if (overrideSlotTime) {
          nextAllDay = false;
          nextHasEndTime = true;
          nextStart.setHours(overrideSlotTime.hour, overrideSlotTime.minute, 0, 0);
          const durMs = ev.allDay
            ? 3_600_000
            : Math.max(15 * 60_000, ev.endAt - ev.startAt);
          nextEndMs = nextStart.getTime() + durMs;
        } else {
          nextStart.setHours(
            ev.allDay ? 0 : origStart.getHours(),
            ev.allDay ? 0 : origStart.getMinutes(),
            0,
            0
          );
          if (ev.allDay) {
            nextEndMs = buildDstSafeAllDayEnd(nextStart);
          } else {
            const dayDelta = Math.round(
              (startOfDay(origEnd).getTime() - startOfDay(origStart).getTime()) / 86_400_000
            );
            const nextEnd = new Date(nextStart);
            nextEnd.setDate(nextEnd.getDate() + Math.max(0, dayDelta));
            nextEnd.setHours(origEnd.getHours(), origEnd.getMinutes(), 0, 0);
            nextEndMs =
              nextEnd.getTime() > nextStart.getTime()
                ? nextEnd.getTime()
                : nextStart.getTime() + Math.max(0, ev.endAt - ev.startAt);
          }
        }

        await window.kapsula.upsertCalendarEvent(
          buildEventUpsertPayload(ev, {
            startAt: nextStart.getTime(),
            endAt: nextEndMs,
            allDay: nextAllDay,
            hasEndTime: nextHasEndTime,
          })
        );
        setSelectedDay(startOfDay(targetDay));
        toast.success(
          t('cal.toast.movedTo', {
            date: targetDay.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }),
          })
        );
        await loadCalendar();
      } catch (err) {
        toast.error(friendlyErrorMessage(err, undefined, locale));
      }
      return;
    }

    const taskRaw = dataTransfer.getData('text/kapsula-task-json');
    if (taskRaw) {
      try {
        const parsedTask = JSON.parse(taskRaw) as {
          id?: string;
          itemId: string;
          sourceType?: 'markdown' | 'voice_action';
          taskIndex?: number;
          taskKey?: string;
          text: string;
        };
        const slot = new Date(targetDay);
        slot.setHours(overrideSlotTime?.hour ?? 12, overrideSlotTime?.minute ?? 0, 0, 0);
        await scheduleVaultTaskAt(parsedTask, slot.getTime(), Boolean(overrideSlotTime));
        setSelectedDay(startOfDay(targetDay));
        toast.success(
          t('cal.toast.taskScheduled', {
            date: targetDay.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }),
          })
        );
        await loadCalendar();
      } catch {
        // ignore
      }
    }
  };

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quickLine.trim();
    if (!clean || quickAddingRef.current) return;
    quickAddingRef.current = true;
    try {
      const parsed = parseRussianEvent(clean, Date.now(), selectedDay.getTime(), locale);
      if (parsed) {
        await window.kapsula.upsertCalendarEvent({
          title: parsed.title || clean,
          startAt: parsed.startAt,
          endAt: parsed.endAt,
          allDay: parsed.allDay,
          hasEndTime: parsed.hasEndTime,
          location: parsed.location,
          notes: parsed.notes,
          kind: 'event',
          color: '#E86A33',
        });
        setQuickLine('');
        const targetDay = startOfDay(new Date(parsed.startAt));
        setSelectedDay(targetDay);
        setCursorDate(new Date(targetDay.getFullYear(), targetDay.getMonth(), 1));
        toast.success(t('cal.toast.parsedAdded', { label: parsed.label }));
        await loadCalendar();
        return;
      }

      const dayStart = new Date(selectedDay);
      dayStart.setHours(10, 0, 0, 0);
      await window.kapsula.upsertCalendarEvent({
        title: clean,
        startAt: dayStart.getTime(),
        endAt: dayStart.getTime() + 1_800_000,
        hasEndTime: false,
        kind: 'event',
        color: '#E86A33',
      });
      setQuickLine('');
      toast.success(t('cal.toast.addedSelectedDay'));
      await loadCalendar();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      quickAddingRef.current = false;
    }
  };

  const handleOpenQuickDetails = () => {
    const clean = quickLine.trim();
    const parsed = clean ? parseRussianEvent(clean, Date.now(), selectedDay.getTime(), locale) : null;
    if (parsed) {
      const d = new Date(parsed.startAt);
      openCreateSheetForDay(d, {
        title: parsed.title,
        dateStr: toLocalDateInput(parsed.startAt),
        startTime: toLocalTimeInput(parsed.startAt),
        allDay: parsed.allDay,
        hasEndTime: parsed.hasEndTime,
        durationMin: parsed.hasEndTime
          ? Math.max(15, Math.round((parsed.endAt - parsed.startAt) / 60_000))
          : undefined,
        location: parsed.location,
        notes: parsed.notes,
      });
    } else {
      openCreateSheetForDay(selectedDay, { title: clean });
    }
  };

  const handleEntryClick = (entry: CalendarDisplayEntry) => {
    if (entry.sourceEvent) {
      openViewSheet(entry.sourceEvent);
      return;
    }
    if (entry.linkedItemId) {
      onOpenItem(entry.linkedItemId);
    }
  };

  const monthLabel = useMemo(() => {
    if (mode === 'day') {
      const dayFmt = new Intl.DateTimeFormat(dateLocale, {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(cursorDate);
      return dayFmt.charAt(0).toUpperCase() + dayFmt.slice(1);
    }
    const fmt = new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric' }).format(cursorDate);
    return fmt.charAt(0).toUpperCase() + fmt.slice(1);
  }, [cursorDate, dateLocale, mode]);

  const nowDate = useMemo(() => new Date(nowTickMs), [nowTickMs]);
  const today = useMemo(() => startOfDay(nowDate), [nowDate]);
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const nowLineTopPx = (nowMinutes / 60) * HOUR_ROW_PX;

  const selectedDayTitle = useMemo(() => {
    const raw = selectedDay.toLocaleDateString(dateLocale, {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [selectedDay, dateLocale]);

  const shiftPeriod = useCallback(
    (dir: -1 | 1) => {
      setNavDir(dir);
      if (mode === 'day') {
        const nextDay = new Date(
          cursorDate.getFullYear(),
          cursorDate.getMonth(),
          cursorDate.getDate() + dir
        );
        setCursorDate(nextDay);
        setSelectedDay(nextDay);
        return;
      }
      if (mode === 'week') {
        setCursorDate(
          (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir * 7)
        );
        return;
      }
      setCursorDate((d) => new Date(d.getFullYear(), d.getMonth() + dir, 1));
    },
    [cursorDate, mode]
  );

  const visibleGridDays = useMemo(
    () => (mode === 'day' ? [startOfDay(cursorDate)] : weekDays),
    [mode, cursorDate, weekDays]
  );

  // Auto-scroll 24h time grid to 07:00 after AnimatePresence mounts Week or Day view
  useEffect(() => {
    if (mode !== 'week' && mode !== 'day') {
      scrolledModeRef.current = null;
    }
  }, [mode]);

  const setTimeGridScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      timeGridScrollRef.current = node;
      if (!node) return;
      if ((mode === 'week' || mode === 'day') && scrolledModeRef.current !== mode) {
        scrolledModeRef.current = mode;
        // Leave 14px breathing room above 07:00 so the hour label (-mt-1.5) is never clipped
        const targetTop = Math.max(0, 7 * HOUR_ROW_PX - 14);
        node.scrollTop = targetTop;
        window.requestAnimationFrame(() => {
          if (timeGridScrollRef.current === node) {
            node.scrollTop = targetTop;
          }
        });
      }
    },
    [mode]
  );

  const switchCalendarMode = useCallback(
    (nextMode: CalendarMode) => {
      if (nextMode === 'day') {
        setCursorDate(selectedDay);
      } else if (nextMode === 'week') {
        const inWeek = weekDays.some((d) => sameDay(d, selectedDay));
        if (!inWeek) {
          setCursorDate(selectedDay);
        }
      }
      setMode(nextMode);
    },
    [selectedDay, weekDays]
  );

  // Drag-to-create and bottom-edge drag-to-resize on 24h grid
  useEffect(() => {
    const applyDragMove = (clientY: number) => {
      const dc = dragCreateMetaRef.current;
      if (dc) {
        const relY = Math.max(0, Math.min(24 * HOUR_ROW_PX, clientY - dc.columnTop));
        const snappedMin = Math.min(
          23 * 60 + 30,
          Math.max(0, Math.floor((relY / HOUR_ROW_PX) * 2) * 30)
        );
        if (snappedMin !== dc.currentMin) {
          dc.currentMin = snappedMin;
          setDragCreateDraft({
            dayKey: dc.dayKey,
            anchorMin: dc.anchorMin,
            currentMin: snappedMin,
          });
        }
      }

      const rs = resizeMetaRef.current;
      if (rs) {
        const deltaSteps = Math.round((clientY - rs.startY) / (HOUR_ROW_PX / 4));
        const nextEndMin = Math.max(
          rs.minEndMin,
          Math.min(24 * 60, rs.initialEndMin + deltaSteps * 15)
        );
        if (nextEndMin !== rs.currentEndMin) {
          rs.currentEndMin = nextEndMin;
          setResizingDraft({ entryId: rs.entryId, endMin: nextEndMin });
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragCreateMetaRef.current && !resizeMetaRef.current) return;
      pendingDragMoveRef.current = { clientY: e.clientY };
      if (dragMoveRafRef.current === null) {
        dragMoveRafRef.current = window.requestAnimationFrame(() => {
          dragMoveRafRef.current = null;
          const pending = pendingDragMoveRef.current;
          pendingDragMoveRef.current = null;
          if (pending) {
            applyDragMove(pending.clientY);
          }
        });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (dragMoveRafRef.current !== null) {
        window.cancelAnimationFrame(dragMoveRafRef.current);
        dragMoveRafRef.current = null;
      }
      if (pendingDragMoveRef.current) {
        const pending = pendingDragMoveRef.current;
        pendingDragMoveRef.current = null;
        applyDragMove(pending.clientY);
      }

      const dc = dragCreateMetaRef.current;
      if (dc) {
        dragCreateMetaRef.current = null;
        setDragCreateDraft(null);
        const movedPx = Math.abs(e.clientY - dc.startY);
        if (movedPx >= 10 || dc.currentMin !== dc.anchorMin) {
          const minStart = Math.min(dc.anchorMin, dc.currentMin);
          const minEnd = Math.min(
            24 * 60,
            Math.max(minStart + 30, Math.max(dc.anchorMin, dc.currentMin) + 30)
          );
          const pad = (n: number) => String(n).padStart(2, '0');
          const startTime = `${pad(Math.floor(minStart / 60))}:${pad(minStart % 60)}`;
          suppressNextSlotClickRef.current = true;
          window.setTimeout(() => {
            suppressNextSlotClickRef.current = false;
          }, 0);
          setSelectedDay(startOfDay(dc.day));
          openCreateSheetForDay(dc.day, {
            dateStr: dc.dayKey,
            startTime,
            hasEndTime: true,
            durationMin: Math.max(30, minEnd - minStart),
          });
        }
      }

      const rs = resizeMetaRef.current;
      if (rs) {
        resizeMetaRef.current = null;
        setResizingDraft(null);
        suppressNextEventClickRef.current = true;
        window.setTimeout(() => {
          suppressNextEventClickRef.current = false;
        }, 0);
        if (rs.currentEndMin !== rs.initialEndMin) {
          const nextEndAt = Math.max(
            rs.sourceEvent.startAt + 15 * 60_000,
            rs.dayStartMs + rs.currentEndMin * 60_000
          );
          if (nextEndAt !== rs.sourceEvent.endAt) {
            void window.kapsula
              .upsertCalendarEvent(
                buildEventUpsertPayload(rs.sourceEvent, {
                  endAt: nextEndAt,
                  hasEndTime: true,
                })
              )
              .then(() => {
                toast.success(t('cal.toast.resized'));
                return loadCalendar();
              })
              .catch((err) => {
                toast.error(friendlyErrorMessage(err, undefined, locale));
              });
          }
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      if (dragMoveRafRef.current !== null) {
        window.cancelAnimationFrame(dragMoveRafRef.current);
        dragMoveRafRef.current = null;
      }
      pendingDragMoveRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [buildEventUpsertPayload, loadCalendar, locale, t]);

  // Keyboard shortcuts (T, ArrowLeft/Right, 1-4) ignored when typing or dialogs open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (sheetOpen || syncPopoverOpen || openOverflowDayKey !== null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      if (e.code === 'KeyT') {
        e.preventDefault();
        const now = startOfDay(new Date());
        setCursorDate(now);
        setSelectedDay(now);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        shiftPeriod(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        shiftPeriod(1);
      } else if (e.key === '1') {
        e.preventDefault();
        switchCalendarMode('month');
      } else if (e.key === '2') {
        e.preventDefault();
        switchCalendarMode('week');
      } else if (e.key === '3') {
        e.preventDefault();
        switchCalendarMode('day');
      } else if (e.key === '4') {
        e.preventDefault();
        switchCalendarMode('agenda');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sheetOpen, syncPopoverOpen, openOverflowDayKey, shiftPeriod, switchCalendarMode]);

  const agendaEntries = useMemo(() => {
    if (!hidePastAgenda) return combinedEntries;
    const todayStart = today.getTime();
    return combinedEntries.filter((e) => e.endAt >= todayStart || e.startAt >= todayStart);
  }, [combinedEntries, hidePastAgenda, today]);

  const agendaGroups = useMemo(() => {
    const groups: Array<{ dayKey: string; label: string; items: CalendarDisplayEntry[] }> = [];
    const byKey = new Map<string, { dayKey: string; label: string; items: CalendarDisplayEntry[] }>();
    for (const ev of agendaEntries) {
      const dayKey = toLocalDateInput(ev.startAt);
      let grp = byKey.get(dayKey);
      if (!grp) {
        const raw = new Date(ev.startAt).toLocaleDateString(dateLocale, {
          day: 'numeric',
          month: 'short',
          weekday: 'short',
        });
        grp = {
          dayKey,
          label: raw.charAt(0).toUpperCase() + raw.slice(1),
          items: [],
        };
        byKey.set(dayKey, grp);
        groups.push(grp);
      }
      grp.items.push(ev);
    }
    return groups;
  }, [agendaEntries, dateLocale]);

  const viewKey =
    mode === 'month'
      ? `m-${cursorDate.getFullYear()}-${cursorDate.getMonth()}`
      : mode === 'week'
        ? `w-${toLocalDateInput(weekDays[0]!.getTime())}`
        : mode === 'day'
          ? `d-${toLocalDateInput(cursorDate.getTime())}`
          : 'agenda';

  return (
    <div data-testid="calendar-hub-view" className="flex flex-col gap-3.5 pb-6">
      {/* Compact Integrated NLP Quick Event Row */}
      <form
        onSubmit={handleQuickAdd}
        className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2 shadow-[var(--k-shadow-card)] flex flex-col gap-1.5 focus-within:border-[var(--k-border-focus)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sparkle weight="fill" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
          <input
            type="text"
            data-testid="calendar-quick-input"
            value={quickLine}
            onChange={(e) => setQuickLine(e.target.value)}
            placeholder={t('cal.quickAddPlaceholder', {
              date: selectedDay.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }),
            })}
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
          />
          {quickLine.trim() ? (
            <>
              <button
                type="button"
                onClick={handleOpenQuickDetails}
                className="k-interactive h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
              >
                {t('cal.moreDetailsBtn')}
              </button>
              <button
                type="submit"
                className="k-interactive h-7.5 px-3 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0"
              >
                {t('common.add')}
              </button>
            </>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {parsedQuick ? (
            <motion.div
              initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
              exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.14 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap items-center gap-2 pl-6 pt-0.5 text-[11.5px] text-[var(--k-ink-secondary)]">
                <span className="inline-flex items-center gap-1 rounded-md bg-[var(--k-accent-soft)] text-[var(--k-accent)] px-2 py-0.5 font-medium">
                  <CalendarBlank weight="fill" className="w-3 h-3" />
                  {parsedQuick.label}
                </span>
                <span className="font-medium text-[var(--k-ink-primary)] truncate max-w-[320px]">
                  {parsedQuick.title}
                </span>
                {parsedQuick.location ? (
                  <span className="inline-flex items-center gap-1 text-[var(--k-ink-muted)]">
                    <MapPin className="w-3 h-3" />
                    {parsedQuick.location}
                  </span>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </form>

      {/* Clean Navigation Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="inline-flex items-center rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] p-0.5 shadow-2xs">
            <button
              type="button"
              onClick={() => shiftPeriod(-1)}
              aria-label={t('cal.prevPeriodAria')}
              className="k-interactive w-7 h-7 rounded-lg hover:bg-[var(--k-bg-surface-2)] inline-flex items-center justify-center cursor-pointer"
            >
              <CaretLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const now = startOfDay(new Date());
                setCursorDate(now);
                setSelectedDay(now);
              }}
              className="k-interactive h-7 px-3 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[12px] font-medium cursor-pointer"
            >
              {t('common.today')}
            </button>
            <button
              type="button"
              onClick={() => shiftPeriod(1)}
              aria-label={t('cal.nextPeriodAria')}
              className="k-interactive w-7 h-7 rounded-lg hover:bg-[var(--k-bg-surface-2)] inline-flex items-center justify-center cursor-pointer"
            >
              <CaretRight className="w-4 h-4" />
            </button>
          </div>
          <h1 className="m-0 text-[19px] font-semibold tracking-tight">{monthLabel}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<CalendarMode>
            value={mode}
            onChange={switchCalendarMode}
            options={[
              { value: 'month', label: t('cal.view.month'), icon: <CalendarBlank className="w-3.5 h-3.5" /> },
              { value: 'week', label: t('cal.view.week') },
              { value: 'day', label: t('cal.view.day') },
              { value: 'agenda', label: t('cal.view.agenda'), icon: <ListBullets className="w-3.5 h-3.5" /> },
            ]}
          />

          <PopoverSurface
            open={syncPopoverOpen}
            onOpenChange={setSyncPopoverOpen}
            align="end"
            widthClass="w-72"
            trigger={
              <button
                type="button"
                className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    syncStatus?.connected ? 'bg-[var(--k-emerald)]' : 'bg-[var(--k-ink-muted)]/50'
                  }`}
                />
                <span>{t('settings.tab.sync')}</span>
              </button>
            }
          >
            <div className="space-y-2.5 text-[12.5px]">
              <div className="space-y-1">
                <div className="font-semibold text-[var(--k-ink-primary)]">{t('cal.gcal.title')}</div>
                <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                  {syncStatus?.connected
                    ? syncStatus.email
                      ? t('cal.gcal.connectedEmail', { email: syncStatus.email })
                      : t('cal.gcal.connected')
                    : t('cal.gcal.connectHint')}
                </div>
              </div>

              {syncStatus?.connected ? (
                <button
                  type="button"
                  disabled={syncing}
                  onClick={async () => {
                    setSyncing(true);
                    try {
                      const res = await window.kapsula.syncCalendarNow();
                      toast.success(t('cal.toast.synced', { imported: res.imported, pushed: res.pushed }));
                      await loadCalendar();
                    } catch (err) {
                      toast.error(friendlyErrorMessage(err, t('cal.toast.syncError'), locale));
                    } finally {
                      setSyncing(false);
                      setSyncPopoverOpen(false);
                    }
                  }}
                  className="k-interactive w-full h-8 px-3 rounded-lg bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ArrowsClockwise className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  <span>{t('cal.gcal.syncNow')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSyncPopoverOpen(false);
                    onOpenIntegrations();
                  }}
                  className="k-interactive w-full h-8 px-3 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] font-medium cursor-pointer"
                >
                  {t('cal.gcal.setup')}
                </button>
              )}

              <div className="h-px bg-[var(--k-border-hairline)]" />

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    setSyncPopoverOpen(false);
                    const r = await window.kapsula.importCalendarIcs();
                    if (r.imported > 0) {
                      toast.success(t('cal.toast.importedCount', { count: r.imported }));
                      await loadCalendar();
                    }
                  }}
                  className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] inline-flex items-center justify-center gap-1.5 cursor-pointer hover:border-[var(--k-border-strong)]"
                >
                  <UploadSimple className="w-3.5 h-3.5" />
                  <span>{t('cal.icsImport')}</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    setSyncPopoverOpen(false);
                    const r = await window.kapsula.exportCalendarIcs();
                    if (r.path) toast.success(t('cal.toast.exportedCount', { count: r.exported }));
                  }}
                  className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] inline-flex items-center justify-center gap-1.5 cursor-pointer hover:border-[var(--k-border-strong)]"
                >
                  <DownloadSimple className="w-3.5 h-3.5" />
                  <span>{t('cal.icsExport')}</span>
                </button>
              </div>
            </div>
          </PopoverSurface>

          <button
            type="button"
            data-testid="calendar-add-event-btn"
            onClick={() => openCreateSheetForDay(selectedDay)}
            className="k-interactive inline-flex items-center gap-1.5 h-8 px-3.5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shadow-2xs"
          >
            <Plus weight="bold" className="w-3.5 h-3.5" />
            <span>{t('cal.kind.event')}</span>
          </button>
        </div>
      </div>

      {/* Main Two-Pane Calendar Grid + Streamlined Right Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_328px] gap-4 items-start">
        <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] overflow-hidden shadow-[var(--k-shadow-card)]">
          <motion.div
            key={viewKey}
            initial={
              prefersReduced
                ? { opacity: 0.7 }
                : { opacity: 0.68, transform: `translate3d(${navDir * 8}px, 0, 0)` }
            }
            animate={
              prefersReduced
                ? { opacity: 1 }
                : { opacity: 1, transform: 'translate3d(0, 0, 0)' }
            }
            transition={{ duration: 0.11, ease: [0.23, 1, 0.32, 1] }}
          >
              {mode === 'month' ? (
                <>
                  <div className="grid grid-cols-7 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50">
                    {weekdaysShort.map((wd) => (
                      <div
                        key={wd}
                        className="py-2 text-center text-[11px] font-semibold text-[var(--k-ink-muted)] tracking-wider uppercase"
                      >
                        {wd}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7">
                    {monthCells.map((day, idx) => {
                      const dayKey = toLocalDateInput(day.getTime());
                      const inMonth = day.getMonth() === cursorDate.getMonth();
                      const isToday = sameDay(day, today);
                      const isSelected = sameDay(day, selectedDay);
                      const isDragOver = dragOverDayKey === dayKey;
                      const dayEntries = entriesForDay(day);
                      const overflowCount = Math.max(0, dayEntries.length - 3);
                      return (
                        <div
                          key={`${day.getTime()}-${idx}`}
                          onClick={() => setSelectedDay(startOfDay(day))}
                          onDoubleClick={() => openCreateSheetForDay(day)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverDayKey(dayKey);
                          }}
                          onDragLeave={() => {
                            if (dragOverDayKey === dayKey) setDragOverDayKey(null);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            void handleDropOnDay(day, e.dataTransfer);
                          }}
                          className={`group/cell relative min-h-[104px] p-1.5 border-[var(--k-border-hairline)] cursor-pointer transition-colors duration-120 overflow-hidden ${
                            (idx + 1) % 7 === 0 ? '' : 'border-r'
                          } ${idx >= 35 ? '' : 'border-b'} ${
                            isDragOver
                              ? 'bg-[var(--k-accent-soft)] ring-2 ring-inset ring-[var(--k-accent)]'
                              : isSelected
                                ? 'bg-[var(--k-accent-soft)]/40 ring-1 ring-inset ring-[var(--k-accent)]/55'
                                : 'hover:bg-[var(--k-bg-surface-2)]/40'
                          } ${!inMonth ? 'opacity-40' : ''}`}
                        >
                          <div className="flex items-center justify-between px-0.5 mb-1">
                            <span
                              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[12px] font-medium ${
                                isToday
                                  ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] font-semibold'
                                  : isSelected
                                    ? 'text-[var(--k-accent)] font-semibold'
                                    : 'text-[var(--k-ink-secondary)]'
                              }`}
                            >
                              {day.getDate()}
                            </span>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDay(startOfDay(day));
                                openCreateSheetForDay(day);
                              }}
                              aria-label={t('cal.addDayAria', { day: day.getDate() })}
                              className="opacity-0 group-hover/cell:opacity-100 w-5 h-5 rounded-md text-[var(--k-ink-muted)] hover:text-[var(--k-accent)] hover:bg-[var(--k-bg-surface-2)] inline-flex items-center justify-center transition-opacity cursor-pointer"
                            >
                              <Plus weight="bold" className="w-3 h-3" />
                            </button>
                          </div>

                          <div className="space-y-1 overflow-hidden">
                            {dayEntries.slice(0, 3).map((ev) => (
                              <ContextMenuSurface key={ev.id} entries={buildEntryContextMenu(ev)}>
                                <button
                                  type="button"
                                  draggable={Boolean(ev.sourceEvent && !ev.isRecurringInstance)}
                                  onDragStart={(e) => {
                                    if (ev.sourceEvent && !ev.isRecurringInstance) {
                                      e.dataTransfer.setData('text/kapsula-cal-event-id', ev.sourceEvent.id);
                                      e.dataTransfer.effectAllowed = 'move';
                                    }
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedDay(startOfDay(day));
                                    handleEntryClick(ev);
                                  }}
                                  title={`${formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))} ${ev.title}`}
                                  className={`w-full text-left flex items-center gap-1.5 h-[22px] px-1.5 rounded-md text-[11px] bg-[var(--k-bg-surface-2)]/90 hover:bg-[var(--k-bg-surface-3)] transition-colors border-l-[2.5px] cursor-pointer overflow-hidden ${
                                    ev.isDone ? 'opacity-50 line-through' : ''
                                  }`}
                                  style={{ borderLeftColor: ev.color }}
                                >
                                  {ev.isReminderOnly ? (
                                    <Bell weight="fill" className="w-2.5 h-2.5 text-[var(--k-amber)] shrink-0" />
                                  ) : !ev.allDay ? (
                                    <span className="k-mono text-[10px] text-[var(--k-ink-muted)] shrink-0">
                                      {formatTimeShort(ev.startAt, dateLocale)}
                                    </span>
                                  ) : null}
                                  <span className="truncate font-medium text-[var(--k-ink-primary)]">
                                    {ev.title}
                                  </span>
                                </button>
                              </ContextMenuSurface>
                            ))}
                            {overflowCount > 0 ? (
                              <PopoverSurface
                                open={openOverflowDayKey === dayKey}
                                onOpenChange={(nextOpen) =>
                                  setOpenOverflowDayKey(nextOpen ? dayKey : null)
                                }
                                align="start"
                                widthClass="w-64"
                                trigger={
                                  <button
                                    type="button"
                                    data-testid={`calendar-overflow-${dayKey}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedDay(startOfDay(day));
                                      setOpenOverflowDayKey((prev) =>
                                        prev === dayKey ? null : dayKey
                                      );
                                    }}
                                    className="k-interactive w-full text-left px-1.5 py-0.5 rounded-md text-[10.5px] font-medium text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer transition-colors"
                                  >
                                    {t('cal.overflowMore', { count: overflowCount })}
                                  </button>
                                }
                              >
                                <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                                  <div className="text-[11px] font-semibold text-[var(--k-ink-muted)] px-1 pb-1 border-b border-[var(--k-border-hairline)]">
                                    {day.toLocaleDateString(dateLocale, {
                                      day: 'numeric',
                                      month: 'long',
                                      weekday: 'short',
                                    })}
                                  </div>
                                  <div className="max-h-[240px] overflow-y-auto space-y-1">
                                    {dayEntries.map((ev) => (
                                      <button
                                        key={`pop-${ev.id}`}
                                        type="button"
                                        onClick={() => {
                                          setOpenOverflowDayKey(null);
                                          setSelectedDay(startOfDay(day));
                                          handleEntryClick(ev);
                                        }}
                                        className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg border-l-[3px] bg-[var(--k-bg-surface-2)]/70 hover:bg-[var(--k-bg-surface-3)] text-[12px] cursor-pointer transition-colors ${
                                          ev.isDone ? 'opacity-55 line-through' : ''
                                        }`}
                                        style={{ borderLeftColor: ev.color }}
                                      >
                                        <span className="k-mono text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
                                          {ev.allDay
                                            ? t('common.allDay')
                                            : formatTimeShort(ev.startAt, dateLocale)}
                                        </span>
                                        <span className="truncate font-medium text-[var(--k-ink-primary)]">
                                          {ev.title}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </PopoverSurface>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : mode === 'week' || mode === 'day' ? (
                /* 24h Week & Day Grid with All-Day Strip, Side-by-Side Overlap Columns & Drag Manipulation */
                <div className="flex flex-col">
                  {/* Day Headers */}
                  <div
                    className="grid pr-[6px] border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50"
                    style={{
                      gridTemplateColumns:
                        mode === 'day'
                          ? '52px minmax(0, 1fr)'
                          : '52px repeat(7, minmax(0, 1fr))',
                    }}
                  >
                    <div className="py-2 text-center text-[10px] text-[var(--k-ink-muted)]" />
                    {visibleGridDays.map((day) => {
                      const isToday = sameDay(day, today);
                      const isSelected = sameDay(day, selectedDay);
                      const dayKey = toLocalDateInput(day.getTime());
                      return (
                        <button
                          key={dayKey}
                          type="button"
                          onClick={() => {
                            setSelectedDay(startOfDay(day));
                            if (mode === 'day') setCursorDate(startOfDay(day));
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            setDragOverDayKey(dayKey);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            void handleDropOnDay(day, e.dataTransfer);
                          }}
                          className={`py-2 px-1 flex flex-col items-center gap-0.5 border-l border-[var(--k-border-hairline)] cursor-pointer transition-colors ${
                            isSelected ? 'bg-[var(--k-accent-soft)]/35' : 'hover:bg-[var(--k-bg-surface-2)]/40'
                          }`}
                        >
                          <span className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)]">
                            {weekdaysShort[(day.getDay() + 6) % 7]}
                          </span>
                          <span
                            className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-[12px] font-semibold ${
                              isToday ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]' : 'text-[var(--k-ink-primary)]'
                            }`}
                          >
                            {day.getDate()}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Dedicated All-Day Strip */}
                  {visibleGridDays.some((d) => partitionAllDayEntries(entriesForDay(d)).allDay.length > 0) ? (
                    <div
                      data-testid="calendar-allday-strip"
                      className="grid pr-[6px] border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/30"
                      style={{
                        gridTemplateColumns:
                          mode === 'day'
                            ? '52px minmax(0, 1fr)'
                            : '52px repeat(7, minmax(0, 1fr))',
                      }}
                    >
                      <div className="px-1.5 py-1.5 text-[9.5px] font-medium text-[var(--k-ink-muted)] text-right leading-tight">
                        {t('cal.allDayRow')}
                      </div>
                      {visibleGridDays.map((day) => {
                        const dayKey = toLocalDateInput(day.getTime());
                        const { allDay: allDayItems } = partitionAllDayEntries(entriesForDay(day));
                        return (
                          <div
                            key={`ad-${dayKey}`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverDayKey(dayKey);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              void handleDropOnDay(day, e.dataTransfer);
                            }}
                            className="p-1 space-y-1 border-l border-[var(--k-border-hairline)] min-h-[28px]"
                          >
                            {allDayItems.map((ev) => (
                              <ContextMenuSurface key={`ad-${ev.id}`} entries={buildEntryContextMenu(ev)}>
                                <button
                                  type="button"
                                  draggable={Boolean(ev.sourceEvent && !ev.isRecurringInstance)}
                                  onDragStart={(e) => {
                                    if (ev.sourceEvent && !ev.isRecurringInstance) {
                                      e.dataTransfer.setData('text/kapsula-cal-event-id', ev.sourceEvent.id);
                                      e.dataTransfer.effectAllowed = 'move';
                                    }
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedDay(startOfDay(day));
                                    handleEntryClick(ev);
                                  }}
                                  style={{
                                    borderLeftColor: ev.color,
                                    backgroundColor: `color-mix(in srgb, ${ev.color} 16%, transparent)`,
                                  }}
                                  className={`w-full text-left px-1.5 py-0.5 rounded-md border border-[var(--k-border-hairline)] border-l-[3px] text-[11px] font-medium truncate cursor-pointer hover:opacity-90 ${
                                    ev.isDone ? 'opacity-50 line-through' : 'text-[var(--k-ink-primary)]'
                                  }`}
                                >
                                  {ev.title}
                                </button>
                              </ContextMenuSurface>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* 24h Timed Scroll Area (auto-scrolled to 07:00) */}
                  <div
                    ref={setTimeGridScrollNode}
                    data-testid="calendar-time-grid-scroll"
                    className="max-h-[540px] overflow-y-scroll relative"
                  >
                    <div
                      className="grid relative"
                      style={{
                        gridTemplateColumns:
                          mode === 'day'
                            ? '52px minmax(0, 1fr)'
                            : '52px repeat(7, minmax(0, 1fr))',
                        height: `${DAY_HOURS.length * HOUR_ROW_PX}px`,
                      }}
                    >
                      {/* Hour Labels Column */}
                      <div className="relative border-r border-[var(--k-border-hairline)]">
                        {DAY_HOURS.map((h, i) => (
                          <div
                            key={h}
                            style={{ top: `${i * HOUR_ROW_PX}px`, height: `${HOUR_ROW_PX}px` }}
                            className={`absolute left-0 right-0 pr-2 text-right text-[10px] k-mono text-[var(--k-ink-muted)] ${
                              i === 0 ? 'pt-0.5' : '-mt-1.5'
                            }`}
                          >
                            {String(h).padStart(2, '0')}:00
                          </div>
                        ))}
                      </div>

                      {/* Visible Day Columns (7 for Week, 1 for Day) */}
                      {visibleGridDays.map((day) => {
                        const dayKey = toLocalDateInput(day.getTime());
                        const dayStartMs = startOfDay(day).getTime();
                        const isToday = sameDay(day, today);
                        const { timed: timedEntries } = partitionAllDayEntries(entriesForDay(day));
                        const overlapSlots = layoutOverlappingEvents(
                          timedEntries.map((ev) => ({
                            id: ev.id,
                            startAt: ev.startAt,
                            endAt:
                              resizingDraft && resizingDraft.entryId === ev.id
                                ? dayStartMs + resizingDraft.endMin * 60_000
                                : ev.endAt,
                            allDay: false,
                          })),
                          { dayStartMs, minDurationMinutes: 30 }
                        );
                        const slotById = new Map(overlapSlots.map((s) => [s.id, s]));

                        const draftBand =
                          dragCreateDraft && dragCreateDraft.dayKey === dayKey
                            ? {
                                startMin: Math.min(dragCreateDraft.anchorMin, dragCreateDraft.currentMin),
                                endMin: Math.min(
                                  24 * 60,
                                  Math.max(dragCreateDraft.anchorMin, dragCreateDraft.currentMin) + 30
                                ),
                              }
                            : null;

                        return (
                          <div
                            key={dayKey}
                            data-testid={`calendar-time-col-${dayKey}`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverDayKey(dayKey);
                            }}
                            onDragLeave={() => {
                              if (dragOverDayKey === dayKey) setDragOverDayKey(null);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relY = Math.max(
                                0,
                                Math.min(24 * HOUR_ROW_PX - 15, e.clientY - rect.top)
                              );
                              const snappedMin = Math.min(
                                23 * 60 + 30,
                                Math.max(0, Math.round((relY / HOUR_ROW_PX) * 2) * 30)
                              );
                              void handleDropOnDay(day, e.dataTransfer, {
                                hour: Math.floor(snappedMin / 60),
                                minute: snappedMin % 60,
                              });
                            }}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              const target = e.target as HTMLElement;
                              if (!target.dataset.slotHour) return;
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relY = Math.max(
                                0,
                                Math.min(24 * HOUR_ROW_PX - 15, e.clientY - rect.top)
                              );
                              const anchorMin = Math.min(
                                23 * 60 + 30,
                                Math.max(0, Math.floor((relY / HOUR_ROW_PX) * 2) * 30)
                              );
                              dragCreateMetaRef.current = {
                                dayKey,
                                day,
                                startY: e.clientY,
                                anchorMin,
                                currentMin: anchorMin,
                                columnTop: rect.top,
                              };
                            }}
                            className={`relative border-l border-[var(--k-border-hairline)] select-none ${
                              dragOverDayKey === dayKey ? 'bg-[var(--k-accent-soft)]/30' : ''
                            }`}
                          >
                            {/* Clickable hour slots */}
                            {DAY_HOURS.map((h, i) => (
                              <div
                                key={h}
                                data-slot-hour={h}
                                onClick={() => {
                                  if (suppressNextSlotClickRef.current) return;
                                  setSelectedDay(startOfDay(day));
                                  openCreateSheetForDay(day, {
                                    startTime: `${String(h).padStart(2, '0')}:00`,
                                    hasEndTime: true,
                                    durationMin: 60,
                                  });
                                }}
                                style={{ top: `${i * HOUR_ROW_PX}px`, height: `${HOUR_ROW_PX}px` }}
                                className="absolute left-0 right-0 border-b border-[var(--k-border-hairline)]/55 hover:bg-[var(--k-bg-surface-2)]/35 cursor-pointer"
                              />
                            ))}

                            {/* Live Drag-to-Create Preview */}
                            {draftBand ? (
                              <div
                                style={{
                                  top: `${(draftBand.startMin / 60) * HOUR_ROW_PX + 1}px`,
                                  height: `${Math.max(
                                    22,
                                    ((draftBand.endMin - draftBand.startMin) / 60) * HOUR_ROW_PX - 2
                                  )}px`,
                                }}
                                className="pointer-events-none absolute left-1 right-1 z-30 rounded-lg border border-[var(--k-accent)] bg-[var(--k-accent-soft)]/70 px-1.5 py-0.5 text-[10.5px] k-mono font-semibold text-[var(--k-accent)]"
                              >
                                {`${String(Math.floor(draftBand.startMin / 60)).padStart(2, '0')}:${String(
                                  draftBand.startMin % 60
                                ).padStart(2, '0')}–${String(Math.floor(draftBand.endMin / 60)).padStart(
                                  2,
                                  '0'
                                )}:${String(draftBand.endMin % 60).padStart(2, '0')}`}
                              </div>
                            ) : null}

                            {/* Live Current Time Line */}
                            {isToday ? (
                              <div
                                style={{ top: `${nowLineTopPx}px` }}
                                className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
                              >
                                <span className="w-2 h-2 rounded-full bg-[var(--k-accent)] -ml-1" />
                                <div className="flex-1 h-[1.5px] bg-[var(--k-accent)]" />
                              </div>
                            ) : null}

                            {/* Positioned Side-by-Side Timed Event Blocks */}
                            {timedEntries.map((ev) => {
                              const slot = slotById.get(ev.id);
                              const startMin = slot ? slot.startMin : 0;
                              const endMin = slot ? slot.endMin : 30;
                              const colIndex = slot ? slot.columnIndex : 0;
                              const totalCols = slot ? slot.totalColumns : 1;
                              const isNarrowWeekCol = mode === 'week' && totalCols >= 2;
                              const topPx = (startMin / 60) * HOUR_ROW_PX + 1;
                              const heightPx = Math.max(
                                22,
                                ((endMin - startMin) / 60) * HOUR_ROW_PX - 2
                              );
                              const canResize = Boolean(ev.sourceEvent && !ev.isRecurringInstance);

                              return (
                                <ContextMenuSurface key={ev.id} entries={buildEntryContextMenu(ev)}>
                                  <button
                                    type="button"
                                    data-testid={`calendar-timed-event-${ev.id}`}
                                    title={`${formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))} · ${ev.title}`}
                                    draggable={Boolean(ev.sourceEvent && !ev.isRecurringInstance)}
                                    onDragStart={(e) => {
                                      if (ev.sourceEvent && !ev.isRecurringInstance) {
                                        e.dataTransfer.setData('text/kapsula-cal-event-id', ev.sourceEvent.id);
                                        e.dataTransfer.effectAllowed = 'move';
                                      }
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (suppressNextEventClickRef.current) {
                                        suppressNextEventClickRef.current = false;
                                        return;
                                      }
                                      setSelectedDay(startOfDay(day));
                                      handleEntryClick(ev);
                                    }}
                                    style={{
                                      top: `${topPx}px`,
                                      height: `${heightPx}px`,
                                      left: isNarrowWeekCol
                                        ? `calc(${(colIndex / totalCols) * 100}% + 1px)`
                                        : `calc(${(colIndex / totalCols) * 100}% + 2px)`,
                                      width: isNarrowWeekCol
                                        ? `calc(${100 / totalCols}% - 2px)`
                                        : `calc(${100 / totalCols}% - 4px)`,
                                      borderLeftColor: ev.color,
                                      backgroundColor: `color-mix(in srgb, ${ev.color} 15%, transparent)`,
                                    }}
                                    className={`group/evbtn absolute z-10 rounded-lg border border-[var(--k-border-hairline)] border-l-[3px] ${
                                      isNarrowWeekCol ? 'px-1 py-0.5' : 'px-1.5 py-1'
                                    } text-left overflow-hidden hover:opacity-95 transition-opacity duration-140 cursor-pointer ${
                                      ev.isDone ? 'opacity-50 line-through' : ''
                                    }`}
                                  >
                                    <div
                                      className={
                                        isNarrowWeekCol
                                          ? 'text-[10px] font-semibold text-[var(--k-ink-primary)] leading-[1.15] break-words line-clamp-3'
                                          : 'text-[11px] font-semibold text-[var(--k-ink-primary)] truncate leading-tight'
                                      }
                                    >
                                      {ev.title}
                                    </div>
                                    {!isNarrowWeekCol && heightPx >= 36 ? (
                                      <div className="text-[10px] k-mono text-[var(--k-ink-secondary)] truncate">
                                        {formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))}
                                      </div>
                                    ) : null}
                                    {canResize ? (
                                      <span
                                        data-testid={`calendar-resize-handle-${ev.id}`}
                                        onMouseDown={(e) => {
                                          e.stopPropagation();
                                          e.preventDefault();
                                          const sDate = new Date(ev.startAt);
                                          const eDate = new Date(ev.endAt);
                                          const startM = sDate.getHours() * 60 + sDate.getMinutes();
                                          const sameEndDay = sameDay(sDate, eDate);
                                          const initEndM = sameEndDay
                                            ? Math.max(startM + 15, eDate.getHours() * 60 + eDate.getMinutes())
                                            : 24 * 60;
                                          resizeMetaRef.current = {
                                            entryId: ev.id,
                                            sourceEvent: ev.sourceEvent!,
                                            dayStartMs,
                                            startY: e.clientY,
                                            initialEndMin: initEndM,
                                            currentEndMin: initEndM,
                                            minEndMin: Math.min(24 * 60, startM + 15),
                                          };
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize opacity-0 group-hover/evbtn:opacity-100 bg-[var(--k-accent)]/25 transition-opacity"
                                      />
                                    ) : null}
                                  </button>
                                </ContextMenuSurface>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col min-h-[380px]">
                  <div className="flex items-center justify-end px-4 py-2 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/40">
                    <button
                      type="button"
                      onClick={() => setHidePastAgenda((v) => !v)}
                      className="k-interactive text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                    >
                      {hidePastAgenda ? t('cal.agenda.showPast') : t('cal.agenda.hidePast')}
                    </button>
                  </div>
                  <div
                    data-testid="calendar-agenda-list"
                    className="divide-y divide-[var(--k-border-hairline)] flex-1"
                  >
                    {agendaGroups.length === 0 ? (
                      <div className="py-16 text-center space-y-2">
                        <div className="text-[14px] font-medium text-[var(--k-ink-secondary)]">
                          {t('cal.emptyPeriod')}
                        </div>
                        <button
                          type="button"
                          onClick={() => openCreateSheetForDay(selectedDay)}
                          className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[12px] font-medium cursor-pointer"
                        >
                          <Plus weight="bold" className="w-3.5 h-3.5" />
                          {t('cal.addFirstEvent')}
                        </button>
                      </div>
                    ) : (
                      agendaGroups.map((group) => (
                        <div key={group.dayKey} className="divide-y divide-[var(--k-border-hairline)]/60">
                          <div className="sticky top-0 z-10 px-4 py-1.5 bg-[var(--k-bg-surface-2)]/95 backdrop-blur-sm text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                            {group.label}
                          </div>
                          {group.items.map((ev) => (
                            <ContextMenuSurface key={ev.id} entries={buildEntryContextMenu(ev)}>
                              <div
                                onClick={() => handleEntryClick(ev)}
                                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--k-bg-surface-2)]/60 transition-colors cursor-pointer"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  {ev.sourceEvent ? (
                                    <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                                      <AnimatedCheckbox
                                        size="sm"
                                        checked={ev.isDone}
                                        onChange={() => void handleToggleEventDone(ev.sourceEvent!)}
                                      />
                                    </div>
                                  ) : ev.sourceTask ? (
                                    <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                                      <AnimatedCheckbox
                                        size="sm"
                                        checked={ev.isDone}
                                        onChange={() => void handleToggleVaultTaskEntry(ev.sourceTask!)}
                                      />
                                    </div>
                                  ) : (
                                    <span
                                      className="w-2.5 h-2.5 rounded-full shrink-0"
                                      style={{ backgroundColor: ev.color }}
                                    />
                                  )}
                                  <div className="min-w-0">
                                    <div
                                      className={`text-[13.5px] font-medium truncate ${
                                        ev.isDone ? 'line-through text-[var(--k-ink-muted)]' : ''
                                      }`}
                                    >
                                      {ev.title}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--k-ink-muted)]">
                                      <span className="k-mono">
                                        {formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))}
                                      </span>
                                      {ev.location ? (
                                        <span className="inline-flex items-center gap-1 truncate max-w-[200px]">
                                          <MapPin className="w-3 h-3 shrink-0" />
                                          {ev.location}
                                        </span>
                                      ) : null}
                                      {ev.checklistTotal > 0 ? (
                                        <span className="inline-flex items-center gap-1">
                                          <ListChecks className="w-3 h-3" />
                                          {ev.checklistDone}/{ev.checklistTotal}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                </div>

                                {ev.linkedItemId ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onOpenItem(ev.linkedItemId!);
                                    }}
                                    className="k-interactive text-[11.5px] text-[var(--k-accent)] hover:underline shrink-0 cursor-pointer"
                                  >
                                    {t('cal.openItem')}
                                  </button>
                                ) : null}
                              </div>
                            </ContextMenuSurface>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </motion.div>
        </div>

        {/* Streamlined Right Day Panel */}
        <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] shadow-[var(--k-shadow-card)] divide-y divide-[var(--k-border-hairline)] overflow-hidden">
          {/* Selected Day */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] font-semibold">
                  {t('cal.selectedDay')}
                </div>
                <div className="text-[15.5px] font-semibold text-[var(--k-ink-primary)]">
                  {selectedDayTitle}
                </div>
              </div>
              <button
                type="button"
                onClick={() => openCreateSheetForDay(selectedDay)}
                aria-label={t('cal.newEventDayAria')}
                className="k-interactive w-8 h-8 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] inline-flex items-center justify-center cursor-pointer transition-colors"
              >
                <Plus weight="bold" className="w-4 h-4" />
              </button>
            </div>

            {selectedDayEntries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--k-border-hairline)] p-4 text-center space-y-1.5">
                <div className="text-[12.5px] text-[var(--k-ink-muted)]">{t('cal.noPlansDay')}</div>
                <button
                  type="button"
                  onClick={() => openCreateSheetForDay(selectedDay)}
                  className="k-interactive inline-flex items-center gap-1 text-[12px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer"
                >
                  <Plus weight="bold" className="w-3 h-3" />
                  {t('cal.scheduleEvent')}
                </button>
              </div>
            ) : (
              <div className="space-y-2 max-h-[210px] overflow-y-auto pr-0.5">
                {selectedDayEntries.map((entry) => {
                  const linkedNote = entry.linkedItemId ? itemMap.get(entry.linkedItemId) : undefined;
                  return (
                    <ContextMenuSurface key={entry.id} entries={buildEntryContextMenu(entry)}>
                      <div
                        data-testid={`calendar-day-entry-${entry.id}`}
                        onClick={() => handleEntryClick(entry)}
                        className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 hover:border-[var(--k-border-strong)] p-3 space-y-2 transition-colors cursor-pointer"
                      >
                        <div className="flex items-start gap-2.5">
                          {entry.sourceEvent ? (
                            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                              <AnimatedCheckbox
                                size="sm"
                                checked={entry.isDone}
                                onChange={() => void handleToggleEventDone(entry.sourceEvent!)}
                              />
                            </div>
                          ) : entry.sourceTask ? (
                            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                              <AnimatedCheckbox
                                size="sm"
                                checked={entry.isDone}
                                onChange={() => void handleToggleVaultTaskEntry(entry.sourceTask!)}
                              />
                            </div>
                          ) : (
                            <span
                              className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                              style={{ backgroundColor: entry.color }}
                            />
                          )}

                        <div className="flex-1 min-w-0 space-y-1">
                          <div
                            className={`text-[13.5px] font-semibold leading-snug ${
                              entry.isDone ? 'line-through text-[var(--k-ink-muted)]' : 'text-[var(--k-ink-primary)]'
                            }`}
                          >
                            {entry.title}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--k-ink-muted)]">
                            <span className="k-mono">{formatEntryTimeLabel(entry, dateLocale, t('common.allDay'))}</span>
                            {entry.location ? (
                              <span className="inline-flex items-center gap-1 truncate max-w-[170px]">
                                <MapPin className="w-3 h-3 shrink-0" />
                                <span className="truncate">{entry.location}</span>
                              </span>
                            ) : null}
                            {entry.checklistTotal > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[var(--k-ink-secondary)]">
                                <ListChecks className="w-3 h-3" />
                                {entry.checklistDone}/{entry.checklistTotal}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {linkedNote || entry.attachmentsCount > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[var(--k-border-hairline)]/70">
                          {linkedNote ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenItem(linkedNote.id);
                              }}
                              className="k-interactive inline-flex items-center gap-1 text-[11px] text-[var(--k-accent)] hover:underline cursor-pointer truncate max-w-[220px]"
                            >
                              <LinkSimple className="w-3 h-3 shrink-0" />
                              <span className="truncate">{linkedNote.title}</span>
                            </button>
                          ) : null}
                          {entry.attachmentsCount > 1 ? (
                            <span className="text-[10.5px] text-[var(--k-ink-muted)]">
                              {t('cal.overflowMore', { count: entry.attachmentsCount - 1 })}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    </ContextMenuSurface>
                  );
                })}
              </div>
            )}
          </div>

          {/* Upcoming 14 Days */}
          <div className="p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] font-semibold">
                {t('cal.next14Days')}
              </div>
              {upcomingEntries.length > 0 ? (
                <span className="k-mono text-[11px] text-[var(--k-ink-muted)]">
                  {upcomingEntries.length}
                </span>
              ) : null}
            </div>

            {upcomingEntries.length === 0 ? (
              <div className="text-[12px] text-[var(--k-ink-muted)]">
                {t('cal.noUpcoming14Days')}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[155px] overflow-y-auto pr-0.5">
                {upcomingEntries.map((ev) => (
                  <button
                    key={`up-${ev.id}`}
                    type="button"
                    onClick={() => {
                      const d = startOfDay(new Date(ev.startAt));
                      setSelectedDay(d);
                      setCursorDate(new Date(d.getFullYear(), d.getMonth(), 1));
                      handleEntryClick(ev);
                    }}
                    className="w-full text-left rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50 hover:bg-[var(--k-bg-surface-2)] px-2.5 py-2 flex items-center justify-between gap-2 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: ev.color }}
                      />
                      <span className="text-[12.5px] font-medium truncate text-[var(--k-ink-primary)]">
                        {ev.title}
                      </span>
                    </div>
                    <span className="k-mono text-[11px] text-[var(--k-ink-muted)] shrink-0">
                      {new Date(ev.startAt).toLocaleDateString(dateLocale, {
                        day: 'numeric',
                        month: 'short',
                      })}
                      {!ev.allDay ? ` · ${formatTimeShort(ev.startAt, dateLocale)}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Unscheduled Tasks — searchable & draggable onto any day cell or time slot! */}
          {allUnscheduledTasks.length > 0 ? (
            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] font-semibold">
                  {t('cal.unscheduledTasks')}
                </div>
                <span className="text-[10.5px] text-[var(--k-ink-muted)]">{t('cal.dragToDayHint')}</span>
              </div>
              <div className="relative">
                <MagnifyingGlass className="w-3.5 h-3.5 text-[var(--k-ink-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  data-testid="calendar-unscheduled-search"
                  value={unscheduledQuery}
                  onChange={(e) => setUnscheduledQuery(e.target.value)}
                  placeholder={t('cal.unscheduledSearchPlaceholder')}
                  className="w-full h-7.5 pl-7.5 pr-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 text-[12px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none focus:border-[var(--k-border-focus)]"
                />
              </div>
              <div className="space-y-1.5 max-h-[210px] overflow-y-auto">
                {unscheduledTasks.map((taskItem) => (
                  <div
                    key={taskItem.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        'text/kapsula-task-json',
                        JSON.stringify({
                          id: taskItem.id,
                          itemId: taskItem.itemId,
                          sourceType: taskItem.sourceType,
                          taskIndex: taskItem.taskIndex,
                          taskKey: taskItem.taskKey,
                          text: taskItem.text,
                        })
                      );
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className="flex items-center justify-between gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/60 hover:border-[var(--k-border-strong)] px-2.5 py-1.5 cursor-grab active:cursor-grabbing"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenItem(taskItem.itemId)}
                      className="text-left text-[12px] truncate flex-1 hover:text-[var(--k-accent)] cursor-pointer"
                    >
                      {taskItem.text}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (schedulingTaskRef.current) return;
                        schedulingTaskRef.current = true;
                        try {
                          const slot = new Date(selectedDay);
                          slot.setHours(12, 0, 0, 0);
                          await scheduleVaultTaskAt(taskItem, slot.getTime(), false);
                          toast.success(t('cal.toast.taskAddedDay'));
                          await loadCalendar();
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, undefined, locale));
                        } finally {
                          schedulingTaskRef.current = false;
                        }
                      }}
                      className="k-interactive text-[11px] text-[var(--k-accent)] font-medium shrink-0 cursor-pointer"
                    >
                      {t('cal.addToDayBtn')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <CalendarEventSheet
        open={sheetOpen}
        event={activeEvent}
        seed={sheetSeed}
        vaultItems={items}
        onClose={() => {
          setSheetOpen(false);
          setActiveEvent(null);
        }}
        onSave={handleSaveSheet}
        onQuickPatchEvent={handleQuickPatchEvent}
        onDelete={handleDeleteEvent}
        onToggleDone={handleToggleEventDone}
        onOpenVaultItem={(id) => {
          setSheetOpen(false);
          onOpenItem(id);
        }}
      />
    </div>
  );
};
