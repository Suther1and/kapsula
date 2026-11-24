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
  Microphone,
  Minus,
  Plus,
  RocketLaunch,
  Sparkle,
  SunHorizon,
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

      <button
        type="button"
        data-testid="studio-insert-image-btn"
        disabled={insertingImage}
        onClick={() => runAndClose(onPickImage)}
        className="k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer disabled:opacity-55"
      >
        <span className="inline-flex items-center gap-2">
          {insertingImage ? (
            <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin text-[var(--k-accent)] shrink-0" />
          ) : (
            <ImageSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
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
        <CheckSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
        <span>{t('note.studio.insert.checklist')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().toggleCodeBlock().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Code className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
        <span>{t('note.studio.insert.code')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(() => editor.chain().focus().setHorizontalRule().run())}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Minus className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
        <span>{t('note.studio.cmd.hr.label')}</span>
      </button>

      <button
        type="button"
        onClick={() => runAndClose(onStartDictation)}
        className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
      >
        <Microphone className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
        <span>{t('note.studio.insert.voice')}</span>
      </button>

      {onOpenAiMenu ? (
        <button
          type="button"
          onClick={() => runAndClose(onOpenAiMenu)}
          className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-left cursor-pointer"
        >
          <Sparkle weight="fill" className="w-3.5 h-3.5 shrink-0" />
          <span>{t('note.studio.cmd.ai.label')}</span>
        </button>
      ) : null}

      <div className="h-px bg-[var(--k-border-hairline)] my-1.5" />
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

      <div className="px-2 pt-1.5 text-[10.5px] text-[var(--k-ink-muted)] border-t border-[var(--k-border-hairline)]">
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
 * left gutter of the active prose line. Always follows the exact visual line
 * (even inside paragraphs containing inline block images) and freezes while the
 * pointer moves horizontally toward the `+` button so it never runs away.
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
  const gutterWrapRef = useRef<HTMLDivElement | null>(null);

  const computePosTop = useCallback(
    (pos: number): number | null => {
      if (!editor || editor.isDestroyed || !containerEl) return null;
      try {
        const clampedPos = Math.max(0, Math.min(pos, editor.state.doc.content.size));
        const coords = editor.view.coordsAtPos(clampedPos);
        const box = containerEl.getBoundingClientRect();
        if (box.height <= 0) return null;
        // If `coords` spans a tall inline image figure (> 56px), pin near its top row
        // rather than floating awkwardly in mid-air; for normal prose lines, center vertically.
        const lineHeight = Math.max(0, coords.bottom - coords.top);
        const anchorY =
          lineHeight > 56
            ? coords.top - box.top + 14
            : (coords.top + coords.bottom) / 2 - box.top;
        return Math.max(0, Math.min(Math.max(0, box.height - 26), Math.round(anchorY - 13)));
      } catch {
        return null;
      }
    },
    [editor, containerEl]
  );

  const syncToCaret = useCallback(() => {
    if (!editor || editor.isDestroyed || !containerEl) return;
    const y = computePosTop(editor.state.selection.from);
    if (y !== null) {
      setTopPx(y);
      setVisible(true);
    }
  }, [editor, containerEl, computePosTop]);

  useEffect(() => {
    if (!editor || !containerEl) return;
    const onSelection = () => syncToCaret();
    const onFocus = () => syncToCaret();
    editor.on('selectionUpdate', onSelection);
    editor.on('focus', onFocus);
    editor.on('update', onSelection);

    // Re-align after inline images finish loading or container height changes
    const onMediaLoad = () => syncToCaret();
    containerEl.addEventListener('load', onMediaLoad, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => syncToCaret());
      ro.observe(containerEl);
    }

    const raf = window.requestAnimationFrame(syncToCaret);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      containerEl.removeEventListener('load', onMediaLoad, true);
      editor.off('selectionUpdate', onSelection);
      editor.off('focus', onFocus);
      editor.off('update', onSelection);
    };
  }, [editor, containerEl, syncToCaret]);

  // Track mouse hover over exact visual lines (not just top-level `<p>` boxes, which break
  // whenever a paragraph contains an inline block image above a line of text).
  useEffect(() => {
    if (!containerEl || !editor) return;
    const onMouseMove = (e: MouseEvent) => {
      if (menuOpen || editor.isDestroyed) return;
      const targetNode = e.target as Node | null;
      if (gutterWrapRef.current?.contains(targetNode)) return;

      const proseRoot = containerEl.querySelector('.ProseMirror') as HTMLElement | null;
      if (!proseRoot) return;
      const proseRect = proseRoot.getBoundingClientRect();
      // Keep the `+` button steady while the pointer travels left into the gutter zone
      if (e.clientX < proseRect.left - 2) return;

      // If pointer is directly inside an inline image figure, align to the image figure top
      const imgFig = (targetNode instanceof Element ? targetNode : targetNode?.parentElement)?.closest(
        '.k-inline-image-figure'
      );
      if (imgFig) {
        const box = containerEl.getBoundingClientRect();
        const figRect = imgFig.getBoundingClientRect();
        const y = Math.max(0, Math.min(Math.max(0, box.height - 26), Math.round(figRect.top - box.top + 8)));
        setTopPx(y);
        setVisible(true);
        return;
      }

      // Resolve the exact ProseMirror line at pointer Y so text lines below an inline image
      // align directly next to the text instead of jumping up to the image.
      const probeX = Math.max(proseRect.left + 8, Math.min(e.clientX, proseRect.right - 8));
      const hit = editor.view.posAtCoords({ left: probeX, top: e.clientY });
      if (hit && typeof hit.pos === 'number') {
        const y = computePosTop(hit.pos);
        if (y !== null) {
          setTopPx(y);
          setVisible(true);
          return;
        }
      }

      // Fallback for empty lines / margins between top-level blocks
      const box = containerEl.getBoundingClientRect();
      const children = Array.from(proseRoot.children) as HTMLElement[];
      for (const child of children) {
        const rect = child.getBoundingClientRect();
        if (e.clientY >= rect.top - 4 && e.clientY <= rect.bottom + 4) {
          const y = Math.max(0, Math.min(Math.max(0, box.height - 26), Math.round(rect.top - box.top)));
          setTopPx(y);
          setVisible(true);
          return;
        }
      }
    };
    containerEl.addEventListener('mousemove', onMouseMove);
    return () => containerEl.removeEventListener('mousemove', onMouseMove);
  }, [containerEl, editor, menuOpen, computePosTop]);

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
      const menuW = 242;
      const estimatedH = 310;
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
        ref={gutterWrapRef}
        style={{ transform: `translate3d(0, ${topPx}px, 0)` }}
        className={`hidden sm:flex items-center justify-center absolute -left-9 top-0 z-10 transition-[transform,opacity] duration-120 ease-out ${
          visible || menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <button
          ref={buttonRef}
          type="button"
          data-no-press-scale="true"
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
                      : { opacity: 0, y: menuAnchor.flipUp ? 5 : -5 }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0 }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, y: menuAnchor.flipUp ? 3 : -3 }
                  }
                  transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
                  style={{
                    left: `${menuAnchor.left}px`,
                    ...(menuAnchor.flipUp
                      ? { bottom: `${window.innerHeight - menuAnchor.top}px` }
                      : { top: `${menuAnchor.top}px` }),
                    width: '242px',
                  }}
                  className="k-popover-card fixed z-[136] max-h-[72vh] overflow-y-auto p-2 text-[var(--k-ink-primary)]"
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
