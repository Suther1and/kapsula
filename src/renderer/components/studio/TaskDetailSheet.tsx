import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowSquareOut,
  CalendarBlank,
  Clock,
  Flag,
  FolderSimple,
  ListChecks,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { OrbitDef, TaskBoardColumn, TaskPriority, VaultTaskEntry } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import {
  TASK_PRIORITY_META,
  TASK_PRIORITY_ORDER,
  combineTaskDateAndTime,
  computeTaskDueAtPreset,
  formatTaskDateInputValue,
  formatTaskTimeInputValue,
  localizeTaskBoardColumnTitle,
} from '@shared/task-helpers';
import { useScopedAccentStyle } from '../../lib/scoped-accent';
import { AnimatedCheckbox } from '../ui/AnimatedCheckbox';
import { SelectMenu } from '../ui/SelectMenu';

export interface TaskMetaUpdatePatch {
  priority?: TaskPriority;
  dueAt?: number | null;
  columnId?: string;
  orbit?: string | null;
  notes?: string | null;
}

interface TaskDetailSheetProps {
  task: VaultTaskEntry | null;
  orbits: OrbitDef[];
  columns: TaskBoardColumn[];
  onClose: () => void;
  onToggleDone: (task: VaultTaskEntry) => void;
  onUpdateText: (task: VaultTaskEntry, nextText: string) => Promise<void> | void;
  onUpdateMeta: (task: VaultTaskEntry, patch: TaskMetaUpdatePatch) => Promise<void> | void;
  onOpenItem: (itemId: string) => void;
  onDelete: (task: VaultTaskEntry) => Promise<void> | void;
}

