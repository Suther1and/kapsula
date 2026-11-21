import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CalendarBlank,
  Check,
  CheckSquare,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Key,
  LinkSimple,
  LockOpen,
  MagnifyingGlass,
  Microphone,
  Paperclip,
  ShieldCheck,
  X,
} from '@phosphor-icons/react';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import type { CalendarEvent, OrbitDef, VaultItem, VaultTaskEntry } from '@shared/types';
import { formatDateCompact, stripLeadingTitle } from '@renderer/lib/format';
import { filterItemsByQuery, pluralRu, stripMobileInlineMarkdown } from '../lib/mobile-helpers';
import { pushBackHandler } from '../lib/back-stack';
import { mobileBridge } from '../native/bridge';

type SearchScope = 'all' | 'items' | 'tasks' | 'calendar' | 'vault';

interface MobileSearchOverlayProps {
  open: boolean;
  query: string;
  items: VaultItem[];
  tasks: VaultTaskEntry[];
  events: CalendarEvent[];
  orbits: OrbitDef[];
  vaultLocked: boolean;
  onChangeQuery: (q: string) => void;
  onClose: () => void;
  onOpenItem: (item: VaultItem) => void;
  onOpenTask: (task: VaultTaskEntry) => void;
  onToggleTask: (task: VaultTaskEntry) => void;
  onOpenEvent: (ev: CalendarEvent) => void;
  onOpenSecret: (item: VaultItem) => void;
  onUnlockVault: () => Promise<boolean>;
}

/**
 * Dedicated full-height bilingual RU <-> EN search overlay.
 * Occupies 100% of the visible space above the Android keyboard with ZERO colliding bottom nav or FAB.
 */
