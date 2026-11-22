import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowsClockwise,
  Bell,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  DownloadSimple,
  LinkSimple,
  ListBullets,
  ListChecks,
  MapPin,
  Plus,
  Sparkle,
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
import { parseRussianEvent } from '@shared/russian-event-parser';
import { friendlyErrorMessage } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
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
}

type CalendarMode = 'month' | 'week' | 'agenda';

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
}

const WEEK_HOURS = Array.from({ length: 17 }, (_, i) => i + 7); // 07:00 .. 23:00
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
}) => {
  const { t, locale, dateLocale } = useI18n();
  const weekdaysShort = useMemo(() => t('cal.weekdaysShort').split(','), [t]);
  const prefersReduced = useReducedMotion();
  const [cursorDate, setCursorDate] = useState(() => startOfDay(new Date()));
  const [navDir, setNavDir] = useState<1 | -1>(1);
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  const [mode, setMode] = useState<CalendarMode>('month');
  const [events, setEvents] = useState<CalendarEvent[]>(initialEvents ?? []);
  const [syncStatus, setSyncStatus] = useState<CalendarSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncPopoverOpen, setSyncPopoverOpen] = useState(false);
  const [dragOverDayKey, setDragOverDayKey] = useState<string | null>(null);

  const [quickLine, setQuickLine] = useState('');
  const quickAddingRef = useRef(false);
  const schedulingTaskRef = useRef(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null>(null);
  const [sheetSeed, setSheetSeed] = useState<CalendarEventSheetSeed | null>(null);

  useEffect(() => {
    if (initialEvents) {
      setEvents(initialEvents);
    }
  }, [initialEvents]);

  const loadCalendar = useCallback(async () => {
    try {
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
  }, [cursorDate, mode]);

  useEffect(() => {
    void loadCalendar();
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
      const effectiveDueAt = task.dueAt ?? parentItem?.remindAt ?? null;
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
        isDone: task.done,
        location: '',
        checklistDone: 0,
        checklistTotal: 0,
        attachmentsCount: 1,
        linkedItemId: task.itemId,
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
  }, [events, items, tasks, itemMap, windowRange, t]);

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

  const entriesForDay = useCallback(
    (day: Date) => {
      const ds = startOfDay(day).getTime();
      const de = ds + 86_400_000 - 1;
      return combinedEntries.filter(
        (e) => e.startAt <= de && (e.endAt > ds || (e.endAt === e.startAt && e.startAt >= ds))
      );
    },
    [combinedEntries]
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

  const unscheduledTasks = useMemo(() => {
    const scheduledTaskKeys = new Set(
      events
        .filter((ev) => ev.linkedItemId)
        .map((ev) => `${ev.linkedItemId}:${ev.title.trim().toLowerCase()}`)
    );
    return tasks
      .filter((t) => {
        if (t.done) return false;
        if (t.dueAt != null) return false;
        if (itemMap.get(t.itemId)?.remindAt != null) return false;
        return !scheduledTaskKeys.has(`${t.itemId}:${t.text.trim().toLowerCase()}`);
      })
      .slice(0, 12);
  }, [tasks, events, itemMap]);

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

  const handleToggleEventDone = async (ev: CalendarEvent) => {
    const prevDone = ev.isDone;
    const nextDone = !prevDone;
    // Instant 0ms optimistic update in calendar list & open sheet before awaiting IPC
    setEvents((prev) =>
      prev.map((row) => (row.id === ev.id ? { ...row, isDone: nextDone } : row))
    );
    setActiveEvent((prev) => (prev && prev.id === ev.id ? { ...prev, isDone: nextDone } : prev));

    try {
      const updated = await window.kapsula.upsertCalendarEvent({
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
        isDone: nextDone,
        externalSource: ev.externalSource,
        externalId: ev.externalId,
      });
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

  // Drag & Drop: move event or schedule task onto a target day
  const handleDropOnDay = async (targetDay: Date, dataTransfer: DataTransfer) => {
    setDragOverDayKey(null);
    const eventId = dataTransfer.getData('text/kapsula-cal-event-id');
    if (eventId) {
      const ev = events.find((e) => e.id === eventId);
      if (!ev) return;
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
        await window.kapsula.upsertCalendarEvent({
          id: ev.id,
          title: ev.title,
          notes: ev.notes,
          location: ev.location,
          startAt: nextStart.getTime(),
          endAt: nextEndMs,
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
        });
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
        const parsedTask = JSON.parse(taskRaw) as { itemId: string; text: string };
        const slot = new Date(targetDay);
        slot.setHours(12, 0, 0, 0);
        await window.kapsula.upsertCalendarEvent({
          title: parsedTask.text,
          startAt: slot.getTime(),
          endAt: slot.getTime() + 1_800_000,
          hasEndTime: false,
          linkedItemId: parsedTask.itemId,
          kind: 'task',
          color: '#3B82F6',
        });
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
    const fmt = new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric' }).format(cursorDate);
    return fmt.charAt(0).toUpperCase() + fmt.slice(1);
  }, [cursorDate, dateLocale]);

  const today = useMemo(() => startOfDay(new Date()), []);
  const nowDate = new Date();
  const nowMinutesFrom7 = (nowDate.getHours() - 7) * 60 + nowDate.getMinutes();
  const showNowLine = nowMinutesFrom7 >= 0 && nowMinutesFrom7 <= WEEK_HOURS.length * 60;
  const nowLineTopPx = (nowMinutesFrom7 / 60) * HOUR_ROW_PX;

  const selectedDayTitle = useMemo(() => {
    const raw = selectedDay.toLocaleDateString(dateLocale, {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [selectedDay, dateLocale]);

  const viewKey =
    mode === 'month'
      ? `m-${cursorDate.getFullYear()}-${cursorDate.getMonth()}`
      : mode === 'week'
        ? `w-${toLocalDateInput(weekDays[0]!.getTime())}`
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
              onClick={() => {
                setNavDir(-1);
                setCursorDate((d) =>
                  mode === 'week'
                    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7)
                    : new Date(d.getFullYear(), d.getMonth() - 1, 1)
                );
              }}
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
              onClick={() => {
                setNavDir(1);
                setCursorDate((d) =>
                  mode === 'week'
                    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
                    : new Date(d.getFullYear(), d.getMonth() + 1, 1)
                );
              }}
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
            onChange={setMode}
            options={[
              { value: 'month', label: t('cal.view.month'), icon: <CalendarBlank className="w-3.5 h-3.5" /> },
              { value: 'week', label: t('cal.view.week') },
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
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={viewKey}
              initial={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: `translate3d(${navDir * 12}px, 0, 0)` }
              }
              animate={
                prefersReduced
                  ? { opacity: 1 }
                  : { opacity: 1, transform: 'translate3d(0, 0, 0)' }
              }
              exit={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: `translate3d(${-navDir * 10}px, 0, 0)` }
              }
              transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
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
                              <button
                                key={ev.id}
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
                            ))}
                            {overflowCount > 0 ? (
                              <div className="px-1.5 text-[10.5px] font-medium text-[var(--k-ink-muted)]">
                                {t('cal.overflowMore', { count: overflowCount })}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : mode === 'week' ? (
                /* Real Hourly Week Grid (07:00 – 23:00) with live Now Line */
                <div className="flex flex-col">
                  {/* Week Day Headers */}
                  <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50">
                    <div className="py-2 text-center text-[10px] text-[var(--k-ink-muted)]" />
                    {weekDays.map((day) => {
                      const isToday = sameDay(day, today);
                      const isSelected = sameDay(day, selectedDay);
                      const dayKey = toLocalDateInput(day.getTime());
                      return (
                        <button
                          key={dayKey}
                          type="button"
                          onClick={() => setSelectedDay(startOfDay(day))}
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

                  {/* All-day row if any */}
                  <div className="max-h-[540px] overflow-y-auto relative">
                    <div
                      className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] relative"
                      style={{ height: `${WEEK_HOURS.length * HOUR_ROW_PX}px` }}
                    >
                      {/* Hour Labels Column */}
                      <div className="relative border-r border-[var(--k-border-hairline)]">
                        {WEEK_HOURS.map((h, i) => (
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

                      {/* 7 Day Columns */}
                      {weekDays.map((day) => {
                        const dayKey = toLocalDateInput(day.getTime());
                        const isToday = sameDay(day, today);
                        const dayEntries = entriesForDay(day);
                        return (
                          <div
                            key={dayKey}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverDayKey(dayKey);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              void handleDropOnDay(day, e.dataTransfer);
                            }}
                            className={`relative border-l border-[var(--k-border-hairline)] ${
                              dragOverDayKey === dayKey ? 'bg-[var(--k-accent-soft)]/30' : ''
                            }`}
                          >
                            {/* Clickable hour slots */}
                            {WEEK_HOURS.map((h, i) => (
                              <div
                                key={h}
                                onClick={() => {
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

                            {/* Live Current Time Line */}
                            {isToday && showNowLine ? (
                              <div
                                style={{ top: `${nowLineTopPx}px` }}
                                className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
                              >
                                <span className="w-2 h-2 rounded-full bg-[var(--k-accent)] -ml-1" />
                                <div className="flex-1 h-[1.5px] bg-[var(--k-accent)]" />
                              </div>
                            ) : null}

                            {/* Positioned Event Blocks */}
                            {dayEntries.map((ev) => {
                              const sDate = new Date(ev.startAt);
                              const startMins = ev.allDay
                                ? 0
                                : Math.max(0, (sDate.getHours() - 7) * 60 + sDate.getMinutes());
                              const durMins = ev.allDay
                                ? 36
                                : Math.max(30, Math.round((ev.endAt - ev.startAt) / 60_000));
                              const topPx = (startMins / 60) * HOUR_ROW_PX + 2;
                              const heightPx = Math.max(24, (durMins / 60) * HOUR_ROW_PX - 4);
                              return (
                                <button
                                  key={ev.id}
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
                                    top: `${topPx}px`,
                                    height: `${heightPx}px`,
                                    borderLeftColor: ev.color,
                                    backgroundColor: `color-mix(in srgb, ${ev.color} 15%, transparent)`,
                                  }}
                                  className={`absolute left-1 right-1 z-10 rounded-lg border border-[var(--k-border-hairline)] border-l-[3px] px-1.5 py-1 text-left overflow-hidden hover:opacity-90 transition-opacity duration-140 cursor-pointer ${
                                    ev.isDone ? 'opacity-50 line-through' : ''
                                  }`}
                                >
                                  <div className="text-[11px] font-semibold text-[var(--k-ink-primary)] truncate leading-tight">
                                    {ev.title}
                                  </div>
                                  {heightPx >= 36 ? (
                                    <div className="text-[10px] k-mono text-[var(--k-ink-secondary)] truncate">
                                      {formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))}
                                    </div>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  data-testid="calendar-agenda-list"
                  className="divide-y divide-[var(--k-border-hairline)] min-h-[380px]"
                >
                  {combinedEntries.length === 0 ? (
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
                    combinedEntries.map((ev) => (
                      <div
                        key={ev.id}
                        onClick={() => handleEntryClick(ev)}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--k-bg-surface-2)]/60 transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {ev.sourceEvent ? (
                            <AnimatedCheckbox
                              size="sm"
                              checked={ev.isDone}
                              onChange={() => void handleToggleEventDone(ev.sourceEvent!)}
                            />
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
                              <span>
                                {new Date(ev.startAt).toLocaleDateString(dateLocale, {
                                  day: 'numeric',
                                  month: 'short',
                                  weekday: 'short',
                                })}{' '}
                                · {formatEntryTimeLabel(ev, dateLocale, t('common.allDay'))}
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
                    ))
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
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
              <div className="space-y-2">
                {selectedDayEntries.map((entry) => {
                  const linkedNote = entry.linkedItemId ? itemMap.get(entry.linkedItemId) : undefined;
                  return (
                    <div
                      key={entry.id}
                      data-testid={`calendar-day-entry-${entry.id}`}
                      onClick={() => handleEntryClick(entry)}
                      className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 hover:border-[var(--k-border-strong)] p-3 space-y-2 transition-colors cursor-pointer"
                    >
                      <div className="flex items-start gap-2.5">
                        {entry.sourceEvent ? (
                          <div className="pt-0.5">
                            <AnimatedCheckbox
                              size="sm"
                              checked={entry.isDone}
                              onChange={() => void handleToggleEventDone(entry.sourceEvent!)}
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
              <div className="space-y-1.5">
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

          {/* Unscheduled Tasks — draggable onto any day cell! */}
          {unscheduledTasks.length > 0 ? (
            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] font-semibold">
                  {t('cal.unscheduledTasks')}
                </div>
                <span className="text-[10.5px] text-[var(--k-ink-muted)]">{t('cal.dragToDayHint')}</span>
              </div>
              <div className="space-y-1.5 max-h-[210px] overflow-y-auto">
                {unscheduledTasks.map((taskItem) => (
                  <div
                    key={taskItem.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        'text/kapsula-task-json',
                        JSON.stringify({ itemId: taskItem.itemId, text: taskItem.text })
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
                          await window.kapsula.upsertCalendarEvent({
                            title: taskItem.text,
                            startAt: slot.getTime(),
                            endAt: slot.getTime() + 1_800_000,
                            hasEndTime: false,
                            linkedItemId: taskItem.itemId,
                            kind: 'task',
                            color: '#3B82F6',
                          });
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
