import React, { useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  CaretDown,
  Check,
  CheckSquare,
  CircleNotch,
  Code,
  Eraser,
  Highlighter,
  LinkSimple,
  ListBullets,
  ListNumbers,
  Plus,
  Quotes,
  TextAa,
  TextB,
  TextItalic,
  TextStrikethrough,
  TextUnderline,
} from '@phosphor-icons/react';
import type { NoteTemplate } from '@shared/note-templates';
import { useI18n } from '@shared/i18n/react';
import { isMacPlatform } from '@shared/shortcuts';
import {
  HIGHLIGHT_SWATCHES,
  TEXT_COLOR_SWATCHES,
  type TextSizeKey,
} from '@shared/tiptap-rich-marks';
import { PopoverSurface } from '../ui/PopoverSurface';
import { InsertMenuContent } from './BlockInsertGutter';

export interface FormatToolbarState {
  h1: boolean;
  h2: boolean;
  h3: boolean;
  task: boolean;
  bullet: boolean;
  ordered: boolean;
  quote: boolean;
  codeBlock: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  highlightColor: string | null;
  textColor: string | null;
  textSize: TextSizeKey | null;
  code: boolean;
  link: boolean;
}

interface NoteFormatDockProps {
  editor: Editor | null;
  state: FormatToolbarState | null | undefined;
  insertingImage?: boolean;
  noteTemplates: readonly NoteTemplate[];
  wordCount: number;
  charCount: number;
  onPickImage: () => void;
  onStartDictation: () => void;
  onOpenAiMenu?: () => void;
  onApplyTemplate: (tpl: NoteTemplate) => void;
  onOpenLinkEditor: () => void;
}

