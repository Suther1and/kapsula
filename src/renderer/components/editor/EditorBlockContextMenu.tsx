import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  CaretRight,
  Check,
  CheckSquare,
  ClipboardText,
  Code,
  Copy,
  CopySimple,
  ListBullets,
  ListNumbers,
  MagnifyingGlassPlus,
  Scissors,
  Square,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextT,
  Trash,
} from '@phosphor-icons/react';
import {
  sanitizeHrVariant,
  type HorizontalRuleVariant,
} from '@shared/tiptap-rich-marks';
import { useI18n } from '@shared/i18n/react';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

export type EditorBlockKind =
  | 'horizontalRule'
  | 'codeBlock'
  | 'blockquote'
  | 'taskList'
  | 'bulletList'
  | 'orderedList'
  | 'heading'
  | 'kapsulaImage';

export interface ResolvedEditorBlock {
  kind: EditorBlockKind;
  pos: number;
  dom: HTMLElement;
}

interface MenuItemSpec {
  type: 'item';
  id: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface MenuSeparatorSpec {
  type: 'separator';
  id: string;
}

interface MenuLabelSpec {
  type: 'label';
  id: string;
  label: string;
}

interface MenuSubmenuSpec {
  type: 'submenu';
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string;
  items: MenuItemSpec[];
}

type BlockMenuEntry = MenuItemSpec | MenuSeparatorSpec | MenuLabelSpec | MenuSubmenuSpec;

const CODE_LANGUAGES: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: '__auto__' },
  { id: 'plaintext', label: '__plain__' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'bash', label: 'Bash / Shell' },
  { id: 'sql', label: 'SQL' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'markdown', label: 'Markdown' },
];

const HR_STYLE_META: ReadonlyArray<{
  variant: HorizontalRuleVariant;
  labelKey:
    | 'note.studio.blockCtx.hrSolid'
    | 'note.studio.blockCtx.hrDashed'
    | 'note.studio.blockCtx.hrDots'
    | 'note.studio.blockCtx.hrFade'
    | 'note.studio.blockCtx.hrAccent';
}> = [
  { variant: 'solid', labelKey: 'note.studio.blockCtx.hrSolid' },
  { variant: 'dashed', labelKey: 'note.studio.blockCtx.hrDashed' },
  { variant: 'dots', labelKey: 'note.studio.blockCtx.hrDots' },
  { variant: 'fade', labelKey: 'note.studio.blockCtx.hrFade' },
  { variant: 'accent', labelKey: 'note.studio.blockCtx.hrAccent' },
];

function HrVariantGlyph({ variant }: { variant: HorizontalRuleVariant }) {
  if (variant === 'dashed') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-3.5 shrink-0">
        <span className="w-3.5 border-t-[1.5px] border-dashed border-current opacity-85" />
      </span>
    );
  }
  if (variant === 'dots') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-3.5 text-[10px] leading-none tracking-[1px] shrink-0 opacity-85">
        •••
      </span>
    );
  }
  if (variant === 'fade') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-3.5 shrink-0">
        <span
          className="w-3.5 h-[1.5px] rounded-full"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, currentColor 35%, currentColor 65%, transparent 100%)',
          }}
        />
      </span>
    );
  }
  if (variant === 'accent') {
    return (
      <span className="inline-flex items-center justify-center w-4 h-3.5 shrink-0">
        <span className="w-3 h-[2px] rounded-full bg-[var(--k-accent)]" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-4 h-3.5 shrink-0">
      <span className="w-3.5 h-[1.5px] rounded-full bg-current opacity-80" />
    </span>
  );
}

/**
 * Resolves which structural editor block was right-clicked along with its exact ProseMirror document position.
 * Returns null for regular paragraphs so native text/spellcheck behavior stays untouched.
 */
