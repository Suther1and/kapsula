import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import Highlight from '@tiptap/extension-highlight';
import { common, createLowlight } from 'lowlight';
import {
  Archive,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowSquareOut,
  ArrowsOutSimple,
  Check,
  CheckSquare,
  CircleNotch,
  ClockCounterClockwise,
  Code,
  Copy,
  DotsThree,
  FileText,
  FolderOpen,
  FolderSimple,
  Highlighter,
  ImageSquare,
  Lightbulb,
  LinkBreak,
  LinkSimple,
  ListBullets,
  ListChecks,
  ListNumbers,
  Microphone,
  Minus,
  Plus,
  Quotes,
  RocketLaunch,
  Sparkle,
  Star,
  SunHorizon,
  TextB,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
  Trash,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type {
  FocusBoard,
  ItemRevision,
  OrbitDef,
  TextTransformPreset,
  VaultItem,
} from '@shared/types';
import { truncateAtWordBoundary } from '@shared/html-entities';
import { getMediaCategory } from '@shared/item-helpers';
import { NOTE_TEMPLATES, type NoteTemplate } from '@shared/note-templates';
import { isMacPlatform } from '@shared/shortcuts';
import { extractWikiLinkTitles } from '@shared/task-helpers';
import '../../styles/editor.css';
import {
  formatFileSize,
  formatRelativeDate,
  friendlyErrorMessage,
  getMediaUrl,
  transcribeItemWithWavFallback,
} from '../../lib/format';
import { playTactileTick } from '../../lib/tactileSound';
import { ShotLightbox } from '../cards/ShotLightbox';
import {
  KapsulaImage,
  extractImageFilesFromDataTransfer,
  saveAndInsertImageFiles,
  type KapsulaImageLightboxInfo,
} from '../editor/KapsulaImageNode';
import { RevisionHistoryModal } from '../editor/RevisionHistoryModal';
import { ProseCaretOverlay } from '../editor/ProseCaretOverlay';
import { WikiLink } from '../editor/WikiLinkNode';
import { CopySlotPill } from '../ui/CopySlotPill';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';
import { InlineTagEditor } from '../ui/InlineTagEditor';
import { PopoverSurface } from '../ui/PopoverSurface';
import { ReminderPopover } from '../ui/ReminderPopover';
import { SectionIcon } from '../ui/SectionIcon';
import { SelectMenu } from '../ui/SelectMenu';
import { VoiceRecorderStudio } from '../ui/VoiceRecorderStudio';
import { WaveformAudioPlayer } from '../ui/WaveformAudioPlayer';

const lowlight = createLowlight(common);
const VIDEO_PATH_RE = /\.(?:mp4|webm|mov|m4v)$/i;
const AUDIO_PATH_RE = /\.(?:wav|webm|ogg|oga|mp3|m4a)$/i;

const PRESET_OPTIONS: Array<{ id: TextTransformPreset; label: string; desc: string }> = [
  { id: 'structure', label: 'Структурировать', desc: 'Абзацы, списки, задачи и логика' },
  { id: 'tasks', label: 'Выделить задачи', desc: 'Превратить дела в чек-лист' },
  { id: 'polish', label: 'Причесать текст', desc: 'Пунктуация, «ёлочки» и чистота слога' },
  { id: 'summary', label: 'Краткая выжимка', desc: 'Главное сверху + ключевые тезисы' },
];

const TEMPLATE_ICON_MAP = {
  meeting: UsersThree,
  idea: Lightbulb,
  project: RocketLaunch,
  day: SunHorizon,
} as const;

type SlashCommandId =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'task'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'code'
  | 'hr'
  | 'image'
  | 'dictate'
  | 'beautify'
  | 'template-meeting'
  | 'template-idea'
  | 'template-project'
  | 'template-day';

interface SlashCommandDef {
  id: SlashCommandId;
  label: string;
  hint: string;
  keywords: string;
  group: 'blocks' | 'media' | 'templates';
  icon: React.ComponentType<{ className?: string; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;
}

const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: 'h1',
    label: 'Заголовок 1',
    hint: 'Крупный заголовок раздела',
    keywords: 'h1 heading title заголовок крупный',
    group: 'blocks',
    icon: TextHOne,
  },
  {
    id: 'h2',
    label: 'Заголовок 2',
    hint: 'Подзаголовок раздела',
    keywords: 'h2 heading subtitle подзаголовок',
    group: 'blocks',
    icon: TextHTwo,
  },
  {
    id: 'h3',
    label: 'Заголовок 3',
    hint: 'Малый подзаголовок',
    keywords: 'h3 heading малый подзаголовок',
    group: 'blocks',
    icon: TextHThree,
  },
  {
    id: 'task',
    label: 'Чек-лист',
    hint: 'Список дел с галочками',
    keywords: 'task todo checklist чеклист задачи галочки',
    group: 'blocks',
    icon: CheckSquare,
  },
  {
    id: 'bullet',
    label: 'Маркированный список',
    hint: 'Обычный список с точками',
    keywords: 'bullet list ul список точки',
    group: 'blocks',
    icon: ListBullets,
  },
  {
    id: 'ordered',
    label: 'Нумерованный список',
    hint: 'Список по порядку 1, 2, 3',
    keywords: 'ordered number ol нумерованный шаги список',
    group: 'blocks',
    icon: ListNumbers,
  },
  {
    id: 'quote',
    label: 'Цитата',
    hint: 'Выделенная мысль или вывод',
    keywords: 'quote blockquote цитата акцент',
    group: 'blocks',
    icon: Quotes,
  },
  {
    id: 'code',
    label: 'Блок кода',
    hint: 'С подсветкой синтаксиса',
    keywords: 'code snippet код программа',
    group: 'blocks',
    icon: Code,
  },
  {
    id: 'hr',
    label: 'Разделитель',
    hint: 'Горизонтальная линия между блоками',
    keywords: 'hr divider line линия разделитель',
    group: 'blocks',
    icon: Minus,
  },
  {
    id: 'image',
    label: 'Вставить фото',
    hint: 'Выбрать картинку с компьютера',
    keywords: 'photo image picture img фото картинка изображение скриншот',
    group: 'media',
    icon: ImageSquare,
  },
  {
    id: 'dictate',
    label: 'Диктовка',
    hint: 'Записать голос и вставить в заметку',
    keywords: 'voice dictate audio голос диктовка микрофон',
    group: 'media',
    icon: Microphone,
  },
  {
    id: 'beautify',
    label: 'Причесать текст',
    hint: 'Разобрать и аккуратно оформить заметку с ИИ',
    keywords: 'ai beautify polish причесать оформить украсить ии',
    group: 'media',
    icon: Sparkle,
  },
  ...NOTE_TEMPLATES.map((tpl): SlashCommandDef => ({
    id: `template-${tpl.id}` as SlashCommandId,
    label: `Шаблон: ${tpl.label}`,
    hint: tpl.description,
    keywords: `template шаблон ${tpl.id} ${tpl.label.toLowerCase()} ${tpl.tags.join(' ')}`,
    group: 'templates',
    icon: TEMPLATE_ICON_MAP[tpl.id],
  })),
];

export type StudioLayoutMode = 'sheet' | 'center' | 'full';

interface NoteStudioProps {
  item: VaultItem;
  isDraft?: boolean;
  orbits: OrbitDef[];
  focusBoards: FocusBoard[];
  allItemsForLinks?: VaultItem[];
  availableTags?: string[];
  soundEnabled: boolean;
  layoutMode?: StudioLayoutMode;
  presentation?: 'page' | 'modal';
  reserveTrafficLights?: boolean;
  leadingBarSlot?: React.ReactNode;
  onChangeLayoutMode?: (mode: StudioLayoutMode) => void;
  onItemUpdated: (updated: VaultItem) => void;
  onDraftPersisted?: (created: VaultItem) => void;
  onCancelDraft?: () => void;
  onSelectRelatedItem?: (item: VaultItem) => void;
  onDelete: (id: string) => void;
  onOpenShotLightbox?: (item: VaultItem) => void;
  onRegisterClose?: (closeFn: (() => Promise<void>) | null) => void;
  onClose?: () => void;
}

