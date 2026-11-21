import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  CalendarBlank,
  CheckSquare,
  Code,
  FileText,
  FunnelSimple,
  GlobeSimple,
  ImageSquare,
  LockKey,
  Microphone,
  NotePencil,
  Plus,
  Sparkle,
} from '@phosphor-icons/react';
import type { CalendarEvent, OrbitDef, VaultItem, VaultTaskEntry } from '@shared/types';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { cleanBrokenTextArtifacts, truncateAtWordBoundary } from '@shared/html-entities';
import { isMacPlatform } from '@shared/shortcuts';
import { formatDateCompact, getDnaHumanLabel, getMediaUrl, stripMarkdownPreview } from '../../lib/format';

export interface GlobalSearchCommand {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

interface GlobalSearchPopoverProps {
  open: boolean;
  query: string;
  items: VaultItem[];
  calendarEvents: CalendarEvent[];
  tasks: VaultTaskEntry[];
  orbits: OrbitDef[];
  serverSearchIds: string[] | null;
  onClose: () => void;
  onOpenItem: (item: VaultItem) => void;
  onOpenEvent: (event: CalendarEvent) => void;
  onToggleTask: (task: VaultTaskEntry) => void;
  onOpenNewNote: () => void;
  onOpenTriage: () => void;
  onOpenAssistant: () => void;
  onOpenCalendarNew: () => void;
}

type SearchEntry =
  | { kind: 'item'; id: string; item: VaultItem }
  | { kind: 'event'; id: string; event: CalendarEvent }
  | { kind: 'task'; id: string; task: VaultTaskEntry }
  | { kind: 'command'; id: string; command: GlobalSearchCommand };

function renderItemIcon(item: VaultItem) {
  switch (item.dna) {
    case 'secret':
      return <LockKey weight="duotone" className="w-4 h-4 text-[var(--k-emerald)]" />;
    case 'link':
      return <GlobeSimple weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />;
    case 'shot':
      return <ImageSquare weight="duotone" className="w-4 h-4 text-[var(--k-info)]" />;
    case 'voice':
      return <Microphone weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />;
    case 'snippet':
      return <Code weight="duotone" className="w-4 h-4 text-[var(--k-violet)]" />;
    case 'doc':
      return <FileText weight="duotone" className="w-4 h-4 text-[var(--k-amber)]" />;
    default:
      return <NotePencil weight="duotone" className="w-4 h-4 text-[var(--k-ink-secondary)]" />;
  }
}

export const GlobalSearchPopover: React.FC<GlobalSearchPopoverProps> = ({
  open,
  query,
  items,
  calendarEvents,
  tasks,
  orbits,
  serverSearchIds,
  onClose,
  onOpenItem,
  onOpenEvent,
  onToggleTask,
  onOpenNewNote,
  onOpenTriage,
  onOpenAssistant,
  onOpenCalendarNew,
}) => {
  const prefersReduced = useReducedMotion();
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);
  const q = query.trim();

