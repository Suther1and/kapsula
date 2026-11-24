import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Editor } from '@tiptap/react';
import {
  CheckSquare,
  CircleNotch,
  Code,
  ImageSquare,
  Lightbulb,
  ListBullets,
  ListNumbers,
  Microphone,
  Minus,
  Plus,
  Quotes,
  RocketLaunch,
  Sparkle,
  SunHorizon,
  TextHOne,
  TextHThree,
  TextHTwo,
  UsersThree,
} from '@phosphor-icons/react';
import type { NoteTemplate } from '@shared/note-templates';
import { useI18n } from '@shared/i18n/react';
import { isMacPlatform } from '@shared/shortcuts';

const TEMPLATE_ICON_MAP = {
  meeting: UsersThree,
  idea: Lightbulb,
  project: RocketLaunch,
  day: SunHorizon,
} as const;

export interface InsertMenuContentProps {
  editor: Editor;
  insertingImage?: boolean;
  noteTemplates: readonly NoteTemplate[];
  onPickImage: () => void;
  onStartDictation: () => void;
  onOpenAiMenu?: () => void;
  onApplyTemplate: (tpl: NoteTemplate) => void;
  onClose: () => void;
}

export const InsertMenuContent: React.FC<InsertMenuContentProps> = ({
  editor,
  insertingImage = false,
  noteTemplates,
  onPickImage,
  onStartDictation,
  onOpenAiMenu,
  onApplyTemplate,
  onClose,
}) => {
  const { t } = useI18n();
  const isMac = isMacPlatform(window.kapsula?.platform);

  const runAndClose = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div className="space-y-0.5 text-[12.5px]">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
        {t('note.studio.insertHeading')}
      </div>

      <div className="grid grid-cols-3 gap-1 px-1 pb-1">
        <button
          type="button"
          onClick={() => runAndClose(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}
          className="k-interactive flex items-center justify-center h-7 rounded-lg bg-[var(--k-bg-surface-2)]/70 hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          title={t('note.studio.toolbar.h1')}
          aria-label={t('note.studio.toolbar.h1')}
        >
          <TextHOne weight="bold" className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => runAndClose(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}
          className="k-interactive flex items-center justify-center h-7 rounded-lg bg-[var(--k-bg-surface-2)]/70 hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          title={t('note.studio.toolbar.h2')}
          aria-label={t('note.studio.toolbar.h2')}
        >
          <TextHTwo weight="bold" className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => runAndClose(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}
          className="k-interactive flex items-center justify-center h-7 rounded-lg bg-[var(--k-bg-surface-2)]/70 hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          title={t('note.studio.toolbar.h3')}
          aria-label={t('note.studio.toolbar.h3')}
        >
          <TextHThree weight="bold" className="w-4 h-4" />
        </button>
      </div>

      <button
        type="button"
        data-testid="studio-insert-image-btn"
        disabled={insertingImage}
        onClick={() => runAndClose(onPickImage)}
        className="k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer disabled:opacity-55"
      >
        <span className="inline-flex items-center gap-2">
          {insertingImage ? (
            <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin text-[var(--k-accent)]" />
          ) : (
            <ImageSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
          )}
          <span>{t('note.studio.insert.photo')}</span>
        </span>
        <span className="k-mono text-[10px] text-[var(--k-ink-muted)]">
          {isMac ? '⌘V' : 'Ctrl+V'}
        </span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleTaskList().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <CheckSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.insert.checklist')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleBulletList().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <ListBullets className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.insert.list')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleOrderedList().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <ListNumbers className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.toolbar.orderedList')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleBlockquote().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Quotes className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.insert.quote')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleCodeBlock().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Code className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.insert.code')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().setHorizontalRule().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Minus className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.cmd.hr.label')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(onStartDictation)}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Microphone className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
        <span>{t('note.studio.insert.voice')}</span>
      </button>

      {onOpenAiMenu ? (
        <button
          type="button"
          onClick={() => runAndClose(onOpenAiMenu)}
          className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-left cursor-pointer"
        >
          <Sparkle weight="fill" className="w-3.5 h-3.5" />
          <span>{t('note.studio.cmd.ai.label')}</span>
        </button>
      ) : null}

      <div className="h-px bg-[var(--k-border-hairline)] my-1" />
      <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
        {t('note.studio.templates')}
      </div>
      <div className="grid grid-cols-2 gap-1 px-1 pb-0.5">
        {noteTemplates.map((tpl) => {
          const Icon = TEMPLATE_ICON_MAP[tpl.id];
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => runAndClose(() => onApplyTemplate(tpl))}
              className="k-interactive inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[var(--k-bg-surface-2)]/75 hover:bg-[var(--k-accent-soft)] text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)] cursor-pointer"
            >
              <Icon weight="duotone" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tpl.shortLabel}</span>
            </button>
          );
        })}
      </div>

      <div className="px-2 pt-1 text-[10.5px] text-[var(--k-ink-muted)] border-t border-[var(--k-border-hairline)]">
        {t('note.studio.slashHint')}
      </div>
    </div>
  );
};

