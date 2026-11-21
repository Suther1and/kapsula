import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CalendarBlank,
  Check,
  Clock,
  Copy,
  LinkSimple,
  ListChecks,
  MapPin,
  NotePencil,
  Paperclip,
  PencilSimple,
  Plus,
  Sparkle,
  Trash,
  VideoCamera,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type {
  CalendarChecklistItem,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventKind,
  CalendarRecurrence,
  VaultItem,
} from '@shared/types';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { getDnaHumanLabel } from '../../lib/format';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { PopoverSurface } from '../ui/PopoverSurface';

type DurationPreset = 'none' | 15 | 30 | 45 | 60 | 90 | 120 | 'custom';

export interface CalendarEventSheetSeed {
  title?: string;
  dateStr?: string;
  startTime?: string;
  allDay?: boolean;
  hasEndTime?: boolean;
  durationMin?: number;
  location?: string;
  notes?: string;
  kind?: CalendarEventKind;
  recurrence?: CalendarRecurrence;
}

interface CalendarEventSheetProps {
  open: boolean;
  event: CalendarEvent | null;
  seed?: CalendarEventSheetSeed | null;
  vaultItems: VaultItem[];
  onClose: () => void;
  onSave: (input: CalendarEventInput) => Promise<void>;
  onQuickPatchEvent?: (input: CalendarEventInput) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onToggleDone?: (event: CalendarEvent) => Promise<void>;
  onOpenVaultItem?: (id: string) => void;
}

const EVENT_COLORS = ['#E86A33', '#10B981', '#3B82F6', '#A855F7', '#F59E0B', '#EF4444'];

const DURATION_OPTIONS: Array<{ value: DurationPreset; label: string }> = [
  { value: 'none', label: 'Без конца' },
  { value: 15, label: '15 мин' },
  { value: 30, label: '30 мин' },
  { value: 45, label: '45 мин' },
  { value: 60, label: '1 ч' },
  { value: 90, label: '1,5 ч' },
  { value: 120, label: '2 ч' },
  { value: 'custom', label: 'Своё' },
];

const RECURRENCE_OPTIONS: Array<{ value: CalendarRecurrence; label: string }> = [
  { value: 'none', label: 'Не повторять' },
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekdays', label: 'По будням' },
  { value: 'weekly', label: 'Каждую неделю' },
  { value: 'monthly', label: 'Каждый месяц' },
];

const KIND_LABELS: Record<CalendarEventKind, string> = {
  event: 'Событие',
  reminder: 'Напоминание',
  task: 'Дедлайн',
};