  const commands: GlobalSearchCommand[] = useMemo(
    () => [
      {
        id: 'cmd-new-note',
        label: 'Новая заметка',
        hint: isMacPlatform(window.kapsula?.platform) ? '⌘N' : 'Ctrl+N',
        icon: <Plus weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />,
        run: onOpenNewNote,
      },
      {
        id: 'cmd-new-event',
        label: 'Новое событие в Календаре',
        icon: <CalendarBlank className="w-3.5 h-3.5 text-[var(--k-accent)]" />,
        run: onOpenCalendarNew,
      },
      {
        id: 'cmd-triage',
        label: 'Умный разбор записей',
        icon: <FunnelSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />,
        run: onOpenTriage,
      },
      {
        id: 'cmd-assistant',
        label: 'Спросить Ассистента',
        icon: <Sparkle weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)]" />,
        run: onOpenAssistant,
      },
    ],
    [onOpenNewNote, onOpenCalendarNew, onOpenTriage, onOpenAssistant]
  );

  const entries = useMemo<SearchEntry[]>(() => {
    const out: SearchEntry[] = [];
    const serverSet = serverSearchIds ? new Set(serverSearchIds) : null;

    const matchedItems = (q
      ? items.filter((item) => {
          if (serverSet && serverSet.has(item.id)) return true;
          const hay = [
            item.title,
            item.summary,
            item.body,
            item.ocrText,
            item.url,
            item.domain,
            item.tags.join(' '),
            item.secretMeta?.service,
            item.secretMeta?.loginHint,
          ]
            .filter(Boolean)
            .join('\n');
          return matchesBilingualHaystack(hay, q);
        })
      : items
    )
      .slice()
      .sort((a, b) => (b.contentUpdatedAt || b.createdAt) - (a.contentUpdatedAt || a.createdAt))
      .slice(0, q ? 7 : 5);

    for (const item of matchedItems) {
      out.push({ kind: 'item', id: `item-${item.id}`, item });
    }

    if (q) {
      const matchedEvents = calendarEvents
        .filter((ev) =>
          matchesBilingualHaystack([ev.title, ev.notes, ev.location].filter(Boolean).join(' '), q)
        )
        .slice(0, 3);
      for (const event of matchedEvents) {
        out.push({ kind: 'event', id: `ev-${event.id}`, event });
      }

      const matchedTasks = tasks
        .filter((t) => !t.done && matchesBilingualHaystack(`${t.text} ${t.itemTitle}`, q))
        .slice(0, 3);
      for (const task of matchedTasks) {
        out.push({ kind: 'task', id: `task-${task.id}`, task });
      }
    }

    const matchedCommands = q
      ? commands.filter((c) => matchesBilingualHaystack(c.label, q))
      : commands;
    for (const command of matchedCommands) {
      out.push({ kind: 'command', id: command.id, command });
    }

    return out;
  }, [q, items, calendarEvents, tasks, serverSearchIds, commands]);

  useEffect(() => {
    setActiveIdx(0);
  }, [q, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (entries.length > 0 ? (i + 1) % entries.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (entries.length > 0 ? (i - 1 + entries.length) % entries.length : 0));
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const chosen = entries[activeIdx];
        if (!chosen) return;
        e.preventDefault();
        if (chosen.kind === 'item') {
          onClose();
          onOpenItem(chosen.item);
        } else if (chosen.kind === 'event') {
          onClose();
          onOpenEvent(chosen.event);
        } else if (chosen.kind === 'task') {
          onToggleTask(chosen.task);
        } else if (chosen.kind === 'command') {
          onClose();
          chosen.command.run();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, entries, activeIdx, onClose, onOpenItem, onOpenEvent, onToggleTask]);

  return (
    <div className="pointer-events-none absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 w-[max(100%,420px)] max-w-[calc(100vw-32px)] z-[110]">
      <AnimatePresence>
        {open ? (
          <motion.div
            key="global-search-popover"
            data-testid="global-search-popover"
            initial={
              prefersReduced
                ? { opacity: 0 }
                : { opacity: 0, transform: 'translate3d(0, -5px, 0) scale(0.985)' }
            }
            animate={
              prefersReduced
                ? { opacity: 1 }
                : { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
            }
            exit={
              prefersReduced
                ? { opacity: 0 }
                : { opacity: 0, transform: 'translate3d(0, -4px, 0) scale(0.985)' }
            }
            transition={{ duration: 0.11, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: 'top center' }}
            onMouseDown={(e) => e.preventDefault()}
            className="pointer-events-auto rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] shadow-[var(--k-shadow-popover)] backdrop-blur-xl overflow-hidden"
          >
          <div ref={listRef} className="max-h-[400px] overflow-y-auto p-1.5 space-y-0.5">
            {entries.length === 0 ? (
              <div className="py-8 text-center text-[12.5px] text-[var(--k-ink-muted)]">
                Ничего не найдено по запросу «{q}»
              </div>
            ) : (
              entries.map((entry, idx) => {
                const isActive = idx === activeIdx;
                if (entry.kind === 'item') {
                  const it = entry.item;
                  const thumb = it.dna !== 'secret' ? getMediaUrl(it.thumbPath || it.imagePath) : null;
                  const orbit = it.orbit ? orbitMap.get(it.orbit) : undefined;
                  const title = cleanBrokenTextArtifacts(it.title || getDnaHumanLabel(it), true);
                  const sub =
                    it.dna === 'secret'
                      ? it.secretMeta?.loginHint || 'Запись в Сейфе'
                      : truncateAtWordBoundary(
                          cleanBrokenTextArtifacts(stripMarkdownPreview(it.summary || it.body || it.url || ''), true),
                          70
                        );
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        onClose();
                        onOpenItem(it);
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-[var(--k-accent-soft)] text-[var(--k-ink-primary)]'
                          : 'hover:bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)]'
                      }`}
                    >
                      <span className="w-7 h-7 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-center shrink-0 overflow-hidden">
                        {thumb ? (
                          <img src={thumb} alt="" className="w-full h-full object-cover" />
                        ) : (
                          renderItemIcon(it)
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{title}</div>
                        {sub ? (
                          <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">{sub}</div>
                        ) : null}
                      </div>
                      {orbit ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[10.5px] text-[var(--k-ink-secondary)] shrink-0 max-w-[96px] truncate">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: orbit.color }}
                          />
                          <span className="truncate">{orbit.name}</span>
                        </span>
                      ) : null}
                      <span className="k-mono text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
                        {formatDateCompact(it.contentUpdatedAt || it.createdAt)}
                      </span>
                    </button>
                  );
                }

                if (entry.kind === 'event') {
                  const ev = entry.event;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        onClose();
                        onOpenEvent(ev);
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                        isActive ? 'bg-[var(--k-accent-soft)]' : 'hover:bg-[var(--k-bg-surface-2)]'
                      }`}
                    >
                      <span className="w-7 h-7 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-center shrink-0">
                        <CalendarBlank className="w-4 h-4" style={{ color: ev.color }} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{ev.title}</div>
                        <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                          Событие ·{' '}
                          {new Date(ev.startAt).toLocaleDateString('ru-RU', {
                            day: 'numeric',
                            month: 'short',
                          })}
                          {!ev.allDay
                            ? ` в ${new Date(ev.startAt).toLocaleTimeString('ru-RU', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}`
                            : ''}
                        </div>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                    </button>
                  );
                }

                if (entry.kind === 'task') {
                  const t = entry.task;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => onToggleTask(t)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                        isActive ? 'bg-[var(--k-accent-soft)]' : 'hover:bg-[var(--k-bg-surface-2)]'
                      }`}
                    >
                      <span className="w-7 h-7 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-center shrink-0">
                        <CheckSquare className="w-4 h-4 text-[var(--k-accent)]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{t.text}</div>
                        <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                          Задача · {t.itemTitle}
                        </div>
                      </div>
                      <span className="text-[10.5px] text-[var(--k-ink-muted)] shrink-0">Отметить</span>
                    </button>
                  );
                }

                const cmd = entry.command;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      onClose();
                      cmd.run();
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer ${
                      isActive ? 'bg-[var(--k-accent-soft)]' : 'hover:bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    <span className="w-6 h-6 rounded-md bg-[var(--k-bg-surface-2)] flex items-center justify-center shrink-0">
                      {cmd.icon}
                    </span>
                    <span className="text-[12.5px] font-medium flex-1 truncate">{cmd.label}</span>
                    {cmd.hint ? (
                      <span className="k-mono text-[10.5px] text-[var(--k-ink-muted)] px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-2)]">
                        {cmd.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50 flex items-center justify-between text-[11px] text-[var(--k-ink-muted)]">
            <span>↑↓ выбор · Enter открыть · Esc закрыть</span>
            <span>Живой поиск по всей Kapsula</span>
          </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};