interface BlockInsertGutterProps {
  editor: Editor | null;
  containerEl: HTMLDivElement | null;
  insertingImage?: boolean;
  noteTemplates: readonly NoteTemplate[];
  onPickImage: () => void;
  onStartDictation: () => void;
  onOpenAiMenu?: () => void;
  onApplyTemplate: (tpl: NoteTemplate) => void;
}

/**
 * Notion-style cursor & hover-following `+` block insert button sitting in the
 * left gutter of the active prose line. Always follows where the user writes or
 * hovers — never forces scrolling back to the top to insert blocks or media.
 */
export const BlockInsertGutter: React.FC<BlockInsertGutterProps> = ({
  editor,
  containerEl,
  insertingImage = false,
  noteTemplates,
  onPickImage,
  onStartDictation,
  onOpenAiMenu,
  onApplyTemplate,
}) => {
  const { t } = useI18n();
  const prefersReduced = useReducedMotion();
  const [topPx, setTopPx] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; top: number; flipUp: boolean } | null>(
    null
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const syncToCaret = useCallback(() => {
    if (!editor || editor.isDestroyed || !containerEl) return;
    try {
      const { from } = editor.state.selection;
      const coords = editor.view.coordsAtPos(from);
      const box = containerEl.getBoundingClientRect();
      const lineMid = (coords.top + coords.bottom) / 2 - box.top;
      const clamped = Math.max(0, Math.min(Math.max(0, box.height - 26), Math.round(lineMid - 13)));
      setTopPx(clamped);
      setVisible(true);
    } catch {
      // ignore invalid pos during rapid switches
    }
  }, [editor, containerEl]);

  useEffect(() => {
    if (!editor || !containerEl) return;
    const onSelection = () => syncToCaret();
    const onFocus = () => syncToCaret();
    editor.on('selectionUpdate', onSelection);
    editor.on('focus', onFocus);
    editor.on('update', onSelection);
    // Initial gentle alignment to first line
    const raf = window.requestAnimationFrame(syncToCaret);
    return () => {
      window.cancelAnimationFrame(raf);
      editor.off('selectionUpdate', onSelection);
      editor.off('focus', onFocus);
      editor.off('update', onSelection);
    };
  }, [editor, containerEl, syncToCaret]);

  // Also track mouse hover over prose blocks so clicking `+` next to any paragraph works effortlessly
  useEffect(() => {
    if (!containerEl) return;
    const onMouseMove = (e: MouseEvent) => {
      if (menuOpen) return;
      const proseRoot = containerEl.querySelector('.ProseMirror');
      if (!proseRoot) return;
      const box = containerEl.getBoundingClientRect();
      const children = Array.from(proseRoot.children) as HTMLElement[];
      if (children.length === 0) return;
      let target: HTMLElement | null = null;
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        if (e.clientY >= rect.top - 4 && e.clientY <= rect.bottom + 4) {
          target = child;
          break;
        }
      }
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const lineOffset = Math.min(13, rect.height / 2);
      const y = Math.max(0, Math.round(rect.top - box.top + lineOffset - 13));
      setTopPx(y);
      setVisible(true);
    };
    containerEl.addEventListener('mousemove', onMouseMove);
    return () => containerEl.removeEventListener('mousemove', onMouseMove);
  }, [containerEl, menuOpen]);

  // Close popover on outside click / Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpen]);

  const handleToggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const btnRect = buttonRef.current?.getBoundingClientRect();
    if (btnRect) {
      const menuW = 246;
      const estimatedH = 380;
      const spaceBelow = window.innerHeight - btnRect.bottom - 14;
      const flipUp = spaceBelow < estimatedH && btnRect.top > spaceBelow;
      const left = Math.max(12, Math.min(window.innerWidth - menuW - 12, btnRect.left));
      const top = flipUp ? Math.max(12, btnRect.top - 8) : Math.min(window.innerHeight - 16, btnRect.bottom + 6);
      setMenuAnchor({ left, top, flipUp });
    }
    setMenuOpen(true);
  };

  if (!editor || topPx === null) return null;

  return (
    <>
      <div
        style={{ transform: `translate3d(0, ${topPx}px, 0)` }}
        className={`hidden sm:flex items-center justify-center absolute -left-9 top-0 z-10 transition-[transform,opacity] duration-120 ease-out ${
          visible || menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <button
          ref={buttonRef}
          type="button"
          data-testid="studio-gutter-insert-btn"
          aria-label={t('note.studio.gutterInsertHint')}
          title={t('note.studio.gutterInsertHint')}
          onMouseDown={(e) => {
            // Keep editor selection intact so inserted block lands at the active line
            e.preventDefault();
          }}
          onClick={handleToggleMenu}
          className={`k-interactive w-[26px] h-[26px] rounded-lg border flex items-center justify-center cursor-pointer transition-colors ${
            menuOpen
              ? 'border-[var(--k-accent)]/45 bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
              : 'border-transparent hover:border-[var(--k-border-hairline)] bg-transparent hover:bg-[var(--k-bg-surface-2)] text-[var(--k-ink-muted)]/70 hover:text-[var(--k-ink-primary)]'
          }`}
        >
          {insertingImage ? (
            <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin text-[var(--k-accent)]" />
          ) : (
            <Plus weight="bold" className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {menuOpen && menuAnchor ? (
                <motion.div
                  ref={menuRef}
                  key="gutter-insert-popover"
                  data-testid="studio-gutter-insert-menu"
                  initial={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.96, y: menuAnchor.flipUp ? 4 : -4 }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, scale: 1, y: 0 }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.97, y: menuAnchor.flipUp ? 3 : -3 }
                  }
                  transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
                  style={{
                    left: `${menuAnchor.left}px`,
                    ...(menuAnchor.flipUp
                      ? { bottom: `${window.innerHeight - menuAnchor.top}px` }
                      : { top: `${menuAnchor.top}px` }),
                    width: '246px',
                    transformOrigin: menuAnchor.flipUp ? 'bottom left' : 'top left',
                  }}
                  className="fixed z-[136] max-h-[72vh] overflow-y-auto rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-2 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] backdrop-blur-xl"
                >
                  <InsertMenuContent
                    editor={editor}
                    insertingImage={insertingImage}
                    noteTemplates={noteTemplates}
                    onPickImage={onPickImage}
                    onStartDictation={onStartDictation}
                    onOpenAiMenu={onOpenAiMenu}
                    onApplyTemplate={onApplyTemplate}
                    onClose={() => setMenuOpen(false)}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </>
  );
};
