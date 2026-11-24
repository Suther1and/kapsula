import React, { useEffect, useRef, useState } from 'react';
import {
  Extension,
  Node,
  mergeAttributes,
  type Editor,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownRendererHelpers,
  type MarkdownToken,
  type RenderContext,
} from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import {
  ArrowsOutSimple,
  Check,
  Copy,
  ImageBroken,
  ImageSquare,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { translate } from '@shared/i18n';
import { useI18n } from '@shared/i18n/react';
import { MAX_UPLOAD_IMAGE_OR_DOC_BYTES, readFileAsBytes } from '../../lib/file-bytes';
import { friendlyErrorMessage, getMediaUrl } from '../../lib/format';

function getDomLocale() {
  return typeof document !== 'undefined' && document.documentElement?.lang === 'en' ? 'en' : 'ru';
}

export interface KapsulaImageLightboxInfo {
  src: string;
  alt: string;
  localFilename: string | null;
}

export interface KapsulaImageOptions {
  onOpenLightbox?: (info: KapsulaImageLightboxInfo) => void;
  compact?: boolean;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|heic|svg)$/i;

export function extractLocalImageFilename(src: string | null | undefined): string | null {
  if (!src || !src.startsWith('kapsula-media://local/')) return null;
  try {
    const raw = src.slice('kapsula-media://local/'.length).split(/[?#]/)[0] ?? '';
    const decoded = decodeURIComponent(raw).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function extractImageFilesFromDataTransfer(
  dt: DataTransfer | null | undefined
): File[] {
  if (!dt) return [];
  const files: File[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (file: File | null | undefined) => {
    if (!file) return;
    const isImage =
      file.type.startsWith('image/') || (!file.type && IMAGE_EXT_RE.test(file.name || ''));
    if (!isImage) return;
    // Omit `lastModified`: on Windows/Chromium clipboard pastes `dt.items[i].getAsFile()`
    // and `dt.files[i]` generate fresh `Date.now()` timestamps for the same pasted screenshot,
    // which previously caused duplicate insertion whenever the millisecond ticked between reads.
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    files.push(file);
  };

  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item && item.kind === 'file') {
        pushUnique(item.getAsFile());
      }
    }
  }
  // Only fall back to `dt.files` when `dt.items` yielded no images, because both lists
  // expose the same clipboard/drop payload and reading both duplicates unnamed pastes.
  if (files.length === 0 && dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i += 1) {
      pushUnique(dt.files[i]);
    }
  }
  return files;
}

const recentImageInserts = new WeakMap<Editor, { sig: string; at: number }>();

export async function saveAndInsertImageFiles(
  editor: Editor,
  files: File[],
  opts?: {
    insertPos?: number | null;
    onBeforeSave?: () => void;
    onAfterSave?: () => void;
  }
): Promise<number> {
  if (!files.length) return 0;
  const sig = files.map((f) => `${f.name}:${f.size}:${f.type}`).join('|');
  const prev = recentImageInserts.get(editor);
  const now = Date.now();
  if (prev && prev.sig === sig && now - prev.at < 450) {
    return 0;
  }
  recentImageInserts.set(editor, { sig, at: now });

  opts?.onBeforeSave?.();
  const insertedNodes: Array<{ src: string; alt: string }> = [];
  const domLocale = getDomLocale();

  try {
    for (const file of files) {
      const mimeType = file.type || 'image/png';
      const fileName = file.name || `image-${Date.now()}.png`;
      const bytes = await readFileAsBytes(
        file,
        MAX_UPLOAD_IMAGE_OR_DOC_BYTES,
        translate(domLocale, 'error.readImageFailed'),
        domLocale
      );
      if (bytes.byteLength === 0) continue;

      const saved = await window.kapsula.saveNoteImage({
        bytes,
        mimeType,
        fileName,
      });
      const src = saved.mediaUrl || getMediaUrl(saved.filename);
      if (!src) continue;
      insertedNodes.push({ src, alt: '' });
    }

    if (insertedNodes.length > 0 && !editor.isDestroyed) {
      // Place each inserted image in its own clean paragraph followed by an empty paragraph
      // so images never share a `<p>` with typed prose via `<br>` (keeps gutter `+` accurate).
      const content: JSONContent[] = [
        ...insertedNodes.map((img) => ({
          type: 'paragraph',
          content: [{ type: 'kapsulaImage', attrs: img }],
        })),
        { type: 'paragraph' },
      ];

      if (typeof opts?.insertPos === 'number' && Number.isFinite(opts.insertPos)) {
        const clampedPos = Math.max(0, Math.min(opts.insertPos, editor.state.doc.content.size));
        editor.chain().focus().insertContentAt(clampedPos, content).run();
      } else {
        editor.chain().focus().insertContent(content).run();
      }
    }
    return insertedNodes.length;
  } catch (err) {
    const domLocale = getDomLocale();
    toast.error(friendlyErrorMessage(err, translate(domLocale, 'error.insertImageFailed'), domLocale));
    return insertedNodes.length;
  } finally {
    opts?.onAfterSave?.();
  }
}

const KapsulaImageView: React.FC<NodeViewProps> = ({
  editor,
  getPos,
  node,
  selected,
  updateAttributes,
  deleteNode,
  extension,
}) => {
  const { t } = useI18n();
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const options = extension.options as KapsulaImageOptions;
  const localFilename = extractLocalImageFilename(src);

  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(alt);
  const captionInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  useEffect(() => {
    setCaptionDraft(alt);
  }, [alt]);

  useEffect(() => {
    if (editingCaption) {
      window.setTimeout(() => captionInputRef.current?.focus(), 10);
    }
  }, [editingCaption]);

  const handleOpenLightbox = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!src || errored) return;
    // Never leave an armed ProseMirror NodeSelection on the atomic image node —
    // otherwise pressing Enter or typing right after closing Lightbox deletes the photo.
    if (selected && typeof getPos === 'function') {
      const pos = getPos();
      if (typeof pos === 'number') {
        const afterPos = Math.min(editor.state.doc.content.size, pos + node.nodeSize);
        editor.commands.setTextSelection(afterPos);
      }
    }
    options.onOpenLightbox?.({ src, alt, localFilename });
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (localFilename) {
        const ok = await window.kapsula.copyImage(localFilename);
        if (ok) {
          setCopied(true);
          toast.success(t('editor.photoCopied'));
          window.setTimeout(() => setCopied(false), 1600);
          return;
        }
      }
      if (src) {
        await window.kapsula.copyText(src);
        setCopied(true);
        toast.success(t('editor.photoLinkCopied'));
        window.setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      toast.error(t('error.copyImageFailed'));
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deleteNode();
  };

  const commitCaption = () => {
    const clean = captionDraft.trim();
    if (clean !== alt) {
      updateAttributes({ alt: clean });
    }
    setEditingCaption(false);
  };

  const showCaptionBar = editingCaption || Boolean(alt);

  return (
    <NodeViewWrapper
      as="span"
      className="k-inline-image-figure"
      data-kapsula-image=""
      data-testid="kapsula-inline-image"
      contentEditable={false}
    >
      <span
        className="k-inline-image-frame"
        data-selected={selected ? 'true' : 'false'}
      >
        <span
          className="k-inline-image-media"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {!loaded && !errored ? (
            <span className="absolute inset-0 flex items-center justify-center gap-2 bg-[var(--k-bg-surface-2)] text-[var(--k-ink-muted)] animate-pulse">
              <ImageSquare className="w-5 h-5 opacity-60" />
              <span className="text-[12px]">{t('editor.loadingPhoto')}</span>
            </span>
          ) : null}

          {errored || !src ? (
            <span className="flex flex-col items-center justify-center gap-2 py-7 px-4 text-center text-[var(--k-ink-muted)]">
              <ImageBroken weight="duotone" className="w-7 h-7 opacity-70" />
              <span className="text-[12.5px] font-medium text-[var(--k-ink-secondary)]">
                {t('editor.imageUnavailable')}
              </span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleDelete}
                className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer"
              >
                <Trash className="w-3.5 h-3.5" />
                {t('editor.deleteBlock')}
              </button>
            </span>
          ) : (
            <img
              src={src}
              alt={alt || t('editor.imageAltFallback')}
              draggable={false}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onLoad={() => setLoaded(true)}
              onError={() => {
                setLoaded(true);
                setErrored(true);
              }}
              onClick={handleOpenLightbox}
              className={`k-inline-image-img ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />
          )}

          {!errored && src ? (
            <span
              className="k-inline-image-toolbar"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {options.onOpenLightbox ? (
                <button
                  type="button"
                  title={t('editor.openLarge')}
                  aria-label={t('editor.openLarge')}
                  onClick={handleOpenLightbox}
                  className="k-inline-image-btn"
                >
                  <ArrowsOutSimple weight="bold" className="w-3.5 h-3.5" />
                  {!options.compact ? <span>{t('editor.largeShort')}</span> : null}
                </button>
              ) : null}
              <button
                type="button"
                title={t('cards.copyPhoto')}
                aria-label={t('cards.copyPhoto')}
                onClick={(e) => void handleCopy(e)}
                className="k-inline-image-btn"
              >
                {copied ? (
                  <Check weight="bold" className="w-3.5 h-3.5 text-[#4ade80]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {!options.compact ? <span>{copied ? t('common.done') : t('common.copy')}</span> : null}
              </button>
              {!options.compact ? (
                <button
                  type="button"
                  title={t('editor.editCaption')}
                  aria-label={t('editor.editCaption')}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingCaption(true);
                  }}
                  className="k-inline-image-btn"
                >
                  <PencilSimple className="w-3.5 h-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                title={t('editor.deletePhoto')}
                aria-label={t('editor.deletePhoto')}
                data-danger="true"
                onClick={handleDelete}
                className="k-inline-image-btn"
              >
                <Trash className="w-3.5 h-3.5" />
              </button>
            </span>
          ) : null}
        </span>

        {showCaptionBar ? (
          <span
            className="k-inline-image-caption-bar"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!editingCaption) setEditingCaption(true);
            }}
          >
            {editingCaption ? (
              <input
                ref={captionInputRef}
                type="text"
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                onBlur={commitCaption}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCaption();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setCaptionDraft(alt);
                    setEditingCaption(false);
                  }
                }}
                placeholder={t('editor.captionPlaceholder')}
                className="k-inline-image-caption-input"
              />
            ) : (
              <span className="truncate cursor-text flex-1" title={t('editor.captionClickHint')}>
                {alt}
              </span>
            )}
          </span>
        ) : null}
      </span>
    </NodeViewWrapper>
  );
};

/**
 * TipTap v3 Paragraph.parseMarkdown (priority 1000) unwraps single-image paragraphs
 * (`![alt](src)` on its own line) into top-level children, which fails ProseMirror
 * schema validation when the image node is `inline: true, group: 'inline'`.
 * Intercepting ONLY single-image paragraphs at priority 1100 keeps BOTH standalone
 * and mid-sentence Markdown images 100% schema-valid inside `<paragraph>`.
 */
const KapsulaImageParagraphAdapter = Extension.create({
  name: 'kapsulaImageParagraphAdapter',
  priority: 1100,
  markdownTokenName: 'paragraph',
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const tokens = token.tokens || [];
    if (tokens.length === 1 && tokens[0]?.type === 'image') {
      const content = helpers.parseInline(tokens);
      if (content.length > 0) {
        return helpers.createNode('paragraph', undefined, content);
      }
    }
    return [];
  },
  renderMarkdown(node: JSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) {
    if (!node) return '';
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const prevContent = Array.isArray(ctx?.previousNode?.content)
        ? ctx.previousNode.content
        : [];
      return ctx?.previousNode?.type === 'paragraph' && prevContent.length === 0
        ? '&nbsp;'
        : '';
    }
    return helpers.renderChildren(content);
  },
});

export const KapsulaImage = Node.create<KapsulaImageOptions>({
  name: 'kapsulaImage',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  selectable: true,

  addExtensions() {
    return [KapsulaImageParagraphAdapter];
  },

  addOptions() {
    return {
      onOpenLightbox: undefined,
      compact: false,
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
      },
      alt: {
        default: '',
      },
      title: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const src = el.getAttribute('src');
          if (!src) return false;
          return {
            src,
            alt: el.getAttribute('alt') || '',
            title: el.getAttribute('title') || null,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  markdownTokenName: 'image',

  parseMarkdown(token: MarkdownToken) {
    const imgToken = token as MarkdownToken & {
      href?: string;
      text?: string;
      title?: string | null;
    };
    const src = typeof imgToken.href === 'string' ? imgToken.href.trim() : '';
    if (!src) return [];
    return {
      type: 'kapsulaImage',
      attrs: {
        src,
        alt: typeof imgToken.text === 'string' ? imgToken.text : '',
        title: typeof imgToken.title === 'string' && imgToken.title ? imgToken.title : null,
      },
    };
  },

  renderMarkdown(node: JSONContent) {
    const src = typeof node.attrs?.src === 'string' ? node.attrs.src.trim() : '';
    if (!src) return '';
    const alt =
      typeof node.attrs?.alt === 'string'
        ? node.attrs.alt.replace(/[\r\n]+/g, ' ').replace(/([[\]])/g, '\\$1')
        : '';
    const title =
      typeof node.attrs?.title === 'string' && node.attrs.title.trim()
        ? ` "${node.attrs.title.replace(/"/g, '\\"')}"`
        : '';
    const safeSrc = /[\s()]/.test(src) ? `<${src}>` : src;
    return `![${alt}](${safeSrc}${title})`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(KapsulaImageView);
  },
});
