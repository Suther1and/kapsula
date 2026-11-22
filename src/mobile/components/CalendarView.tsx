import React, { useMemo, useRef, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  Clock,
  DotsThree,
  MapPin,
  PencilSimple,
  Plus,
  Repeat,
  Sparkle,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarRecurrence,
  VaultTaskEntry,
} from '@shared/types';
import type { MobileDictKey } from '@shared/i18n/mobile-dict';
import {
  capitalizeFirst,
  eventOccursOnDay,
  sameCalendarDay,
} from '../lib/mobile-helpers';
import { tm, useMobileI18n } from '../lib/mobile-i18n';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { ItemActionSheet, type ActionSheetEntry } from './ItemActionSheet';
import { SwipeableRow } from './SwipeableRow';

interface CalendarViewProps {
  events: CalendarEvent[];
  tasks: VaultTaskEntry[];
  isExpanded: boolean;
  isWide: boolean;
  hingeRightOffsetPx?: number;
  searchQuery?: string;
  selectedDateIso: string;
  onSelectDateIso: (iso: string) => void;
  onSaveEvent: (input: CalendarEventInput) => Promise<CalendarEvent>;
  onDeleteEvent: (id: string) => Promise<void>;
  onToggleTask: (task: VaultTaskEntry) => Promise<void>;
}

const EVENT_COLORS = ['#E86A33', '#2EA06B', '#3B82F6', '#8B5CF6', '#EC4899', '#F5A524'];
const TIME_PRESETS = ['09:00', '11:00', '14:00', '16:00', '19:00'];
const RECURRENCE_OPTION_KEYS: Array<{ id: CalendarRecurrence; labelKey: MobileDictKey }> = [
  { id: 'none', labelKey: 'calendar.recurrenceOnce' },
  { id: 'daily', labelKey: 'calendar.recurrenceDaily' },
  { id: 'weekdays', labelKey: 'calendar.recurrenceWeekdays' },
  { id: 'weekly', labelKey: 'calendar.recurrenceWeeklyOpt' },
  { id: 'monthly', labelKey: 'calendar.recurrenceMonthlyOpt' },
];
const RECURRENCE_LABEL_KEYS: Record<CalendarRecurrence, MobileDictKey> = {
  none: 'calendar.recurrenceNone',
  daily: 'calendar.recurrenceDaily',
  weekdays: 'calendar.recurrenceWeekdays',
  weekly: 'calendar.recurrenceWeekly',
  monthly: 'calendar.recurrenceMonthly',
};

import { toDateIso } from '../lib/date-utils';
export { toDateIso };