export const NoteFormatDock: React.FC<NoteFormatDockProps> = ({
  editor,
  state,
  insertingImage = false,
  noteTemplates,
  wordCount,
  charCount,
  onPickImage,
  onStartDictation,
  onOpenAiMenu,
  onApplyTemplate,
  onOpenLinkEditor,
}) => {
  const { t, locale } = useI18n();
  const isMac = isMacPlatform(window.kapsula?.platform);
  const [insertOpen, setInsertOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  if (!editor) return null;

  const activeSizeLabel = state?.h1
    ? 'H1'
    : state?.h2
      ? 'H2'
      : state?.h3
        ? 'H3'
        : state?.textSize === 'sm'
          ? t('note.studio.toolbar.sizeSmall')
          : state?.textSize === 'lg' || state?.textSize === 'xl'
            ? t('note.studio.toolbar.sizeLarge')
            : t('note.studio.toolbar.sizeNormal');

  const activeTextSwatch = TEXT_COLOR_SWATCHES.find((s) => s.key === state?.textColor);
  const activeBgSwatch = HIGHLIGHT_SWATCHES.find((s) => s.key === state?.highlightColor);

  const btnClass = (active?: boolean) =>
    `k-interactive inline-flex items-center justify-center h-7 w-7 rounded-lg cursor-pointer shrink-0 transition-colors ${
      active
        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
    }`;

  return (
    <div
      data-testid="studio-format-dock"
      className="shrink-0 border-t border-[var(--k-border-hairline)]/80 bg-[var(--k-bg-surface-1)]/96 backdrop-blur-md px-3 sm:px-4 py-1.5 flex items-center justify-between gap-2"
    >
      <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto k-scroll-hidden py-0.5">
        {/* Quick Insert Popover (always reachable from bottom as well as Notion left gutter) */}
        <PopoverSurface
          open={insertOpen}
          onOpenChange={setInsertOpen}
          side="top"
          align="start"
          widthClass="w-[246px] !p-2"
          trigger={
            <button
              type="button"
              data-testid="studio-insert-menu-btn"
              title={t('note.studio.insertTitle')}
              className="k-interactive inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/75 hover:bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-primary)] cursor-pointer shrink-0 mr-1"
            >
              {insertingImage ? (
                <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin text-[var(--k-accent)]" />
              ) : (
                <Plus weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              )}
              <span className="hidden @[560px]:inline">{t('note.studio.insertShort')}</span>
            </button>
          }
        >
          <InsertMenuContent
            editor={editor}
            insertingImage={insertingImage}
            noteTemplates={noteTemplates}
            onPickImage={onPickImage}
            onStartDictation={onStartDictation}
            onOpenAiMenu={onOpenAiMenu}
            onApplyTemplate={onApplyTemplate}
            onClose={() => setInsertOpen(false)}
          />
        </PopoverSurface>

        {/* Text Style & Size Selector */}
        <PopoverSurface
          open={sizeOpen}
          onOpenChange={setSizeOpen}
          side="top"
          align="start"
          widthClass="w-[192px] !p-1.5"
          trigger={
            <button
              type="button"
              data-testid="format-size-btn"
              title={t('note.studio.toolbar.textSize')}
              onMouseDown={(e) => e.preventDefault()}
              className={`k-interactive inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] font-medium cursor-pointer shrink-0 ${
                state?.h1 || state?.h2 || state?.h3 || state?.textSize
                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              <TextAa weight="bold" className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden @[480px]:inline max-w-[78px] truncate">{activeSizeLabel}</span>
              <CaretDown weight="bold" className="w-2.5 h-2.5 opacity-70 shrink-0" />
            </button>
          }
        >
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().setParagraph().unsetTextSize().run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
            >
              <span>{t('note.studio.toolbar.sizeNormal')}</span>
              {!state?.h1 && !state?.h2 && !state?.h3 && !state?.textSize ? (
                <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().setParagraph().setTextSize('sm').run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[11.5px] text-[var(--k-ink-secondary)] cursor-pointer"
            >
              <span>{t('note.studio.toolbar.sizeSmall')}</span>
              {state?.textSize === 'sm' ? (
                <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().setParagraph().setTextSize('lg').run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[15px] font-medium cursor-pointer"
            >
              <span>{t('note.studio.toolbar.sizeLarge')}</span>
              {state?.textSize === 'lg' ? (
                <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
              ) : null}
            </button>

            <div className="h-px bg-[var(--k-border-hairline)] my-1" />

            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().unsetTextSize().toggleHeading({ level: 1 }).run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[16px] font-bold cursor-pointer"
            >
              <span>{t('note.studio.toolbar.h1')}</span>
              {state?.h1 ? <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" /> : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().unsetTextSize().toggleHeading({ level: 2 }).run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[14.5px] font-semibold cursor-pointer"
            >
              <span>{t('note.studio.toolbar.h2')}</span>
              {state?.h2 ? <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" /> : null}
            </button>
            <button
              type="button"
              onClick={() => {
                setSizeOpen(false);
                editor.chain().focus().unsetTextSize().toggleHeading({ level: 3 }).run();
              }}
              className="k-interactive w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-[13.5px] font-semibold text-[var(--k-ink-secondary)] cursor-pointer"
            >
              <span>{t('note.studio.toolbar.h3')}</span>
              {state?.h3 ? <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)]" /> : null}
            </button>
          </div>
        </PopoverSurface>

        <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-1 shrink-0" />

        {/* Core Inline Marks */}
        <button
          type="button"
          data-testid="format-bold-btn"
          title={`${t('note.studio.toolbar.bold')} (${isMac ? '⌘B' : 'Ctrl+B'})`}
          aria-label={t('note.studio.toolbar.bold')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={btnClass(state?.bold)}
        >
          <TextB weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-testid="format-italic-btn"
          title={`${t('note.studio.toolbar.italic')} (${isMac ? '⌘I' : 'Ctrl+I'})`}
          aria-label={t('note.studio.toolbar.italic')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={btnClass(state?.italic)}
        >
          <TextItalic weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-testid="format-underline-btn"
          title={`${t('note.studio.toolbar.underline')} (${isMac ? '⌘U' : 'Ctrl+U'})`}
          aria-label={t('note.studio.toolbar.underline')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={btnClass(state?.underline)}
        >
          <TextUnderline weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-testid="format-strike-btn"
          title={t('note.studio.toolbar.strike')}
          aria-label={t('note.studio.toolbar.strike')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={btnClass(state?.strike)}
        >
          <TextStrikethrough weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-testid="format-code-btn"
          title={t('note.studio.toolbar.code')}
          aria-label={t('note.studio.toolbar.code')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={btnClass(state?.code)}
        >
          <Code weight="bold" className="w-3.5 h-3.5" />
        </button>

        <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-1 shrink-0" />

        {/* Text Color Picker */}
        <PopoverSurface
          open={colorOpen}
          onOpenChange={setColorOpen}
          side="top"
          align="center"
          widthClass="w-[208px] !p-2"
          trigger={
            <button
              type="button"
              data-testid="format-color-btn"
              title={t('note.studio.toolbar.textColor')}
              aria-label={t('note.studio.toolbar.textColor')}
              onMouseDown={(e) => e.preventDefault()}
              className={`k-interactive relative inline-flex flex-col items-center justify-center h-7 w-7 rounded-lg cursor-pointer shrink-0 ${
                state?.textColor
                  ? 'bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)]'
                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              <span className="text-[12.5px] font-bold leading-none">A</span>
              <span
                className="w-3.5 h-[2.5px] rounded-full mt-0.5"
                style={{ backgroundColor: activeTextSwatch?.dot ?? 'var(--k-ink-muted)' }}
              />
            </button>
          }
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                {t('note.studio.toolbar.textColor')}
              </span>
              {state?.textColor ? (
                <button
                  type="button"
                  onClick={() => {
                    setColorOpen(false);
                    editor.chain().focus().unsetTextColor().run();
                  }}
                  className="text-[11px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer"
                >
                  {t('note.studio.toolbar.defaultColor')}
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {TEXT_COLOR_SWATCHES.map((swatch) => {
                const active = state?.textColor === swatch.key;
                return (
                  <button
                    key={swatch.key}
                    type="button"
                    data-testid={`format-color-${swatch.key}`}
                    title={locale === 'en' ? swatch.labelEn : swatch.labelRu}
                    onClick={() => {
                      setColorOpen(false);
                      if (active) {
                        editor.chain().focus().unsetTextColor().run();
                      } else {
                        editor.chain().focus().setTextColor(swatch.key).run();
                      }
                    }}
                    className={`k-interactive h-7 rounded-lg flex items-center justify-center border cursor-pointer ${
                      active
                        ? 'border-[var(--k-ink-primary)] bg-[var(--k-bg-surface-2)]'
                        : 'border-transparent hover:bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-full ring-1 ring-black/15"
                      style={{ backgroundColor: swatch.dot }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverSurface>

        {/* Multi-color Highlight Marker Picker */}
        <PopoverSurface
          open={bgOpen}
          onOpenChange={setBgOpen}
          side="top"
          align="center"
          widthClass="w-[196px] !p-2"
          trigger={
            <button
              type="button"
              data-testid="format-highlight-btn"
              title={t('note.studio.toolbar.highlight')}
              aria-label={t('note.studio.toolbar.highlight')}
              onMouseDown={(e) => e.preventDefault()}
              className={`k-interactive relative inline-flex flex-col items-center justify-center h-7 w-7 rounded-lg cursor-pointer shrink-0 ${
                state?.highlight
                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              <Highlighter weight="bold" className="w-3.5 h-3.5" />
              {state?.highlight ? (
                <span
                  className="w-3 h-[2px] rounded-full mt-[1px]"
                  style={{ backgroundColor: activeBgSwatch?.dot ?? 'var(--k-accent)' }}
                />
              ) : null}
            </button>
          }
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                {t('note.studio.toolbar.highlight')}
              </span>
              {state?.highlight ? (
                <button
                  type="button"
                  onClick={() => {
                    setBgOpen(false);
                    editor.chain().focus().unsetHighlight().run();
                  }}
                  className="text-[11px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer"
                >
                  {t('note.studio.toolbar.noHighlight')}
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-6 gap-1.5">
              {HIGHLIGHT_SWATCHES.map((swatch) => {
                const active = state?.highlight && state?.highlightColor === swatch.key;
                return (
                  <button
                    key={swatch.key}
                    type="button"
                    data-testid={`format-highlight-${swatch.key}`}
                    title={locale === 'en' ? swatch.labelEn : swatch.labelRu}
                    onClick={() => {
                      setBgOpen(false);
                      if (active) {
                        editor.chain().focus().unsetHighlight().run();
                      } else {
                        editor.chain().focus().setHighlight({ color: swatch.key }).run();
                      }
                    }}
                    className={`k-interactive h-7 rounded-lg flex items-center justify-center border cursor-pointer ${
                      active
                        ? 'border-[var(--k-ink-primary)] bg-[var(--k-bg-surface-2)]'
                        : 'border-transparent hover:bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-md ring-1 ring-black/15"
                      style={{ backgroundColor: swatch.dot, opacity: 0.72 }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverSurface>

        <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-1 shrink-0" />

        {/* Block & List Quick Toggles */}
        <button
          type="button"
          title={t('note.studio.toolbar.taskList')}
          aria-label={t('note.studio.toolbar.taskList')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          className={btnClass(state?.task)}
        >
          <CheckSquare weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title={t('note.studio.toolbar.bulletList')}
          aria-label={t('note.studio.toolbar.bulletList')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={btnClass(state?.bullet)}
        >
          <ListBullets weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title={t('note.studio.toolbar.orderedList')}
          aria-label={t('note.studio.toolbar.orderedList')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={btnClass(state?.ordered)}
        >
          <ListNumbers weight="bold" className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title={t('note.studio.toolbar.quote')}
          aria-label={t('note.studio.toolbar.quote')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={btnClass(state?.quote)}
        >
          <Quotes weight="bold" className="w-3.5 h-3.5" />
        </button>
        <PopoverSurface
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open);
            if (open) {
              setLinkUrl((editor.getAttributes('link')?.href as string | undefined) ?? '');
            }
          }}
          side="top"
          align="center"
          widthClass="w-[264px] !p-2"
          trigger={
            <button
              type="button"
              data-testid="format-link-btn"
              title={t('note.studio.toolbar.link')}
              aria-label={t('note.studio.toolbar.link')}
              onMouseDown={(e) => e.preventDefault()}
              className={btnClass(state?.link)}
            >
              <LinkSimple weight="bold" className="w-3.5 h-3.5" />
            </button>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = linkUrl.trim();
              if (!trimmed) {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
              } else {
                const normalized = /^https?:\/\/|^mailto:/i.test(trimmed)
                  ? trimmed
                  : `https://${trimmed}`;
                if (editor.state.selection.empty) {
                  editor
                    .chain()
                    .focus()
                    .insertContent(`<a href="${normalized.replace(/"/g, '&quot;')}">${trimmed}</a>`)
                    .run();
                } else {
                  editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run();
                }
              }
              setLinkOpen(false);
              setLinkUrl('');
            }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://example.com"
              className="flex-1 min-w-0 h-7.5 px-2 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] text-[12px] text-[var(--k-ink-primary)] outline-none select-text"
            />
            <button
              type="submit"
              aria-label={t('note.studio.applyLink')}
              className="k-interactive inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] cursor-pointer shrink-0"
            >
              <Check weight="bold" className="w-3.5 h-3.5" />
            </button>
          </form>
        </PopoverSurface>

        <button
          type="button"
          title={t('note.studio.toolbar.clearFormat')}
          aria-label={t('note.studio.toolbar.clearFormat')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          className={btnClass(false)}
        >
          <Eraser className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Quiet Live Word & Char Counter */}
      <div className="hidden @[600px]:flex items-center gap-1.5 shrink-0 text-[11px] text-[var(--k-ink-muted)] k-tabular select-none">
        {wordCount > 0 ? (
          <>
            <span>{t('note.studio.wordsCount', { count: wordCount })}</span>
            <span className="opacity-40">·</span>
            <span>{t('note.studio.charsCount', { count: charCount })}</span>
          </>
        ) : (
          <span className="opacity-70">/</span>
        )}
      </div>
    </div>
  );
};
