import type { CalendarEvent } from './types';

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function isSameLocalCalendarDay(aMsOrDate: number | Date, bDate: Date): boolean {
  const a = aMsOrDate instanceof Date ? aMsOrDate : new Date(aMsOrDate);
  return (
    a.getFullYear() === bDate.getFullYear() &&
    a.getMonth() === bDate.getMonth() &&
    a.getDate() === bDate.getDate()
  );
}

export function buildDstSafeAllDayEnd(startDate: Date): number {
  return new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate(),
    23,
    59,
    59,
    0
  ).getTime();
}

export function formatLocalDateKey(tsOrDate: number | Date): string {
  const d = tsOrDate instanceof Date ? tsOrDate : new Date(tsOrDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function matchesRecurrenceOnLocalDay(ev: CalendarEvent, day: Date): boolean {
  if (ev.deletedAt) return false;
  const origin = new Date(ev.startAt);
  const targetStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const targetEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);

  const rec = ev.recurrence ?? 'none';
  if (rec === 'none') {
    if (ev.endAt > ev.startAt) {
      return ev.startAt < targetEnd.getTime() && ev.endAt > targetStart.getTime();
    }
    return isSameLocalCalendarDay(origin, targetStart);
  }

  const originStart = new Date(
    origin.getFullYear(),
    origin.getMonth(),
    origin.getDate(),
    0,
    0,
    0,
    0
  );
  if (targetStart.getTime() < originStart.getTime()) return false;

  if (rec === 'daily') return true;
  if (rec === 'weekdays') {
    const dow = targetStart.getDay();
    return dow >= 1 && dow <= 5;
  }
  if (rec === 'weekly') {
    return targetStart.getDay() === originStart.getDay();
  }
  if (rec === 'monthly') {
    const targetDom = Math.min(origin.getDate(), daysInMonth(targetStart.getFullYear(), targetStart.getMonth()));
    return targetStart.getDate() === targetDom;
  }
  return false;
}

export interface ExpandedRecurrenceOccurrence {
  occurrenceId: string;
  startAt: number;
  endAt: number;
  isRecurringInstance: boolean;
  sourceEvent: CalendarEvent;
}

const MAX_RECURRENCE_SCAN_DAYS = 2000;

export function expandCalendarEventOccurrences(
  events: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number
): ExpandedRecurrenceOccurrence[] {
  const out: ExpandedRecurrenceOccurrence[] = [];

  for (const ev of events) {
    if (ev.deletedAt) continue;
    const rec = ev.recurrence ?? 'none';
    if (rec === 'none') {
      if (ev.endAt < windowStartMs || ev.startAt > windowEndMs) continue;
      out.push({
        occurrenceId: ev.id,
        startAt: ev.startAt,
        endAt: ev.endAt,
        isRecurringInstance: false,
        sourceEvent: ev,
      });
      continue;
    }

    const duration = Math.max(0, ev.endAt - ev.startAt);
    const origin = new Date(ev.startAt);
    const origHours = origin.getHours();
    const origMins = origin.getMinutes();
    const originMidnight = new Date(
      origin.getFullYear(),
      origin.getMonth(),
      origin.getDate(),
      0,
      0,
      0,
      0
    );
    const winStartDate = new Date(windowStartMs);
    const winStartMidnight = new Date(
      winStartDate.getFullYear(),
      winStartDate.getMonth(),
      winStartDate.getDate(),
      0,
      0,
      0,
      0
    );
    const winEndDate = new Date(windowEndMs);
    const winEndMidnight = new Date(
      winEndDate.getFullYear(),
      winEndDate.getMonth(),
      winEndDate.getDate(),
      0,
      0,
      0,
      0
    );

    const cursor = new Date(Math.max(winStartMidnight.getTime(), originMidnight.getTime()));
    let guard = 0;

    while (cursor.getTime() <= winEndMidnight.getTime() && guard < MAX_RECURRENCE_SCAN_DAYS) {
      guard += 1;
      if (matchesRecurrenceOnLocalDay(ev, cursor)) {
        const instStart = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          cursor.getDate(),
          origHours,
          origMins,
          0,
          0
        );
        const startMs = instStart.getTime();
        const isOrigin = isSameLocalCalendarDay(cursor, origin);
        out.push({
          occurrenceId: isOrigin ? ev.id : `${ev.id}::rec::${formatLocalDateKey(startMs)}`,
          startAt: startMs,
          endAt: ev.allDay ? buildDstSafeAllDayEnd(instStart) : startMs + duration,
          isRecurringInstance: !isOrigin,
          sourceEvent: ev,
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return out;
}