function formatInputTime24(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fromDateIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y || 2026, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

/** Returns the 7 days (Mon..Sun) containing `date`. */
export function getWeekStripDays(date: Date): Date[] {
  const dow = (date.getDay() + 6) % 7; // Mon = 0
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dow);
  return Array.from(
    { length: 7 },
    (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
  );
}

function formatTime(ms: number, intlLocale = 'ru-RU'): string {
  return new Date(ms).toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' });
}

function parseHourMinute(raw: string, fallbackH: number, fallbackM: number): [number, number] {
  const [hStr, mStr] = (raw || '').split(':');
  const h = Number.parseInt(hStr ?? '', 10);
  const m = Number.parseInt(mStr ?? '', 10);
  return [Number.isFinite(h) ? h : fallbackH, Number.isFinite(m) ? m : fallbackM];
}

function addMinutesToTimeStr(timeStr: string, addMin: number): string {
  const [h, m] = parseHourMinute(timeStr, 10, 0);
  const total = (h * 60 + m + addMin) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  events,
  tasks,
  isExpanded,
  isWide,
  hingeRightOffsetPx = 0,
  searchQuery = '',
  selectedDateIso,
  onSelectDateIso,
  onSaveEvent,
  onDeleteEvent,
  onToggleTask,
}) => {
  const { locale, intlLocale, t, plural, weekdays } = useMobileI18n();
  const prefersReduced = useReducedMotion();
  const selectedDate = useMemo(() => fromDateIso(selectedDateIso), [selectedDateIso]);
  const [monthCursor, setMonthCursor] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1)
  );
  // On compact Fold outer screen, default to spacious 1-row Week Strip so day agenda gets 70%+ height!
  const [compactCalendarMode, setCompactCalendarMode] = useState<'week' | 'month'>('week');

  const [quickInput, setQuickInput] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [actionEvent, setActionEvent] = useState<CalendarEvent | null>(null);

  // Event editor form state
  const [title, setTitle] = useState('');
  const [dateStr, setDateStr] = useState(selectedDateIso);
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [recurrence, setRecurrence] = useState<CalendarRecurrence>('none');
  const [color, setColor] = useState('#E86A33');

  const gridTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const todayIsoStr = toDateIso(new Date());

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return events;
    return events.filter((ev) =>
      matchesBilingualHaystack(`${ev.title} ${ev.location || ''} ${ev.notes || ''}`, q)
    );
  }, [events, searchQuery]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return tasks;
    return tasks.filter((t) => matchesBilingualHaystack(`${t.text} ${t.itemTitle}`, q));
  }, [tasks, searchQuery]);

  const monthDays = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const first = new Date(year, month, 1);
    const firstDow = (first.getDay() + 6) % 7;
    const startCell = new Date(year, month, 1 - firstDow);
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) {
      cells.push(new Date(startCell.getFullYear(), startCell.getMonth(), startCell.getDate() + i));
    }
    return cells;
  }, [monthCursor]);

  const weekDays = useMemo(() => getWeekStripDays(selectedDate), [selectedDate]);

  const dayEvents = useMemo(
    () =>
      filteredEvents
        .filter((ev) => eventOccursOnDay(ev, selectedDate))
        .sort((a, b) => a.startAt - b.startAt),
    [filteredEvents, selectedDate]
  );

  const dayTasks = useMemo(
    () => filteredTasks.filter((t) => t.remindAt && sameCalendarDay(t.remindAt, selectedDate)),
    [filteredTasks, selectedDate]
  );

  const stepPeriod = (delta: -1 | 1) => {
    mobileBridge.haptic('light');
    if (!isExpanded && compactCalendarMode === 'week') {
      const next = new Date(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate() + delta * 7
      );
      onSelectDateIso(toDateIso(next));
      setMonthCursor(new Date(next.getFullYear(), next.getMonth(), 1));
    } else {
      setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + delta, 1));
    }
  };

  const openCreateModal = () => {
    setEditingEvent(null);
    setTitle('');
    setDateStr(selectedDateIso);
    setStartTime('10:00');
    setEndTime('11:00');
    setAllDay(false);
    setLocation('');
    setNotes('');
    setRecurrence('none');
    setColor('#E86A33');
    setEditorOpen(true);
  };

  const openEditModal = (ev: CalendarEvent) => {
    setEditingEvent(ev);
    setTitle(ev.title);
    setDateStr(toDateIso(new Date(ev.startAt)));
    setStartTime(formatInputTime24(ev.startAt));
    setEndTime(formatInputTime24(ev.endAt));
    setAllDay(ev.allDay);
    setLocation(ev.location || '');
    setNotes(ev.notes || '');
    setRecurrence(ev.recurrence || 'none');
    setColor(ev.color || '#E86A33');
    setEditorOpen(true);
  };

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quickInput.trim();
    if (!clean) return;
    const parsed = parseRussianEvent(clean, Date.now(), selectedDate.getTime(), locale);
    if (parsed) {
      const defaultRuTitle = tm('calendar.defaultEventTitle', undefined, 'ru');
      const eventTitle =
        locale === 'en' && parsed.title === defaultRuTitle
          ? t('calendar.defaultEventTitle')
          : parsed.title;
      await onSaveEvent({
        title: eventTitle,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        allDay: parsed.allDay,
        hasEndTime: parsed.hasEndTime,
        location: parsed.location,
        notes: parsed.notes,
        kind: 'event',
      });
      const target = new Date(parsed.startAt);
      onSelectDateIso(toDateIso(target));
      setMonthCursor(new Date(target.getFullYear(), target.getMonth(), 1));
      mobileBridge.haptic('success');
      toast.success(t('calendar.quickAddedToast', { title: eventTitle }));
    } else {
      const start = new Date(selectedDate);
      start.setHours(10, 0, 0, 0);
      await onSaveEvent({
        title: clean,
        startAt: start.getTime(),
        endAt: start.getTime() + 3_600_000,
        allDay: false,
        hasEndTime: true,
        kind: 'event',
      });
      mobileBridge.haptic('success');
      toast.success(t('calendar.eventAddedToast'));
    }
    setQuickInput('');
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim() || t('calendar.defaultEventTitle');
    const base = fromDateIso(dateStr);
    const [sh, sm] = parseHourMinute(startTime, 10, 0);
    const [eh, em] = parseHourMinute(endTime, (sh + 1) % 24, sm);
    const start = new Date(base);
    const end = new Date(base);
    if (allDay) {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 0, 0);
    } else {
      start.setHours(sh, sm, 0, 0);
      end.setHours(eh, em, 0, 0);
      if (end.getTime() <= start.getTime()) {
        end.setTime(start.getTime() + 3_600_000);
      }
    }

    await onSaveEvent({
      id: editingEvent?.id,
      title: cleanTitle,
      startAt: start.getTime(),
      endAt: end.getTime(),
      allDay,
      hasEndTime: !allDay,
      location: location.trim(),
      notes: notes.trim(),
      recurrence,
      color,
      kind: editingEvent?.kind ?? 'event',
    });
    onSelectDateIso(dateStr);
    setMonthCursor(new Date(base.getFullYear(), base.getMonth(), 1));
    setEditorOpen(false);
    mobileBridge.haptic('success');
    toast.success(editingEvent ? t('calendar.eventUpdatedToast') : t('calendar.eventCreatedToast'));
  };

  const moveEventByDays = async (ev: CalendarEvent, deltaDays: number) => {
    const deltaMs = deltaDays * 86_400_000;
    await onSaveEvent({
      id: ev.id,
      title: ev.title,
      notes: ev.notes,
      location: ev.location,
      startAt: ev.startAt + deltaMs,
      endAt: ev.endAt + deltaMs,
      allDay: ev.allDay,
      hasEndTime: ev.hasEndTime,
      color: ev.color,
      kind: ev.kind,
      recurrence: ev.recurrence,
    });
    toast.success(t('calendar.eventMovedTomorrowToast'));
  };

  const buildEventActions = (ev: CalendarEvent): ActionSheetEntry[] => [
    {
      id: 'edit',
      label: t('calendar.actionEdit'),
      icon: <PencilSimple className="w-5 h-5" />,
      onSelect: () => openEditModal(ev),
    },
    {
      id: 'tomorrow',
      label: t('calendar.actionMoveTomorrow'),
      icon: <CalendarBlank className="w-5 h-5" />,
      onSelect: () => void moveEventByDays(ev, 1),
    },
    {
      id: 'delete',
      label: t('calendar.actionDelete'),
      icon: <Trash className="w-5 h-5" />,
      danger: true,
      onSelect: () => void onDeleteEvent(ev.id),
    },
  ];

  const headerDateRef = !isExpanded && compactCalendarMode === 'week' ? selectedDate : monthCursor;
  const monthTitle = capitalizeFirst(
    headerDateRef
      .toLocaleDateString(intlLocale, { month: 'long', year: 'numeric' })
      .replace(/\s*г\.?$/i, '')
  );
  const selectedDayLabel = capitalizeFirst(
    selectedDate.toLocaleDateString(intlLocale, {
      weekday: isExpanded ? 'short' : 'long',
      day: 'numeric',
      month: 'long',
    })
  );

  const renderDayCell = (day: Date, isWeekStrip: boolean) => {
    const iso = toDateIso(day);
    const inMonth = isWeekStrip || day.getMonth() === monthCursor.getMonth();
    const isToday = iso === todayIsoStr;
    const isSelected = iso === selectedDateIso;
    const evs = filteredEvents.filter((e) => eventOccursOnDay(e, day));
    const hasTasks = filteredTasks.some((t) => t.remindAt && sameCalendarDay(t.remindAt, day));

    return (
      <button
        key={iso}
        type="button"
        data-testid={`cal-day-${iso}`}
        onClick={() => {
          mobileBridge.haptic('light');
          if (!isExpanded && compactCalendarMode === 'month' && isSelected) {
            setCompactCalendarMode('week');
            return;
          }
          onSelectDateIso(iso);
          setMonthCursor(new Date(day.getFullYear(), day.getMonth(), 1));
        }}
        className={`k-tap flex flex-col items-center overflow-hidden ${
          isWide
            ? 'justify-start p-1.5 min-h-[76px]'
            : isExpanded
              ? 'justify-center py-2.5 h-[68px]'
              : isWeekStrip
                ? 'justify-center py-2 min-h-[54px]'
                : 'justify-center py-1 min-h-[38px]'
        } rounded-xl border transition-colors ${
          isSelected
            ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
            : isToday
              ? 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-strong)] text-[var(--k-accent)]'
              : 'bg-transparent border-transparent hover:bg-[var(--k-bg-surface-1)]'
        } ${!inMonth ? 'opacity-35' : ''}`}
      >
        <span
          className={`text-[13.5px] font-semibold leading-none ${
            isSelected || isToday ? 'text-[var(--k-accent)]' : 'text-[var(--k-ink-primary)]'
          }`}
        >
          {day.getDate()}
        </span>

        {isWide && evs.length > 0 ? (
          <div className="w-full mt-1.5 space-y-0.5">
            {evs.slice(0, 2).map((ev) => {
              const chipColor = ev.color || 'var(--k-accent)';
              return (
                <div
                  key={ev.id}
                  className="text-[10px] leading-tight px-1 py-0.5 rounded truncate text-left font-medium"
                  style={{
                    background: `color-mix(in srgb, ${chipColor} 16%, transparent)`,
                    color: chipColor,
                  }}
                >
                  {ev.title}
                </div>
              );
            })}
            {hasTasks ? (
              <div className="flex items-center gap-1 px-1 pt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--k-emerald)]" />
                <span className="text-[9.5px] text-[var(--k-emerald)]">{t('calendar.legendTasks')}</span>
              </div>
            ) : null}
          </div>
        ) : evs.length > 0 || hasTasks ? (
          <div className="flex items-center justify-center gap-1 mt-1.5 flex-wrap">
            {evs.slice(0, 3).map((ev) => (
              <span
                key={ev.id}
                className={`${isExpanded ? 'w-2 h-2' : 'w-1.5 h-1.5'} rounded-full`}
                style={{ background: ev.color || 'var(--k-accent)' }}
              />
            ))}
            {hasTasks ? (
              <span
                className={`${isExpanded ? 'w-2 h-2' : 'w-1.5 h-1.5'} rounded-full bg-[var(--k-emerald)]`}
              />
            ) : null}
          </div>
        ) : (
          <span className="h-[6px] mt-1.5" aria-hidden="true" />
        )}
      </button>
    );
  };

  const calendarGridSection = (
    <div
      data-testid="calendar-grid-pane"
      data-calendar-mode={isExpanded ? 'month' : compactCalendarMode}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (!t) return;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
        if (vw > 0 && (t.clientX < 24 || t.clientX > vw - 24)) {
          gridTouchStartRef.current = null;
          return;
        }
        gridTouchStartRef.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const start = gridTouchStartRef.current;
        gridTouchStartRef.current = null;
        const end = e.changedTouches[0];
        if (!start || !end) return;
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.45) {
          stepPeriod(dx < 0 ? 1 : -1);
        }
      }}
      onTouchCancel={() => {
        gridTouchStartRef.current = null;
      }}
      className={`flex flex-col ${
        isExpanded
          ? 'flex-1 min-w-0 h-full min-h-0 p-4 border-r border-[var(--k-border-hairline)]'
          : 'px-3.5 pt-2.5 pb-2 border-b border-[var(--k-border-hairline)] shrink-0 bg-[var(--k-bg-rail)]/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="text-[15.5px] font-bold text-[var(--k-ink-primary)] truncate">
            {monthTitle}
          </h2>
          {!isExpanded ? (
            <button
              type="button"
              data-testid="calendar-mode-toggle"
              aria-label={compactCalendarMode === 'week' ? t('calendar.expandMonthAria') : t('calendar.collapseWeekAria')}
              onClick={() => {
                mobileBridge.haptic('light');
                setCompactCalendarMode((m) => (m === 'week' ? 'month' : 'week'));
              }}
              className="k-tap inline-flex items-center gap-1 px-2 h-7 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-semibold shrink-0"
            >
              <span>{compactCalendarMode === 'week' ? t('calendar.modeWeek') : t('calendar.modeMonth')}</span>
              {compactCalendarMode === 'week' ? (
                <CaretDown weight="bold" className="w-3 h-3" />
              ) : (
                <CaretUp weight="bold" className="w-3 h-3" />
              )}
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              const now = new Date();
              setMonthCursor(new Date(now.getFullYear(), now.getMonth(), 1));
              onSelectDateIso(toDateIso(now));
            }}
            className="k-tap px-2.5 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-primary)]"
          >
            {t('tasks.duePresetToday')}
          </button>
          <button
            type="button"
            aria-label={compactCalendarMode === 'week' && !isExpanded ? t('calendar.prevWeekAria') : t('calendar.prevMonthAria')}
            onClick={() => stepPeriod(-1)}
            className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
          >
            <CaretLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            aria-label={compactCalendarMode === 'week' && !isExpanded ? t('calendar.nextWeekAria') : t('calendar.nextMonthAria')}
            onClick={() => stepPeriod(1)}
            className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
          >
            <CaretRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdays.map((w) => (
          <div
            key={w}
            className="text-center text-[11px] font-semibold text-[var(--k-ink-muted)] py-0.5"
          >
            {w}
          </div>
        ))}
      </div>

      {!isExpanded ? (
        <AnimatePresence mode="wait" initial={false}>
          {compactCalendarMode === 'week' ? (
            <motion.div
              key="week-strip"
              data-testid="calendar-week-strip"
              initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={prefersReduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.16 }}
              className="grid grid-cols-7 gap-1"
            >
              {weekDays.map((day) => renderDayCell(day, true))}
            </motion.div>
          ) : (
            <motion.div
              key="month-grid"
              data-testid="calendar-month-grid"
              initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              animate={prefersReduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="grid grid-cols-7 gap-1"
            >
              {monthDays.map((day) => renderDayCell(day, false))}
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        <div className={`grid grid-cols-7 gap-1.5 ${isWide ? 'flex-1 auto-rows-fr' : ''}`}>
          {monthDays.map((day) => renderDayCell(day, false))}
        </div>
      )}

      {isExpanded && !isWide ? (
        <div className="mt-4 pt-3 border-t border-[var(--k-border-hairline)] flex items-center gap-4 text-[11.5px] text-[var(--k-ink-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--k-accent)]" />
            {t('calendar.legendEvents')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--k-emerald)]" />
            {t('calendar.legendDueTasks')}
          </span>
        </div>
      ) : null}
    </div>
  );

  const dayAgendaSection = (
    <div
      data-testid="calendar-day-pane"
      className={`flex flex-col min-h-0 ${
        isExpanded
          ? 'w-[310px] lg:w-[360px] shrink-0 h-full bg-[var(--k-bg-rail)]'
          : 'flex-1'
      }`}
    >
      <div className="px-4 py-2.5 border-b border-[var(--k-border-hairline)] space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14.5px] font-bold text-[var(--k-ink-primary)] truncate">
              {selectedDayLabel}
            </div>
            <div className="text-[11.5px] text-[var(--k-ink-muted)]">
              {plural('event', dayEvents.length)} ·{' '}
              {plural('task', dayTasks.length)}
            </div>
          </div>
          <button
            type="button"
            data-testid="calendar-new-event-btn"
            onClick={openCreateModal}
            className="k-tap inline-flex items-center gap-1 px-3 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold shrink-0"
          >
            <Plus weight="bold" className="w-3.5 h-3.5" />
            {t('calendar.defaultEventTitle')}
          </button>
        </div>

        <form onSubmit={(e) => void handleQuickAdd(e)} className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Sparkle className="w-3.5 h-3.5 text-[var(--k-accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid="calendar-quick-input"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              placeholder={t('calendar.quickInputPlaceholder')}
              className="w-full h-10 pl-8 pr-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
          </div>
          <button
            type="submit"
            disabled={!quickInput.trim()}
            className="k-tap px-3 h-10 rounded-xl bg-[var(--k-bg-surface-2)] text-[12.5px] font-medium text-[var(--k-ink-primary)] disabled:opacity-40"
          >
            {t('common.ok')}
          </button>
        </form>
      </div>

      {/* Generous scrollable day list — auto-collapses Month to Week when scrolling on compact Fold! */}
      <div
        data-testid="calendar-agenda-scroll"
        onScroll={(e) => {
          if (!isExpanded && compactCalendarMode === 'month' && e.currentTarget.scrollTop > 18) {
            setCompactCalendarMode('week');
          }
        }}
        className="flex-1 min-h-0 k-scroll p-3.5 pb-28 space-y-2.5"
      >
        {dayEvents.length === 0 && dayTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 px-4">
            <CalendarBlank weight="duotone" className="w-8 h-8 text-[var(--k-ink-muted)] mb-2" />
            <div className="text-[14px] font-semibold text-[var(--k-ink-primary)]">
              {t('calendar.emptyDayTitle')}
            </div>
            <p className="text-[12.5px] text-[var(--k-ink-muted)] mt-1">
              {t('calendar.emptyDayHint')}
            </p>
          </div>
        ) : null}

        {dayEvents.map((ev) => (
          <SwipeableRow
            key={ev.id}
            onLongPress={() => setActionEvent(ev)}
            rightAction={{
              label: t('common.delete'),
              icon: <Trash weight="fill" className="w-4 h-4" />,
              bgClass: 'bg-[var(--k-danger)]',
              onTrigger: () => void onDeleteEvent(ev.id),
            }}
          >
            <div
              data-testid={`calendar-event-${ev.id}`}
              onClick={() => openEditModal(ev)}
              className="rounded-2xl k-m-card bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] cursor-pointer space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: ev.color || 'var(--k-accent)' }}
                  />
                  <span className="k-mono text-[11.5px] font-medium text-[var(--k-ink-secondary)] inline-flex items-center gap-1">
                    <Clock className="w-3 h-3 shrink-0" />
                    {ev.allDay
                      ? t('calendar.allDay')
                      : `${formatTime(ev.startAt, intlLocale)}–${formatTime(ev.endAt, intlLocale)}`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    mobileBridge.haptic('light');
                    setActionEvent(ev);
                  }}
                  aria-label={t('calendar.eventActionsAria')}
                  className="inline-flex items-center justify-center w-9 h-9 -mr-2 -my-1.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] shrink-0"
                >
                  <DotsThree weight="bold" className="w-4 h-4" />
                </button>
              </div>

              <div className="text-[14.5px] font-semibold leading-snug text-[var(--k-ink-primary)] line-clamp-2">
                {ev.title}
              </div>

              {ev.location ? (
                <div className="text-[12px] text-[var(--k-ink-secondary)] inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                  {ev.location}
                </div>
              ) : null}

              {ev.notes ? (
                <p className="text-[12.5px] text-[var(--k-ink-secondary)] line-clamp-2">
                  {ev.notes}
                </p>
              ) : null}

              {ev.recurrence && ev.recurrence !== 'none' ? (
                <div className="text-[11px] text-[var(--k-accent)] inline-flex items-center gap-1">
                  <Repeat className="w-3 h-3" />
                  {t(RECURRENCE_LABEL_KEYS[ev.recurrence])}
                </div>
              ) : null}
            </div>
          </SwipeableRow>
        ))}

        {dayTasks.length > 0 ? (
          <div className="space-y-2 pt-2">
            <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] px-1">
              {t('calendar.dayTasksHeading')}
            </div>
            {dayTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-start gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
              >
                <button
                  type="button"
                  onClick={() => void onToggleTask(task)}
                  aria-label={task.done ? t('tasks.actionUncheck') : t('tasks.actionDone')}
                  className="inline-flex items-center justify-center w-9 h-9 -ml-2 -my-1.5 shrink-0"
                >
                  <span
                    className={`w-5 h-5 rounded-md border flex items-center justify-center transition-[background-color,border-color] duration-[80ms] ease-out ${
                      task.done
                        ? 'bg-[var(--k-emerald)] border-[var(--k-emerald)] text-white'
                        : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    {task.done ? <Check weight="bold" className="w-3 h-3" /> : null}
                  </span>
                </button>
                <span
                  className={`text-[13.5px] leading-snug flex-1 min-w-0 line-clamp-2 ${
                    task.done
                      ? 'line-through text-[var(--k-ink-muted)]'
                      : 'text-[var(--k-ink-primary)]'
                  }`}
                >
                  {task.text}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      data-testid="mobile-calendar-view"
      className={`flex h-full min-h-0 ${isExpanded ? 'flex-row' : 'flex-col'}`}
    >
      {calendarGridSection}
      {dayAgendaSection}

      <BottomSheet
        open={editorOpen}
        title={editingEvent ? t('calendar.editEventSheetTitle') : t('calendar.newEventSheetTitle')}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setEditorOpen(false)}
        headerRight={
          editingEvent ? (
            <button
              type="button"
              onClick={async () => {
                await onDeleteEvent(editingEvent.id);
                setEditorOpen(false);
              }}
              aria-label={t('calendar.actionDelete')}
              className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-danger)]"
            >
              <Trash className="w-4 h-4" />
            </button>
          ) : null
        }
      >
        <form onSubmit={(e) => void handleSaveForm(e)} className="p-4 space-y-3.5">
          <input
            type="text"
            required
            data-testid="calendar-event-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('calendar.eventTitlePlaceholder')}
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[15px] font-medium text-[var(--k-ink-primary)]"
          />

          <div className="grid grid-cols-2 gap-2 items-end">
            <label className="flex flex-col gap-1 text-[11.5px] text-[var(--k-ink-muted)]">
              {t('calendar.fieldDate')}
              <input
                type="date"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="h-10 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] text-[var(--k-ink-primary)]"
              />
            </label>

            <div className="flex items-center justify-between px-3 h-10 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13px] text-[var(--k-ink-primary)]">
              <span>{t('calendar.allDay')}</span>
              <Switch.Root
                checked={allDay}
                onCheckedChange={(checked) => {
                  mobileBridge.haptic('light');
                  setAllDay(checked);
                }}
                aria-label={t('calendar.allDay')}
                className="k-switch-root"
              >
                <Switch.Thumb className="k-switch-thumb" />
              </Switch.Root>
            </div>
          </div>

          {!allDay ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11.5px] text-[var(--k-ink-muted)]">
                  {t('calendar.fieldStart')}
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => {
                      setStartTime(e.target.value);
                      setEndTime(addMinutesToTimeStr(e.target.value, 60));
                    }}
                    className="h-10 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] text-[var(--k-ink-primary)]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11.5px] text-[var(--k-ink-muted)]">
                  {t('calendar.fieldEnd')}
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="h-10 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] text-[var(--k-ink-primary)]"
                  />
                </label>
              </div>

              {/* 1-tap Time & Duration Presets */}
              <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar">
                {TIME_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setStartTime(preset);
                      setEndTime(addMinutesToTimeStr(preset, 60));
                    }}
                    className={`k-tap k-mono px-2.5 h-7 rounded-lg text-[11.5px] font-medium shrink-0 border ${
                      startTime === preset
                        ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                        : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
                {([30, 60, 120] as const).map((dur) => (
                  <button
                    key={dur}
                    type="button"
                    onClick={() => setEndTime(addMinutesToTimeStr(startTime, dur))}
                    className="k-tap px-2 h-7 rounded-lg text-[11px] font-medium shrink-0 bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[var(--k-ink-muted)]"
                  >
                    +{dur === 30 ? t('calendar.dur30m') : dur === 60 ? t('calendar.dur1h') : t('calendar.dur2h')}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Recurrence Chips (NO ugly native <select>!) */}
          <div className="space-y-1.5">
            <div className="text-[11.5px] text-[var(--k-ink-muted)]">{t('calendar.fieldRepeat')}</div>
            <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar pb-0.5">
              {RECURRENCE_OPTION_KEYS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setRecurrence(opt.id)}
                  className={`k-tap px-3 h-8 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                    recurrence === opt.id
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Color Swatches */}
          <div className="space-y-1.5">
            <div className="text-[11.5px] text-[var(--k-ink-muted)]">{t('calendar.fieldColor')}</div>
            <div className="flex items-center gap-2">
              {EVENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={`w-7 h-7 rounded-full flex items-center justify-center transition-transform ${
                    color === c
                      ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                      : 'opacity-80'
                  }`}
                >
                  {color === c ? <Check weight="bold" className="w-3.5 h-3.5 text-white" /> : null}
                </button>
              ))}
            </div>
          </div>

          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={t('calendar.locationPlaceholder')}
            className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
          />

          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('calendar.notesPlaceholder')}
            className="w-full p-3.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[13.5px] text-[var(--k-ink-primary)] resize-none"
          />

          <button
            type="submit"
            className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold"
          >
            {editingEvent ? t('common.saveChanges') : t('calendar.addToCalendarBtn')}
          </button>
        </form>
      </BottomSheet>

      <ItemActionSheet
        open={Boolean(actionEvent)}
        title={actionEvent?.title || t('calendar.defaultEventTitle')}
        actions={actionEvent ? buildEventActions(actionEvent) : []}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setActionEvent(null)}
      />
    </div>
  );
};