export const TaskDetailSheet: React.FC<TaskDetailSheetProps> = ({
  task,
  orbits,
  columns,
  onClose,
  onToggleDone,
  onUpdateText,
  onUpdateMeta,
  onOpenItem,
  onDelete,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const scopedAccentStyle = useScopedAccentStyle();

  const [titleDraft, setTitleDraft] = useState(task?.text ?? '');
  const [notesDraft, setNotesDraft] = useState(task?.notes ?? '');
  const [dateInput, setDateInput] = useState(formatTaskDateInputValue(task?.dueAt ?? task?.remindAt));
  const [timeInput, setTimeInput] = useState(formatTaskTimeInputValue(task?.dueAt ?? task?.remindAt));

  const latestRef = useRef({
    task,
    titleDraft,
    notesDraft,
    onUpdateText,
    onUpdateMeta,
  });
  latestRef.current = { task, titleDraft, notesDraft, onUpdateText, onUpdateMeta };

  useEffect(() => {
    setTitleDraft(task?.text ?? '');
    setNotesDraft(task?.notes ?? '');
    const effDue = task?.dueAt ?? task?.remindAt ?? null;
    setDateInput(formatTaskDateInputValue(effDue));
    setTimeInput(formatTaskTimeInputValue(effDue));
  }, [task?.id, task?.text, task?.notes, task?.dueAt, task?.remindAt]);

  const flushPendingDrafts = (targetTask: VaultTaskEntry | null) => {
    if (!targetTask) return;
    const cleanTitle = latestRef.current.titleDraft.replace(/[\r\n]+/g, ' ').trim();
    if (cleanTitle && cleanTitle !== targetTask.text) {
      void latestRef.current.onUpdateText(targetTask, cleanTitle);
    }
    const trimmedNotes = latestRef.current.notesDraft.trim();
    const prevNotes = (targetTask.notes ?? '').trim();
    if (trimmedNotes !== prevNotes) {
      void latestRef.current.onUpdateMeta(targetTask, {
        notes: trimmedNotes || null,
      });
    }
  };

  useEffect(() => {
    if (!task) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        flushPendingDrafts(latestRef.current.task);
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [task?.id, onClose]);

  const handleRequestClose = () => {
    flushPendingDrafts(task);
    onClose();
  };

  const applyDateAndTime = (nextDate: string, nextTime: string) => {
    if (!task) return;
    setDateInput(nextDate);
    setTimeInput(nextTime);
    if (!nextDate) {
      void onUpdateMeta(task, { dueAt: null });
      return;
    }
    const combined = combineTaskDateAndTime(nextDate, nextTime);
    if (combined !== null) {
      void onUpdateMeta(task, { dueAt: combined });
    }
  };

  const columnOptions = columns.map((col) => ({
    value: col.id,
    label: localizeTaskBoardColumnTitle(col, locale),
    dotColor: col.color,
  }));

  const orbitOptions = [
    { value: '', label: t('tasks.ctx.noSection') },
    ...orbits.map((orbit) => ({
      value: orbit.id,
      label: orbit.name,
      dotColor: orbit.color,
    })),
  ];

  const activeOrbit = task?.orbit ? orbits.find((o) => o.id === task.orbit) ?? null : null;
  const activeColId = task?.columnId ?? (task?.done ? 'done' : 'inbox');

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {task ? (
        <div
          key="task-detail-sheet-portal"
          style={scopedAccentStyle}
          className="fixed inset-0 z-[92] flex justify-end overflow-hidden"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.13 }}
            onClick={handleRequestClose}
            className="fixed inset-0 bg-[var(--k-bg-backdrop)] backdrop-blur-[2px]"
          />

          <motion.div
            key="task-detail-sheet-panel"
            data-testid="task-detail-sheet"
            initial={
              prefersReduced
                ? { opacity: 0 }
                : { opacity: 0, transform: 'translate3d(42px, 0, 0) scale(0.985)' }
            }
            animate={
              prefersReduced
                ? { opacity: 1 }
                : {
                    opacity: 1,
                    transform: 'translate3d(0px, 0, 0) scale(1)',
                    transition: {
                      type: 'spring',
                      stiffness: 520,
                      damping: 36,
                      mass: 0.65,
                      opacity: { duration: 0.13, ease: [0.23, 1, 0.32, 1] },
                    },
                  }
            }
            exit={
              prefersReduced
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    transform: 'translate3d(32px, 0, 0) scale(0.99)',
                    transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] },
                  }
            }
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 w-[min(440px,92vw)] h-full bg-[var(--k-bg-surface-1)] border-l border-[var(--k-border-strong)] shadow-[var(--k-shadow-sheet)] flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="shrink-0 px-4 py-3 border-b border-[var(--k-border-hairline)] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <AnimatedCheckbox
                  checked={task.done}
                  size="md"
                  label={task.done ? t('tasks.markUndone') : t('tasks.markDone')}
                  data-testid="task-sheet-toggle"
                  onChange={() => onToggleDone(task)}
                />
                <span className="text-[13px] font-semibold text-[var(--k-ink-primary)] truncate">
                  {t('tasks.sheet.title')}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-testid="task-sheet-delete-btn"
                  title={t('tasks.ctx.deleteTask')}
                  onClick={() => {
                    onClose();
                    void onDelete(task);
                  }}
                  className="k-interactive w-8 h-8 rounded-lg flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[#EF4444] hover:bg-[#EF4444]/10 cursor-pointer"
                >
                  <Trash size={15} />
                </button>
                <button
                  type="button"
                  data-testid="task-sheet-close-btn"
                  onClick={handleRequestClose}
                  className="k-interactive w-8 h-8 rounded-lg flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
              {/* Editable Task Title */}
              <div>
                <textarea
                  data-testid="task-sheet-title-input"
                  value={titleDraft}
                  rows={2}
                  placeholder={t('tasks.sheet.taskPlaceholder')}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => {
                    const clean = titleDraft.replace(/[\r\n]+/g, ' ').trim();
                    if (clean && clean !== task.text) {
                      void onUpdateText(task, clean);
                    } else if (!clean) {
                      setTitleDraft(task.text);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      (e.currentTarget as HTMLTextAreaElement).blur();
                    }
                  }}
                  className={`w-full resize-none rounded-xl px-3 py-2 text-[15px] font-semibold leading-snug bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-accent)] focus:outline-none text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-subtle)] ${
                    task.done ? 'line-through text-[var(--k-ink-muted)]' : ''
                  }`}
                />
              </div>

              {/* Status & Section row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--k-ink-muted)] mb-1.5">
                    <ListChecks size={13} />
                    <span>{t('tasks.sheet.statusColumn')}</span>
                  </label>
                  <SelectMenu
                    data-testid="task-sheet-column-select"
                    size="sm"
                    value={activeColId}
                    options={columnOptions}
                    onChange={(colId) => {
                      if (colId && colId !== activeColId) {
                        void onUpdateMeta(task, { columnId: colId });
                      }
                    }}
                  />
                </div>

                <div>
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--k-ink-muted)] mb-1.5">
                    <FolderSimple size={13} />
                    <span>{t('tasks.quickAdd.orbitLabel')}</span>
                  </label>
                  <SelectMenu
                    data-testid="task-sheet-orbit-select"
                    size="sm"
                    value={task.orbit || ''}
                    options={orbitOptions}
                    onChange={(nextOrbit) => {
                      void onUpdateMeta(task, { orbit: nextOrbit || '' });
                    }}
                  />
                </div>
              </div>

              {/* Priority pills */}
              <div>
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--k-ink-muted)] mb-1.5">
                  <Flag size={13} />
                  <span>{t('tasks.ctx.priority')}</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {TASK_PRIORITY_ORDER.map((prio) => {
                    const meta = TASK_PRIORITY_META[prio];
                    const active = (task.priority ?? 'none') === prio;
                    return (
                      <button
                        key={prio}
                        type="button"
                        data-testid={`task-sheet-priority-${prio}`}
                        onClick={() => void onUpdateMeta(task, { priority: prio })}
                        className={`k-interactive h-7 px-2.5 rounded-lg text-[11.5px] font-medium inline-flex items-center gap-1.5 border cursor-pointer transition-colors ${
                          active
                            ? 'bg-[var(--k-accent-soft)] border-[var(--k-accent)] text-[var(--k-accent)]'
                            : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: meta.dotColor }}
                        />
                        <span>{t(meta.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Due date & time */}
              <div>
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--k-ink-muted)] mb-1.5">
                  <CalendarBlank size={13} />
                  <span>{t('tasks.ctx.due')}</span>
                </label>

                <div className="flex flex-wrap gap-1.5 mb-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const ts = computeTaskDueAtPreset('today');
                      setDateInput(formatTaskDateInputValue(ts));
                      setTimeInput(formatTaskTimeInputValue(ts));
                      void onUpdateMeta(task, { dueAt: ts });
                    }}
                    className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] cursor-pointer whitespace-nowrap"
                  >
                    {t('tasks.ctx.tonight')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const ts = computeTaskDueAtPreset('tomorrow');
                      setDateInput(formatTaskDateInputValue(ts));
                      setTimeInput(formatTaskTimeInputValue(ts));
                      void onUpdateMeta(task, { dueAt: ts });
                    }}
                    className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] cursor-pointer whitespace-nowrap"
                  >
                    {t('tasks.ctx.tomorrow10')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const ts = computeTaskDueAtPreset('week');
                      setDateInput(formatTaskDateInputValue(ts));
                      setTimeInput(formatTaskTimeInputValue(ts));
                      void onUpdateMeta(task, { dueAt: ts });
                    }}
                    className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] cursor-pointer whitespace-nowrap"
                  >
                    {t('tasks.ctx.in3Days')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDateInput('');
                      setTimeInput('');
                      void onUpdateMeta(task, { dueAt: null });
                    }}
                    className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-[var(--k-ink-muted)] hover:text-[#EF4444] hover:bg-[#EF4444]/10 cursor-pointer whitespace-nowrap"
                  >
                    {t('tasks.ctx.clearDue')}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="block text-[10.5px] text-[var(--k-ink-subtle)] mb-1">
                      {t('tasks.sheet.dueDate')}
                    </span>
                    <input
                      type="date"
                      data-testid="task-sheet-date-input"
                      value={dateInput}
                      onChange={(e) => applyDateAndTime(e.target.value, timeInput)}
                      className="w-full h-8 px-2.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-primary)] focus:outline-none focus:border-[var(--k-accent)]"
                    />
                  </div>
                  <div>
                    <span className="flex items-center justify-between text-[10.5px] text-[var(--k-ink-subtle)] mb-1">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} />
                        {t('tasks.sheet.dueTime')}
                      </span>
                      {timeInput ? (
                        <button
                          type="button"
                          onClick={() => applyDateAndTime(dateInput, '')}
                          className="text-[10.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          {t('tasks.sheet.clearTime')}
                        </button>
                      ) : null}
                    </span>
                    <input
                      type="time"
                      data-testid="task-sheet-time-input"
                      value={timeInput}
                      disabled={!dateInput}
                      onChange={(e) => applyDateAndTime(dateInput, e.target.value)}
                      className="w-full h-8 px-2.5 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-primary)] focus:outline-none focus:border-[var(--k-accent)] disabled:opacity-45"
                    />
                  </div>
                </div>
              </div>

              {/* Multi-line Task Notes */}
              <div>
                <label className="block text-[11px] font-medium text-[var(--k-ink-muted)] mb-1.5">
                  {t('tasks.sheet.notesLabel')}
                </label>
                <textarea
                  data-testid="task-sheet-notes"
                  value={notesDraft}
                  rows={5}
                  placeholder={t('tasks.sheet.notesPlaceholder')}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  onBlur={() => {
                    const trimmed = notesDraft.trim();
                    const prev = (task.notes ?? '').trim();
                    if (trimmed !== prev) {
                      void onUpdateMeta(task, { notes: trimmed || null });
                    }
                  }}
                  className="w-full resize-y min-h-[104px] rounded-xl px-3 py-2.5 text-[13px] leading-relaxed bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-accent)] focus:outline-none text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-subtle)]"
                />
              </div>

              {/* Source note link / section info */}
              <div className="pt-2 border-t border-[var(--k-border-hairline)] flex items-center justify-between gap-2 text-[12px]">
                <div className="flex items-center gap-2 min-w-0 text-[var(--k-ink-muted)]">
                  {activeOrbit ? (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: activeOrbit.color }}
                    />
                  ) : null}
                  <span className="truncate">
                    {task.isStandaloneTask
                      ? t('tasks.sheet.standaloneHint')
                      : `${t('tasks.sheet.sourceLabel')}: ${task.itemTitle}`}
                  </span>
                </div>
                {!task.isStandaloneTask ? (
                  <button
                    type="button"
                    data-testid="task-sheet-open-note-btn"
                    onClick={() => {
                      handleRequestClose();
                      onOpenItem(task.itemId);
                    }}
                    className="k-interactive shrink-0 h-7 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--k-accent)] bg-[var(--k-accent-soft)] hover:brightness-105 cursor-pointer"
                  >
                    <span>{t('tasks.sheet.openNoteBtn')}</span>
                    <ArrowSquareOut size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
};
