import React from 'react';
import {
  Node,
  mergeAttributes,
  nodeInputRule,
  type JSONContent,
  type MarkdownToken,
} from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { LinkSimple } from '@phosphor-icons/react';
import { useI18n } from '@shared/i18n/react';

export interface WikiLinkOptions {
  onNavigate?: (title: string, targetId?: string | null) => void;
}

const WIKI_TOKEN_START_RE = /^\[\[([^\]\[\n]+)\]\]/;
const WIKI_INPUT_RULE_RE = /\[\[([^\]\[\n]+)\]\]$/;

function parseWikiInner(rawInner: string): { title: string; label: string | null } | null {
  const clean = rawInner.trim();
  if (!clean) return null;
  const pipeIdx = clean.indexOf('|');
  const title = (pipeIdx >= 0 ? clean.slice(0, pipeIdx) : clean).trim();
  const label = pipeIdx >= 0 ? clean.slice(pipeIdx + 1).trim() : null;
  if (!title) return null;
  return {
    title,
    label: label && label !== title ? label : null,
  };
}

const WikiLinkView: React.FC<NodeViewProps> = ({ node, extension }) => {
  const { t } = useI18n();
  const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
  const label = typeof node.attrs.label === 'string' && node.attrs.label ? node.attrs.label : title;
  const targetId = typeof node.attrs.targetId === 'string' ? node.attrs.targetId : null;
  const options = extension.options as WikiLinkOptions;

  return (
    <NodeViewWrapper as="span" className="k-wiki-link-wrap" contentEditable={false}>
      <button
        type="button"
        data-wiki-link=""
        data-wiki-title={title}
        title={t('editor.wikiOpenTitle', { title })}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          options.onNavigate?.(title, targetId);
        }}
        className="k-wiki-link"
      >
        <LinkSimple weight="bold" className="w-3 h-3 shrink-0 opacity-80" />
        <span className="truncate max-w-[240px]">{label}</span>
      </button>
    </NodeViewWrapper>
  );
};

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addOptions() {
    return {
      onNavigate: undefined,
    };
  },

  addAttributes() {
    return {
      title: {
        default: '',
      },
      label: {
        default: null,
      },
      targetId: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const title = (el.getAttribute('data-wiki-title') || el.textContent || '').trim();
          if (!title) return false;
          const label = el.getAttribute('data-wiki-label');
          const targetId = el.getAttribute('data-wiki-target-id');
          return {
            title,
            label: label && label !== title ? label : null,
            targetId: targetId || null,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
    const label =
      typeof node.attrs.label === 'string' && node.attrs.label ? node.attrs.label : title;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wiki-link': '',
        'data-wiki-title': title,
        ...(node.attrs.label ? { 'data-wiki-label': node.attrs.label } : {}),
        ...(node.attrs.targetId ? { 'data-wiki-target-id': node.attrs.targetId } : {}),
        class: 'k-wiki-link',
      }),
      label,
    ];
  },

  markdownTokenName: 'wikiLink',

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize(src: string) {
      const match = WIKI_TOKEN_START_RE.exec(src);
      if (!match) return undefined;
      const parsed = parseWikiInner(match[1] ?? '');
      if (!parsed) return undefined;
      return {
        type: 'wikiLink',
        raw: match[0],
        text: parsed.title,
        title: parsed.title,
        label: parsed.label,
      };
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const wikiToken = token as MarkdownToken & {
      title?: string;
      label?: string | null;
      text?: string;
    };
    const title = (wikiToken.title ?? wikiToken.text ?? '').trim();
    if (!title) return [];
    return {
      type: 'wikiLink',
      attrs: {
        title,
        label: wikiToken.label && wikiToken.label !== title ? wikiToken.label : null,
        targetId: null,
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    const title = typeof node.attrs?.title === 'string' ? node.attrs.title.trim() : '';
    if (!title) return '';
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label.trim() : '';
    return label && label !== title ? `[[${title}|${label}]]` : `[[${title}]]`;
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: WIKI_INPUT_RULE_RE,
        type: this.type,
        getAttributes: (match) => {
          const parsed = parseWikiInner(match[1] ?? '');
          if (!parsed) return false;
          return {
            title: parsed.title,
            label: parsed.label,
            targetId: null,
          };
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikiLinkView);
  },
});