export const MobileSearchOverlay: React.FC<MobileSearchOverlayProps> = ({
  open,
  query,
  items,
  tasks,
  events,
  orbits,
  vaultLocked,
  onChangeQuery,
  onClose,
  onOpenItem,
  onOpenTask,
  onToggleTask,
  onOpenEvent,
  onOpenSecret,
  onUnlockVault,
}) => {
  const [scope, setScope] = useState<SearchScope>('all');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    const removeBack = pushBackHandler(() => onCloseRef.current());
    return () => {
      cancelAnimationFrame(id);
      removeBack();
    };
  }, [open]);

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);
  const trimmed = query.trim();

  const nonSecretItems = useMemo(() => items.filter((it) => it.dna !== 'secret'), [items]);
  const secretItems = useMemo(() => items.filter((it) => it.dna === 'secret'), [items]);

  const matchedItems = useMemo(
    () => (trimmed ? filterItemsByQuery(nonSecretItems, trimmed) : nonSecretItems.slice(0, 6)),
    [nonSecretItems, trimmed]
  );

  const matchedTasks = useMemo(() => {
    if (!trimmed) return tasks.filter((t) => !t.done).slice(0, 5);
    return tasks.filter((t) =>
      matchesBilingualHaystack(`${t.text} ${t.itemTitle}`.toLowerCase(), trimmed)
    );
  }, [tasks, trimmed]);

  const matchedEvents = useMemo(() => {
    if (!trimmed) {
      const now = Date.now() - 86_400_000;
      return events.filter((e) => e.endAt >= now).slice(0, 5);
    }
    return events.filter((e) =>
      matchesBilingualHaystack(
        `${e.title} ${e.notes || ''} ${e.location || ''}`.toLowerCase(),
        trimmed
      )
    );
  }, [events, trimmed]);

  const matchedSecrets = useMemo(() => {
    if (vaultLocked) return [];
    if (!trimmed) return secretItems.slice(0, 4);
    return filterItemsByQuery(secretItems, trimmed);
  }, [secretItems, trimmed, vaultLocked]);

  if (!open) return null;

  const totalCount =
    matchedItems.length + matchedTasks.length + matchedEvents.length + matchedSecrets.length;

  const showItems = (scope === 'all' || scope === 'items') && matchedItems.length > 0;
  const showTasks = (scope === 'all' || scope === 'tasks') && matchedTasks.length > 0;
  const showEvents = (scope === 'all' || scope === 'calendar') && matchedEvents.length > 0;
  const showSecrets = (scope === 'all' || scope === 'vault') && matchedSecrets.length > 0;

  const closeAndBlur = () => {
    void mobileBridge.hideKeyboard();
    onClose();
  };

  const scopeChips: Array<{ id: SearchScope; label: string; count?: number }> = [
    { id: 'all', label: 'Всё', count: trimmed ? totalCount : undefined },
    { id: 'items', label: 'Заметки', count: matchedItems.length },
    { id: 'tasks', label: 'Задачи', count: matchedTasks.length },
    { id: 'calendar', label: 'Календарь', count: matchedEvents.length },
    { id: 'vault', label: 'Сейф', count: vaultLocked ? undefined : matchedSecrets.length },
  ];

  return (
    <div
      data-testid="mobile-search-overlay"
      className="fixed inset-0 z-40 flex flex-col bg-[var(--k-bg-canvas)] overflow-hidden"
    >
      {/* Fixed Search Top Header (always stays pinned at y = 0!) */}
      <div className="shrink-0 bg-[var(--k-bg-rail)] border-b border-[var(--k-border-hairline)]">
        <div className="h-[56px] px-3 flex items-center gap-2">
          <button
            type="button"
            data-testid="mobile-search-close"
            onClick={closeAndBlur}
            aria-label="Закрыть поиск"
            className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="relative flex-1 min-w-0">
            <MagnifyingGlass className="w-4 h-4 text-[var(--k-accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={inputRef}
              type="search"
              data-testid="mobile-search-input"
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
              placeholder="Поиск по всей Kapsula…"
              className="w-full h-10 pl-9 pr-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  onChangeQuery('');
                  inputRef.current?.focus({ preventScroll: true });
                }}
                aria-label="Очистить запрос"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Scope Chips */}
        <div className="px-3 pr-6 pb-2.5 flex items-center gap-1.5 overflow-x-auto k-no-scrollbar k-scroll-fade-r">
          {scopeChips.map((chip) => {
            const active = scope === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setScope(chip.id)}
                className={`k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-xl text-[12px] font-medium shrink-0 border transition-colors ${
                  active
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                }`}
              >
                <span>{chip.label}</span>
                {typeof chip.count === 'number' && chip.count > 0 ? (
                  <span className="text-[11px] opacity-75 k-tabular">{chip.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Full-Height Results Area (100% height above keyboard!) */}
      <div
        data-testid="mobile-search-results"
        className="flex-1 min-h-0 k-scroll px-3.5 py-3 space-y-5"
      >
        {!trimmed ? (
          <div className="text-[11.5px] text-[var(--k-ink-muted)] px-1">
            Недавние записи · работает поиск на русском и английском (включая раскладку)
          </div>
        ) : null}

        {trimmed && totalCount === 0 && !vaultLocked ? (
          <div className="flex flex-col items-center justify-center text-center py-12 px-6">
            <MagnifyingGlass weight="duotone" className="w-9 h-9 text-[var(--k-ink-muted)] mb-2.5" />
            <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
              По запросу «{trimmed}» ничего не нашлось
            </div>
            <p className="text-[13px] text-[var(--k-ink-muted)] mt-1 max-w-xs">
              Попробуй другое слово, тег, домен ссылки или проверь фильтр сверху.
            </p>
          </div>
        ) : null}

        {/* Items / Notes / Links */}
        {showItems ? (
          <section className="space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                Заметки и ссылки
              </h3>
              <span className="text-[11.5px] text-[var(--k-ink-muted)]">
                {pluralRu(matchedItems.length, 'запись', 'записи', 'записей')}
              </span>
            </div>
            {matchedItems.slice(0, 20).map((item) => {
              const orbit = item.orbit ? orbitMap.get(item.orbit) : null;
              const preview = stripLeadingTitle(
                stripMobileInlineMarkdown(item.body || item.summary || ''),
                item.title
              );
              const Icon =
                item.dna === 'link'
                  ? LinkSimple
                  : item.dna === 'shot'
                    ? ImageIcon
                    : item.dna === 'voice'
                      ? Microphone
                      : item.dna === 'doc'
                        ? Paperclip
                        : FileText;

              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`search-result-item-${item.id}`}
                  onClick={() => {
                    closeAndBlur();
                    onOpenItem(item);
                  }}
                  className="k-tap w-full text-left flex items-start gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                >
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-accent)] shrink-0 mt-0.5">
                    <Icon weight="duotone" className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                        {item.title || 'Без названия'}
                      </span>
                      <span className="text-[11px] text-[var(--k-ink-muted)] shrink-0">
                        {formatDateCompact(item.contentUpdatedAt || item.updatedAt)}
                      </span>
                    </div>
                    {preview ? (
                      <p className="text-[12.5px] text-[var(--k-ink-secondary)] line-clamp-1 mt-0.5">
                        {preview}
                      </p>
                    ) : null}
                    {orbit ? (
                      <span
                        className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--k-ink-primary)]"
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
                </button>
              );
            })}
          </section>
        ) : null}

        {/* Tasks */}
        {showTasks ? (
          <section className="space-y-1.5">
            <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] px-1">
              Задачи · {matchedTasks.length}
            </h3>
            {matchedTasks.slice(0, 12).map((task) => (
              <div
                key={task.id}
                onClick={() => {
                  closeAndBlur();
                  onOpenTask(task);
                }}
                className="k-tap flex items-center gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] cursor-pointer"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTask(task);
                  }}
                  aria-label={task.done ? 'Снять отметку' : 'Отметить выполненной'}
                  className="inline-flex items-center justify-center w-9 h-9 -ml-2 -my-1.5 shrink-0"
                >
                  <span
                    className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                      task.done
                        ? 'bg-[var(--k-emerald)] border-[var(--k-emerald)] text-white'
                        : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    {task.done ? <Check weight="bold" className="w-3 h-3" /> : null}
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-[13.5px] truncate ${
                      task.done
                        ? 'line-through text-[var(--k-ink-muted)]'
                        : 'text-[var(--k-ink-primary)] font-medium'
                    }`}
                  >
                    {task.text}
                  </div>
                  <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                    {task.itemTitle}
                  </div>
                </div>
                <CheckSquare className="w-4 h-4 text-[var(--k-ink-muted)] shrink-0" />
              </div>
            ))}
          </section>
        ) : null}

        {/* Calendar Events */}
        {showEvents ? (
          <section className="space-y-1.5">
            <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] px-1">
              Календарь · {matchedEvents.length}
            </h3>
            {matchedEvents.slice(0, 10).map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => {
                  closeAndBlur();
                  onOpenEvent(ev);
                }}
                className="k-tap w-full text-left flex items-center gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: ev.color || 'var(--k-accent)' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                    {ev.title}
                  </div>
                  <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                    {new Date(ev.startAt).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                    })}
                    {!ev.allDay
                      ? ` · ${new Date(ev.startAt).toLocaleTimeString('ru-RU', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`
                      : ' · Весь день'}
                  </div>
                </div>
                <CalendarBlank className="w-4 h-4 text-[var(--k-ink-muted)] shrink-0" />
              </button>
            ))}
          </section>
        ) : null}

        {/* Vault Secrets */}
        {scope === 'all' || scope === 'vault' ? (
          vaultLocked ? (
            secretItems.length > 0 && (trimmed || scope === 'vault') ? (
              <button
                type="button"
                onClick={() => void onUnlockVault()}
                className="k-tap w-full flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-left"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <ShieldCheck weight="duotone" className="w-5 h-5 text-[var(--k-accent)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                      Искать также в Сейфе
                    </div>
                    <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                      Подтверди вход, чтобы увидеть карты и пароли
                    </div>
                  </div>
                </div>
                <LockOpen className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
              </button>
            ) : null
          ) : showSecrets ? (
            <section className="space-y-1.5">
              <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] px-1">
                Сейф · {matchedSecrets.length}
              </h3>
              {matchedSecrets.slice(0, 10).map((sec) => {
                const isCard = sec.secretMeta?.kind === 'bank_card';
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => {
                      closeAndBlur();
                      onOpenSecret(sec);
                    }}
                    className="k-tap w-full text-left flex items-center gap-2.5 p-3 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                  >
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
                      {isCard ? <CreditCard className="w-4 h-4" /> : <Key className="w-4 h-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                        {sec.title}
                      </div>
                      <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                        {isCard
                          ? `•••• ${sec.secretMeta?.last4 || '••••'}`
                          : sec.secretMeta?.loginHint || sec.secretMeta?.service || 'Секрет'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </section>
          ) : null
        ) : null}
      </div>
    </div>
  );
};
