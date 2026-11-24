import {
  Mark,
  mergeAttributes,
  type JSONContent,
  type MarkdownToken,
  type MarkdownRendererHelpers,
  type RenderContext,
} from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';

export type TextColorKey =
  | 'accent'
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'blue'
  | 'violet'
  | 'pink'
  | 'muted';

export type TextSizeKey = 'sm' | 'lg' | 'xl';

export type HighlightColorKey = 'amber' | 'green' | 'blue' | 'violet' | 'pink' | 'red';

export const TEXT_COLOR_SWATCHES: ReadonlyArray<{
  key: TextColorKey;
  dot: string;
  labelRu: string;
  labelEn: string;
}> = [
  { key: 'accent', dot: 'var(--k-accent)', labelRu: 'Акцентный', labelEn: 'Accent' },
  { key: 'red', dot: '#ef4444', labelRu: 'Красный', labelEn: 'Red' },
  { key: 'orange', dot: '#f97316', labelRu: 'Оранжевый', labelEn: 'Orange' },
  { key: 'amber', dot: '#eab308', labelRu: 'Жёлтый', labelEn: 'Amber' },
  { key: 'green', dot: '#22c55e', labelRu: 'Зелёный', labelEn: 'Green' },
  { key: 'teal', dot: '#14b8a6', labelRu: 'Бирюзовый', labelEn: 'Teal' },
  { key: 'blue', dot: '#3b82f6', labelRu: 'Синий', labelEn: 'Blue' },
  { key: 'violet', dot: '#a855f7', labelRu: 'Фиолетовый', labelEn: 'Violet' },
  { key: 'pink', dot: '#ec4899', labelRu: 'Розовый', labelEn: 'Pink' },
  { key: 'muted', dot: '#8c8a82', labelRu: 'Приглушённый', labelEn: 'Muted' },
];

export const HIGHLIGHT_SWATCHES: ReadonlyArray<{
  key: HighlightColorKey;
  dot: string;
  labelRu: string;
  labelEn: string;
}> = [
  { key: 'amber', dot: '#f59e0b', labelRu: 'Жёлтый маркер', labelEn: 'Yellow highlight' },
  { key: 'green', dot: '#22c55e', labelRu: 'Зелёный маркер', labelEn: 'Green highlight' },
  { key: 'blue', dot: '#3b82f6', labelRu: 'Синий маркер', labelEn: 'Blue highlight' },
  { key: 'violet', dot: '#a855f7', labelRu: 'Фиолетовый маркер', labelEn: 'Purple highlight' },
  { key: 'pink', dot: '#ec4899', labelRu: 'Розовый маркер', labelEn: 'Pink highlight' },
  { key: 'red', dot: '#ef4444', labelRu: 'Красный маркер', labelEn: 'Red highlight' },
];

const VALID_COLORS = new Set<string>(TEXT_COLOR_SWATCHES.map((s) => s.key));
const VALID_SIZES = new Set<string>(['sm', 'lg', 'xl']);
const VALID_HIGHLIGHTS = new Set<string>(HIGHLIGHT_SWATCHES.map((s) => s.key));

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const SPAN_COLOR_TOKEN_RE = /^<span\s+data-k-color="([a-z0-9#-]+)">([\s\S]*?)<\/span>/i;
const SPAN_SIZE_TOKEN_RE = /^<span\s+data-k-size="(sm|lg|xl)">([\s\S]*?)<\/span>/i;
const MARK_BG_TOKEN_RE = /^<mark\s+data-k-bg="([a-z0-9#-]+)">([\s\S]*?)<\/mark>/i;

function sanitizeColorAttr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase();
  if (VALID_COLORS.has(clean) || HEX_COLOR_RE.test(clean)) return clean;
  return null;
}

function sanitizeSizeAttr(raw: unknown): TextSizeKey | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase();
  return VALID_SIZES.has(clean) ? (clean as TextSizeKey) : null;
}

function sanitizeHighlightAttr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase();
  if (VALID_HIGHLIGHTS.has(clean) || HEX_COLOR_RE.test(clean)) return clean;
  return null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    textSize: {
      setTextSize: (size: TextSizeKey) => ReturnType;
      unsetTextSize: () => ReturnType;
    };
  }
}

export const TextColorMark = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          if (typeof el === 'string') return null;
          const attr = el.getAttribute('data-k-color');
          if (attr) return sanitizeColorAttr(attr);
          const styleColor = el.style?.color;
          return styleColor ? sanitizeColorAttr(styleColor) : null;
        },
        renderHTML: (attrs) => {
          const color = sanitizeColorAttr(attrs.color);
          if (!color) return {};
          if (color.startsWith('#')) {
            return { 'data-k-color': color, style: `color: ${color}` };
          }
          return { 'data-k-color': color };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-k-color]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextColor:
        (color: string) =>
        ({ commands }) => {
          const clean = sanitizeColorAttr(color);
          if (!clean) return commands.unsetMark(this.name);
          return commands.setMark(this.name, { color: clean });
        },
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  markdownTokenName: 'textColor',

  markdownTokenizer: {
    name: 'textColor',
    level: 'inline',
    start: (src: string) => src.indexOf('<span data-k-color="'),
    tokenize(src: string, _tokens: MarkdownToken[], lexer: { inlineTokens: (s: string) => MarkdownToken[] }) {
      const match = SPAN_COLOR_TOKEN_RE.exec(src);
      if (!match) return undefined;
      const color = sanitizeColorAttr(match[1]);
      if (!color) return undefined;
      const inner = match[2] ?? '';
      return {
        type: 'textColor',
        raw: match[0],
        color,
        tokens: lexer.inlineTokens(inner),
      };
    },
  },

  parseMarkdown(token: MarkdownToken, helpers: { applyMark: (name: string, content: JSONContent[], attrs?: Record<string, unknown>) => JSONContent; parseInline: (tokens: MarkdownToken[]) => JSONContent[] }) {
    const color = sanitizeColorAttr((token as MarkdownToken & { color?: string }).color);
    const children = helpers.parseInline(token.tokens || []);
    if (!color) return children;
    return helpers.applyMark('textColor', children, { color });
  },

  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers, _ctx: RenderContext) {
    const color = sanitizeColorAttr(node.attrs?.color);
    const inner = helpers.renderChildren(node.content || []);
    if (!color || !inner) return inner;
    return `<span data-k-color="${color}">${inner}</span>`;
  },
});

