import React, { useEffect, useState } from 'react';
import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Image as ImageIcon, LinkSimple, Trash } from '@phosphor-icons/react';
import { tm } from './mobile-i18n';

const KAPSULA_LOCAL_MEDIA_PREFIX = 'kapsula-media://local/';

export function extractLocalFilenameFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.startsWith(KAPSULA_LOCAL_MEDIA_PREFIX)) {
    const raw = src.slice(KAPSULA_LOCAL_MEDIA_PREFIX.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function buildInlineMediaMarkdownUrl(filename: string): string {
  return `${KAPSULA_LOCAL_MEDIA_PREFIX}${encodeURIComponent(filename)}`;
}

interface KapsulaImageOptions {
  ensureMediaUrl: (localName?: string | null) => Promise<string | null>;
  onOpenImage?: (src: string, caption?: string) => void;
}

const MobileInlineImageView: React.FC<NodeViewProps> = ({ node, deleteNode, extension }) => {
  const rawSrc = String(node.attrs.src || '');
  const alt = String(node.attrs.alt || tm('common.photo'));
  const opts = extension.options as KapsulaImageOptions;
  const localFilename = extractLocalFilenameFromSrc(rawSrc);

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => {
    if (!rawSrc) return null;
    if (localFilename) return null;
    if (/^(?:https?:|data:|blob:)/i.test(rawSrc)) return rawSrc;
    return null;
  });
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    if (!rawSrc) {
      setResolvedSrc(null);
      return;
    }
    if (!localFilename) {
      setResolvedSrc(/^(?:https?:|data:|blob:)/i.test(rawSrc) ? rawSrc : null);
      return;
    }
    let cancelled = false;
    void opts.ensureMediaUrl(localFilename).then((url) => {
      if (!cancelled) setResolvedSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [rawSrc, localFilename, opts]);

  return (
    <NodeViewWrapper
      as="span"
      data-testid="mobile-inline-image-node"
      className="k-inline-image-figure block my-3 relative rounded-2xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]"
      contentEditable={false}
    >
      {resolvedSrc && !broken ? (
        <img
          src={resolvedSrc}
          alt={alt}
          loading="lazy"
          onError={() => setBroken(true)}
          onClick={() => opts.onOpenImage?.(resolvedSrc, alt)}
          className="w-full max-h-80 object-contain bg-[var(--k-bg-surface-2)] block cursor-zoom-in"
        />
      ) : (
        <div className="flex items-center justify-center gap-2 h-32 px-4 text-[12.5px] text-[var(--k-ink-muted)] bg-[var(--k-bg-surface-2)]">
          <ImageIcon className="w-4 h-4 shrink-0" />
          <span>{broken ? tm('inlineImage.unavailable') : tm('inlineImage.loading')}</span>
        </div>
      )}

      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          deleteNode();
        }}
        aria-label={tm('inlineImage.removeAria')}
        className="k-tap absolute top-2 right-2 inline-flex items-center justify-center w-8 h-8 rounded-xl bg-black/60 text-white backdrop-blur-sm border border-white/15"
      >
        <Trash className="w-3.5 h-3.5" />
      </button>
    </NodeViewWrapper>
  );
};

export const KapsulaImage = Node.create<KapsulaImageOptions>({
  name: 'kapsulaImage',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      ensureMediaUrl: async () => null,
      onOpenImage: undefined,
    };
  },

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-kapsula-src]',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return {
            src: el.getAttribute('data-kapsula-src') || '',
            alt: el.getAttribute('data-alt') || '',
            title: el.getAttribute('title') || '',
          };
        },
      },
      { tag: 'img[src]' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const src = String(node.attrs.src || '');
    // Android WebView has no `kapsula-media://` scheme — emitting a real <img src="kapsula-media://…">
    // (clipboard copy, getHTML, DOM serialization) fires a failed net::ERR_UNKNOWN_URL_SCHEME request.
    // Serialize local inline photos as an inert placeholder; the React NodeView resolves blob: URLs lazily.
    if (extractLocalFilenameFromSrc(src) || !/^(?:https?:|data:|blob:)/i.test(src)) {
      return [
        'span',
        {
          class: 'k-inline-image-img',
          'data-kapsula-src': src,
          'data-alt': String(node.attrs.alt || ''),
          ...(node.attrs.title ? { title: String(node.attrs.title) } : {}),
        },
      ];
    }
    return ['img', mergeAttributes(HTMLAttributes, { class: 'k-inline-image-img' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MobileInlineImageView);
  },

  markdownTokenName: 'image',

  parseMarkdown(token, helpers) {
    const t = token as { href?: string; text?: string; title?: string };
    return helpers.createNode('kapsulaImage', {
      src: t.href || '',
      alt: t.text || '',
      title: t.title || '',
    });
  },

  renderMarkdown(node) {
    const src = String(node.attrs?.src || '').trim();
    if (!src) return '';
    const alt = String(node.attrs?.alt || '')
      .replace(/\]/g, '\\]')
      .replace(/\r?\n/g, ' ');
    return `![${alt}](${src})`;
  },
});

interface WikiLinkOptions {
  onOpenWikiLink?: (title: string) => void;
}

const MobileWikiLinkView: React.FC<NodeViewProps> = ({ node, extension }) => {
  const title = String(node.attrs.title || '');
  const label = String(node.attrs.label || title);
  const opts = extension.options as WikiLinkOptions;

  return (
    <NodeViewWrapper as="span" className="inline align-baseline" contentEditable={false}>
      <button
        type="button"
        data-testid={`wiki-link-pill-${title}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          opts.onOpenWikiLink?.(title);
        }}
        className="k-wiki-link inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] border border-[var(--k-border-focus)]/50 text-[13.5px] font-medium leading-tight align-baseline"
      >
        <LinkSimple className="w-3 h-3 shrink-0" />
        <span>{label}</span>
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
      onOpenWikiLink: undefined,
    };
  },

  addAttributes() {
    return {
      title: { default: '' },
      label: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const title = el.getAttribute('data-wiki-link') || el.textContent || '';
          return { title, label: el.textContent || title };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const title = String(node.attrs.title || '');
    const label = String(node.attrs.label || title);
    return ['span', { 'data-wiki-link': title, class: 'k-wiki-link' }, label];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MobileWikiLinkView);
  },

  markdownTokenName: 'wikiLink',

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start(src: string) {
      return src.indexOf('[[');
    },
    tokenize(src: string) {
      const m = /^\[\[([^\]\n]+)\]\]/.exec(src);
      if (!m) return undefined;
      const rawInner = m[1] ?? '';
      if (!rawInner.trim() || rawInner.includes('[')) return undefined;
      const pipeIdx = rawInner.indexOf('|');
      const targetTitle = (pipeIdx >= 0 ? rawInner.slice(0, pipeIdx) : rawInner).trim();
      const label = (pipeIdx >= 0 ? rawInner.slice(pipeIdx + 1) : rawInner).trim();
      if (!targetTitle) return undefined;
      return {
        type: 'wikiLink',
        raw: m[0],
        targetTitle,
        label: label || targetTitle,
      };
    },
  },

  parseMarkdown(token, helpers) {
    const t = token as { targetTitle?: string; label?: string; text?: string };
    const title = (t.targetTitle || t.text || '').trim();
    const label = (t.label || title).trim();
    return helpers.createNode('wikiLink', { title, label });
  },

  renderMarkdown(node) {
    const title = String(node.attrs?.title || '').trim();
    const label = String(node.attrs?.label || title).trim();
    if (!title) return '';
    return label && label !== title ? `[[${title}|${label}]]` : `[[${title}]]`;
  },
});
