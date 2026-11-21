import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Hash, Plus, X } from '@phosphor-icons/react';

const DEFAULT_STARTER_TAGS = [
  'идея',
  'важно',
  'работа',
  'личное',
  'проект',
  'задача',
  'референс',
  'почитать',
] as const;

interface InlineTagEditorProps {
  tags: string[];
  availableTags?: string[];
  onChange: (nextTags: string[]) => void;
}

function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

interface TagSuggestionOption {
  kind: 'existing' | 'create';
  tag: string;
}

export const InlineTagEditor: React.FC<InlineTagEditorProps> = ({
  tags,
  availableTags = [],
  onChange,
}) => {
  const prefersReduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverRect, setPopoverRect] = useState<{
    left: number;
    top: number;
    showAbove: boolean;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputWrapRef = useRef<HTMLDivElement | null>(null);

  const cleanDraft = useMemo(() => normalizeTag(draft), [draft]);
  const queryLower = useMemo(
    () => draft.trim().replace(/^#+/, '').toLowerCase(),
    [draft],
  );

  // Merge vault tags (frequency-ordered from parent) with quiet universal starter tags
  const suggestionPool = useMemo(() => {
    const existingSet = new Set(tags.map((t) => t.toLowerCase()));
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const raw of availableTags) {
      const clean = normalizeTag(raw);
      if (clean && !existingSet.has(clean) && !seen.has(clean)) {
        seen.add(clean);
        merged.push(clean);
      }
    }

    for (const fallback of DEFAULT_STARTER_TAGS) {
      if (!existingSet.has(fallback) && !seen.has(fallback)) {
        seen.add(fallback);
        merged.push(fallback);
      }
    }

    return merged;
  }, [availableTags, tags]);

  const options = useMemo<TagSuggestionOption[]>(() => {
    const matched = queryLower
      ? suggestionPool
          .filter((t) => t.includes(queryLower))
          .sort((a, b) => {
            const aStarts = a.startsWith(queryLower) ? 0 : 1;
            const bStarts = b.startsWith(queryLower) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return 0;
          })
          .slice(0, 7)
      : suggestionPool.slice(0, 8);

    const list: TagSuggestionOption[] = matched.map((tag) => ({
      kind: 'existing',
      tag,
    }));

    const alreadyOnItem = tags.some((t) => t.toLowerCase() === cleanDraft);
    const alreadyInList = matched.includes(cleanDraft);
    if (cleanDraft && !alreadyOnItem && !alreadyInList) {
      list.push({ kind: 'create', tag: cleanDraft });
    }

    return list;
  }, [suggestionPool, queryLower, cleanDraft, tags]);

  // Clamp active highlight index whenever options shrink
  useEffect(() => {
    if (options.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= options.length) {
      setActiveIndex(0);
    }
  }, [options.length, activeIndex]);

  const measurePopover = useCallback(() => {
    const el = inputWrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const popW = 216;
    const left = Math.max(12, Math.min(window.innerWidth - popW - 12, rect.left));
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const showAbove = spaceBelow < 210 && rect.top > spaceBelow;
    const top = showAbove ? Math.max(12, rect.top - 6) : rect.bottom + 6;
    setPopoverRect({ left, top, showAbove });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measurePopover();
  }, [open, tags.length, draft, measurePopover]);

  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => measurePopover();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, measurePopover]);

  const addTag = useCallback(
    (raw: string) => {
      const clean = normalizeTag(raw);
      if (clean && !tags.some((t) => t.toLowerCase() === clean)) {
        onChange([...tags, clean]);
      }
      setDraft('');
      setActiveIndex(0);
    },
    [tags, onChange],
  );

  const removeTag = useCallback(
    (target: string) => {
      onChange(tags.filter((t) => t !== target));
    },
    [tags, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (options.length > 0) {
        e.preventDefault();
        setOpen(true);
        setActiveIndex((prev) => (prev + 1) % options.length);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      if (options.length > 0) {
        e.preventDefault();
        setOpen(true);
        setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
      }
      return;
    }

    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (options.length > 0 && (queryLower || open)) {
        const picked = options[activeIndex % options.length];
        if (picked) {
          addTag(picked.tag);
          return;
        }
      }
      if (cleanDraft) {
        addTag(cleanDraft);
      }
      return;
    }

    if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      const last = tags[tags.length - 1];
      if (last) removeTag(last);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft('');
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div
      data-testid="inline-tag-editor"
      className="min-h-[28px] flex flex-wrap items-center gap-1.5"
    >
      {tags.map((tag) => (
        <span
          key={tag}
          data-testid={`inline-tag-pill-${tag}`}
          className="inline-flex items-center gap-1 h-[24px] pl-2 pr-1.5 rounded-full border border-[var(--k-border-hairline)] bg-transparent text-[11.5px] text-[var(--k-ink-secondary)] hover:border-[var(--k-border-strong)] transition-colors duration-140"
        >
          <Hash weight="bold" className="w-2.5 h-2.5 text-[var(--k-ink-muted)] opacity-75 shrink-0" />
          <span>{tag}</span>
          <button
            type="button"
            aria-label={`Удалить тег ${tag}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => removeTag(tag)}
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] transition-colors cursor-pointer"
          >
            <X weight="bold" className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}

      {/* Always-mounted stable-width input slot: zero unmount/remount or width collapse flicker on blur */}
      <div
        ref={inputWrapRef}
        className="relative inline-flex items-center h-[26px] shrink-0"
      >
        <Plus
          weight="bold"
          className={`pointer-events-none absolute left-2 w-3 h-3 transition-colors duration-140 ${
            open ? 'text-[var(--k-accent)]' : 'text-[var(--k-ink-muted)]'
          }`}
        />
        <input
          ref={inputRef}
          type="text"
          data-testid="inline-tag-input"
          value={draft}
          onFocus={() => {
            setOpen(true);
            setActiveIndex(0);
          }}
          onBlur={() => {
            setOpen(false);
            setDraft('');
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="тег"
          aria-label="Добавить тег"
          aria-autocomplete="list"
          aria-expanded={open && options.length > 0}
          className={`h-[26px] w-[124px] pl-6 pr-2 rounded-full border text-[11.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none transition-[border-color,background-color] duration-140 select-text ${
            open
              ? 'border-[var(--k-border-focus)] bg-[var(--k-bg-surface-1)]'
              : 'border-transparent bg-transparent hover:border-[var(--k-border-hairline)] hover:bg-[var(--k-bg-surface-2)]/60'
          }`}
        />
      </div>

      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {open && options.length > 0 && popoverRect ? (
                <motion.div
                  key="inline-tag-suggestions"
                  data-testid="inline-tag-suggestions"
                  role="listbox"
                  initial={
                    prefersReduced
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: popoverRect.showAbove
                            ? 'translate3d(0, calc(-100% + 4px), 0) scale(0.98)'
                            : 'translate3d(0, -4px, 0) scale(0.98)',
                        }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : {
                          opacity: 1,
                          transform: popoverRect.showAbove
                            ? 'translate3d(0, -100%, 0) scale(1)'
                            : 'translate3d(0, 0, 0) scale(1)',
                        }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: popoverRect.showAbove
                            ? 'translate3d(0, calc(-100% + 3px), 0) scale(0.98)'
                            : 'translate3d(0, -3px, 0) scale(0.98)',
                        }
                  }
                  transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
                  style={{
                    position: 'fixed',
                    left: `${popoverRect.left}px`,
                    top: `${popoverRect.top}px`,
                    width: '216px',
                    transformOrigin: popoverRect.showAbove ? 'bottom left' : 'top left',
                  }}
                  className="z-[140] rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1 shadow-[var(--k-shadow-popover)] backdrop-blur-xl"
                >
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {queryLower ? 'Подходящие теги' : 'Предложения тегов'}
                  </div>
                  <div className="max-h-[210px] overflow-y-auto flex flex-col gap-0.5">
                    {options.map((opt, idx) => {
                      const active = idx === activeIndex % options.length;
                      return (
                        <button
                          key={`${opt.kind}-${opt.tag}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          data-testid={`inline-tag-option-${opt.tag}`}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            addTag(opt.tag);
                          }}
                          className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] cursor-pointer transition-colors duration-100 ${
                            active
                              ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                              : 'text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)]'
                          }`}
                        >
                          {opt.kind === 'create' ? (
                            <>
                              <Plus weight="bold" className="w-3.5 h-3.5 shrink-0 text-[var(--k-accent)]" />
                              <span className="truncate">Создать «#{opt.tag}»</span>
                            </>
                          ) : (
                            <>
                              <Hash
                                weight="bold"
                                className={`w-3 h-3 shrink-0 ${
                                  active ? 'text-[var(--k-accent)]' : 'text-[var(--k-ink-muted)]'
                                }`}
                              />
                              <span className="truncate">{opt.tag}</span>
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
};
