export type CalendarRecurrenceKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface CalendarIntervalInput {
  id: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
}

export interface CalendarLayoutSlot {
  id: string;
  startMin: number;
  endMin: number;
  columnIndex: number;
  totalColumns: number;
}

export interface LayoutOverlappingOptions {
  dayStartMs?: number;
  minDurationMinutes?: number;
  maxMinutes?: number;
}

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const WEEKDAYS_SET = 'FR,MO,TH,TU,WE';

/**
 * Splits calendar entries into all-day items and timed items while preserving input order.
 */
export function partitionAllDayEntries<T extends { allDay?: boolean }>(
  entries: readonly T[],
): { allDay: T[]; timed: T[] } {
  const allDay: T[] = [];
  const timed: T[] = [];
  for (const entry of entries) {
    if (entry.allDay) {
      allDay.push(entry);
    } else {
      timed.push(entry);
    }
  }
  return { allDay, timed };
}

function resolveDayStartMs(events: readonly CalendarIntervalInput[]): number {
  let earliest = events[0]?.startAt ?? 0;
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.startAt < earliest) {
      earliest = events[i]!.startAt;
    }
  }
  const base = new Date(earliest);
  base.setHours(0, 0, 0, 0);
  return base.getTime();
}

/**
 * Sweep-line connected-component interval coloring for timed day events.
 * Adjacent back-to-back events (endMin === next.startMin) do not overlap and stay full width.
 */
export function layoutOverlappingEvents(
  events: readonly CalendarIntervalInput[],
  options?: LayoutOverlappingOptions,
): CalendarLayoutSlot[] {
  const timedEvents = events.filter((ev) => !ev.allDay);
  if (timedEvents.length === 0) return [];

  const maxMinutes = options?.maxMinutes ?? MINUTES_PER_DAY;
  const minDuration = Math.max(1, options?.minDurationMinutes ?? 15);
  const dayStartMs = options?.dayStartMs ?? resolveDayStartMs(timedEvents);

  const normalized = timedEvents.map((ev) => {
    const rawStart = Math.floor((ev.startAt - dayStartMs) / MS_PER_MINUTE);
    const startMin = Math.max(0, Math.min(maxMinutes - minDuration, rawStart));
    const rawEnd = Math.ceil((ev.endAt - dayStartMs) / MS_PER_MINUTE);
    const endMin = Math.min(maxMinutes, Math.max(startMin + minDuration, rawEnd));
    return { id: ev.id, startMin, endMin };
  });

  normalized.sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    const durDiff = b.endMin - b.startMin - (a.endMin - a.startMin);
    if (durDiff !== 0) return durDiff;
    return a.id.localeCompare(b.id);
  });

  const slots: CalendarLayoutSlot[] = [];
  let clusterStartIdx = 0;

  while (clusterStartIdx < normalized.length) {
    let clusterMaxEnd = normalized[clusterStartIdx]!.endMin;
    let clusterEndIdx = clusterStartIdx + 1;

    while (clusterEndIdx < normalized.length && normalized[clusterEndIdx]!.startMin < clusterMaxEnd) {
      if (normalized[clusterEndIdx]!.endMin > clusterMaxEnd) {
        clusterMaxEnd = normalized[clusterEndIdx]!.endMin;
      }
      clusterEndIdx++;
    }

    const colEndMinutes: number[] = [];
    const clusterPlacements: Array<{
      id: string;
      startMin: number;
      endMin: number;
      columnIndex: number;
    }> = [];

    for (let i = clusterStartIdx; i < clusterEndIdx; i++) {
      const item = normalized[i]!;
      let placedCol = -1;
      for (let col = 0; col < colEndMinutes.length; col++) {
        if (colEndMinutes[col]! <= item.startMin) {
          placedCol = col;
          colEndMinutes[col] = item.endMin;
          break;
        }
      }
      if (placedCol === -1) {
        placedCol = colEndMinutes.length;
        colEndMinutes.push(item.endMin);
      }
      clusterPlacements.push({
        id: item.id,
        startMin: item.startMin,
        endMin: item.endMin,
        columnIndex: placedCol,
      });
    }

    const totalColumns = Math.max(1, colEndMinutes.length);
    for (const placed of clusterPlacements) {
      slots.push({
        id: placed.id,
        startMin: placed.startMin,
        endMin: placed.endMin,
        columnIndex: placed.columnIndex,
        totalColumns,
      });
    }

    clusterStartIdx = clusterEndIdx;
  }

  return slots;
}

/**
 * Converts Kapsula recurrence enum to Google Calendar RFC 5545 RRULE array.
 */
export function toGoogleRecurrenceRrule(
  recurrence: CalendarRecurrenceKind | string | undefined | null,
): string[] | undefined {
  switch (recurrence) {
    case 'daily':
      return ['RRULE:FREQ=DAILY'];
    case 'weekdays':
      return ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'];
    case 'weekly':
      return ['RRULE:FREQ=WEEKLY'];
    case 'monthly':
      return ['RRULE:FREQ=MONTHLY'];
    default:
      return undefined;
  }
}

/**
 * Maps Google Calendar RFC 5545 RRULE strings to Kapsula recurrence enum.
 */
export function fromGoogleRecurrenceRrule(
  rrules: readonly string[] | undefined | null,
): CalendarRecurrenceKind {
  if (!rrules || rrules.length === 0) return 'none';

  const ruleLine = rrules.find((line) => /^RRULE:/i.test(line.trim()));
  if (!ruleLine) return 'none';

  const body = ruleLine.trim().replace(/^RRULE:/i, '');
  const parts = new Map<string, string>();
  for (const segment of body.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = segment.slice(0, eqIdx).trim().toUpperCase();
    const val = segment.slice(eqIdx + 1).trim().toUpperCase();
    if (key && val) parts.set(key, val);
  }

  const intervalRaw = parts.get('INTERVAL');
  const interval = intervalRaw ? Number.parseInt(intervalRaw, 10) : 1;
  if (Number.isFinite(interval) && interval > 1) return 'none';

  const freq = parts.get('FREQ');
  if (freq === 'DAILY') {
    return 'daily';
  }
  if (freq === 'WEEKLY') {
    const byDay = parts.get('BYDAY');
    if (byDay) {
      const normalizedDays = byDay
        .split(',')
        .map((d) => d.trim().replace(/^[+-]?\d+/, ''))
        .filter(Boolean)
        .sort()
        .join(',');
      if (normalizedDays === WEEKDAYS_SET) {
        return 'weekdays';
      }
    }
    return 'weekly';
  }
  if (freq === 'MONTHLY') {
    return 'monthly';
  }

  return 'none';
}