export function resolveEditorBlockAtTarget(
  editor: Editor,
  rawTarget: EventTarget | null
): ResolvedEditorBlock | null {
  if (!editor || editor.isDestroyed) return null;
  const el =
    rawTarget instanceof HTMLElement
      ? rawTarget
      : rawTarget instanceof Node
        ? rawTarget.parentElement
        : null;
  if (!el) return null;

  const proseRoot = editor.view.dom;
  if (!proseRoot.contains(el)) return null;

  const candidates: Array<{ selector: string; kind: EditorBlockKind }> = [
    { selector: 'hr', kind: 'horizontalRule' },
    { selector: '.k-inline-image-figure', kind: 'kapsulaImage' },
    { selector: 'pre', kind: 'codeBlock' },
    { selector: 'blockquote', kind: 'blockquote' },
    { selector: 'h1, h2, h3, h4, h5, h6', kind: 'heading' },
    { selector: 'ul[data-type="taskList"]', kind: 'taskList' },
    { selector: 'ul', kind: 'bulletList' },
    { selector: 'ol', kind: 'orderedList' },
  ];

  // Pick the closest (innermost) matching structural block inside `.ProseMirror`
  let matchedEl: HTMLElement | null = null;
  let matchedKind: EditorBlockKind | null = null;
  let cur: HTMLElement | null = el;
  while (cur && cur !== proseRoot) {
    for (const c of candidates) {
      if (cur.matches(c.selector)) {
        matchedEl = cur;
        matchedKind = c.kind;
        break;
      }
    }
    if (matchedEl) break;
    cur = cur.parentElement;
  }

  if (!matchedEl || !matchedKind) return null;

  // Locate exact ProseMirror node position by matching DOM ownership
  let resolvedPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (resolvedPos !== null) return false;
    if (node.type.name !== matchedKind) return true;
    const dom = editor.view.nodeDOM(pos);
    if (
      dom === matchedEl ||
      (dom instanceof HTMLElement && (dom.contains(matchedEl) || matchedEl.contains(dom)))
    ) {
      resolvedPos = pos;
      return false;
    }
    return true;
  });

  // Fallback via posAtDOM ancestor lookup
  if (resolvedPos === null) {
    try {
      const rawPos = editor.view.posAtDOM(matchedEl, 0);
      const $pos = editor.state.doc.resolve(
        Math.max(0, Math.min(rawPos, editor.state.doc.content.size))
      );
      for (let d = $pos.depth; d >= 0; d -= 1) {
        if ($pos.node(d).type.name === matchedKind) {
          resolvedPos = d === 0 ? 0 : $pos.before(d);
          break;
        }
      }
    } catch {
      resolvedPos = null;
    }
  }

  if (resolvedPos === null) return null;
  return { kind: matchedKind, pos: resolvedPos, dom: matchedEl };
}

interface EditorBlockContextMenuProps {
  editor: Editor | null;
  containerEl: HTMLElement | null;
  onOpenImageLightbox?: (src: string, alt: string) => void;
}

interface OpenMenuState {
  block: ResolvedEditorBlock;
  clientX: number;
  clientY: number;
}

interface HighlightTrack {
  id: string;
  top: number;
  height: number;
  danger: boolean;
  visible: boolean;
  animatePosition: boolean;
}