function toDateInputValue(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toTimeInputValue(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function resolveDurationPreset(event: CalendarEvent): {
  preset: DurationPreset;
  customEndTime: string;
} {
  if (event.hasEndTime === false) {
    return { preset: 'none', customEndTime: toTimeInputValue(event.startAt + 3_600_000) };
  }
  const diffMin = Math.round((event.endAt - event.startAt) / 60_000);
  if (diffMin <= 0) {
    return { preset: 'none', customEndTime: toTimeInputValue(event.startAt + 3_600_000) };
  }
  if (([15, 30, 45, 60, 90, 120] as const).includes(diffMin as 15 | 30 | 45 | 60 | 90 | 120)) {
    return {
      preset: diffMin as 15 | 30 | 45 | 60 | 90 | 120,
      customEndTime: toTimeInputValue(event.endAt),
    };
  }
  return { preset: 'custom', customEndTime: toTimeInputValue(event.endAt) };
}

function computeEndFromTime(dateStr: string, startMs: number, endTimeStr: string): number {
  const [eh = 12, em = 0] = endTimeStr.split(':').map(Number);
  const base = new Date(`${dateStr}T00:00:00`);
  if (!Number.isFinite(base.getTime())) return startMs + 3_600_000;
  base.setHours(Number.isFinite(eh) ? eh : 12, Number.isFinite(em) ? em : 0, 0, 0);
  if (base.getTime() <= startMs) {
    return startMs + 1_800_000;
  }
  return base.getTime();
}

function formatReadableEventWhen(ev: CalendarEvent): { dateLabel: string; timeLabel: string } {
  const d = new Date(ev.startAt);
  const rawDate = d.toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const dateLabel = rawDate.charAt(0).toUpperCase() + rawDate.slice(1);
  if (ev.allDay) {
    return { dateLabel, timeLabel: 'Весь день' };
  }
  const start = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (!ev.hasEndTime) {
    return { dateLabel, timeLabel: start };
  }
  const end = new Date(ev.endAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return { dateLabel, timeLabel: `${start} – ${end}` };
}

export const CalendarEventSheet: React.FC<CalendarEventSheetProps> = ({
  open,
  event,
  seed,
  vaultItems,
  onClose,
  onSave,
  onQuickPatchEvent,
  onDelete,
  onToggleDone,
  onOpenVaultItem,
}) => {
  const prefersReduced = useReducedMotion();

  // Existing events open in View Mode by default; new events open directly in Edit Mode
  const [mode, setMode] = useState<'view' | 'edit'>(event ? 'view' : 'edit');

  const [smartText, setSmartText] = useState('');
  const [title, setTitle] = useState('');
  const [dateStr, setDateStr] = useState(() => toDateInputValue(Date.now()));
  const [startTime, setStartTime] = useState('10:00');
  const [allDay, setAllDay] = useState(false);
  const [durationPreset, setDurationPreset] = useState<DurationPreset>('none');
  const [customEndTime, setCustomEndTime] = useState('11:00');
  const [kind, setKind] = useState<CalendarEventKind>('event');
  const [recurrence, setRecurrence] = useState<CalendarRecurrence>('none');
  const [color, setColor] = useState('#E86A33');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [checklist, setChecklist] = useState<CalendarChecklistItem[]>([]);
  const [newChecklistText, setNewChecklistText] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [attachQuery, setAttachQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSmartText('');
    setNewChecklistText('');
    setAttachQuery('');
    setAttachPickerOpen(false);

    if (event) {
      setMode('view');
      setTitle(event.title);
      setDateStr(toDateInputValue(event.startAt));
      setStartTime(toTimeInputValue(event.startAt));
      setAllDay(event.allDay);
      const { preset, customEndTime: resolvedEnd } = resolveDurationPreset(event);
      setDurationPreset(preset);
      setCustomEndTime(resolvedEnd);
      setKind(event.kind);
      setRecurrence(event.recurrence ?? 'none');
      setColor(event.color || '#E86A33');
      setLocation(event.location || '');
      setNotes(event.notes || '');
      setChecklist(Array.isArray(event.checklist) ? event.checklist : []);
      const ids = Array.isArray(event.attachments) ? [...event.attachments] : [];
      if (event.linkedItemId && !ids.includes(event.linkedItemId)) {
        ids.unshift(event.linkedItemId);
      }
      setAttachments(ids);
      return;
    }

    setMode('edit');
    const baseDate = seed?.dateStr || toDateInputValue(Date.now());
    setTitle(seed?.title || '');
    setDateStr(baseDate);
    setStartTime(seed?.startTime || '10:00');
    setAllDay(Boolean(seed?.allDay));
    if (seed?.hasEndTime && seed.durationMin) {
      const m = seed.durationMin;
      if (([15, 30, 45, 60, 90, 120] as const).includes(m as 15 | 30 | 45 | 60 | 90 | 120)) {
        setDurationPreset(m as 15 | 30 | 45 | 60 | 90 | 120);
      } else {
        setDurationPreset('custom');
      }
      const [h = 10, min = 0] = (seed.startTime || '10:00').split(':').map(Number);
      const tmp = new Date(`${baseDate}T00:00:00`);
      tmp.setHours(Number.isFinite(h) ? h : 10, Number.isFinite(min) ? min : 0, 0, 0);
      setCustomEndTime(toTimeInputValue(tmp.getTime() + m * 60_000));
    } else {
      setDurationPreset('none');
      setCustomEndTime('11:00');
    }
    setKind(seed?.kind || 'event');
    setRecurrence(seed?.recurrence || 'none');
    setColor('#E86A33');
    setLocation(seed?.location || '');
    setNotes(seed?.notes || '');
    setChecklist([]);
    setAttachments([]);
  }, [open, event, seed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (attachPickerOpen) {
          setAttachPickerOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, attachPickerOpen, onClose]);

  const parsedSmart = useMemo(() => {
    const clean = smartText.trim();
    if (clean.length < 4) return null;
    const res = parseRussianEvent(clean);
    return res?.isEventIntent ? res : null;
  }, [smartText]);

  const applySmartParse = (textToParse: string) => {
    const parsed = parseRussianEvent(textToParse.trim());
    if (!parsed) return false;
    setTitle(parsed.title || title || 'Событие');
    setDateStr(toDateInputValue(parsed.startAt));
    setAllDay(parsed.allDay);
    if (!parsed.allDay) {
      setStartTime(toTimeInputValue(parsed.startAt));
    }
    if (parsed.hasEndTime) {
      const diffMin = Math.round((parsed.endAt - parsed.startAt) / 60_000);
      if (([15, 30, 45, 60, 90, 120] as const).includes(diffMin as 15 | 30 | 45 | 60 | 90 | 120)) {
        setDurationPreset(diffMin as 15 | 30 | 45 | 60 | 90 | 120);
      } else {
        setDurationPreset('custom');
        setCustomEndTime(toTimeInputValue(parsed.endAt));
      }
    } else {
      setDurationPreset('none');
    }
    if (parsed.location) {
      setLocation(parsed.location);
    }
    return true;
  };

  const handleAddChecklistItem = () => {
    const clean = newChecklistText.trim();
    if (!clean) return;
    setChecklist((prev) => [
      ...prev,
      { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: clean, done: false },
    ]);
    setNewChecklistText('');
  };

  const handleToggleChecklistInView = async (entryId: string, nextDone: boolean) => {
    const prevList = checklist;
    const nextList = checklist.map((c) => (c.id === entryId ? { ...c, done: nextDone } : c));
    setChecklist(nextList);
    if (event) {
      const payload: CalendarEventInput = {
        id: event.id,
        title: event.title,
        notes: event.notes,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        allDay: event.allDay,
        hasEndTime: event.hasEndTime,
        kind: event.kind,
        recurrence: event.recurrence ?? 'none',
        color: event.color,
        linkedItemId: event.linkedItemId,
        checklist: nextList,
        attachments: event.attachments,
        isDone: event.isDone,
        externalSource: event.externalSource,
        externalId: event.externalId,
      };
      try {
        if (onQuickPatchEvent) {
          await onQuickPatchEvent(payload);
        } else {
          await onSave(payload);
        }
      } catch {
        setChecklist(prevList);
      }
    }
  };

  const itemMap = useMemo(() => {
    const map = new Map<string, VaultItem>();
    for (const i of vaultItems) map.set(i.id, i);
    return map;
  }, [vaultItems]);

  const attachableItems = useMemo(() => {
    const attachedSet = new Set(attachments);
    return vaultItems
      .filter((i) => i.dna !== 'secret' && !attachedSet.has(i.id))
      .filter((i) => {
        if (!attachQuery.trim()) return true;
        return matchesBilingualHaystack(
          [i.title, i.summary, i.body, i.url, ...i.tags].filter(Boolean).join(' '),
          attachQuery
        );
      })
      .slice(0, 16);
  }, [vaultItems, attachments, attachQuery]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || saving) return;

    const baseDate = new Date(`${dateStr}T00:00:00`);
    const validBase = Number.isFinite(baseDate.getTime()) ? baseDate : new Date();
    validBase.setHours(0, 0, 0, 0);

    let startAt = validBase.getTime();
    let endAt = startAt + 86_400_000 - 1000;
    let hasEndTime = false;

    if (!allDay) {
      const [sh = 10, sm = 0] = startTime.split(':').map(Number);
      validBase.setHours(Number.isFinite(sh) ? sh : 10, Number.isFinite(sm) ? sm : 0, 0, 0);
      startAt = validBase.getTime();
      if (durationPreset === 'none') {
        hasEndTime = false;
        endAt = startAt + 1_800_000;
      } else if (durationPreset === 'custom') {
        hasEndTime = true;
        endAt = computeEndFromTime(dateStr, startAt, customEndTime);
      } else {
        hasEndTime = true;
        endAt = startAt + durationPreset * 60_000;
      }
    }

    setSaving(true);
    try {
      await onSave({
        id: event?.id,
        title: title.trim(),
        notes: notes.trim(),
        location: location.trim(),
        startAt,
        endAt,
        allDay,
        hasEndTime,
        kind,
        recurrence,
        color,
        linkedItemId: attachments[0] ?? null,
        checklist,
        attachments,
        isDone: event?.isDone ?? false,
        externalSource: event?.externalSource ?? null,
        externalId: event?.externalId ?? null,
      });
      if (event) {
        setMode('view');
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;

  const isLocationUrl = /^https?:\/\/\S+$/i.test(location.trim());
  const recurrenceLabel =
    RECURRENCE_OPTIONS.find((r) => r.value === (event?.recurrence ?? recurrence))?.label ?? '';
  const readableWhen = event ? formatReadableEventWhen(event) : null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div
          key="calendar-event-sheet-backdrop"
          className="fixed inset-0 z-[95] flex justify-end overflow-hidden"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            onClick={onClose}
            className="fixed inset-0 bg-[var(--k-bg-backdrop)] backdrop-blur-[2px]"
          />

          <motion.div
            key="calendar-event-sheet-panel"
            data-testid="calendar-event-sheet"
            initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(44px, 0, 0)' }}
            animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
            exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(38px, 0, 0)' }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="relative z-10 w-full max-w-[490px] h-full bg-[var(--k-bg-surface-1)] border-l border-[var(--k-border-strong)] shadow-[var(--k-shadow-sheet)] flex flex-col overflow-hidden text-[var(--k-ink-primary)]"
          >
            {/* Clean Top Bar */}
            <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-b border-[var(--k-border-hairline)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-[13px] font-medium text-[var(--k-ink-secondary)] truncate">
                  {event
                    ? mode === 'view'
                      ? KIND_LABELS[event.kind] ?? 'Событие'
                      : 'Редактирование'
                    : 'Новое событие'}
                </span>
                {event?.externalSource === 'vault_auto' ? (
                  <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium shrink-0">
                    Из заметки
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {event && onDelete ? (
                  <button
                    type="button"
                    data-testid="calendar-event-delete-btn"
                    onClick={() => void onDelete(event.id)}
                    aria-label="Удалить событие"
                    className="k-interactive inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer"
                  >
                    <Trash className="w-4 h-4" />
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Закрыть карточку"
                  className="k-interactive inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {event && mode === 'view' ? (
                /* ===================== CLEAN VIEW MODE ===================== */
                <motion.div
                  key="cal-view-mode"
                  data-testid="calendar-event-view-mode"
                  initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                  animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                  exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, -4px, 0)' }}
                  transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                  className="flex-1 min-h-0 flex flex-col"
                >
                  <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
                    {/* Hero Title + Status */}
                    <div className="space-y-2.5">
                      <h2
                        className={`m-0 text-[21px] font-semibold leading-snug tracking-[-0.02em] k-selectable ${
                          event.isDone ? 'line-through text-[var(--k-ink-muted)]' : 'text-[var(--k-ink-primary)]'
                        }`}
                      >
                        {event.title}
                      </h2>

                      {/* Clean Date & Time Block */}
                      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--k-ink-secondary)]">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] font-medium text-[var(--k-ink-primary)]">
                          <CalendarBlank className="w-3.5 h-3.5" style={{ color }} />
                          <span>{readableWhen?.dateLabel}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] k-mono text-[12.5px] text-[var(--k-ink-primary)]">
                          <Clock className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                          <span>{readableWhen?.timeLabel}</span>
                        </span>
                        {event.recurrence && event.recurrence !== 'none' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-medium">
                            <ArrowsClockwise className="w-3 h-3" />
                            <span>{recurrenceLabel}</span>
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Prominent Call / Location Action */}
                    {location.trim() ? (
                      isLocationUrl ? (
                        <div className="rounded-xl border border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)]/55 p-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="w-8 h-8 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] flex items-center justify-center shrink-0">
                              <VideoCamera weight="fill" className="w-4 h-4" />
                            </span>
                            <div className="min-w-0">
                              <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                                Ссылка на встречу
                              </div>
                              <div className="text-[11.5px] text-[var(--k-ink-secondary)] truncate">
                                {location.trim()}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              title="Скопировать ссылку"
                              onClick={() => {
                                void window.kapsula.copyText(location.trim());
                                toast.success('Ссылка скопирована');
                              }}
                              className="k-interactive w-8 h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center justify-center cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void window.kapsula.openExternal(location.trim())}
                              className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium inline-flex items-center gap-1 cursor-pointer"
                            >
                              <span>Открыть</span>
                              <ArrowSquareOut className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/65 px-3.5 py-2.5 flex items-center gap-2.5 text-[13px] text-[var(--k-ink-primary)]">
                          <MapPin className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                          <span className="k-selectable">{location.trim()}</span>
                        </div>
                      )
                    ) : null}

                    {/* Interactive Checklist right inside View Mode */}
                    {checklist.length > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                          <span className="inline-flex items-center gap-1.5">
                            <ListChecks className="w-3.5 h-3.5" />
                            Подготовка
                          </span>
                          <span className="k-mono">
                            {checklist.filter((c) => c.done).length}/{checklist.length}
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {checklist.map((entry) => (
                            <div
                              key={entry.id}
                              onClick={() => void handleToggleChecklistInView(entry.id, !entry.done)}
                              className="flex items-center gap-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/55 hover:border-[var(--k-border-strong)] px-3 py-2 cursor-pointer transition-colors"
                            >
                              <AnimatedCheckbox
                                size="sm"
                                checked={entry.done}
                                onChange={(next) => void handleToggleChecklistInView(entry.id, next)}
                              />
                              <span
                                className={`flex-1 text-[13px] ${
                                  entry.done
                                    ? 'line-through text-[var(--k-ink-muted)]'
                                    : 'text-[var(--k-ink-primary)]'
                                }`}
                              >
                                {entry.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {/* Readable Notes */}
                    {notes.trim() ? (
                      <div className="space-y-1.5">
                        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                          Детали
                        </div>
                        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/45 p-3.5 text-[13.5px] leading-relaxed text-[var(--k-ink-primary)] whitespace-pre-wrap k-selectable">
                          {notes.trim()}
                        </div>
                      </div>
                    ) : null}

                    {/* Linked Materials */}
                    {attachments.length > 0 ? (
                      <div className="space-y-2">
                        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] inline-flex items-center gap-1.5">
                          <Paperclip className="w-3.5 h-3.5" />
                          Связанные записи
                        </div>
                        <div className="space-y-1.5">
                          {attachments.map((attId) => {
                            const found = itemMap.get(attId);
                            if (!found) return null;
                            return (
                              <button
                                key={attId}
                                type="button"
                                onClick={() => onOpenVaultItem?.(found.id)}
                                className="k-interactive w-full text-left rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 hover:border-[var(--k-accent)]/50 px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer"
                              >
                                <div className="min-w-0">
                                  <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                                    {found.title || getDnaHumanLabel(found)}
                                  </div>
                                  <div className="text-[11px] text-[var(--k-ink-muted)]">
                                    {getDnaHumanLabel(found)}
                                  </div>
                                </div>
                                <ArrowSquareOut className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {!location.trim() && checklist.length === 0 && !notes.trim() && attachments.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[var(--k-border-hairline)] p-5 text-center space-y-2">
                        <div className="text-[12.5px] text-[var(--k-ink-muted)]">
                          Дополнительных деталей пока нет
                        </div>
                        <button
                          type="button"
                          onClick={() => setMode('edit')}
                          className="k-interactive text-[12px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer"
                        >
                          Добавить заметку, ссылку или чек-лист
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* Clean View Footer */}
                  <div className="px-5 py-3.5 border-t border-[var(--k-border-hairline)] flex items-center justify-between gap-2 shrink-0 bg-[var(--k-bg-surface-1)]">
                    {onToggleDone ? (
                      <button
                        type="button"
                        onClick={() => void onToggleDone(event)}
                        className={`k-interactive h-9 px-3.5 rounded-xl border text-[12.5px] font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                          event.isDone
                            ? 'bg-[var(--k-emerald-soft)] border-[var(--k-emerald)]/40 text-[var(--k-emerald)]'
                            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]'
                        }`}
                      >
                        <Check weight="bold" className="w-4 h-4" />
                        <span>{event.isDone ? 'Выполнено' : 'Отметить выполненным'}</span>
                      </button>
                    ) : (
                      <span />
                    )}

                    <button
                      type="button"
                      data-testid="calendar-event-edit-btn"
                      onClick={() => setMode('edit')}
                      className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <PencilSimple className="w-3.5 h-3.5" />
                      <span>Изменить</span>
                    </button>
                  </div>
                </motion.div>
              ) : (
                /* ===================== EDIT / CREATE FORM ===================== */
                <motion.div
                  key="cal-edit-mode"
                  data-testid="calendar-event-edit-mode"
                  initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                  animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                  exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, -4px, 0)' }}
                  transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                  className="flex-1 min-h-0 flex flex-col"
                >
                  <form
                    id="calendar-event-sheet-form"
                    onSubmit={handleSubmit}
                    className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4"
                  >
                    {/* Smart paste helper for new events */}
                    {!event ? (
                      <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <Sparkle weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                          <input
                            type="text"
                            value={smartText}
                            onChange={(e) => setSmartText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                applySmartParse(smartText);
                              }
                            }}
                            placeholder="Быстрый разбор: «Пятница 15:00 созвон в Zoom на 45 мин»…"
                            className="flex-1 bg-transparent border-none outline-none text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
                          />
                          {parsedSmart ? (
                            <button
                              type="button"
                              onClick={() => applySmartParse(smartText)}
                              className="k-interactive h-6 px-2.5 rounded-md bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11px] font-medium cursor-pointer shrink-0"
                            >
                              Заполнить
                            </button>
                          ) : null}
                        </div>
                        {parsedSmart ? (
                          <div className="text-[11px] text-[var(--k-ink-secondary)] pl-5">
                            Распознано: <strong className="text-[var(--k-ink-primary)]">{parsedSmart.label}</strong>
                            {parsedSmart.location ? ` · ${parsedSmart.location}` : ''}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Title + Type + Color */}
                    <div className="space-y-2.5">
                      <input
                        type="text"
                        required
                        autoFocus
                        data-testid="calendar-event-title-input"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Название встречи, дела или дедлайна…"
                        className="w-full h-10 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 text-[15px] font-semibold outline-none focus:border-[var(--k-border-focus)]"
                      />

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--k-bg-surface-2)] p-0.5 border border-[var(--k-border-hairline)]">
                          {(
                            [
                              ['event', 'Событие'],
                              ['reminder', 'Напоминание'],
                              ['task', 'Дедлайн'],
                            ] as const
                          ).map(([k, lbl]) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setKind(k)}
                              className={`h-6 px-2.5 rounded-md text-[11.5px] font-medium transition-colors duration-120 cursor-pointer ${
                                kind === k
                                  ? 'bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] shadow-xs'
                                  : 'text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]'
                              }`}
                            >
                              {lbl}
                            </button>
                          ))}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {EVENT_COLORS.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              onClick={() => setColor(hex)}
                              aria-label={`Цвет ${hex}`}
                              className={`w-5 h-5 rounded-full transition-transform duration-120 cursor-pointer ${
                                color === hex ? 'scale-115 ring-2 ring-[var(--k-ink-primary)]/40' : 'opacity-75 hover:opacity-100'
                              }`}
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Date, Start time, Duration & Recurrence */}
                    <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/60 p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <label className="flex-1 min-w-[140px] space-y-1">
                          <span className="text-[11px] font-medium text-[var(--k-ink-muted)] flex items-center gap-1">
                            <CalendarBlank className="w-3.5 h-3.5" />
                            Дата
                          </span>
                          <input
                            type="date"
                            value={dateStr}
                            onChange={(e) => setDateStr(e.target.value)}
                            className="w-full h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                          />
                        </label>

                        {!allDay ? (
                          <label className="w-[116px] space-y-1">
                            <span className="text-[11px] font-medium text-[var(--k-ink-muted)] flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5" />
                              Начало
                            </span>
                            <input
                              type="time"
                              value={startTime}
                              onChange={(e) => setStartTime(e.target.value)}
                              className="w-full h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                            />
                          </label>
                        ) : null}

                        <div className="pt-4">
                          <button
                            type="button"
                            onClick={() => setAllDay((v) => !v)}
                            className={`k-interactive h-9 px-3 rounded-lg border text-[12px] font-medium cursor-pointer ${
                              allDay
                                ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/40 text-[var(--k-accent)]'
                                : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                            }`}
                          >
                            Весь день
                          </button>
                        </div>
                      </div>

                      {!allDay ? (
                        <div className="space-y-1.5">
                          <span className="text-[11px] font-medium text-[var(--k-ink-muted)]">
                            Длительность
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5" data-testid="duration-pills">
                            {DURATION_OPTIONS.map((opt) => {
                              const active = durationPreset === opt.value;
                              return (
                                <button
                                  key={String(opt.value)}
                                  type="button"
                                  data-testid={`duration-pill-${opt.value}`}
                                  onClick={() => {
                                    setDurationPreset(opt.value);
                                    if (opt.value === 'custom' && durationPreset !== 'custom') {
                                      const [sh = 10, sm = 0] = startTime.split(':').map(Number);
                                      const d = new Date(`${dateStr}T00:00:00`);
                                      d.setHours(Number.isFinite(sh) ? sh : 10, Number.isFinite(sm) ? sm : 0, 0, 0);
                                      const mins = typeof durationPreset === 'number' ? durationPreset : 60;
                                      setCustomEndTime(toTimeInputValue(d.getTime() + mins * 60_000));
                                    }
                                  }}
                                  className={`k-interactive h-7 px-2.5 rounded-lg border text-[11.5px] font-medium cursor-pointer ${
                                    active
                                      ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:border-[var(--k-border-strong)] hover:text-[var(--k-ink-primary)]'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>

                          {durationPreset === 'custom' ? (
                            <div className="pt-1 flex items-center gap-2">
                              <span className="text-[12px] text-[var(--k-ink-muted)]">Окончание:</span>
                              <input
                                type="time"
                                value={customEndTime}
                                onChange={(e) => setCustomEndTime(e.target.value)}
                                className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] outline-none focus:border-[var(--k-border-focus)]"
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Recurrence */}
                      <div className="space-y-1.5 pt-1 border-t border-[var(--k-border-hairline)]">
                        <span className="text-[11px] font-medium text-[var(--k-ink-muted)] inline-flex items-center gap-1">
                          <ArrowsClockwise className="w-3 h-3" />
                          Повтор
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {RECURRENCE_OPTIONS.map((opt) => {
                            const active = recurrence === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setRecurrence(opt.value)}
                                className={`k-interactive h-7 px-2.5 rounded-lg border text-[11.5px] font-medium cursor-pointer ${
                                  active
                                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/50 text-[var(--k-accent)]'
                                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                                }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Location or Link */}
                    <div className="space-y-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)] flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                        Место или ссылка на созвон
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={location}
                          onChange={(e) => setLocation(e.target.value)}
                          placeholder="Адрес, кабинет или ссылка (Zoom, Meet, Телемост)…"
                          className="flex-1 h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                        />
                        {isLocationUrl ? (
                          <button
                            type="button"
                            onClick={() => void window.kapsula.openExternal(location.trim())}
                            className="k-interactive h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-accent)] hover:border-[var(--k-accent)]/40 inline-flex items-center gap-1 cursor-pointer shrink-0"
                          >
                            <ArrowSquareOut className="w-3.5 h-3.5" />
                            Открыть
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Preparation Checklist */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11.5px] font-medium text-[var(--k-ink-secondary)] flex items-center gap-1.5">
                          <ListChecks className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                          Чек-лист подготовки
                        </span>
                        {checklist.length > 0 ? (
                          <span className="text-[11px] k-mono text-[var(--k-ink-muted)]">
                            {checklist.filter((c) => c.done).length}/{checklist.length}
                          </span>
                        ) : null}
                      </div>

                      {checklist.length > 0 ? (
                        <div className="space-y-1">
                          {checklist.map((entry) => (
                            <div
                              key={entry.id}
                              className="group flex items-center gap-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 px-2.5 py-1.5"
                            >
                              <AnimatedCheckbox
                                size="sm"
                                checked={entry.done}
                                onChange={(next) =>
                                  setChecklist((prev) =>
                                    prev.map((c) => (c.id === entry.id ? { ...c, done: next } : c))
                                  )
                                }
                              />
                              <span
                                className={`flex-1 text-[12.5px] ${
                                  entry.done
                                    ? 'line-through text-[var(--k-ink-muted)]'
                                    : 'text-[var(--k-ink-primary)]'
                                }`}
                              >
                                {entry.text}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setChecklist((prev) => prev.filter((c) => c.id !== entry.id))
                                }
                                aria-label="Удалить пункт"
                                className="opacity-0 group-hover:opacity-100 text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] transition-opacity cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          data-testid="calendar-checklist-input"
                          value={newChecklistText}
                          onChange={(e) => setNewChecklistText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddChecklistItem();
                            }
                          }}
                          placeholder="Добавить пункт: взять паспорт, подготовить вопросы…"
                          className="flex-1 h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 text-[12.5px] outline-none focus:border-[var(--k-border-focus)]"
                        />
                        <button
                          type="button"
                          data-testid="calendar-checklist-add-btn"
                          onClick={handleAddChecklistItem}
                          disabled={!newChecklistText.trim()}
                          className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium hover:border-[var(--k-border-strong)] disabled:opacity-40 cursor-pointer shrink-0"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Spacious Notes */}
                    <div className="space-y-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)] flex items-center gap-1.5">
                        <NotePencil className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                        Заметки, контакты и детали
                      </label>
                      <textarea
                        rows={4}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Повестка встречи, телефон врача, номер заказа, важные детали…"
                        className="k-selectable w-full rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3 text-[13px] leading-relaxed resize-y outline-none focus:border-[var(--k-border-focus)]"
                      />
                    </div>

                    {/* Attached Vault Items */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-medium text-[var(--k-ink-secondary)] flex items-center gap-1.5">
                          <Paperclip className="w-3.5 h-3.5 text-[var(--k-ink-muted)]" />
                          Связанные материалы из Kapsula
                        </span>

                        <PopoverSurface
                          open={attachPickerOpen}
                          onOpenChange={setAttachPickerOpen}
                          align="end"
                          widthClass="w-80"
                          trigger={
                            <button
                              type="button"
                              data-testid="calendar-attach-item-btn"
                              className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                            >
                              <LinkSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                              Прикрепить запись
                            </button>
                          }
                        >
                          <div className="space-y-2">
                            <input
                              type="text"
                              autoFocus
                              value={attachQuery}
                              onChange={(e) => setAttachQuery(e.target.value)}
                              placeholder="Поиск заметки, ссылки или файла…"
                              className="w-full h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 text-[12px] outline-none focus:border-[var(--k-border-focus)]"
                            />
                            <div className="max-h-52 overflow-y-auto space-y-1">
                              {attachableItems.length === 0 ? (
                                <div className="py-4 text-center text-[11.5px] text-[var(--k-ink-muted)]">
                                  Подходящих записей не найдено
                                </div>
                              ) : (
                                attachableItems.map((candidate) => (
                                  <button
                                    key={candidate.id}
                                    type="button"
                                    onClick={() => {
                                      setAttachments((prev) => [...prev, candidate.id]);
                                      setAttachPickerOpen(false);
                                      setAttachQuery('');
                                    }}
                                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-accent-soft)] transition-colors duration-100 flex items-center justify-between gap-2 cursor-pointer"
                                  >
                                    <span className="truncate text-[12px] font-medium text-[var(--k-ink-primary)]">
                                      {candidate.title || getDnaHumanLabel(candidate)}
                                    </span>
                                    <span className="text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
                                      {getDnaHumanLabel(candidate)}
                                    </span>
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        </PopoverSurface>
                      </div>

                      {attachments.length > 0 ? (
                        <div className="space-y-1.5">
                          {attachments.map((attId) => {
                            const found = itemMap.get(attId);
                            return (
                              <div
                                key={attId}
                                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 px-3 py-2"
                              >
                                <button
                                  type="button"
                                  onClick={() => found && onOpenVaultItem?.(found.id)}
                                  className="text-left min-w-0 flex-1 hover:text-[var(--k-accent)] cursor-pointer"
                                >
                                  <div className="text-[12.5px] font-medium truncate">
                                    {found?.title || 'Связанная запись'}
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAttachments((prev) => prev.filter((id) => id !== attId))}
                                  aria-label="Открепить запись"
                                  className="text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </form>

                  {/* Edit Footer */}
                  <div className="px-5 py-3.5 border-t border-[var(--k-border-hairline)] flex items-center justify-end gap-2 shrink-0 bg-[var(--k-bg-surface-1)]">
                    <button
                      type="button"
                      onClick={() => (event ? setMode('view') : onClose())}
                      className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                    >
                      Отмена
                    </button>
                    <button
                      type="submit"
                      form="calendar-event-sheet-form"
                      data-testid="calendar-event-save-btn"
                      disabled={!title.trim() || saving}
                      className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default"
                    >
                      <Check weight="bold" className="w-3.5 h-3.5" />
                      <span>{saving ? 'Сохраняю…' : event ? 'Сохранить' : 'Добавить событие'}</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
};