function deriveTitleFromBody(md: string): string {
  const first = (md || '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
        .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*]\s+\[[ xX]\]\s+/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/[*_`>#~[\]()]/g, '')
        .trim()
    )
    .find(Boolean);
  return first ? truncateAtWordBoundary(first, 96) : 'Заметка';
}

function isGenericDraftTitle(val: string): boolean {
  const clean = val.trim();
  return (
    !clean ||
    clean === 'Заметка' ||
    clean === 'Новая заметка' ||
    clean === 'Быстрая заметка' ||
    clean.startsWith('Голосовая заметка') ||
    clean.startsWith('Аудиозапись')
  );
}

export const NoteStudio: React.FC<NoteStudioProps> = ({
  item,
  isDraft = false,
  orbits,
  focusBoards,
  allItemsForLinks = [],
  availableTags,
  soundEnabled,
  layoutMode = 'full',
  presentation = 'page',
  reserveTrafficLights = false,
  leadingBarSlot,
  onItemUpdated,
  onDraftPersisted,
  onCancelDraft,
  onSelectRelatedItem,
  onDelete,
  onOpenShotLightbox,
  onRegisterClose,
  onClose,
}) => {
  const prefersReduced = useReducedMotion();
  const [title, setTitle] = useState(isDraft ? '' : item.title || '');
  const [liveBody, setLiveBody] = useState(item.body || '');
  const [tags, setTags] = useState<string[]>(item.tags || []);
  const [draftOrbit, setDraftOrbit] = useState<string>(item.orbit || '');
  const [draftBoardId, setDraftBoardId] = useState<string | null>(item.focusBoardId ?? null);
  const [draftRemindAt, setDraftRemindAt] = useState<number | null>(item.remindAt ?? null);
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const [beautifying, setBeautifying] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [extractingVoiceTasks, setExtractingVoiceTasks] = useState(false);
  const [insertingImage, setInsertingImage] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [activePreset, setActivePreset] = useState<TextTransformPreset>('structure');
  const [orbitMenuOpen, setOrbitMenuOpen] = useState(false);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [bubbleLinkEditing, setBubbleLinkEditing] = useState(false);
  const [bubbleLinkUrl, setBubbleLinkUrl] = useState('');
  const [editorBoundaryEl, setEditorBoundaryEl] = useState<HTMLDivElement | null>(null);
  const bubbleMenuOptions = useMemo(
    () => ({
      placement: 'top-start' as const,
      offset: 8,
      flip: {
        fallbackPlacements: ['bottom-start', 'top', 'bottom'] as Array<
          'bottom-start' | 'top' | 'bottom'
        >,
        padding: 6,
        ...(editorBoundaryEl ? { boundary: editorBoundaryEl } : {}),
      },
      shift: {
        padding: 6,
        ...(editorBoundaryEl ? { boundary: editorBoundaryEl } : {}),
      },
    }),
    [editorBoundaryEl]
  );
  const [showVoiceStudio, setShowVoiceStudio] = useState(false);
  const [revisions, setRevisions] = useState<ItemRevision[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringRevId, setRestoringRevId] = useState<string | null>(null);
  const [quickRevertRevId, setQuickRevertRevId] = useState<string | null>(null);
  const [inlineLightboxItem, setInlineLightboxItem] = useState<VaultItem | null>(null);
  const [relatedState, setRelatedState] = useState<{
    related: Array<{ item: VaultItem; reason: string; score: number }>;
    backlinks: VaultItem[];
  }>({ related: [], backlinks: [] });

  // Floating caret menus: `/` slash commands and `[[` wiki-links
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [wikiQuery, setWikiQuery] = useState<string | null>(null);
  const [wikiIndex, setWikiIndex] = useState(0);
  const [caretRect, setCaretRect] = useState<{ left: number; top: number; bottom: number } | null>(
    null
  );

  const titleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const slashListRef = useRef<HTMLDivElement | null>(null);

  const itemRef = useRef(item);
  itemRef.current = item;
  const isDraftRef = useRef(isDraft);
  isDraftRef.current = isDraft;
  const persistedDraftIdRef = useRef<string | null>(isDraft ? null : item.id);
  const titleRef = useRef(isDraft ? '' : item.title || '');
  const bodyMarkdownRef = useRef(item.body || '');
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const loadingItemRef = useRef(false);
  const allItemsForLinksRef = useRef(allItemsForLinks);
  allItemsForLinksRef.current = allItemsForLinks;

  const onItemUpdatedRef = useRef(onItemUpdated);
  onItemUpdatedRef.current = onItemUpdated;
  const onDraftPersistedRef = useRef(onDraftPersisted);
  onDraftPersistedRef.current = onDraftPersisted;
  const onCancelDraftRef = useRef(onCancelDraft);
  onCancelDraftRef.current = onCancelDraft;
  const onSelectRelatedItemRef = useRef(onSelectRelatedItem);
  onSelectRelatedItemRef.current = onSelectRelatedItem;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const draftOrbitRef = useRef(draftOrbit);
  draftOrbitRef.current = draftOrbit;
  const draftBoardIdRef = useRef(draftBoardId);
  draftBoardIdRef.current = draftBoardId;
  const draftRemindAtRef = useRef(draftRemindAt);
  draftRemindAtRef.current = draftRemindAt;
  const inflightCreateRef = useRef<Promise<VaultItem | null> | null>(null);

  const openInlineImageLightboxRef = useRef<(info: KapsulaImageLightboxInfo) => void>(() => {});
  openInlineImageLightboxRef.current = (info) => {
    const cur = itemRef.current;
    setInlineLightboxItem({
      ...cur,
      title: info.alt || cur.title || 'Изображение',
      summary: info.alt ? cur.title : '',
      imagePath: info.localFilename,
      thumbPath: info.localFilename,
      ogImageUrl: info.localFilename ? null : info.src,
      annotations: [],
      colorPalette: [],
    });
  };

  const navigateWikiLinkRef = useRef<(linkTitle: string, targetId?: string | null) => Promise<void>>(
    async () => {}
  );
  navigateWikiLinkRef.current = async (linkTitle, targetId) => {
    const cleanLower = linkTitle.trim().toLowerCase();
    const candidates = allItemsForLinksRef.current;
    let found =
      (targetId ? candidates.find((c) => c.id === targetId) : undefined) ??
      candidates.find((c) => c.title.trim().toLowerCase() === cleanLower);

    if (!found && cleanLower) {
      try {
        const remote = await window.kapsula.queryVault({
          search: linkTitle.trim(),
          includeArchived: true,
          includeSecrets: false,
          limit: 12,
        });
        found =
          remote.find((c) => c.title.trim().toLowerCase() === cleanLower) ??
          remote.find((c) => c.title.toLowerCase().includes(cleanLower));
      } catch {
        // ignore search errors
      }
    }

    if (found) {
      onSelectRelatedItemRef.current?.(found);
    } else {
      toast.info(`Заметка «${linkTitle}» не найдена`);
    }
  };

  const slashMenuStateRef = useRef<{
    query: string | null;
    index: number;
    filtered: readonly SlashCommandDef[];
    run: (cmdId: SlashCommandId) => void;
  }>({
    query: null,
    index: 0,
    filtered: [],
    run: () => {},
  });

  const wikiMenuStateRef = useRef<{
    query: string | null;
    index: number;
    filtered: VaultItem[];
    run: (target: VaultItem) => void;
  }>({
    query: null,
    index: 0,
    filtered: [],
    run: () => {},
  });

  const insertImageFilesRef = useRef<(files: File[], insertPos?: number | null) => Promise<void>>(
    async () => {}
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: {
            rel: 'noopener noreferrer',
          },
        },
      }),
      Markdown,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      CodeBlockLowlight.configure({
        lowlight,
      }),
      Placeholder.configure({
        placeholder: 'Начни писать или введи «/» для вставки блока…',
      }),
      Typography,
      Highlight,
      KapsulaImage.configure({
        onOpenLightbox: (info) => openInlineImageLightboxRef.current(info),
      }),
      WikiLink.configure({
        onNavigate: (linkTitle, targetId) => {
          void navigateWikiLinkRef.current(linkTitle, targetId);
        },
      }),
    ],
    content: item.body || '',
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'k-prose min-h-[340px] pb-24',
        'data-testid': 'note-studio-editor',
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
        if (anchor) {
          const href = anchor.getAttribute('href');
          if (href && /^https?:\/\/|^mailto:/i.test(href)) {
            event.preventDefault();
            void window.kapsula.openExternal(href);
            return true;
          }
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = extractImageFilesFromDataTransfer(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImageFilesRef.current(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = extractImageFilesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        setIsDraggingImage(false);
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void insertImageFilesRef.current(files, coords?.pos ?? null);
        return true;
      },
      handleKeyDown: (_view, event) => {
        const curWiki = wikiMenuStateRef.current;
        if (curWiki.query !== null) {
          const count = curWiki.filtered.length;
          if (event.key === 'ArrowDown' && count > 0) {
            event.preventDefault();
            setWikiIndex((i) => (i + 1) % count);
            return true;
          }
          if (event.key === 'ArrowUp' && count > 0) {
            event.preventDefault();
            setWikiIndex((i) => (i - 1 + count) % count);
            return true;
          }
          if (event.key === 'Enter' && count > 0) {
            event.preventDefault();
            const chosen = curWiki.filtered[curWiki.index % count];
            if (chosen) curWiki.run(chosen);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setWikiQuery(null);
            return true;
          }
        }

        const cur = slashMenuStateRef.current;
        if (cur.query !== null) {
          const count = cur.filtered.length;
          if (event.key === 'ArrowDown' && count > 0) {
            event.preventDefault();
            setSlashIndex((i) => (i + 1) % count);
            return true;
          }
          if (event.key === 'ArrowUp' && count > 0) {
            event.preventDefault();
            setSlashIndex((i) => (i - 1 + count) % count);
            return true;
          }
          if (event.key === 'Enter' && count > 0) {
            event.preventDefault();
            const chosen = cur.filtered[cur.index % count];
            if (chosen) cur.run(chosen.id);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSlashQuery(null);
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (loadingItemRef.current) return;

      const { state, view } = ed;
      const { $from, empty, from } = state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
      if (empty && ed.isActive('bulletList') && $from.parent.type.name === 'paragraph') {
        const boxMatch = /^\[([ xX]?)\]\s$/.exec(textBefore);
        if (boxMatch) {
          const isChecked = (boxMatch[1] ?? '').toLowerCase() === 'x';
          // 1) Remove "[ ] " and lift ONLY this item out of bulletList into a standalone paragraph
          //    (separate transaction so toggleTaskList NEVER converts preceding bulletList items into checkboxes)
          ed.chain()
            .focus()
            .deleteRange({ from: $from.start(), to: $from.pos })
            .liftListItem('listItem')
            .run();
          let guard = 0;
          while (ed.isActive('bulletList') && ed.can().liftListItem('listItem') && guard < 4) {
            ed.commands.liftListItem('listItem');
            guard += 1;
          }
          // 2) Wrap ONLY the lifted standalone paragraph into a fresh taskList
          if (!ed.isActive('bulletList')) {
            let taskChain = ed.chain().focus().toggleTaskList();
            if (isChecked) {
              taskChain = taskChain.updateAttributes('taskItem', { checked: true });
            }
            taskChain.run();
          }
          return;
        }
      }

      const md = ed.getMarkdown();
      bodyMarkdownRef.current = md;
      setLiveBody(md);
      dirtyRef.current = true;
      setSaveState('saving');

      const updateCaretPosition = () => {
        try {
          const coords = view.coordsAtPos(from);
          setCaretRect({ left: coords.left, top: coords.top, bottom: coords.bottom });
        } catch {
          setCaretRect(null);
        }
      };

      const wikiMatch = /\[\[([^\[\]]*)$/.exec(textBefore);
      if (wikiMatch) {
        setWikiQuery((wikiMatch[1] ?? '').toLowerCase());
        setWikiIndex(0);
        setSlashQuery(null);
        updateCaretPosition();
      } else {
        setWikiQuery(null);
        const slashMatch = /(?:^|\s)\/([а-яёa-z0-9_-]*)$/i.exec(textBefore);
        if (slashMatch) {
          setSlashQuery((slashMatch[1] ?? '').toLowerCase());
          setSlashIndex(0);
          updateCaretPosition();
        } else {
          setSlashQuery(null);
        }
      }

      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
      }, 420);
    },
  });

  // Wire image insertion ref once editor is ready
  insertImageFilesRef.current = async (files, insertPos) => {
    if (!editor || files.length === 0) return;
    const count = await saveAndInsertImageFiles(editor, files, {
      insertPos,
      onBeforeSave: () => setInsertingImage(true),
      onAfterSave: () => setInsertingImage(false),
    });
    if (count > 0) {
      playTactileTick(soundEnabled, 'soft');
      toast.success(count === 1 ? 'Фото вставлено в заметку' : `Вставлено фото: ${count}`);
    }
  };

  // Subscribe only to toolbar active-state changes (zero per-keystroke full-component re-renders)
  const toolbarState = useEditorState({
    editor,
    selector: (ctx) => ({
      h2: ctx.editor?.isActive('heading', { level: 2 }) ?? false,
      task: ctx.editor?.isActive('taskList') ?? false,
      bullet: ctx.editor?.isActive('bulletList') ?? false,
      ordered: ctx.editor?.isActive('orderedList') ?? false,
      quote: ctx.editor?.isActive('blockquote') ?? false,
      codeBlock: ctx.editor?.isActive('codeBlock') ?? false,
      bold: ctx.editor?.isActive('bold') ?? false,
      italic: ctx.editor?.isActive('italic') ?? false,
      strike: ctx.editor?.isActive('strike') ?? false,
      highlight: ctx.editor?.isActive('highlight') ?? false,
      code: ctx.editor?.isActive('code') ?? false,
      link: ctx.editor?.isActive('link') ?? false,
    }),
  });

  const computeReconciledLinksOut = useCallback(
    (rawBody: string): string[] | null => {
      const candidates = allItemsForLinksRef.current;
      const explicitIds: string[] = [];
      if (editor && !editor.isDestroyed) {
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'wikiLink' && typeof node.attrs.targetId === 'string' && node.attrs.targetId) {
            explicitIds.push(node.attrs.targetId);
          }
        });
      }
      if (candidates.length === 0 && explicitIds.length === 0) {
        return null;
      }
      const curId = persistedDraftIdRef.current || itemRef.current.id;
      const byLowerTitle = new Map<string, string>();
      for (const cand of candidates) {
        if (cand.id === curId || cand.dna === 'secret') continue;
        const key = cand.title.trim().toLowerCase();
        if (key && !byLowerTitle.has(key)) byLowerTitle.set(key, cand.id);
      }
      const resolved = new Set<string>(explicitIds.filter((id) => id !== curId));
      for (const wikiTitle of extractWikiLinkTitles(rawBody)) {
        const matchedId = byLowerTitle.get(wikiTitle.trim().toLowerCase());
        if (matchedId) resolved.add(matchedId);
      }
      return Array.from(resolved);
    },
    [editor]
  );

  const flushDraft = useCallback(
    async (targetId: string, forceWasDraft = false) => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      // Snapshot live refs synchronously BEFORE any await so fast-switching to another note
      // never contaminates this flush with the next note's metadata or text.
      const rawTitle = titleRef.current.trim();
      const rawBody = bodyMarkdownRef.current;
      const orbitVal = draftOrbitRef.current || undefined;
      const boardVal = draftBoardIdRef.current;
      const remindVal = draftRemindAtRef.current;
      const draftTags = [...tagsRef.current];
      const reconciledLinks = computeReconciledLinksOut(rawBody);

      // Serialize behind any in-flight draft creation to prevent duplicate captures
      if (inflightCreateRef.current) {
        await inflightCreateRef.current;
      }

      if (!dirtyRef.current) {
        setSaveState('saved');
        return;
      }

      const bodyHasContent = rawBody.replace(/\s+/g, '').length > 0;

      // Never materialize an empty draft note into DB
      const wasDraft =
        (forceWasDraft || targetId === '__draft__' || isDraftRef.current) &&
        !persistedDraftIdRef.current;
      if (wasDraft) {
        if (!rawTitle && !bodyHasContent) {
          dirtyRef.current = false;
          setSaveState('saved');
          return;
        }
        dirtyRef.current = false;
        const effectiveTitle = rawTitle || deriveTitleFromBody(rawBody);
        const createPromise = window.kapsula
          .capture({
            title: effectiveTitle,
            text: rawBody,
            orbitOverride: orbitVal,
            focusBoardId: boardVal,
            remindAt: remindVal,
            tags: draftTags,
            source: 'vault_ui',
          })
          .catch(() => null);
        inflightCreateRef.current = createPromise;
        try {
          let created = await createPromise;
          if (!created) return;
          if (reconciledLinks && reconciledLinks.length > 0) {
            const linked = await window.kapsula
              .updateItem(created.id, { linksOut: reconciledLinks })
              .catch(() => null);
            if (linked) created = linked;
          }
          // Only bind to live buffer if user has not switched to another note mid-flight
          if (itemRef.current.id === '__draft__') {
            persistedDraftIdRef.current = created.id;
            isDraftRef.current = false;
            const userTypedMeanwhile =
              titleRef.current.trim() !== rawTitle || bodyMarkdownRef.current !== rawBody;
            if (!rawTitle && titleRef.current.trim() === '') {
              setTitle(created.title);
              titleRef.current = created.title;
            }
            onDraftPersistedRef.current?.(created);
            if (userTypedMeanwhile) {
              dirtyRef.current = true;
              setSaveState('saving');
              if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = window.setTimeout(() => {
                void flushDraft(created.id);
              }, 300);
              return;
            }
          }
        } finally {
          if (inflightCreateRef.current === createPromise) {
            inflightCreateRef.current = null;
          }
          if (!dirtyRef.current) setSaveState('saved');
        }
        return;
      }

      dirtyRef.current = false;
      const finalId =
        (targetId && targetId !== '__draft__' ? targetId : null) ||
        persistedDraftIdRef.current ||
        (itemRef.current.id !== '__draft__' ? itemRef.current.id : null);
      if (!finalId) {
        setSaveState('saved');
        return;
      }
      const nextTitle = rawTitle || deriveTitleFromBody(rawBody);
      try {
        const patch: Record<string, unknown> = {
          title: nextTitle,
          body: rawBody,
        };
        if (reconciledLinks !== null) {
          patch.linksOut = reconciledLinks;
        }
        const updated = await window.kapsula.updateItem(finalId, patch);
        const stillSameItem = (persistedDraftIdRef.current || itemRef.current.id) === finalId;
        const userTypedMeanwhile =
          stillSameItem &&
          (titleRef.current.trim() !== rawTitle || bodyMarkdownRef.current !== rawBody);
        if (updated) onItemUpdatedRef.current(updated);
        if (userTypedMeanwhile) {
          dirtyRef.current = true;
          setSaveState('saving');
          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(() => {
            void flushDraft(finalId);
          }, 300);
          return;
        }
      } finally {
        if (!dirtyRef.current) setSaveState('saved');
      }
    },
    [computeReconciledLinksOut]
  );

  // Flush changes when switching item (preserve follow-up timer when draft promotes to its persisted ID)
  useEffect(() => {
    const closedItemId = item.id;
    const closedWasDraft = isDraft;
    return () => {
      const promotedToCurrent =
        closedWasDraft &&
        persistedDraftIdRef.current !== null &&
        persistedDraftIdRef.current === itemRef.current.id;
      if (promotedToCurrent) {
        return;
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        const flushId = persistedDraftIdRef.current || closedItemId;
        void flushDraft(flushId, closedWasDraft && !persistedDraftIdRef.current);
      }
    };
  }, [item.id, isDraft, flushDraft]);

  // Sync editor when selecting a different item (skip overwriting live buffer on draft->persisted promotion)
  useEffect(() => {
    const isSamePromotedDraft = !isDraft && persistedDraftIdRef.current === item.id;
    if (!isSamePromotedDraft) {
      persistedDraftIdRef.current = isDraft ? null : item.id;
      isDraftRef.current = isDraft;
      const initTitle = isDraft ? '' : item.title || '';
      setTitle(initTitle);
      titleRef.current = initTitle;
      setTags(item.tags || []);
      setDraftOrbit(item.orbit || '');
      draftOrbitRef.current = item.orbit || '';
      setDraftBoardId(item.focusBoardId ?? null);
      draftBoardIdRef.current = item.focusBoardId ?? null;
      setDraftRemindAt(item.remindAt ?? null);
      draftRemindAtRef.current = item.remindAt ?? null;
      setShowVoiceStudio(false);
      setSlashQuery(null);
      setWikiQuery(null);
      setQuickRevertRevId(null);
      setHistoryOpen(false);
      setInlineLightboxItem(null);
      setBubbleLinkEditing(false);
      setBubbleLinkUrl('');
      setOrbitMenuOpen(false);
      setInsertMenuOpen(false);
      setMoreMenuOpen(false);
      const nextBody = item.body || '';
      bodyMarkdownRef.current = nextBody;
      setLiveBody(nextBody);
      dirtyRef.current = false;
      setSaveState('saved');

      if (editor) {
        loadingItemRef.current = true;
        editor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
        window.setTimeout(() => {
          loadingItemRef.current = false;
          if (isDraft) {
            editor.commands.focus('end');
          }
        }, 15);
      }
    }

    if (!isDraft) {
      window.kapsula
        .listRevisions(item.id)
        .then(setRevisions)
        .catch(() => setRevisions([]));
      window.kapsula
        .getRelatedItems(item.id)
        .then(setRelatedState)
        .catch(() => setRelatedState({ related: [], backlinks: [] }));
    } else {
      setRevisions([]);
      setRelatedState({ related: [], backlinks: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, isDraft]);

  useEffect(() => {
    setTags(item.tags || []);
  }, [item.tags]);

  // Live sync external enrichment updates when user hasn't modified this note
  useEffect(() => {
    if (isDraft || persistedDraftIdRef.current !== item.id || dirtyRef.current) return;
    const extTitle = item.title || '';
    if (extTitle && extTitle !== titleRef.current) {
      setTitle(extTitle);
      titleRef.current = extTitle;
    }
    const extBody = item.body || '';
    if (editor && extBody !== bodyMarkdownRef.current) {
      bodyMarkdownRef.current = extBody;
      setLiveBody(extBody);
      loadingItemRef.current = true;
      editor.commands.setContent(extBody, { contentType: 'markdown', emitUpdate: false });
      window.setTimeout(() => {
        loadingItemRef.current = false;
      }, 15);
    }
  }, [item.id, item.updatedAt, item.title, item.body, editor, isDraft]);

  useLayoutEffect(() => {
    const el = titleTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, layoutMode, item.id]);

  // Reset floating link input whenever editor selection collapses
  useEffect(() => {
    if (!editor) return;
    const onSelectionUpdate = () => {
      if (editor.state.selection.empty) {
        setBubbleLinkEditing(false);
      }
    };
    editor.on('selectionUpdate', onSelectionUpdate);
    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
    };
  }, [editor]);

  // Keep active keyboard-selected slash item scrolled into view
  useEffect(() => {
    if (slashQuery === null || !slashListRef.current) return;
    const activeEl = slashListRef.current.querySelector('[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashQuery]);

  const handleCloseStudio = useCallback(async () => {
    const curTitle = titleRef.current.trim();
    const curBody = bodyMarkdownRef.current.trim();
    const curItem = itemRef.current;

    if (isDraftRef.current && !persistedDraftIdRef.current && !curTitle && !curBody) {
      onCancelDraftRef.current?.();
      onCloseRef.current?.();
      return;
    }

    await flushDraft(persistedDraftIdRef.current || curItem.id);

    // Clean up auto-created blank note if user left both title & body completely empty
    const effectiveId = persistedDraftIdRef.current || curItem.id;
    const isEmptyUntouched =
      !curBody &&
      (!curTitle || curTitle === 'Новая заметка') &&
      !curItem.imagePath &&
      !curItem.mediaPath &&
      !curItem.url;
    if (isEmptyUntouched && effectiveId && !isDraftRef.current) {
      onDeleteRef.current(effectiveId);
    }
    onCloseRef.current?.();
  }, [flushDraft]);

  useEffect(() => {
    onRegisterClose?.(handleCloseStudio);
    return () => {
      onRegisterClose?.(null);
    };
  }, [onRegisterClose, handleCloseStudio]);

  const handleTitleChange = (val: string) => {
    setTitle(val);
    titleRef.current = val;
    dirtyRef.current = true;
    setSaveState('saving');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
    }, 420);
  };

  const applyMetaPatch = async (patch: Record<string, unknown>) => {
    if ('orbit' in patch && typeof patch.orbit === 'string') {
      setDraftOrbit(patch.orbit);
      draftOrbitRef.current = patch.orbit;
    }
    if ('focusBoardId' in patch) {
      const nextBoard = (patch.focusBoardId as string | null) ?? null;
      setDraftBoardId(nextBoard);
      draftBoardIdRef.current = nextBoard;
    }
    if ('remindAt' in patch) {
      const nextRemind = (patch.remindAt as number | null) ?? null;
      setDraftRemindAt(nextRemind);
      draftRemindAtRef.current = nextRemind;
    }
    if (isDraftRef.current && !persistedDraftIdRef.current) {
      dirtyRef.current = true;
      await flushDraft(item.id, true);
    }
    const effectiveId = persistedDraftIdRef.current || item.id;
    if (!effectiveId || effectiveId.startsWith('__draft__')) return;
    const updated = await window.kapsula.updateItem(effectiveId, patch);
    if (updated) onItemUpdated(updated);
  };

  const refreshRevisions = async () => {
    const effectiveId = persistedDraftIdRef.current || item.id;
    if (!effectiveId || effectiveId.startsWith('__draft__')) return [];
    const list = await window.kapsula.listRevisions(effectiveId);
    setRevisions(list);
    return list;
  };

  const handleOpenHistoryModal = async () => {
    if (dirtyRef.current) {
      await flushDraft(persistedDraftIdRef.current || item.id);
    }
    await refreshRevisions().catch(() => []);
    setHistoryOpen(true);
  };

  const handleBeautify = async (preset: TextTransformPreset = activePreset) => {
    if (!editor || beautifying) return;
    const rawMd = editor.getMarkdown().trim();
    if (!rawMd) {
      toast.info('Напиши или надиктуй текст, чтобы красиво его оформить');
      return;
    }

    if (isDraftRef.current && !persistedDraftIdRef.current) {
      dirtyRef.current = true;
      await flushDraft(item.id);
    }
    const effectiveId = persistedDraftIdRef.current || item.id;

    setBeautifying(true);
    setMoreMenuOpen(false);
    try {
      const res = await window.kapsula.transformText({
        itemId: effectiveId,
        text: rawMd,
        preset,
      });

      if (res.formattedText && res.formattedText.trim()) {
        loadingItemRef.current = true;
        editor.commands.setContent(res.formattedText, { contentType: 'markdown' });
        loadingItemRef.current = false;

        const nextMd = editor.getMarkdown();
        bodyMarkdownRef.current = nextMd;
        setLiveBody(nextMd);
        const nextTitle =
          isGenericDraftTitle(title) && res.titleSuggestion
            ? res.titleSuggestion
            : title.trim() || deriveTitleFromBody(nextMd);
        if (nextTitle !== title) {
          setTitle(nextTitle);
          titleRef.current = nextTitle;
        }

        dirtyRef.current = false;
        const updated = await window.kapsula.updateItem(effectiveId, {
          title: nextTitle,
          body: nextMd,
          ...(res.summary ? { summary: res.summary } : {}),
        });
        if (updated) onItemUpdated(updated);

        const revs = await refreshRevisions();
        if (revs[0]) setQuickRevertRevId(revs[0].id);
        playTactileTick(soundEnabled, 'success');
        toast.success('Текст оформлен', {
          description: res.usedCloud ? 'ИИ привёл структуру в порядок' : 'Отформатировано локально',
        });
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось оформить заметку'));
    } finally {
      setBeautifying(false);
    }
  };

  const handleTranscribeVoice = async (extractTasks = false) => {
    if (!editor || transcribing || extractingVoiceTasks) return;
    const effectiveId = persistedDraftIdRef.current || item.id;
    if (!effectiveId || effectiveId.startsWith('__draft__') || !item.mediaPath) return;

    if (extractTasks) setExtractingVoiceTasks(true);
    else setTranscribing(true);

    try {
      const res = await transcribeItemWithWavFallback(
        {
          id: effectiveId,
          mediaPath: item.mediaPath,
          mediaDurationSec: item.mediaDurationSec,
        },
        { extractTasks }
      );

      if (!res.ok) {
        if (extractTasks && editor.getMarkdown().trim()) {
          // Graceful fallback: transform existing transcript text into a checklist
          await handleBeautify('tasks');
          return;
        }
        toast.error(
          res.error || 'Не удалось расшифровать запись. Проверь подключение и ключ ИИ в Настройках.'
        );
        return;
      }

      let nextBody = res.item?.body ?? '';
      if (!nextBody && res.transcript) {
        nextBody = res.transcript;
      }
      if (
        extractTasks &&
        res.extractedTasks &&
        res.extractedTasks.length > 0 &&
        !/^\s*[-*]\s+\[[ xX]\]/m.test(nextBody)
      ) {
        const checklistBlock = `## Задачи\n${res.extractedTasks.map((t) => `- [ ] ${t}`).join('\n')}`;
        nextBody = nextBody.trim() ? `${nextBody.trim()}\n\n${checklistBlock}` : checklistBlock;
        const patched = await window.kapsula.updateItem(effectiveId, { body: nextBody });
        if (patched) res.item = patched;
      }

      if (nextBody) {
        loadingItemRef.current = true;
        editor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
        loadingItemRef.current = false;
        const normalizedMd = editor.getMarkdown();
        bodyMarkdownRef.current = normalizedMd;
        setLiveBody(normalizedMd);
      }

      if (res.item?.title && res.item.title !== titleRef.current) {
        setTitle(res.item.title);
        titleRef.current = res.item.title;
      }

      dirtyRef.current = false;
      setSaveState('saved');
      if (res.item) onItemUpdated(res.item);
      await refreshRevisions();
      playTactileTick(soundEnabled, 'success');
      toast.success(
        extractTasks ? 'Задачи выделены из записи' : 'Голосовая заметка расшифрована'
      );
    } catch (err) {
      toast.error(
        friendlyErrorMessage(err, 'Не удалось расшифровать аудио. Проверь настройки ИИ.')
      );
    } finally {
      setTranscribing(false);
      setExtractingVoiceTasks(false);
    }
  };

  const handleQuickRevert = async (revisionId?: string) => {
    const effectiveId = persistedDraftIdRef.current || item.id;
    const targetRevId = revisionId || quickRevertRevId || revisions[0]?.id;
    if (!targetRevId || !editor) return;
    setRestoringRevId(targetRevId);
    try {
      const reverted = await window.kapsula.revertRevision(effectiveId, targetRevId);
      if (!reverted) return;

      const nextBody = reverted.body || '';
      loadingItemRef.current = true;
      editor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
      loadingItemRef.current = false;
      bodyMarkdownRef.current = nextBody;
      setLiveBody(nextBody);
      setTitle(reverted.title || '');
      titleRef.current = reverted.title || '';
      dirtyRef.current = false;
      setQuickRevertRevId(null);
      setHistoryOpen(false);
      onItemUpdated(reverted);
      await refreshRevisions();
      playTactileTick(soundEnabled, 'soft');
      toast.success('Версия восстановлена');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось восстановить версию'));
    } finally {
      setRestoringRevId(null);
    }
  };

  const applyNoteTemplate = useCallback(
    (tpl: NoteTemplate, replaceEntireDoc = false) => {
      if (!editor) return;
      const existingMd = editor.getMarkdown().trim();
      if (replaceEntireDoc || !existingMd) {
        editor.commands.setContent(tpl.body, { contentType: 'markdown' });
      } else {
        editor.chain().focus().insertContent(`\n\n${tpl.body}`, { contentType: 'markdown' }).run();
      }
      const nextMd = editor.getMarkdown();
      bodyMarkdownRef.current = nextMd;
      setLiveBody(nextMd);

      if (isGenericDraftTitle(titleRef.current)) {
        setTitle(tpl.title);
        titleRef.current = tpl.title;
      }

      const mergedTags = Array.from(new Set([...tagsRef.current, ...tpl.tags]));
      if (mergedTags.length !== tagsRef.current.length) {
        setTags(mergedTags);
        tagsRef.current = mergedTags;
        if (!isDraftRef.current || persistedDraftIdRef.current) {
          void applyMetaPatch({ tags: mergedTags });
        }
      }

      dirtyRef.current = true;
      setSaveState('saving');
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
      }, 280);
      playTactileTick(soundEnabled, 'soft');
      editor.commands.focus('end');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, flushDraft, soundEnabled]
  );

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((cmd) =>
      `${cmd.label} ${cmd.hint} ${cmd.keywords}`.toLowerCase().includes(slashQuery)
    );
  }, [slashQuery]);

  const filteredWikiItems = useMemo(() => {
    if (wikiQuery === null) return [];
    const curId = persistedDraftIdRef.current || item.id;
    const candidates = allItemsForLinks.filter((i) => i.id !== curId && i.dna !== 'secret');
    if (!wikiQuery) return candidates.slice(0, 7);
    return candidates
      .filter((i) => `${i.title} ${i.summary}`.toLowerCase().includes(wikiQuery))
      .slice(0, 7);
  }, [wikiQuery, allItemsForLinks, item.id]);

  const executeSlashCommand = (cmdId: SlashCommandId) => {
    if (!editor) return;
    const { state } = editor;
    const { $from } = state.selection;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
    const match = /(\/[а-яёa-z0-9_-]*)$/i.exec(textBefore);
    if (match?.[1]) {
      const fromPos = state.selection.from - match[1].length;
      editor.chain().focus().deleteRange({ from: fromPos, to: state.selection.from }).run();
    }
    setSlashQuery(null);

    if (cmdId.startsWith('template-')) {
      const tplId = cmdId.slice('template-'.length);
      const tpl = NOTE_TEMPLATES.find((t) => t.id === tplId);
      if (tpl) applyNoteTemplate(tpl);
      return;
    }

    switch (cmdId) {
      case 'h1':
        editor.chain().focus().clearNodes().toggleHeading({ level: 1 }).run();
        break;
      case 'h2':
        editor.chain().focus().clearNodes().toggleHeading({ level: 2 }).run();
        break;
      case 'h3':
        editor.chain().focus().clearNodes().toggleHeading({ level: 3 }).run();
        break;
      case 'task':
        editor.chain().focus().toggleTaskList().run();
        break;
      case 'bullet':
        editor.chain().focus().toggleBulletList().run();
        break;
      case 'ordered':
        editor.chain().focus().toggleOrderedList().run();
        break;
      case 'quote':
        editor.chain().focus().clearNodes().toggleBlockquote().run();
        break;
      case 'code':
        editor.chain().focus().clearNodes().toggleCodeBlock().run();
        break;
      case 'hr':
        editor.chain().focus().setHorizontalRule().run();
        break;
      case 'image':
        imageInputRef.current?.click();
        break;
      case 'dictate':
        setShowVoiceStudio(true);
        break;
      case 'beautify':
        void handleBeautify('structure');
        break;
    }
  };

  const insertWikiLink = (target: VaultItem) => {
    if (!editor) return;
    const { state } = editor;
    const { $from } = state.selection;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
    const match = /(\[\[[^\[\]]*)$/.exec(textBefore);
    if (match?.[1]) {
      const fromPos = state.selection.from - match[1].length;
      editor
        .chain()
        .focus()
        .deleteRange({ from: fromPos, to: state.selection.from })
        .insertContent([
          {
            type: 'wikiLink',
            attrs: { title: target.title, label: null, targetId: target.id },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    }
    setWikiQuery(null);
    const nextLinks = Array.from(new Set([...(item.linksOut ?? []), target.id]));
    void applyMetaPatch({ linksOut: nextLinks });
  };

  slashMenuStateRef.current = {
    query: slashQuery,
    index: slashIndex,
    filtered: filteredSlashCommands,
    run: executeSlashCommand,
  };

  wikiMenuStateRef.current = {
    query: wikiQuery,
    index: wikiIndex,
    filtered: filteredWikiItems,
    run: insertWikiLink,
  };

  const boardOptions = useMemo(
    () => [
      { value: '', label: 'Без холста' },
      ...focusBoards.map((b) => ({ value: b.id, label: b.name, dotColor: b.color })),
    ],
    [focusBoards]
  );

  // Use explicit vault-wide availableTags or derive frequency-sorted tags from allItemsForLinks
  const resolvedAvailableTags = useMemo(() => {
    if (availableTags && availableTags.length > 0) return availableTags;
    const freq = new Map<string, number>();
    for (const entry of allItemsForLinks) {
      for (const raw of entry.tags || []) {
        const clean = raw.trim().toLowerCase();
        if (clean) freq.set(clean, (freq.get(clean) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
      .map(([t]) => t);
  }, [availableTags, allItemsForLinks]);

  const activeOrbitId = isDraft && !persistedDraftIdRef.current ? draftOrbit : item.orbit || '';
  const activeOrbit = useMemo(
    () => orbits.find((o) => o.id === activeOrbitId) ?? null,
    [orbits, activeOrbitId]
  );
  const activeRemindAt = isDraft && !persistedDraftIdRef.current ? draftRemindAt : item.remindAt;

  const handleCopyNote = async () => {
    const cleanTitle = titleRef.current.trim();
    const cleanBody = (editor?.getMarkdown() ?? bodyMarkdownRef.current).trim();
    const combined = [cleanTitle, cleanBody].filter(Boolean).join('\n\n');
    if (!combined) {
      toast.info('Заметка пока пуста');
      return;
    }
    try {
      await window.kapsula.copyText(combined);
      playTactileTick(soundEnabled, 'soft');
      toast.success('Заметка скопирована');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось скопировать'));
    }
  };

  const handleOpenBubbleLink = () => {
    if (!editor) return;
    const existingHref = (editor.getAttributes('link')?.href as string | undefined) ?? '';
    setBubbleLinkUrl(existingHref);
    setBubbleLinkEditing(true);
  };

  const handleApplyBubbleLink = () => {
    if (!editor) return;
    const trimmed = bubbleLinkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setBubbleLinkEditing(false);
      return;
    }
    const normalized = /^https?:\/\/|^mailto:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run();
    setBubbleLinkEditing(false);
    setBubbleLinkUrl('');
  };

  const mediaUrl = getMediaUrl(item.mediaPath);
  const mediaCat = getMediaCategory(item);
  const isVideoMedia = Boolean(
    item.mediaPath &&
      (mediaCat === 'video' || (!item.mediaType?.startsWith('audio/') && VIDEO_PATH_RE.test(item.mediaPath)))
  );
  const isAudioMedia = Boolean(
    item.mediaPath && !isVideoMedia && (mediaCat === 'audio' || AUDIO_PATH_RE.test(item.mediaPath))
  );
  const imageUrl = getMediaUrl(item.imagePath || item.thumbPath);

  const isVoiceNote = item.dna === 'voice' || isAudioMedia;
  const hasVoiceText = Boolean((liveBody || item.mediaMeta?.transcript || '').trim().length > 0);

  const showEmptyTemplateChips = Boolean(
    !liveBody.trim() &&
      !isVoiceNote &&
      !isVideoMedia &&
      !imageUrl &&
      !item.url &&
      item.dna !== 'doc'
  );

  const portalPlacement = useMemo(() => {
    if (!caretRect) return null;
    const menuW = 324;
    const left = Math.max(16, Math.min(window.innerWidth - menuW - 16, caretRect.left));
    const spaceBelow = window.innerHeight - caretRect.bottom - 16;
    const spaceAbove = caretRect.top - 16;
    // Prefer opening BELOW caret whenever >= 220px is available (only flip upward near bottom edge)
    const showAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const availableH = showAbove ? spaceAbove : spaceBelow;
    const listMaxHeight = Math.max(152, Math.min(280, Math.floor(availableH - 42)));
    const estimatedMenuH = listMaxHeight + 40;
    const top = showAbove
      ? Math.max(16, caretRect.top - estimatedMenuH - 6)
      : caretRect.bottom + 6;
    return {
      style: {
        left: `${left}px`,
        top: `${top}px`,
        width: `${menuW}px`,
        transformOrigin: showAbove ? 'bottom left' : 'top left',
      } as React.CSSProperties,
      listMaxHeight,
    };
  }, [caretRect]);

  return (
    <div
      data-testid="note-studio"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          if (!isDraggingImage) setIsDraggingImage(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsDraggingImage(false);
        }
      }}
      onDrop={() => setIsDraggingImage(false)}
      className={`@container flex flex-col h-full min-h-0 text-[var(--k-ink-primary)] ${
        presentation === 'modal' ? 'bg-[var(--k-bg-surface-1)]' : 'bg-[var(--k-bg-canvas)]'
      }`}
    >
      {/* Hidden file picker for inline note photo uploads */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="studio-image-file-input"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (picked.length > 0) {
            void insertImageFilesRef.current(picked);
          }
        }}
      />

      {/* Serene Minimal Document Header */}
      <div
        data-testid="note-studio-header"
        className={`flex items-center justify-between gap-3 h-[48px] border-b border-[var(--k-border-hairline)]/70 shrink-0 ${
          presentation === 'modal'
            ? 'bg-[var(--k-bg-surface-1)] px-5'
            : reserveTrafficLights
              ? 'bg-[var(--k-bg-canvas)] pl-[82px] pr-5 k-drag-region'
              : 'bg-[var(--k-bg-canvas)] px-5'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden k-no-drag">
          {leadingBarSlot}

          {presentation !== 'modal' && onClose ? (
            <>
              <button
                type="button"
                data-testid="note-studio-close"
                onClick={() => void handleCloseStudio()}
                aria-label="Назад к списку"
                className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-7.5 pl-2 pr-2 rounded-lg text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
              >
                <ArrowLeft weight="bold" className="w-3.5 h-3.5 shrink-0" />
                <span>Назад</span>
                <span className="k-mono text-[10px] text-[var(--k-ink-muted)] px-1 py-0.25 rounded bg-[var(--k-bg-surface-2)]/85 ml-0.5 hidden sm:inline">
                  Esc
                </span>
              </button>
              <span className="w-px h-3.5 bg-[var(--k-border-hairline)] shrink-0" />
            </>
          ) : null}

          {/* Unmistakable Section Chip Selector (matches Feed Section chip 1:1) */}
          <PopoverSurface
            open={orbitMenuOpen}
            onOpenChange={setOrbitMenuOpen}
            align="start"
            widthClass="w-56 !p-1.5"
            trigger={
              activeOrbit ? (
                <button
                  type="button"
                  data-testid="note-studio-orbit-breadcrumb"
                  title={`Раздел: ${activeOrbit.name} · нажми, чтобы сменить`}
                  style={{
                    backgroundColor: `color-mix(in srgb, ${activeOrbit.color} 13%, transparent)`,
                    borderColor: `color-mix(in srgb, ${activeOrbit.color} 28%, transparent)`,
                  }}
                  className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] border text-[12px] font-medium text-[var(--k-ink-primary)] hover:brightness-105 cursor-pointer min-w-0 max-w-[200px]"
                >
                  <SectionIcon
                    name={activeOrbit.icon}
                    color={activeOrbit.color}
                    className="w-3.5 h-3.5 shrink-0"
                  />
                  <span className="truncate">{activeOrbit.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="note-studio-orbit-breadcrumb"
                  title="Выбрать раздел"
                  className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[7px] border border-dashed border-[var(--k-border-strong)]/70 bg-transparent text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]/70 cursor-pointer min-w-0 max-w-[180px]"
                >
                  <FolderSimple className="w-3.5 h-3.5 shrink-0 opacity-75" />
                  <span className="truncate">Без раздела</span>
                </button>
              )
            }
          >
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto text-[12.5px]">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                Раздел
              </div>
              <button
                type="button"
                onClick={() => {
                  setOrbitMenuOpen(false);
                  void applyMetaPatch({ orbit: '' });
                }}
                className={`k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer ${
                  !activeOrbitId
                    ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                    : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                }`}
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  <FolderSimple className="w-3.5 h-3.5 shrink-0 opacity-70" />
                  <span>Без раздела</span>
                </span>
                {!activeOrbitId ? <Check weight="bold" className="w-3.5 h-3.5 shrink-0" /> : null}
              </button>
              {orbits.map((o) => {
                const selected = activeOrbitId === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setOrbitMenuOpen(false);
                      void applyMetaPatch({ orbit: o.id });
                    }}
                    className={`k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer ${
                      selected
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                        : 'text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <SectionIcon
                        name={o.icon}
                        color={o.color}
                        className="w-3.5 h-3.5 shrink-0"
                      />
                      <span className="truncate">{o.name}</span>
                    </span>
                    {selected ? <Check weight="bold" className="w-3.5 h-3.5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </PopoverSurface>

          {/* Subtle Relative Date & Save Status */}
          <span className="text-[11.5px] text-[var(--k-ink-muted)]/85 k-tabular truncate hidden @[480px]:inline">
            {saveState === 'saving'
              ? '· Сохраняю…'
              : !isDraft
                ? `· ${formatRelativeDate(item.updatedAt)}`
                : '· Новая заметка'}
          </span>
        </div>

        {/* Right: ONLY Compact Low-Contrast Icon Controls */}
        <div className="flex items-center gap-1 shrink-0 k-no-drag">
          {quickRevertRevId ? (
            <button
              type="button"
              data-testid="studio-revert-original-btn"
              onClick={() => void handleQuickRevert(quickRevertRevId)}
              title="Вернуть оригинал"
              aria-label="Вернуть оригинал"
              className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-accent)] hover:border-[var(--k-border-strong)] cursor-pointer mr-0.5"
            >
              <ArrowCounterClockwise weight="bold" className="w-3.5 h-3.5" />
              <span className="hidden @[520px]:inline">Вернуть оригинал</span>
            </button>
          ) : null}

          {!isDraft ? (
            <button
              type="button"
              data-testid="studio-favorite-btn"
              onClick={() => void applyMetaPatch({ isPinned: !item.isPinned })}
              aria-label={item.isPinned ? 'Убрать из избранного' : 'В избранное'}
              title={item.isPinned ? 'Убрать из избранного' : 'В избранное'}
              className={`k-interactive k-focus-ring inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg cursor-pointer ${
                item.isPinned
                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                  : 'text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
              }`}
            >
              <Star weight={item.isPinned ? 'fill' : 'regular'} className="w-4 h-4" />
            </button>
          ) : null}

          <ReminderPopover
            remindAt={activeRemindAt}
            className={
              activeRemindAt
                ? '!h-7.5 !px-2 !rounded-lg'
                : '!h-7.5 !w-7.5 !px-0 justify-center !border-transparent !bg-transparent hover:!bg-[var(--k-bg-surface-2)] !text-[var(--k-ink-muted)] hover:!text-[var(--k-ink-primary)] !rounded-lg'
            }
            labelClassName={activeRemindAt ? 'max-w-[110px]' : 'hidden'}
            onChange={(nextMs) => void applyMetaPatch({ remindAt: nextMs })}
          />

          {!isDraft && (revisions.length > 0 || Boolean(liveBody.trim())) ? (
            <button
              type="button"
              data-testid="studio-history-btn"
              title={
                revisions.length > 0
                  ? `История версий (${revisions.length})`
                  : 'История версий'
              }
              aria-label="История версий"
              onClick={() => void handleOpenHistoryModal()}
              className="k-interactive relative inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <ClockCounterClockwise className="w-4 h-4" />
              {revisions.length > 0 ? (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--k-accent)]" />
              ) : null}
            </button>
          ) : null}

          <PopoverSurface
            open={moreMenuOpen}
            onOpenChange={setMoreMenuOpen}
            align="end"
            widthClass="w-60 !p-1.5"
            trigger={
              <button
                type="button"
                data-testid="studio-more-menu-btn"
                aria-label="Ещё действия"
                title="Ещё действия"
                className="k-interactive inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer"
              >
                <DotsThree weight="bold" className="w-4.5 h-4.5" />
              </button>
            }
          >
            <div className="space-y-0.5 text-[12.5px]">
              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  void handleCopyNote();
                }}
                className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                <span>Скопировать текст</span>
              </button>

              <button
                type="button"
                data-testid="studio-beautify-btn"
                disabled={beautifying}
                onClick={() => void handleBeautify(activePreset)}
                className="k-interactive w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-accent-soft)] text-left cursor-pointer disabled:opacity-60"
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkle weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                  <span>{beautifying ? 'Причёсываю…' : 'Причесать с ИИ'}</span>
                </span>
              </button>

              <div className="px-2 pb-1 pt-0.5 grid grid-cols-2 gap-1">
                {PRESET_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`beautify-preset-${opt.id}`}
                    disabled={beautifying}
                    title={opt.desc}
                    onClick={() => {
                      setActivePreset(opt.id);
                      void handleBeautify(opt.id);
                    }}
                    className={`k-interactive rounded-md px-2 py-1 text-[11px] text-left truncate cursor-pointer ${
                      activePreset === opt.id
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] font-medium'
                        : 'bg-[var(--k-bg-surface-2)]/70 text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="h-px bg-[var(--k-border-hairline)] my-1" />

              <button
                type="button"
                data-testid="studio-dictate-btn"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setShowVoiceStudio((prev) => !prev);
                }}
                className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
              >
                <Microphone className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                <span>{showVoiceStudio ? 'Скрыть диктовку' : 'Надиктовать голосом'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  imageInputRef.current?.click();
                }}
                className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
              >
                <ImageSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                <span>Вставить фото</span>
              </button>

              {focusBoards.length > 0 ? (
                <div className="px-2 py-1.5 mt-1 space-y-1 border-t border-[var(--k-border-hairline)]">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    Холст
                  </div>
                  <SelectMenu
                    size="sm"
                    value={
                      isDraft && !persistedDraftIdRef.current
                        ? draftBoardId || ''
                        : item.focusBoardId || ''
                    }
                    options={boardOptions}
                    onChange={(val) => void applyMetaPatch({ focusBoardId: val || null })}
                  />
                </div>
              ) : null}

              {!isDraft ? (
                <>
                  <div className="h-px bg-[var(--k-border-hairline)] my-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void handleOpenHistoryModal();
                    }}
                    className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                  >
                    <ClockCounterClockwise className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                    <span>История версий ({revisions.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void applyMetaPatch({ isArchived: !item.isArchived });
                    }}
                    className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                    <span>{item.isArchived ? 'Вернуть из архива' : 'В архив'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onDelete(persistedDraftIdRef.current || item.id);
                    }}
                    className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] text-left cursor-pointer"
                  >
                    <Trash className="w-3.5 h-3.5" />
                    <span>В корзину</span>
                  </button>
                </>
              ) : null}
            </div>
          </PopoverSurface>

          {presentation === 'modal' && onClose ? (
            <>
              <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-0.5 shrink-0" />
              <button
                type="button"
                data-testid="note-studio-close"
                onClick={() => void handleCloseStudio()}
                aria-label="Закрыть заметку"
                title="Закрыть (Esc)"
                className="k-interactive k-focus-ring inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
              >
                <X weight="bold" className="w-4 h-4" />
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Main Scrollable Serene Document Canvas */}
      <div className="flex-1 min-h-0 overflow-y-auto k-scroll-stable">
        <div
          className={`${
            presentation === 'modal'
              ? 'max-w-[720px] mx-auto px-7 py-6'
              : 'max-w-[760px] mx-auto px-8 py-8'
          } flex flex-col gap-5 transition-colors duration-140 ${
            isDraggingImage ? 'k-editor-drop-active' : ''
          }`}
        >

          {showVoiceStudio ? (
            <VoiceRecorderStudio
              mode="dictate"
              itemId={!isDraftRef.current ? persistedDraftIdRef.current || item.id : undefined}
              onDictated={async (res, wav) => {
                setShowVoiceStudio(false);
                if (!editor) return;
                if (isDraftRef.current && !persistedDraftIdRef.current) {
                  const dictatedBody = (res.formattedText || res.transcript || '').trim();
                  const effectiveTitle = res.titleSuggestion || titleRef.current.trim() || undefined;
                  const created = await window.kapsula.capture({
                    audioBase64: wav.wavBase64,
                    audioMime: wav.mime,
                    audioDurationSec: wav.durationSec,
                    title: effectiveTitle,
                    text: dictatedBody,
                    orbitOverride: item.orbit || undefined,
                    focusBoardId: item.focusBoardId,
                    mediaMeta: { waveformPeaks: wav.peaks, transcript: res.transcript },
                  });
                  persistedDraftIdRef.current = created.id;
                  isDraftRef.current = false;

                  loadingItemRef.current = true;
                  const renderedBody = created.body || dictatedBody;
                  editor.commands.setContent(renderedBody, {
                    contentType: 'markdown',
                    emitUpdate: false,
                  });
                  loadingItemRef.current = false;

                  const nextMd = editor.getMarkdown();
                  bodyMarkdownRef.current = nextMd;
                  setLiveBody(nextMd);
                  if (created.title) {
                    setTitle(created.title);
                    titleRef.current = created.title;
                  }
                  dirtyRef.current = false;
                  setSaveState('saved');

                  onDraftPersistedRef.current?.(created);
                  playTactileTick(soundEnabled, 'success');
                  toast.success('Голос и аудио сохранены в заметке');
                  return;
                }
                const effectiveId = persistedDraftIdRef.current || item.id;
                await window.kapsula.saveRevision(effectiveId, 'voice');
                const inserted = res.formattedText || res.transcript;
                if (inserted) {
                  if (!editor.getMarkdown().trim()) {
                    editor.commands.setContent(inserted, { contentType: 'markdown' });
                  } else {
                    editor.chain().focus().insertContent(`\n\n${inserted}`, { contentType: 'markdown' }).run();
                  }
                  if (res.titleSuggestion && (!title.trim() || title.trim() === 'Заметка')) {
                    setTitle(res.titleSuggestion);
                    titleRef.current = res.titleSuggestion;
                  }
                  const nextMd = editor.getMarkdown();
                  bodyMarkdownRef.current = nextMd;
                  setLiveBody(nextMd);
                  dirtyRef.current = true;
                  await flushDraft(effectiveId);
                  await refreshRevisions();
                  playTactileTick(soundEnabled, 'success');
                }
                toast.success('Голос и аудио прикреплены к заметке');
              }}
              onFallbackSaveAudio={async (wav) => {
                setShowVoiceStudio(false);
                const created = await window.kapsula.capture({
                  audioBase64: wav.wavBase64,
                  audioMime: wav.mime,
                  audioDurationSec: wav.durationSec,
                  source: 'vault_ui',
                  orbitOverride: item.orbit || undefined,
                  mediaMeta: { waveformPeaks: wav.peaks },
                });
                if (isDraftRef.current) onDraftPersisted?.(created);
                toast.success('Аудиозапись сохранена');
              }}
              onCancel={() => setShowVoiceStudio(false)}
            />
          ) : null}

          {isVideoMedia && item.mediaPath ? (
            <InlineReferenceVideo
              mediaPath={item.mediaPath}
              posterPath={item.thumbPath || item.imagePath}
              heightClass="max-h-[320px]"
              onOpenFull={() => void window.kapsula.openMediaFile(item.mediaPath!)}
            />
          ) : null}

          {imageUrl && !isVideoMedia ? (
            <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] overflow-hidden">
              <div className="relative max-h-[300px] overflow-hidden flex items-center justify-center bg-[var(--k-bg-surface-2)]">
                <img
                  src={imageUrl}
                  alt={item.title}
                  className="max-h-[300px] w-auto object-contain"
                />
                <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                  <CopySlotPill
                    label="Фото"
                    copiedLabel="Скопировано"
                    widthPx={104}
                    heightPx={28}
                    onCopy={() => window.kapsula.copyImage(item.imagePath || item.thumbPath || '')}
                  />
                  {onOpenShotLightbox ? (
                    <button
                      type="button"
                      aria-label="Открыть во весь экран"
                      title="Открыть во весь экран"
                      onClick={() => onOpenShotLightbox(item)}
                      className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg border border-white/15 bg-black/55 text-white hover:bg-black/75 cursor-pointer"
                    >
                      <ArrowsOutSimple className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              {item.ocrText ? (
                <details className="px-3.5 py-2 border-t border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-secondary)]">
                  <summary className="cursor-pointer select-none font-medium text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]">
                    Текст со скриншота
                  </summary>
                  <div className="mt-2 flex items-start justify-between gap-2 k-selectable">
                    <p className="m-0 whitespace-pre-wrap leading-relaxed">{item.ocrText}</p>
                    <CopySlotPill
                      label="Текст"
                      copiedLabel="Готово"
                      widthPx={82}
                      heightPx={24}
                      onCopy={() => window.kapsula.copyText(item.ocrText)}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}

          {isAudioMedia && mediaUrl ? (
            <div className="flex flex-col gap-2.5 rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/60 p-3">
              <WaveformAudioPlayer
                src={mediaUrl}
                fallbackDurationSec={item.mediaDurationSec}
                peaks={item.mediaMeta?.waveformPeaks}
                seedKey={item.id}
              />

              {/* Voice AI Action Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                {!hasVoiceText ? (
                  <>
                    <button
                      type="button"
                      data-testid="studio-audio-transcribe-btn"
                      disabled={transcribing}
                      onClick={() => void handleTranscribeVoice(false)}
                      className={`k-interactive inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:opacity-65 ${
                        transcribing ? 'k-beautify-shimmer' : ''
                      }`}
                    >
                      {transcribing ? (
                        <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin shrink-0" />
                      ) : (
                        <Sparkle weight="fill" className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>{transcribing ? 'Расшифровываю…' : 'Расшифровать через ИИ'}</span>
                    </button>
                    <span className="text-[11.5px] text-[var(--k-ink-muted)]">
                      Переведёт запись в чистый текст и выделит главное
                    </span>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="studio-retranscribe-btn"
                      disabled={transcribing || extractingVoiceTasks}
                      onClick={() => void handleTranscribeVoice(false)}
                      className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-55"
                    >
                      {transcribing ? (
                        <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ArrowCounterClockwise className="w-3.5 h-3.5" />
                      )}
                      <span>{transcribing ? 'Расшифровываю…' : 'Перерасшифровать'}</span>
                    </button>
                    <button
                      type="button"
                      data-testid="studio-voice-extract-tasks-btn"
                      disabled={transcribing || extractingVoiceTasks}
                      onClick={() => void handleTranscribeVoice(true)}
                      className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)] text-[12px] font-medium text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)] cursor-pointer disabled:opacity-55"
                    >
                      {extractingVoiceTasks ? (
                        <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ListChecks weight="bold" className="w-3.5 h-3.5" />
                      )}
                      <span>{extractingVoiceTasks ? 'Выделяю задачи…' : 'Выделить задачи'}</span>
                    </button>
                  </div>
                )}
              </div>

              {item.mediaMeta?.transcript &&
              item.mediaMeta.transcript.trim() !== liveBody.trim() ? (
                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2 text-[12.5px] text-[var(--k-ink-secondary)] k-selectable">
                  <span className="font-medium text-[var(--k-ink-muted)] mr-1.5">Расшифровка:</span>
                  {item.mediaMeta.transcript}
                </div>
              ) : null}
            </div>
          ) : null}

          {item.url ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <LinkSimple className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                <span className="text-[12.5px] text-[var(--k-ink-secondary)] truncate k-selectable">
                  {item.url}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <CopySlotPill
                  label="Ссылка"
                  copiedLabel="Готово"
                  widthPx={84}
                  heightPx={28}
                  onCopy={() => window.kapsula.copyText(item.url || '')}
                />
                <button
                  type="button"
                  onClick={() => void window.kapsula.openExternal(item.url || '')}
                  className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  <span>Открыть</span>
                  <ArrowSquareOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : null}

          {item.dna === 'doc' && item.mediaPath ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <FileText weight="duotone" className="w-5 h-5 text-[var(--k-accent)] shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {item.mediaMeta?.fileName || item.title}
                  </div>
                  <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                    {[
                      formatFileSize(item.mediaMeta?.fileSize),
                      item.mediaMeta?.pageCount ? `${item.mediaMeta.pageCount} стр.` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Документ'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void window.kapsula.openMediaFile(item.mediaPath!)}
                  className="k-interactive h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  Открыть
                </button>
                <button
                  type="button"
                  onClick={() => void window.kapsula.revealMediaFile(item.mediaPath!)}
                  aria-label="Показать в папке"
                  className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : null}

          {/* Generous Borderless Editorial Document Title */}
          <div className="flex flex-col gap-2.5">
            <textarea
              ref={titleTextareaRef}
              rows={1}
              data-testid="note-studio-title"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value.replace(/\r?\n/g, ' '))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  editor?.commands.focus();
                }
              }}
              placeholder="Без названия"
              className="w-full resize-none overflow-hidden bg-transparent border-none outline-none text-[28px] sm:text-[31px] font-bold tracking-[-0.006em] leading-[1.22] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]/55 k-selectable"
            />

            {/* Quiet Metadata, Smart Tags & On-Demand `+` Insert Pill */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3.5 border-b border-[var(--k-border-hairline)]/65">
              <InlineTagEditor
                tags={tags}
                availableTags={resolvedAvailableTags}
                onChange={(nextTags) => {
                  setTags(nextTags);
                  void applyMetaPatch({ tags: nextTags });
                }}
              />

              {editor ? (
                <PopoverSurface
                  open={insertMenuOpen}
                  onOpenChange={setInsertMenuOpen}
                  align="end"
                  widthClass="w-56 !p-1.5"
                  trigger={
                    <button
                      type="button"
                      data-testid="studio-insert-menu-btn"
                      title="Вставить блок, фото или шаблон (или введи «/» в тексте)"
                      className="k-interactive inline-flex items-center gap-1 h-[26px] px-2 rounded-full border border-transparent hover:border-[var(--k-border-hairline)] hover:bg-[var(--k-bg-surface-2)]/80 text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
                    >
                      {insertingImage ? (
                        <CircleNotch weight="bold" className="w-3 h-3 animate-spin text-[var(--k-accent)]" />
                      ) : (
                        <Plus weight="bold" className="w-3 h-3" />
                      )}
                      <span>Вставить</span>
                    </button>
                  }
                >
                  <div className="space-y-0.5 text-[12.5px]">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      Вставить в заметку
                    </div>
                    <button
                      type="button"
                      data-testid="studio-insert-image-btn"
                      disabled={insertingImage}
                      onClick={() => {
                        setInsertMenuOpen(false);
                        imageInputRef.current?.click();
                      }}
                      className="k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer disabled:opacity-55"
                    >
                      <span className="inline-flex items-center gap-2">
                        <ImageSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                        <span>Фото</span>
                      </span>
                      <span className="k-mono text-[10px] text-[var(--k-ink-muted)]">
                        {isMacPlatform(window.kapsula?.platform) ? '⌘V' : 'Ctrl+V'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        editor.chain().focus().toggleTaskList().run();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <CheckSquare className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Чек-лист</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        editor.chain().focus().toggleHeading({ level: 2 }).run();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <TextHTwo className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Заголовок</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        editor.chain().focus().toggleBulletList().run();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <ListBullets className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Список</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        editor.chain().focus().toggleBlockquote().run();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <Quotes className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Цитата</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        editor.chain().focus().toggleCodeBlock().run();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <Code className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Блок кода</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInsertMenuOpen(false);
                        setShowVoiceStudio(true);
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <Microphone className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                      <span>Голосовая диктовка</span>
                    </button>

                    <div className="h-px bg-[var(--k-border-hairline)] my-1" />
                    <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      Шаблоны
                    </div>
                    <div className="grid grid-cols-2 gap-1 px-1 pb-0.5">
                      {NOTE_TEMPLATES.map((tpl) => {
                        const Icon = TEMPLATE_ICON_MAP[tpl.id];
                        return (
                          <button
                            key={tpl.id}
                            type="button"
                            onClick={() => {
                              setInsertMenuOpen(false);
                              applyNoteTemplate(tpl);
                            }}
                            className="k-interactive inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-[var(--k-bg-surface-2)]/75 hover:bg-[var(--k-accent-soft)] text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-accent)] cursor-pointer"
                          >
                            <Icon weight="duotone" className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{tpl.shortLabel}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="px-2 pt-1 text-[10.5px] text-[var(--k-ink-muted)] border-t border-[var(--k-border-hairline)]">
                      Также работает «/» в тексте и «[[» для связей
                    </div>
                  </div>
                </PopoverSurface>
              ) : null}
            </div>
          </div>

          {/* 1-Click Empty Draft Starter Templates (calm & subtle, vanishes on first character) */}
          <AnimatePresence initial={false}>
            {showEmptyTemplateChips ? (
              <motion.div
                key="empty-template-chips"
                data-testid="studio-template-chips"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                className="overflow-hidden -mt-2"
              >
                <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                  <span className="text-[11.5px] text-[var(--k-ink-muted)] mr-0.5">
                    Начать с шаблона:
                  </span>
                  {NOTE_TEMPLATES.map((tpl) => {
                    const Icon = TEMPLATE_ICON_MAP[tpl.id];
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        data-testid={`studio-template-chip-${tpl.id}`}
                        title={tpl.description}
                        onClick={() => applyNoteTemplate(tpl, true)}
                        className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        <Icon weight="duotone" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                        <span>{tpl.shortLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* On-Demand Floating Selection Bubble Toolbar */}
          {editor ? (
            <BubbleMenu
              editor={editor}
              options={bubbleMenuOptions}
              className="k-bubble-menu z-[40] flex items-center gap-0.5 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1 shadow-[var(--k-shadow-popover)] backdrop-blur-xl"
            >
              {bubbleLinkEditing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleApplyBubbleLink();
                  }}
                  className="flex items-center gap-1 px-1"
                >
                  <input
                    type="text"
                    autoFocus
                    value={bubbleLinkUrl}
                    onChange={(e) => setBubbleLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setBubbleLinkEditing(false);
                        editor.commands.focus();
                      }
                    }}
                    placeholder="https://example.com"
                    className="h-7 w-48 px-2 rounded-lg bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] text-[12px] text-[var(--k-ink-primary)] outline-none select-text"
                  />
                  <button
                    type="submit"
                    aria-label="Применить ссылку"
                    title="Применить ссылку"
                    className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] cursor-pointer"
                  >
                    <Check weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  {toolbarState?.link ? (
                    <button
                      type="button"
                      aria-label="Убрать ссылку"
                      title="Убрать ссылку"
                      onClick={() => {
                        editor.chain().focus().extendMarkRange('link').unsetLink().run();
                        setBubbleLinkEditing(false);
                      }}
                      className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer"
                    >
                      <LinkBreak weight="bold" className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Отмена"
                    onClick={() => {
                      setBubbleLinkEditing(false);
                      editor.commands.focus();
                    }}
                    className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                  >
                    <X weight="bold" className="w-3.5 h-3.5" />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    title={isMacPlatform(window.kapsula?.platform) ? 'Жирный (⌘B)' : 'Жирный (Ctrl+B)'}
                    aria-label="Жирный"
                    onClick={() => editor.chain().focus().toggleBold().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.bold
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <TextB weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title={isMacPlatform(window.kapsula?.platform) ? 'Курсив (⌘I)' : 'Курсив (Ctrl+I)'}
                    aria-label="Курсив"
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.italic
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <TextItalic weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Зачёркнутый"
                    aria-label="Зачёркнутый"
                    onClick={() => editor.chain().focus().toggleStrike().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.strike
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <TextStrikethrough weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Код"
                    aria-label="Код"
                    onClick={() => editor.chain().focus().toggleCode().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.code
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <Code weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Выделение"
                    aria-label="Выделение"
                    onClick={() => editor.chain().focus().toggleHighlight().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.highlight
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <Highlighter weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-0.5" />
                  <button
                    type="button"
                    title="Заголовок H2"
                    aria-label="Заголовок H2"
                    onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.h2
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <TextHTwo weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Ссылка"
                    aria-label="Ссылка"
                    onClick={handleOpenBubbleLink}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.link
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <LinkSimple weight="bold" className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </BubbleMenu>
          ) : null}

          {/* TipTap Rich Markdown Canvas */}
          <div ref={setEditorBoundaryEl} className="relative min-w-0">
            <EditorContent editor={editor} />
            <ProseCaretOverlay editor={editor} containerEl={editorBoundaryEl} />
          </div>

          {/* Backlinks & Similar Notes — Clearly Separated */}
          {!isDraft && (relatedState.backlinks.length > 0 || relatedState.related.length > 0) ? (
            <div className="pt-4 border-t border-[var(--k-border-hairline)]/70 flex flex-col gap-3">
              {relatedState.backlinks.length > 0 ? (
                <div data-testid="note-studio-backlinks" className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-accent)] flex items-center gap-1.5">
                    <LinkSimple weight="bold" className="w-3.5 h-3.5" />
                    <span>Обратные ссылки ({relatedState.backlinks.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {relatedState.backlinks.map((bk) => (
                      <button
                        key={`bk-${bk.id}`}
                        type="button"
                        onClick={() => onSelectRelatedItem?.(bk)}
                        className="k-interactive inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[12px] font-medium text-[var(--k-accent)] hover:border-[var(--k-accent)]/60 cursor-pointer"
                      >
                        <LinkSimple className="w-3 h-3 shrink-0" />
                        <span className="truncate max-w-[200px]">{bk.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {relatedState.related.length > 0 ? (
                <div data-testid="note-studio-related" className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    Похожие записи ({relatedState.related.length})
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {relatedState.related.map((rel) => (
                      <button
                        key={`rel-${rel.item.id}`}
                        type="button"
                        title={rel.reason}
                        onClick={() => onSelectRelatedItem?.(rel.item)}
                        className="k-interactive inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                      >
                        <span className="truncate max-w-[180px]">{rel.item.title}</span>
                        <span className="text-[10.5px] text-[var(--k-ink-muted)]">
                          · {rel.reason}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Inline Photo Lightbox */}
      <ShotLightbox item={inlineLightboxItem} onClose={() => setInlineLightboxItem(null)} />

      {/* Full Revision History & Diff Modal */}
      <RevisionHistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        revisions={revisions}
        currentTitle={title}
        currentBody={liveBody}
        restoringId={restoringRevId}
        onRestore={(revId) => handleQuickRevert(revId)}
      />

      {/* Floating Caret-Anchored Portal for `/` Slash Menu (GPU popup, ZERO layout push!) */}
      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {slashQuery !== null && filteredSlashCommands.length > 0 && portalPlacement ? (
                <motion.div
                  key="slash-command-menu"
                  data-testid="slash-command-menu"
                  initial={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, transform: 'translate3d(0, -4px, 0) scale(0.97)' }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, transform: 'translate3d(0px, 0, 0) scale(1)' }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, transform: 'translate3d(0, -3px, 0) scale(0.97)' }
                  }
                  transition={{ duration: 0.13, ease: [0.23, 1, 0.32, 1] }}
                  style={portalPlacement.style}
                  className="fixed z-[135] rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl"
                >
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    Команды и шаблоны
                  </div>
                  <div className="relative">
                    <div
                      ref={slashListRef}
                      style={{ maxHeight: `${portalPlacement.listMaxHeight}px` }}
                      className="overflow-y-auto flex flex-col gap-0.5 pb-3 scroll-pb-3"
                    >
                    {filteredSlashCommands.map((cmd, idx) => {
                      const Icon = cmd.icon;
                      const active = idx === slashIndex % filteredSlashCommands.length;
                      return (
                        <button
                          key={cmd.id}
                          type="button"
                          data-active={active ? 'true' : 'false'}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            executeSlashCommand(cmd.id);
                          }}
                          className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left cursor-pointer ${
                            active
                              ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                              : 'hover:bg-[var(--k-bg-surface-3)]'
                          }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)] truncate">
                              {cmd.label}
                            </div>
                            <div
                              className={`text-[11px] truncate ${
                                active ? 'text-[var(--k-ink-secondary)]' : 'text-[var(--k-ink-muted)]'
                              }`}
                            >
                              {cmd.hint}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                    </div>
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-5 rounded-b-lg bg-gradient-to-t from-[var(--k-bg-surface-1)] to-transparent"
                    />
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}

      {/* Floating Caret-Anchored Portal for `[[` Wiki-Link Picker */}
      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {wikiQuery !== null && filteredWikiItems.length > 0 && portalPlacement ? (
                <motion.div
                  key="wiki-link-menu"
                  data-testid="wiki-link-menu"
                  initial={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, transform: 'translate3d(0, -4px, 0) scale(0.97)' }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, transform: 'translate3d(0px, 0, 0) scale(1)' }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, transform: 'translate3d(0, -3px, 0) scale(0.97)' }
                  }
                  transition={{ duration: 0.13, ease: [0.23, 1, 0.32, 1] }}
                  style={portalPlacement.style}
                  className="fixed z-[135] rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-1.5 shadow-[var(--k-shadow-popover)] backdrop-blur-xl"
                >
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    Связать с заметкой
                  </div>
                  {filteredWikiItems.map((cand, idx) => {
                    const active = idx === wikiIndex % filteredWikiItems.length;
                    return (
                      <button
                        key={cand.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertWikiLink(cand);
                        }}
                        className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-pointer ${
                          active
                            ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                            : 'hover:bg-[var(--k-bg-surface-3)]'
                        }`}
                      >
                        <LinkSimple className="w-3.5 h-3.5 shrink-0 opacity-75" />
                        <span className="text-[12.5px] font-medium truncate text-[var(--k-ink-primary)]">
                          {cand.title}
                        </span>
                      </button>
                    );
                  })}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </div>
  );
};