export const EditorBlockContextMenu: React.FC<EditorBlockContextMenuProps> = ({
  editor,
  containerEl,
  onOpenImageLightbox,
}) => {
  const { t } = useI18n();
  const prefersReduced = useReducedMotion();
  const scopedAccentStyle = useScopedAccentStyle();
  const [menuState, setMenuState] = useState<OpenMenuState | null>(null);
  const [submenuOpenId, setSubmenuOpenId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [hl, setHl] = useState<HighlightTrack | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const highlightedDomRef = useRef<HTMLElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenuState(null);
    setSubmenuOpenId(null);
    setHl(null);
  }, []);

  // Visually highlight the targeted block while its context menu is open
  useEffect(() => {
    if (highlightedDomRef.current) {
      highlightedDomRef.current.removeAttribute('data-k-ctx-target');
      highlightedDomRef.current = null;
    }
    if (menuState?.block.dom) {
      menuState.block.dom.setAttribute('data-k-ctx-target', 'true');
      highlightedDomRef.current = menuState.block.dom;
    }
    return () => {
      if (highlightedDomRef.current) {
        highlightedDomRef.current.removeAttribute('data-k-ctx-target');
        highlightedDomRef.current = null;
      }
    };
  }, [menuState]);

  // Listen for right-click on editor structural blocks
  useEffect(() => {
    if (!editor || !containerEl) return;
    const onContextMenu = (e: MouseEvent) => {
      if (editor.isDestroyed) return;
      const resolved = resolveEditorBlockAtTarget(editor, e.target);
      if (!resolved) {
        setMenuState(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setSubmenuOpenId(null);
      setHl(null);
      setMenuState({
        block: resolved,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    };
    containerEl.addEventListener('contextmenu', onContextMenu);
    return () => containerEl.removeEventListener('contextmenu', onContextMenu);
  }, [editor, containerEl]);

  // Clamp popup coordinates inside viewport after render
  useLayoutEffect(() => {
    if (!menuState || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const pad = 10;
    const left = Math.max(
      pad,
      Math.min(menuState.clientX, window.innerWidth - rect.width - pad)
    );
    const top = Math.max(
      pad,
      Math.min(menuState.clientY, window.innerHeight - rect.height - pad)
    );
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [menuState, submenuOpenId]);

  // Dismiss on outside click, Escape, scroll, or window blur
  useEffect(() => {
    if (!menuState) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
      }
    };
    const onScroll = () => closeMenu();
    const onBlur = () => closeMenu();
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [menuState, closeMenu]);

  const focusRow = useCallback((id: string, danger = false) => {
    const el = rowRefs.current.get(id);
    if (!el) return;
    const top = Math.round(el.offsetTop);
    const height = Math.round(el.offsetHeight);
    setHl((prev) => ({
      id,
      top,
      height,
      danger,
      visible: true,
      animatePosition: Boolean(prev?.visible),
    }));
  }, []);

  if (!editor || editor.isDestroyed || !menuState || typeof document === 'undefined') {
    return null;
  }

  const { block } = menuState;
  const targetNode = editor.state.doc.nodeAt(block.pos);
  if (!targetNode || targetNode.type.name !== block.kind) {
    return null;
  }

  const runAndClose = (fn: () => void) => {
    closeMenu();
    fn();
  };

  const deleteBlock = () => {
    const { state, view } = editor;
    const live = state.doc.nodeAt(block.pos);
    if (!live) return;
    const tr = state.tr.delete(block.pos, block.pos + live.nodeSize);
    const safePos = Math.max(0, Math.min(block.pos, tr.doc.content.size));
    try {
      tr.setSelection(TextSelection.near(tr.doc.resolve(safePos)));
    } catch {
      // Fallback to default selection
    }
    view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };

  const duplicateBlock = () => {
    const { state, view } = editor;
    const live = state.doc.nodeAt(block.pos);
    if (!live) return;
    const insertAt = block.pos + live.nodeSize;
    const copy = live.type.create(live.attrs, live.content, live.marks);
    const tr = state.tr.insert(insertAt, copy);
    view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };

  const insertParagraphAdjacent = (where: 'above' | 'below') => {
    const { state, view } = editor;
    const live = state.doc.nodeAt(block.pos);
    const pType = state.schema.nodes.paragraph;
    if (!live || !pType) return;

    // For inline images inside a paragraph, anchor around the enclosing top-level block
    let insertPos = where === 'above' ? block.pos : block.pos + live.nodeSize;
    if (block.kind === 'kapsulaImage') {
      const $p = state.doc.resolve(block.pos);
      if ($p.depth >= 1) {
        insertPos = where === 'above' ? $p.before(1) : $p.after(1);
      }
    }

    const tr = state.tr.insert(insertPos, pType.create());
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(insertPos + 1, tr.doc.content.size)));
    } catch {
      // Ignore selection fallback
    }
    view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };

  const convertBlockToParagraph = () => {
    const { state, view } = editor;
    const live = state.doc.nodeAt(block.pos);
    const pType = state.schema.nodes.paragraph;
    if (!live || !pType) return;

    if (block.kind === 'codeBlock') {
      const lines = live.textContent.split(/\r?\n/);
      const nodes = lines.map((line) =>
        line ? pType.create(null, state.schema.text(line)) : pType.create()
      );
      const tr = state.tr.replaceWith(block.pos, block.pos + live.nodeSize, nodes);
      try {
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(block.pos + 1, tr.doc.content.size))));
      } catch {
        // Ignore
      }
      view.dispatch(tr.scrollIntoView());
      editor.commands.focus();
      return;
    }

    // Place selection inside the block and use standard TipTap commands for blockquote/heading/lists
    const insidePos = Math.min(block.pos + 1, state.doc.content.size);
    const chain = editor.chain().focus().setTextSelection(insidePos);
    if (block.kind === 'blockquote') {
      chain.lift('blockquote').run();
    } else if (block.kind === 'heading') {
      chain.setParagraph().run();
    } else if (block.kind === 'taskList') {
      chain.toggleTaskList().run();
    } else if (block.kind === 'bulletList') {
      chain.toggleBulletList().run();
    } else if (block.kind === 'orderedList') {
      chain.toggleOrderedList().run();
    }
  };

  const setAllTaskItemsChecked = (checked: boolean) => {
    const { state, view } = editor;
    const live = state.doc.nodeAt(block.pos);
    if (!live || live.type.name !== 'taskList') return;
    const tr = state.tr;
    live.descendants((child, relPos) => {
      if (child.type.name === 'taskItem') {
        const absPos = block.pos + 1 + relPos;
        tr.setNodeMarkup(absPos, undefined, { ...child.attrs, checked });
      }
      return true;
    });
    view.dispatch(tr);
    editor.commands.focus();
  };

  // Optional clipboard entries when text is actively selected inside a text-bearing block
  const sel = editor.state.selection;
  const hasTextSelection =
    !sel.empty &&
    block.kind !== 'horizontalRule' &&
    block.kind !== 'kapsulaImage' &&
    sel.from >= block.pos &&
    sel.to <= block.pos + targetNode.nodeSize;

  const entries: BlockMenuEntry[] = [];

  if (hasTextSelection) {
    const selectedText = editor.state.doc.textBetween(sel.from, sel.to, '\n');
    entries.push(
      {
        type: 'item',
        id: 'copy-sel',
        label: t('note.studio.blockCtx.copySelection'),
        icon: <Copy className="w-3.5 h-3.5" />,
        onSelect: () => {
          if (selectedText) void navigator.clipboard?.writeText(selectedText);
        },
      },
      {
        type: 'item',
        id: 'cut-sel',
        label: t('note.studio.blockCtx.cutSelection'),
        icon: <Scissors className="w-3.5 h-3.5" />,
        onSelect: () => {
          if (selectedText) void navigator.clipboard?.writeText(selectedText);
          editor.chain().focus().deleteSelection().run();
        },
      },
      {
        type: 'item',
        id: 'paste-sel',
        label: t('note.studio.blockCtx.paste'),
        icon: <ClipboardText className="w-3.5 h-3.5" />,
        onSelect: () => {
          void navigator.clipboard?.readText().then((clip) => {
            if (clip) editor.chain().focus().insertContent(clip).run();
          });
        },
      },
      { type: 'separator', id: 'sep-sel' }
    );
  }

  if (block.kind === 'horizontalRule') {
    const currentVariant = sanitizeHrVariant(targetNode.attrs?.variant);
    entries.push({ type: 'label', id: 'lbl-hr', label: t('note.studio.blockCtx.hr') });
    for (const meta of HR_STYLE_META) {
      entries.push({
        type: 'item',
        id: `hr-var-${meta.variant}`,
        label: t(meta.labelKey),
        icon: <HrVariantGlyph variant={meta.variant} />,
        active: currentVariant === meta.variant,
        onSelect: () => {
          const { state, view } = editor;
          const live = state.doc.nodeAt(block.pos);
          if (!live || live.type.name !== 'horizontalRule') return;
          const tr = state.tr.setNodeMarkup(block.pos, undefined, {
            ...live.attrs,
            variant: meta.variant,
          });
          view.dispatch(tr);
        },
      });
    }
    entries.push(
      { type: 'separator', id: 'sep-hr-nav' },
      {
        type: 'item',
        id: 'ins-above',
        label: t('note.studio.blockCtx.insertAbove'),
        icon: <ArrowUp className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('above'),
      },
      {
        type: 'item',
        id: 'ins-below',
        label: t('note.studio.blockCtx.insertBelow'),
        icon: <ArrowDown className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('below'),
      },
      {
        type: 'item',
        id: 'dup-hr',
        label: t('note.studio.blockCtx.duplicate'),
        icon: <CopySimple className="w-3.5 h-3.5" />,
        onSelect: duplicateBlock,
      },
      { type: 'separator', id: 'sep-hr-del' },
      {
        type: 'item',
        id: 'del-hr',
        label: t('note.studio.blockCtx.deleteHr'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  } else if (block.kind === 'codeBlock') {
    const curLang = (targetNode.attrs?.language as string | null | undefined) ?? null;
    const curLangLabel =
      curLang === null || curLang === ''
        ? t('note.studio.blockCtx.languageAuto')
        : curLang === 'plaintext'
          ? t('note.studio.blockCtx.languagePlain')
          : CODE_LANGUAGES.find((l) => l.id === curLang)?.label ?? curLang;

    entries.push(
      { type: 'label', id: 'lbl-code', label: t('note.studio.blockCtx.codeBlock') },
      {
        type: 'item',
        id: 'copy-all-code',
        label: t('note.studio.blockCtx.copyCode'),
        icon: <Copy className="w-3.5 h-3.5" />,
        onSelect: () => {
          void navigator.clipboard?.writeText(targetNode.textContent);
          toast.success(t('note.studio.blockCtx.copiedCode'));
        },
      },
      {
        type: 'submenu',
        id: 'code-lang',
        label: t('note.studio.blockCtx.language'),
        icon: <Code className="w-3.5 h-3.5" />,
        badge: curLangLabel,
        items: CODE_LANGUAGES.map((lang) => {
          const label =
            lang.label === '__auto__'
              ? t('note.studio.blockCtx.languageAuto')
              : lang.label === '__plain__'
                ? t('note.studio.blockCtx.languagePlain')
                : lang.label;
          const active =
            (lang.id === null && (!curLang || curLang === '')) || curLang === lang.id;
          return {
            type: 'item',
            id: `lang-${lang.id ?? 'auto'}`,
            label,
            active,
            onSelect: () => {
              const { state, view } = editor;
              const live = state.doc.nodeAt(block.pos);
              if (!live || live.type.name !== 'codeBlock') return;
              const tr = state.tr.setNodeMarkup(block.pos, undefined, {
                ...live.attrs,
                language: lang.id,
              });
              view.dispatch(tr);
            },
          };
        }),
      },
      {
        type: 'item',
        id: 'code-to-text',
        label: t('note.studio.blockCtx.toParagraph'),
        icon: <TextT className="w-3.5 h-3.5" />,
        onSelect: convertBlockToParagraph,
      },
      { type: 'separator', id: 'sep-code-nav' },
      {
        type: 'item',
        id: 'ins-above',
        label: t('note.studio.blockCtx.insertAbove'),
        icon: <ArrowUp className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('above'),
      },
      {
        type: 'item',
        id: 'ins-below',
        label: t('note.studio.blockCtx.insertBelow'),
        icon: <ArrowDown className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('below'),
      },
      {
        type: 'item',
        id: 'dup-code',
        label: t('note.studio.blockCtx.duplicate'),
        icon: <CopySimple className="w-3.5 h-3.5" />,
        onSelect: duplicateBlock,
      },
      { type: 'separator', id: 'sep-code-del' },
      {
        type: 'item',
        id: 'del-code',
        label: t('note.studio.blockCtx.deleteCode'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  } else if (block.kind === 'blockquote') {
    entries.push(
      { type: 'label', id: 'lbl-quote', label: t('note.studio.blockCtx.blockquote') },
      {
        type: 'item',
        id: 'quote-to-text',
        label: t('note.studio.blockCtx.toParagraph'),
        icon: <TextT className="w-3.5 h-3.5" />,
        onSelect: convertBlockToParagraph,
      },
      {
        type: 'item',
        id: 'quote-to-code',
        label: t('note.studio.blockCtx.toCodeBlock'),
        icon: <Code className="w-3.5 h-3.5" />,
        onSelect: () => {
          const { state, view } = editor;
          const live = state.doc.nodeAt(block.pos);
          const codeType = state.schema.nodes.codeBlock;
          if (!live || !codeType) return;
          const text = live.textContent;
          const codeNode = text
            ? codeType.create(null, state.schema.text(text))
            : codeType.create();
          const tr = state.tr.replaceWith(block.pos, block.pos + live.nodeSize, codeNode);
          view.dispatch(tr.scrollIntoView());
          editor.commands.focus();
        },
      },
      {
        type: 'item',
        id: 'ins-below',
        label: t('note.studio.blockCtx.insertBelow'),
        icon: <ArrowDown className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('below'),
      },
      {
        type: 'item',
        id: 'dup-quote',
        label: t('note.studio.blockCtx.duplicate'),
        icon: <CopySimple className="w-3.5 h-3.5" />,
        onSelect: duplicateBlock,
      },
      { type: 'separator', id: 'sep-quote-del' },
      {
        type: 'item',
        id: 'del-quote',
        label: t('note.studio.blockCtx.deleteQuote'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  } else if (block.kind === 'heading') {
    const level = Number(targetNode.attrs?.level ?? 1);
    entries.push(
      { type: 'label', id: 'lbl-heading', label: t('note.studio.blockCtx.heading') },
      {
        type: 'item',
        id: 'h-1',
        label: t('note.studio.blockCtx.heading1'),
        icon: <TextHOne className="w-3.5 h-3.5" />,
        active: level === 1,
        onSelect: () => {
          const { state, view } = editor;
          const live = state.doc.nodeAt(block.pos);
          if (!live) return;
          view.dispatch(state.tr.setNodeMarkup(block.pos, undefined, { ...live.attrs, level: 1 }));
        },
      },
      {
        type: 'item',
        id: 'h-2',
        label: t('note.studio.blockCtx.heading2'),
        icon: <TextHTwo className="w-3.5 h-3.5" />,
        active: level === 2,
        onSelect: () => {
          const { state, view } = editor;
          const live = state.doc.nodeAt(block.pos);
          if (!live) return;
          view.dispatch(state.tr.setNodeMarkup(block.pos, undefined, { ...live.attrs, level: 2 }));
        },
      },
      {
        type: 'item',
        id: 'h-3',
        label: t('note.studio.blockCtx.heading3'),
        icon: <TextHThree className="w-3.5 h-3.5" />,
        active: level === 3,
        onSelect: () => {
          const { state, view } = editor;
          const live = state.doc.nodeAt(block.pos);
          if (!live) return;
          view.dispatch(state.tr.setNodeMarkup(block.pos, undefined, { ...live.attrs, level: 3 }));
        },
      },
      {
        type: 'item',
        id: 'h-text',
        label: t('note.studio.blockCtx.toParagraph'),
        icon: <TextT className="w-3.5 h-3.5" />,
        onSelect: convertBlockToParagraph,
      },
      { type: 'separator', id: 'sep-h-del' },
      {
        type: 'item',
        id: 'dup-h',
        label: t('note.studio.blockCtx.duplicate'),
        icon: <CopySimple className="w-3.5 h-3.5" />,
        onSelect: duplicateBlock,
      },
      {
        type: 'item',
        id: 'del-h',
        label: t('note.studio.blockCtx.deleteHeading'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  } else if (
    block.kind === 'taskList' ||
    block.kind === 'bulletList' ||
    block.kind === 'orderedList'
  ) {
    const labelKey =
      block.kind === 'taskList'
        ? 'note.studio.blockCtx.taskList'
        : block.kind === 'bulletList'
          ? 'note.studio.blockCtx.bulletList'
          : 'note.studio.blockCtx.orderedList';
    const selectListRange = () => {
      const from = Math.min(block.pos + 2, editor.state.doc.content.size);
      const to = Math.max(from, Math.min(block.pos + targetNode.nodeSize - 2, editor.state.doc.content.size));
      return editor.chain().focus().setTextSelection({ from, to });
    };

    entries.push({ type: 'label', id: 'lbl-list', label: t(labelKey) });
    if (block.kind !== 'taskList') {
      entries.push({
        type: 'item',
        id: 'to-task',
        label: t('note.studio.blockCtx.toTaskList'),
        icon: <CheckSquare className="w-3.5 h-3.5" />,
        onSelect: () => selectListRange().toggleTaskList().run(),
      });
    }
    if (block.kind !== 'bulletList') {
      entries.push({
        type: 'item',
        id: 'to-bullet',
        label: t('note.studio.blockCtx.toBulletList'),
        icon: <ListBullets className="w-3.5 h-3.5" />,
        onSelect: () => selectListRange().toggleBulletList().run(),
      });
    }
    if (block.kind !== 'orderedList') {
      entries.push({
        type: 'item',
        id: 'to-ordered',
        label: t('note.studio.blockCtx.toOrderedList'),
        icon: <ListNumbers className="w-3.5 h-3.5" />,
        onSelect: () => selectListRange().toggleOrderedList().run(),
      });
    }
    if (block.kind === 'taskList') {
      entries.push(
        {
          type: 'item',
          id: 'check-all',
          label: t('note.studio.blockCtx.checkAll'),
          icon: <CheckSquare className="w-3.5 h-3.5" />,
          onSelect: () => setAllTaskItemsChecked(true),
        },
        {
          type: 'item',
          id: 'uncheck-all',
          label: t('note.studio.blockCtx.uncheckAll'),
          icon: <Square className="w-3.5 h-3.5" />,
          onSelect: () => setAllTaskItemsChecked(false),
        }
      );
    }
    entries.push(
      {
        type: 'item',
        id: 'list-to-text',
        label: t('note.studio.blockCtx.toParagraph'),
        icon: <TextT className="w-3.5 h-3.5" />,
        onSelect: () => {
          const chain = selectListRange();
          if (block.kind === 'taskList') chain.toggleTaskList().run();
          else if (block.kind === 'bulletList') chain.toggleBulletList().run();
          else chain.toggleOrderedList().run();
        },
      },
      { type: 'separator', id: 'sep-list-del' },
      {
        type: 'item',
        id: 'del-list',
        label: t('note.studio.blockCtx.deleteList'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  } else if (block.kind === 'kapsulaImage') {
    const src = String(targetNode.attrs?.src ?? '');
    const alt = String(targetNode.attrs?.alt ?? '');
    entries.push({ type: 'label', id: 'lbl-img', label: t('note.studio.blockCtx.image') });
    if (src && onOpenImageLightbox) {
      entries.push({
        type: 'item',
        id: 'open-img',
        label: t('note.studio.blockCtx.openImage'),
        icon: <MagnifyingGlassPlus className="w-3.5 h-3.5" />,
        onSelect: () => onOpenImageLightbox(src, alt),
      });
    }
    entries.push(
      {
        type: 'item',
        id: 'ins-above',
        label: t('note.studio.blockCtx.insertAbove'),
        icon: <ArrowUp className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('above'),
      },
      {
        type: 'item',
        id: 'ins-below',
        label: t('note.studio.blockCtx.insertBelow'),
        icon: <ArrowDown className="w-3.5 h-3.5" />,
        onSelect: () => insertParagraphAdjacent('below'),
      },
      { type: 'separator', id: 'sep-img-del' },
      {
        type: 'item',
        id: 'del-img',
        label: t('note.studio.blockCtx.deleteImage'),
        icon: <Trash className="w-3.5 h-3.5" />,
        danger: true,
        onSelect: deleteBlock,
      }
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-testid="editor-block-context-menu"
      data-block-kind={block.kind}
      style={{
        ...scopedAccentStyle,
        left: `${pos.left}px`,
        top: `${pos.top}px`,
      }}
      onContextMenu={(e) => e.preventDefault()}
      className="k-popover-card fixed z-[140] min-w-[214px] max-w-[276px] p-1.5 outline-none text-[var(--k-ink-primary)]"
    >
      <div
        className="relative flex flex-col gap-0.5"
        onMouseLeave={() =>
          setHl((prev) => (prev ? { ...prev, visible: false, animatePosition: false } : null))
        }
      >
        {hl ? (
          <span
            aria-hidden="true"
            style={{
              transform: `translate3d(0, ${hl.top}px, 0)`,
              height: `${hl.height}px`,
              opacity: hl.visible ? 1 : 0,
              transition: prefersReduced
                ? 'none'
                : hl.animatePosition
                  ? 'transform 110ms cubic-bezier(0.22, 1, 0.36, 1), height 110ms cubic-bezier(0.22, 1, 0.36, 1), opacity 80ms ease-out, background-color 90ms ease-out'
                  : 'opacity 80ms ease-out, background-color 90ms ease-out',
            }}
            className={`pointer-events-none absolute top-0 left-0 right-0 z-0 rounded-lg ${
              hl.danger ? 'bg-[var(--k-danger-soft)]' : 'bg-[var(--k-bg-surface-3)]'
            }`}
          />
        ) : null}

        {entries.map((entry) => {
          if (entry.type === 'separator') {
            return (
              <div
                key={entry.id}
                role="separator"
                className="relative z-[1] my-1 h-px bg-[var(--k-border-hairline)]"
              />
            );
          }
          if (entry.type === 'label') {
            return (
              <div
                key={entry.id}
                className="relative z-[1] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--k-ink-muted)] select-none"
              >
                {entry.label}
              </div>
            );
          }
          if (entry.type === 'submenu') {
            const expanded = submenuOpenId === entry.id;
            return (
              <div key={entry.id} className="relative z-[1]">
                <button
                  ref={(el) => {
                    if (el) rowRefs.current.set(entry.id, el);
                    else rowRefs.current.delete(entry.id);
                  }}
                  type="button"
                  role="menuitem"
                  aria-expanded={expanded}
                  onMouseEnter={() => focusRow(entry.id, false)}
                  onClick={() => setSubmenuOpenId((prev) => (prev === entry.id ? null : entry.id))}
                  className="w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--k-ink-primary)] cursor-pointer outline-none select-none"
                >
                  <span className="inline-flex items-center gap-2 min-w-0 truncate">
                    {entry.icon ? <span className="shrink-0 opacity-80">{entry.icon}</span> : null}
                    <span className="truncate">{entry.label}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 shrink-0 text-[11px] text-[var(--k-ink-muted)]">
                    {entry.badge ? <span className="max-w-[74px] truncate">{entry.badge}</span> : null}
                    <CaretRight
                      weight="bold"
                      className={`w-3 h-3 transition-transform duration-120 ${
                        expanded ? 'rotate-90' : ''
                      }`}
                    />
                  </span>
                </button>
                {expanded ? (
                  <div className="mt-1 mb-0.5 ml-2 pl-1.5 border-l border-[var(--k-border-hairline)] max-h-[210px] overflow-y-auto flex flex-col gap-0.5">
                    {entry.items.map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        role="menuitem"
                        onClick={() => runAndClose(sub.onSelect)}
                        className="w-full flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[12px] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer text-left"
                      >
                        <span className="truncate">{sub.label}</span>
                        {sub.active ? (
                          <Check weight="bold" className="w-3.5 h-3.5 shrink-0 text-[var(--k-accent)]" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }

          return (
            <button
              key={entry.id}
              ref={(el) => {
                if (el) rowRefs.current.set(entry.id, el);
                else rowRefs.current.delete(entry.id);
              }}
              type="button"
              role="menuitem"
              data-testid={`editor-ctx-${entry.id}`}
              onMouseEnter={() => focusRow(entry.id, Boolean(entry.danger))}
              onClick={() => runAndClose(entry.onSelect)}
              className={`relative z-[1] w-full flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] cursor-pointer outline-none select-none text-left ${
                entry.danger ? 'text-[var(--k-danger)]' : 'text-[var(--k-ink-primary)]'
              }`}
            >
              <span className="inline-flex items-center gap-2 min-w-0 truncate">
                {entry.icon ? <span className="shrink-0 opacity-85">{entry.icon}</span> : null}
                <span className="truncate">{entry.label}</span>
              </span>
              {entry.active ? (
                <Check weight="bold" className="w-3.5 h-3.5 shrink-0 text-[var(--k-accent)]" />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
};