export const TextSizeMark = Mark.create({
  name: 'textSize',

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (el) => {
          if (typeof el === 'string') return null;
          return sanitizeSizeAttr(el.getAttribute('data-k-size'));
        },
        renderHTML: (attrs) => {
          const size = sanitizeSizeAttr(attrs.size);
          if (!size) return {};
          return { 'data-k-size': size };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-k-size]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextSize:
        (size: TextSizeKey) =>
        ({ commands }) => {
          const clean = sanitizeSizeAttr(size);
          if (!clean) return commands.unsetMark(this.name);
          return commands.setMark(this.name, { size: clean });
        },
      unsetTextSize:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  markdownTokenName: 'textSize',

  markdownTokenizer: {
    name: 'textSize',
    level: 'inline',
    start: (src: string) => src.indexOf('<span data-k-size="'),
    tokenize(src: string, _tokens: MarkdownToken[], lexer: { inlineTokens: (s: string) => MarkdownToken[] }) {
      const match = SPAN_SIZE_TOKEN_RE.exec(src);
      if (!match) return undefined;
      const size = sanitizeSizeAttr(match[1]);
      if (!size) return undefined;
      const inner = match[2] ?? '';
      return {
        type: 'textSize',
        raw: match[0],
        size,
        tokens: lexer.inlineTokens(inner),
      };
    },
  },

  parseMarkdown(token: MarkdownToken, helpers: { applyMark: (name: string, content: JSONContent[], attrs?: Record<string, unknown>) => JSONContent; parseInline: (tokens: MarkdownToken[]) => JSONContent[] }) {
    const size = sanitizeSizeAttr((token as MarkdownToken & { size?: string }).size);
    const children = helpers.parseInline(token.tokens || []);
    if (!size) return children;
    return helpers.applyMark('textSize', children, { size });
  },

  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers, _ctx: RenderContext) {
    const size = sanitizeSizeAttr(node.attrs?.size);
    const inner = helpers.renderChildren(node.content || []);
    if (!size || !inner) return inner;
    return `<span data-k-size="${size}">${inner}</span>`;
  },
});

/**
 * Extends TipTap Highlight with theme-adaptive named swatches (`data-k-bg`)
 * while preserving lossless `==text==` markdown round-trip for default highlights.
 */
export const KapsulaHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => {
          if (typeof el === 'string') return null;
          const kBg = el.getAttribute('data-k-bg');
          if (kBg) return sanitizeHighlightAttr(kBg);
          const dataColor = el.getAttribute('data-color');
          return dataColor ? sanitizeHighlightAttr(dataColor) : null;
        },
        renderHTML: (attrs) => {
          const color = sanitizeHighlightAttr(attrs.color);
          if (!color) return {};
          if (color.startsWith('#')) {
            return { 'data-k-bg': color, style: `background-color: ${color}` };
          }
          return { 'data-k-bg': color };
        },
      },
    };
  },

  markdownTokenName: 'highlight',

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => {
      const idxMark = src.indexOf('<mark data-k-bg="');
      const idxEq = src.indexOf('==');
      if (idxMark === -1) return idxEq;
      if (idxEq === -1) return idxMark;
      return Math.min(idxMark, idxEq);
    },
    tokenize(src: string, _tokens: MarkdownToken[], lexer: { inlineTokens: (s: string) => MarkdownToken[] }) {
      const markMatch = MARK_BG_TOKEN_RE.exec(src);
      if (markMatch) {
        const color = sanitizeHighlightAttr(markMatch[1]);
        const inner = markMatch[2] ?? '';
        return {
          type: 'highlight',
          raw: markMatch[0],
          color: color ?? null,
          tokens: lexer.inlineTokens(inner),
        };
      }
      const eqMatch = /^==([^=\n][\s\S]*?)==/.exec(src);
      if (eqMatch) {
        return {
          type: 'highlight',
          raw: eqMatch[0],
          color: null,
          tokens: lexer.inlineTokens(eqMatch[1] ?? ''),
        };
      }
      return undefined;
    },
  },

  parseMarkdown(token: MarkdownToken, helpers: { applyMark: (name: string, content: JSONContent[], attrs?: Record<string, unknown>) => JSONContent; parseInline: (tokens: MarkdownToken[]) => JSONContent[] }) {
    const color = sanitizeHighlightAttr((token as MarkdownToken & { color?: string | null }).color);
    const children = helpers.parseInline(token.tokens || []);
    return helpers.applyMark('highlight', children, color ? { color } : {});
  },

  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers, _ctx: RenderContext) {
    const color = sanitizeHighlightAttr(node.attrs?.color);
    const inner = helpers.renderChildren(node.content || []);
    if (!inner) return '';
    if (color) return `<mark data-k-bg="${color}">${inner}</mark>`;
    return `==${inner}==`;
  },
}).configure({ multicolor: true });
