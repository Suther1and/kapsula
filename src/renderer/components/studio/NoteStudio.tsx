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
import { common, createLowlight } from 'lowlight';
import {
  Archive,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowSquareOut,
  ArrowsInSimple,
  ArrowsOutSimple,
  Check,
  CheckSquare,
  CircleNotch,
  ClockCounterClockwise,
  Code,
  Copy,
  DotsThree,
  EyeSlash,
  FileText,
  FolderOpen,
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
  NotePencil,
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
  TextUnderline,
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
import { useI18n } from '@shared/i18n/react';
import { getMediaCategory, isGenericDraftTitle, isUntitledPlaceholderTitle } from '@shared/item-helpers';
import { getNoteTemplates, type NoteTemplate } from '@shared/note-templates';
import { isMacPlatform } from '@shared/shortcuts';
import { extractWikiLinkTitles } from '@shared/task-helpers';
import {
  KapsulaHighlight,
  KapsulaHorizontalRule,
  TEXT_COLOR_SWATCHES,
  TextColorMark,
  TextSizeMark,
  type TextSizeKey,
} from '@shared/tiptap-rich-marks';
import '../../styles/editor.css';
import {
  formatFileSize,
  formatRelativeDate,
  friendlyErrorMessage,
  getMediaUrl,
  stripMarkdownPreview,
  transcribeItemWithWavFallback,
} from '../../lib/format';
import { playTactileTick } from '../../lib/tactileSound';
import { ShotLightbox } from '../cards/ShotLightbox';
import { BlockInsertGutter } from '../editor/BlockInsertGutter';
import { EditorBlockContextMenu } from '../editor/EditorBlockContextMenu';
import {
  KapsulaImage,
  extractImageFilesFromDataTransfer,
  saveAndInsertImageFiles,
  type KapsulaImageLightboxInfo,
} from '../editor/KapsulaImageNode';
import { NoteFormatDock } from '../editor/NoteFormatDock';
import { RevisionHistoryModal } from '../editor/RevisionHistoryModal';
import { ProseCaretOverlay } from '../editor/ProseCaretOverlay';
import { WikiLink } from '../editor/WikiLinkNode';
import { CopySlotPill } from '../ui/CopySlotPill';
import { InlineReferenceVideo } from '../ui/InlineReferenceVideo';
import { InlineTagEditor } from '../ui/InlineTagEditor';
import { PopoverSurface } from '../ui/PopoverSurface';
import { ReminderPopover } from '../ui/ReminderPopover';
import { SectionPickerPopover } from '../ui/SectionPickerPopover';
import { SelectMenu } from '../ui/SelectMenu';
import { VoiceRecorderStudio } from '../ui/VoiceRecorderStudio';
import { WaveformAudioPlayer } from '../ui/WaveformAudioPlayer';

let cachedLowlight: ReturnType<typeof createLowlight> | null = null;
function getLowlight() {
  if (!cachedLowlight) {
    cachedLowlight = createLowlight(common);
  }
  return cachedLowlight;
}

/** Pre-warms syntax highlighting grammars on idle so first NoteStudio open has zero main-thread hitch. */
export function warmNoteStudioRuntime(): void {
  getLowlight();
}
const VIDEO_PATH_RE = /\.(?:mp4|webm|mov|m4v)$/i;
const AUDIO_PATH_RE = /\.(?:wav|webm|ogg|oga|mp3|m4a)$/i;

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

export type StudioLayoutMode = 'sheet' | 'center' | 'full';

type FlushDraftResult = {
  ok: boolean;
  itemId: string | null;
};

interface PendingNoteSaveEntry {
  ownerInstanceId: number;
  ownerSessionSeq: number;
  promise: Promise<void>;
  title: string;
  body: string;
  ok: boolean;
}

interface ActiveMountedNoteOwner {
  instanceId: number;
  layoutToken: number;
}

// Tracks active title/body saves by itemId across NoteStudio unmount/remount cycles
// (e.g. A edited -> B truncated unmounts NoteStudio -> A remounts before updateItem(A) settles).
let nextStudioInstanceId = 0;
const inFlightNoteSavesById = new Map<string, PendingNoteSaveEntry>();
const activeMountedNoteOwnerById = new Map<string, ActiveMountedNoteOwner>();

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
  expandedModal?: boolean;
  onToggleExpandedModal?: () => void;
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

function deriveTitleFromBody(md: string, fallbackTitle: string): string {
  const first = (md || '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
        .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
        .replace(/<\/?(?:span|mark|u)(?:\s+[^>]*)?>/gi, '')
        .replace(/<hr\b[^>]*\/?>/gi, '')
        .replace(/==([^=\n]+)==/g, '$1')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*]\s+\[[ xX]\]\s+/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/[*_`>#~[\]()]/g, '')
        .trim()
    )
    .find(Boolean);
  return first ? truncateAtWordBoundary(first, 96) : fallbackTitle;
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
  expandedModal = false,
  onToggleExpandedModal,
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
  const { t, locale, dateLocale } = useI18n();
  const prefersReduced = useReducedMotion();
  const noteTemplates = useMemo(() => getNoteTemplates(locale), [locale]);
  const presetOptions = useMemo<Array<{ id: TextTransformPreset; label: string; desc: string }>>(
    () => [
      { id: 'structure', label: t('note.studio.ai.structure.label'), desc: t('note.studio.ai.structure.desc') },
      { id: 'tasks', label: t('note.studio.ai.tasks.label'), desc: t('note.studio.ai.tasks.desc') },
      { id: 'polish', label: t('note.studio.ai.polish.label'), desc: t('note.studio.ai.polish.desc') },
      { id: 'summary', label: t('note.studio.ai.summary.label'), desc: t('note.studio.ai.summary.desc') },
    ],
    [t]
  );
  const slashCommands = useMemo<readonly SlashCommandDef[]>(
    () => [
      {
        id: 'h1',
        label: t('note.studio.cmd.h1.label'),
        hint: t('note.studio.cmd.h1.hint'),
        keywords: 'h1 heading title',
        group: 'blocks',
        icon: TextHOne,
      },
      {
        id: 'h2',
        label: t('note.studio.cmd.h2.label'),
        hint: t('note.studio.cmd.h2.hint'),
        keywords: 'h2 heading subtitle',
        group: 'blocks',
        icon: TextHTwo,
      },
      {
        id: 'h3',
        label: t('note.studio.cmd.h3.label'),
        hint: t('note.studio.cmd.h3.hint'),
        keywords: 'h3 heading small',
        group: 'blocks',
        icon: TextHThree,
      },
      {
        id: 'task',
        label: t('note.studio.cmd.todo.label'),
        hint: t('note.studio.cmd.todo.hint'),
        keywords: 'task todo checklist',
        group: 'blocks',
        icon: CheckSquare,
      },
      {
        id: 'bullet',
        label: t('note.studio.cmd.ul.label'),
        hint: t('note.studio.cmd.ul.hint'),
        keywords: 'bullet list ul',
        group: 'blocks',
        icon: ListBullets,
      },
      {
        id: 'ordered',
        label: t('note.studio.cmd.ol.label'),
        hint: t('note.studio.cmd.ol.hint'),
        keywords: 'ordered number ol steps',
        group: 'blocks',
        icon: ListNumbers,
      },
      {
        id: 'quote',
        label: t('note.studio.cmd.quote.label'),
        hint: t('note.studio.cmd.quote.hint'),
        keywords: 'quote blockquote',
        group: 'blocks',
        icon: Quotes,
      },
      {
        id: 'code',
        label: t('note.studio.cmd.code.label'),
        hint: t('note.studio.cmd.code.hint'),
        keywords: 'code snippet',
        group: 'blocks',
        icon: Code,
      },
      {
        id: 'hr',
        label: t('note.studio.cmd.hr.label'),
        hint: t('note.studio.cmd.hr.hint'),
        keywords: 'hr divider line',
        group: 'blocks',
        icon: Minus,
      },
      {
        id: 'image',
        label: t('note.studio.cmd.photo.label'),
        hint: t('note.studio.cmd.photo.hint'),
        keywords: 'photo image picture img screenshot',
        group: 'media',
        icon: ImageSquare,
      },
      {
        id: 'dictate',
        label: t('note.studio.cmd.voice.label'),
        hint: t('note.studio.cmd.voice.hint'),
        keywords: 'voice dictate audio mic',
        group: 'media',
        icon: Microphone,
      },
      {
        id: 'beautify',
        label: t('note.studio.cmd.ai.label'),
        hint: t('note.studio.cmd.ai.hint'),
        keywords: 'ai beautify polish format',
        group: 'media',
        icon: Sparkle,
      },
      ...noteTemplates.map((tpl): SlashCommandDef => ({
        id: `template-${tpl.id}` as SlashCommandId,
        label: t('note.studio.cmd.templatePrefix', { label: tpl.label }),
        hint: tpl.description,
        keywords: `template ${tpl.id} ${tpl.label.toLowerCase()} ${tpl.tags.join(' ')}`,
        group: 'templates',
        icon: TEMPLATE_ICON_MAP[tpl.id],
      })),
    ],
    [t, noteTemplates]
  );
  const studioInstanceIdRef = useRef<number | null>(null);
  if (studioInstanceIdRef.current === null) {
    studioInstanceIdRef.current = ++nextStudioInstanceId;
  }
  const initialMountSave = !isDraft ? inFlightNoteSavesById.get(item.id) : undefined;
  const initialPendingMountSave =
    initialMountSave && initialMountSave.ownerInstanceId !== studioInstanceIdRef.current
      ? initialMountSave
      : undefined;
  const [title, setTitle] = useState(
    isDraft ? '' : initialPendingMountSave ? initialPendingMountSave.title : item.title || ''
  );
  const [liveBody, setLiveBody] = useState(
    initialPendingMountSave ? initialPendingMountSave.body : item.body || ''
  );
  const [tags, setTags] = useState<string[]>(item.tags || []);
  const [draftOrbit, setDraftOrbit] = useState<string>(item.orbit || '');
  const [draftBoardId, setDraftBoardId] = useState<string | null>(item.focusBoardId ?? null);
  const [draftRemindAt, setDraftRemindAt] = useState<number | null>(item.remindAt ?? null);
  const [optimisticPinned, setOptimisticPinned] = useState<boolean>(Boolean(item.isPinned));
  const [optimisticMuted, setOptimisticMuted] = useState<boolean>(Boolean(item.isMuted));
  useEffect(() => {
    setOptimisticPinned(Boolean(item.isPinned));
    setOptimisticMuted(Boolean(item.isMuted));
  }, [item.id, item.isPinned, item.isMuted]);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>(
    initialPendingMountSave ? 'saving' : 'saved'
  );
  const [persistingSlow, setPersistingSlow] = useState(false);
  const slowPersistTimerRef = useRef<number | null>(null);
  const clearSlowPersist = useCallback(() => {
    if (slowPersistTimerRef.current) {
      window.clearTimeout(slowPersistTimerRef.current);
      slowPersistTimerRef.current = null;
    }
    setPersistingSlow(false);
  }, []);
  const armSlowPersist = useCallback(() => {
    if (!isMountedRef.current || slowPersistTimerRef.current) return;
    slowPersistTimerRef.current = window.setTimeout(() => {
      slowPersistTimerRef.current = null;
      if (!isMountedRef.current) return;
      setPersistingSlow(true);
    }, 900);
  }, []);
  useEffect(() => () => {
    if (slowPersistTimerRef.current) window.clearTimeout(slowPersistTimerRef.current);
  }, []);
  const [beautifying, setBeautifying] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [extractingVoiceTasks, setExtractingVoiceTasks] = useState(false);
  const [insertingImage, setInsertingImage] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [selectedPresets, setSelectedPresets] = useState<TextTransformPreset[]>(['structure']);
  const [createdOrbits, setCreatedOrbits] = useState<OrbitDef[]>([]);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [bubbleColorOpen, setBubbleColorOpen] = useState(false);
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
  const [quickRevertSnapshot, setQuickRevertSnapshot] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const beautifyUndoStackRef = useRef<Array<{ title: string; body: string }>>([]);
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
  const tRef = useRef(t);
  tRef.current = t;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const fallbackTitleRef = useRef(t('dna.note'));
  fallbackTitleRef.current = t('dna.note');
  const bodyPlaceholderRef = useRef(t('note.studio.bodyPlaceholder'));
  bodyPlaceholderRef.current = t('note.studio.bodyPlaceholder');
  const isDraftRef = useRef(isDraft);
  isDraftRef.current = isDraft;
  const isMountedRef = useRef(true);
  useLayoutEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const initialPendingMountRef = useRef<{ itemId: string; entry: PendingNoteSaveEntry } | null>(
    initialPendingMountSave ? { itemId: item.id, entry: initialPendingMountSave } : null
  );
  const initialMountConsumedRef = useRef(false);
  const pendingTransitionSaveRef = useRef<{ itemId: string; entry: PendingNoteSaveEntry } | null>(
    null
  );
  const activePendingSaveRef = useRef<PendingNoteSaveEntry | null>(initialPendingMountSave ?? null);
  const prevEffectSessionRef = useRef<{ id: string; isDraft: boolean } | null>(null);
  const prevLayoutSessionRef = useRef<{ id: string; isDraft: boolean } | null>(null);
  const persistedDraftIdRef = useRef<string | null>(isDraft ? null : item.id);
  const sessionMediaMetaRef = useRef<VaultItem['mediaMeta']>(item.mediaMeta);
  const createdDraftIdBySessionRef = useRef<Map<number, string>>(new Map());
  const titleRef = useRef(
    isDraft ? '' : initialPendingMountSave ? initialPendingMountSave.title : item.title || ''
  );
  const bodyMarkdownRef = useRef(
    initialPendingMountSave ? initialPendingMountSave.body : item.body || ''
  );
  const dirtyRef = useRef(false);
  const editSeqRef = useRef(0);
  const noteSessionSeqRef = useRef(0);
  const layoutSessionSeqRef = useRef(0);
  const inFlightSaveCountRef = useRef(0);
  const inFlightUpdatePromiseRef = useRef<Promise<void> | null>(null);
  const lastSavedStateRef = useRef<{ id: string; seq: number; title: string; body: string } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const liveBodyTimerRef = useRef<number | null>(null);
  const markdownSyncTimerRef = useRef<number | null>(null);
  const markdownSyncPendingRef = useRef(false);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const mountedEditorInstanceRef = useRef<ReturnType<typeof useEditor>>(null);
  const loadingItemRef = useRef(false);
  const loadingItemTimerRef = useRef<number | null>(null);
  const allItemsForLinksRef = useRef(allItemsForLinks);
  allItemsForLinksRef.current = allItemsForLinks;

  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const aiMenuOpenRef = useRef(aiMenuOpen);
  aiMenuOpenRef.current = aiMenuOpen;
  const moreMenuOpenRef = useRef(moreMenuOpen);
  moreMenuOpenRef.current = moreMenuOpen;
  const historyOpenRef = useRef(historyOpen);
  historyOpenRef.current = historyOpen;
  const inlineLightboxItemRef = useRef(inlineLightboxItem);
  inlineLightboxItemRef.current = inlineLightboxItem;
  const showVoiceStudioRef = useRef(showVoiceStudio);
  showVoiceStudioRef.current = showVoiceStudio;
  const bubbleColorOpenRef = useRef(bubbleColorOpen);
  bubbleColorOpenRef.current = bubbleColorOpen;
  const bubbleLinkEditingRef = useRef(bubbleLinkEditing);
  bubbleLinkEditingRef.current = bubbleLinkEditing;
  const handleCloseStudioRef = useRef<() => Promise<void>>(async () => {});

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
  const inflightCreateRef = useRef<Promise<void> | null>(null);

  const openInlineImageLightboxRef = useRef<(info: KapsulaImageLightboxInfo) => void>(() => {});
  openInlineImageLightboxRef.current = (info) => {
    const cur = itemRef.current;
    setInlineLightboxItem({
      ...cur,
      title: info.alt || cur.title || tRef.current('dna.image'),
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
    const sessionBefore = noteSessionSeqRef.current;
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
          projection: 'card',
          limit: 12,
        });
        if (noteSessionSeqRef.current !== sessionBefore) return;
        found =
          remote.find((c) => c.title.trim().toLowerCase() === cleanLower) ??
          remote.find((c) => c.title.toLowerCase().includes(cleanLower));
      } catch {
        // ignore search errors
      }
    }

    if (noteSessionSeqRef.current !== sessionBefore) return;
    if (found) {
      onSelectRelatedItemRef.current?.(found);
    } else {
      toast.info(tRef.current('note.studio.notFoundLink', { title: linkTitle }));
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

  const lowlight = useMemo(() => getLowlight(), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: {
            rel: 'noopener noreferrer',
          },
        },
      }),
      KapsulaHorizontalRule,
      Markdown,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      CodeBlockLowlight.configure({
        lowlight,
      }),
      Placeholder.configure({
        placeholder: () => bodyPlaceholderRef.current,
      }),
      Typography,
      KapsulaHighlight,
      TextColorMark,
      TextSizeMark,
      KapsulaImage.configure({
        onOpenLightbox: (info) => openInlineImageLightboxRef.current(info),
      }),
      WikiLink.configure({
        onNavigate: (linkTitle, targetId) => {
          void navigateWikiLinkRef.current(linkTitle, targetId);
        },
      }),
    ],
    content: bodyMarkdownRef.current,
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

        if (
          event.key === 'Escape' &&
          presentationRef.current === 'modal' &&
          onCloseRef.current &&
          !aiMenuOpenRef.current &&
          !moreMenuOpenRef.current &&
          !historyOpenRef.current &&
          !inlineLightboxItemRef.current &&
          !showVoiceStudioRef.current &&
          !bubbleColorOpenRef.current &&
          !bubbleLinkEditingRef.current &&
          !document.querySelector('[data-k-popup="true"], [role="menu"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          void handleCloseStudioRef.current();
          return true;
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

      markdownSyncPendingRef.current = true;
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
      }
      if (liveBodyTimerRef.current) {
        window.clearTimeout(liveBodyTimerRef.current);
      }
      markdownSyncTimerRef.current = window.setTimeout(() => {
        markdownSyncTimerRef.current = null;
        const curEd = editorRef.current;
        if (curEd && !curEd.isDestroyed && markdownSyncPendingRef.current) {
          bodyMarkdownRef.current = curEd.getMarkdown();
          markdownSyncPendingRef.current = false;
        }
        setLiveBody(bodyMarkdownRef.current);
      }, 180);
      dirtyRef.current = true;
      editSeqRef.current += 1;
      setSaveState((prev) => (prev === 'saving' ? prev : 'saving'));

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
  editorRef.current = editor;

  // Ensure initial TipTap mount (when immediatelyRender:false creates editor on 2nd render)
  // picks up any pending cross-unmount save body that useEffect([item.id, isDraft]) seeded.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (mountedEditorInstanceRef.current === editor) return;
    mountedEditorInstanceRef.current = editor;
    if (!dirtyRef.current && bodyMarkdownRef.current !== (itemRef.current.body || '')) {
      loadingItemRef.current = true;
      editor.commands.setContent(bodyMarkdownRef.current, {
        contentType: 'markdown',
        emitUpdate: false,
      });
      loadingItemRef.current = false;
    }
  }, [editor]);

  const syncMarkdownFromEditor = useCallback((): string => {
    if (markdownSyncTimerRef.current !== null) {
      window.clearTimeout(markdownSyncTimerRef.current);
      markdownSyncTimerRef.current = null;
    }
    const ed = editorRef.current;
    if (ed && !ed.isDestroyed && markdownSyncPendingRef.current) {
      const md = ed.getMarkdown();
      bodyMarkdownRef.current = md;
      markdownSyncPendingRef.current = false;
    }
    return bodyMarkdownRef.current;
  }, []);

  // Wire image insertion ref once editor is ready
  insertImageFilesRef.current = async (files, insertPos) => {
    if (!editor || files.length === 0) return;
    const sessionBefore = noteSessionSeqRef.current;
    const effectiveIdBefore = persistedDraftIdRef.current || itemRef.current.id;
    const count = await saveAndInsertImageFiles(editor, files, {
      insertPos,
      onBeforeSave: () => setInsertingImage(true),
      onAfterSave: () => {
        if (noteSessionSeqRef.current === sessionBefore) {
          setInsertingImage(false);
        }
      },
      shouldInsert: () =>
        noteSessionSeqRef.current === sessionBefore &&
        (persistedDraftIdRef.current || itemRef.current.id) === effectiveIdBefore,
    });
    if (count > 0 && noteSessionSeqRef.current === sessionBefore) {
      playTactileTick(soundEnabled, 'soft');
      toast.success(
        count === 1
          ? tRef.current('note.studio.photosInserted')
          : tRef.current('note.studio.photosInsertedMany', { count })
      );
    }
  };

  // Subscribe only to toolbar active-state changes (zero per-keystroke full-component re-renders)
  const toolbarState = useEditorState({
    editor,
    selector: (ctx) => ({
      h1: ctx.editor?.isActive('heading', { level: 1 }) ?? false,
      h2: ctx.editor?.isActive('heading', { level: 2 }) ?? false,
      h3: ctx.editor?.isActive('heading', { level: 3 }) ?? false,
      task: ctx.editor?.isActive('taskList') ?? false,
      bullet: ctx.editor?.isActive('bulletList') ?? false,
      ordered: ctx.editor?.isActive('orderedList') ?? false,
      quote: ctx.editor?.isActive('blockquote') ?? false,
      codeBlock: ctx.editor?.isActive('codeBlock') ?? false,
      bold: ctx.editor?.isActive('bold') ?? false,
      italic: ctx.editor?.isActive('italic') ?? false,
      underline: ctx.editor?.isActive('underline') ?? false,
      strike: ctx.editor?.isActive('strike') ?? false,
      highlight: ctx.editor?.isActive('highlight') ?? false,
      highlightColor: (ctx.editor?.getAttributes('highlight')?.color as string | null) ?? null,
      textColor: (ctx.editor?.getAttributes('textColor')?.color as string | null) ?? null,
      textSize: (ctx.editor?.getAttributes('textSize')?.size as TextSizeKey | null) ?? null,
      code: ctx.editor?.isActive('code') ?? false,
      link: ctx.editor?.isActive('link') ?? false,
    }),
  });

  const computeReconciledLinksOut = useCallback(
    (rawBody: string, currentItemId?: string): string[] | null => {
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
      const curId = currentItemId || persistedDraftIdRef.current || itemRef.current.id;
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
    async (targetId: string, forceWasDraft = false): Promise<FlushDraftResult> => {
      syncMarkdownFromEditor();
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      markdownSyncPendingRef.current = false;
      if (liveBodyTimerRef.current) {
        window.clearTimeout(liveBodyTimerRef.current);
        liveBodyTimerRef.current = null;
      }
      setLiveBody(bodyMarkdownRef.current);

      // Snapshot live refs synchronously BEFORE any await so fast-switching to another note
      // never contaminates this flush with the next note's metadata or text.
      const rawTitle = titleRef.current.trim();
      const rawBody = bodyMarkdownRef.current;
      const orbitVal = draftOrbitRef.current || undefined;
      const boardVal = draftBoardIdRef.current;
      const remindVal = draftRemindAtRef.current;
      const draftTags = [...tagsRef.current];
      const draftMediaMeta = sessionMediaMetaRef.current;
      const snapshotSeq = editSeqRef.current;
      const snapshotSessionSeq = noteSessionSeqRef.current;
      const snapshotLayoutToken = layoutSessionSeqRef.current;
      const snapshotDirty = dirtyRef.current;
      const snapshotIsDraft = isDraftRef.current;
      const snapshotPersistedDraftId = persistedDraftIdRef.current;
      const snapshotItemId =
        snapshotPersistedDraftId ||
        (targetId && targetId !== '' ? targetId : null) ||
        itemRef.current.id;
      const reconciledLinks = computeReconciledLinksOut(rawBody, snapshotItemId);

      // Serialize behind any in-flight draft creation (while loop + outer task guard prevents
      // concurrent captures when multiple flushes wake up on the same microtask turn).
      while (inflightCreateRef.current) {
        await inflightCreateRef.current.catch(() => {});
      }

      const knownSessionPersistedId =
        snapshotPersistedDraftId ||
        createdDraftIdBySessionRef.current.get(snapshotSessionSeq) ||
        null;
      const currentEffectiveId = persistedDraftIdRef.current || itemRef.current.id;
      const stillSameAfterCreate =
        noteSessionSeqRef.current === snapshotSessionSeq &&
        (currentEffectiveId === snapshotItemId ||
          (knownSessionPersistedId !== null && currentEffectiveId === knownSessionPersistedId));

      const effectiveDirty = stillSameAfterCreate ? dirtyRef.current : snapshotDirty;
      const hasPendingSaveToAwait =
        activePendingSaveRef.current !== null ||
        inFlightUpdatePromiseRef.current !== null ||
        Boolean(
          snapshotItemId &&
            snapshotItemId !== '__draft__' &&
            inFlightNoteSavesById.has(snapshotItemId)
        );
      if (!effectiveDirty && !hasPendingSaveToAwait) {
        if (inFlightSaveCountRef.current === 0 && !dirtyRef.current) {
          setSaveState('saved');
          clearSlowPersist();
        }
        const resolvedId =
          knownSessionPersistedId ||
          (stillSameAfterCreate && itemRef.current.id !== '__draft__' ? itemRef.current.id : null) ||
          (targetId && targetId !== '__draft__' ? targetId : null);
        return { ok: true, itemId: resolvedId };
      }

      const bodyHasContent = rawBody.replace(/\s+/g, '').length > 0;

      // Never materialize an empty draft note into DB
      const resolvedDraftIdForSession =
        (stillSameAfterCreate ? persistedDraftIdRef.current : null) || knownSessionPersistedId;
      const wasDraft =
        (forceWasDraft || targetId === '__draft__' || snapshotIsDraft) &&
        !resolvedDraftIdForSession;
      if (wasDraft && effectiveDirty) {
        if (!rawTitle && !bodyHasContent) {
          if (stillSameAfterCreate) {
            dirtyRef.current = false;
            if (inFlightSaveCountRef.current === 0) {
              setSaveState('saved');
              clearSlowPersist();
            }
          }
          return { ok: true, itemId: null };
        }
        const effectiveTitle = rawTitle || deriveTitleFromBody(rawBody, fallbackTitleRef.current);
        let createResult: FlushDraftResult = { ok: false, itemId: null };
        let createTask!: Promise<void>;
        createTask = (async () => {
          inFlightSaveCountRef.current += 1;
          armSlowPersist();
          let saveFailed = false;
          try {
            let created = await window.kapsula.capture({
              title: effectiveTitle,
              text: rawBody,
              orbitOverride: orbitVal,
              focusBoardId: boardVal,
              remindAt: remindVal,
              tags: draftTags,
              ...(draftMediaMeta ? { mediaMeta: draftMediaMeta } : {}),
              source: 'vault_ui',
            });
            if (!created) {
              saveFailed = true;
              if (
                isMountedRef.current &&
                itemRef.current.id === '__draft__' &&
                noteSessionSeqRef.current === snapshotSessionSeq
              ) {
                dirtyRef.current = true;
                setSaveState('error');
              }
              return;
            }
            if (reconciledLinks && reconciledLinks.length > 0) {
              const linked = await window.kapsula
                .updateItem(created.id, { linksOut: reconciledLinks })
                .catch(() => null);
              if (linked) created = linked;
            }
            // Record materialized ID for this draft session unconditionally so any queued flush
            // from useLayoutEffect cleanup never calls capture() a second time.
            createdDraftIdBySessionRef.current.set(snapshotSessionSeq, created.id);
            if (createdDraftIdBySessionRef.current.size > 32) {
              const oldestKey = createdDraftIdBySessionRef.current.keys().next().value;
              if (oldestKey !== undefined) createdDraftIdBySessionRef.current.delete(oldestKey);
            }
            lastSavedStateRef.current = {
              id: created.id,
              seq: snapshotSeq,
              title: rawTitle,
              body: rawBody,
            };
            createResult = { ok: true, itemId: created.id };

            // Only bind to live buffer if mounted and user has not switched to another note mid-flight
            if (
              isMountedRef.current &&
              itemRef.current.id === '__draft__' &&
              noteSessionSeqRef.current === snapshotSessionSeq
            ) {
              persistedDraftIdRef.current = created.id;
              isDraftRef.current = false;
              const userTypedMeanwhile =
                dirtyRef.current &&
                (editSeqRef.current !== snapshotSeq ||
                  titleRef.current.trim() !== rawTitle ||
                  bodyMarkdownRef.current !== rawBody);
              if (!userTypedMeanwhile) {
                dirtyRef.current = false;
              }
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
            } else {
              onItemUpdatedRef.current(created);
            }
          } catch {
            saveFailed = true;
            if (
              isMountedRef.current &&
              itemRef.current.id === '__draft__' &&
              noteSessionSeqRef.current === snapshotSessionSeq
            ) {
              dirtyRef.current = true;
              setSaveState('error');
            }
          } finally {
            inFlightSaveCountRef.current = Math.max(0, inFlightSaveCountRef.current - 1);
            if (inflightCreateRef.current === createTask) {
              inflightCreateRef.current = null;
            }
            if (!saveFailed && !dirtyRef.current && inFlightSaveCountRef.current === 0) {
              setSaveState('saved');
              clearSlowPersist();
            } else if (saveFailed) {
              clearSlowPersist();
            }
          }
        })();
        inflightCreateRef.current = createTask;
        await createTask;
        return createResult;
      }

      let awaitedFailedForeignSave = false;
      while (inFlightUpdatePromiseRef.current) {
        const currentUpdateGuard = inFlightUpdatePromiseRef.current;
        const activePending = activePendingSaveRef.current;
        await currentUpdateGuard.catch(() => {});
        if (activePending && activePending.promise === currentUpdateGuard && !activePending.ok) {
          awaitedFailedForeignSave = true;
        }
      }
      const pendingAdopted = activePendingSaveRef.current;
      if (pendingAdopted) {
        await pendingAdopted.promise.catch(() => {});
        if (!pendingAdopted.ok) {
          awaitedFailedForeignSave = true;
        }
      }

      const postUpdateWaitKnownId =
        snapshotPersistedDraftId ||
        createdDraftIdBySessionRef.current.get(snapshotSessionSeq) ||
        null;
      const finalId =
        (targetId && targetId !== '__draft__' ? targetId : null) ||
        (noteSessionSeqRef.current === snapshotSessionSeq ? persistedDraftIdRef.current : null) ||
        postUpdateWaitKnownId ||
        (noteSessionSeqRef.current === snapshotSessionSeq && itemRef.current.id !== '__draft__'
          ? itemRef.current.id
          : null);
      if (!finalId) {
        if (inFlightSaveCountRef.current === 0 && !dirtyRef.current) {
          setSaveState('saved');
          clearSlowPersist();
        }
        return { ok: true, itemId: null };
      }

      while (inFlightNoteSavesById.has(finalId)) {
        const pendingByItem = inFlightNoteSavesById.get(finalId);
        if (
          pendingByItem &&
          (pendingByItem.ownerInstanceId !== studioInstanceIdRef.current ||
            pendingByItem.ownerSessionSeq !== noteSessionSeqRef.current)
        ) {
          await pendingByItem.promise.catch(() => {});
          if (!pendingByItem.ok) {
            awaitedFailedForeignSave = true;
          }
        } else {
          break;
        }
      }

      const currentOwner = activeMountedNoteOwnerById.get(finalId);
      if (
        currentOwner &&
        (currentOwner.instanceId !== studioInstanceIdRef.current ||
          currentOwner.layoutToken !== snapshotLayoutToken)
      ) {
        if (inFlightSaveCountRef.current === 0 && !dirtyRef.current) {
          clearSlowPersist();
        }
        return { ok: false, itemId: finalId };
      }

      const stillSameBeforeWrite =
        (persistedDraftIdRef.current || itemRef.current.id) === finalId &&
        noteSessionSeqRef.current === snapshotSessionSeq;
      const hasUnsavedChanges = stillSameBeforeWrite ? dirtyRef.current : snapshotDirty;
      if (!hasUnsavedChanges && !awaitedFailedForeignSave) {
        if (inFlightSaveCountRef.current === 0 && !dirtyRef.current) {
          setSaveState('saved');
          clearSlowPersist();
        }
        return { ok: true, itemId: finalId };
      }

      // Only re-read live refs if NoteStudio is still in the exact same note session for finalId;
      // otherwise strictly flush the pre-await snapshot for finalId (prevents A -> B -> A stale prop clobber).
      const writeSessionSeq = stillSameBeforeWrite ? noteSessionSeqRef.current : snapshotSessionSeq;
      const latestSeq = stillSameBeforeWrite ? editSeqRef.current : snapshotSeq;
      const latestRawTitle = stillSameBeforeWrite ? titleRef.current.trim() : rawTitle;
      const latestRawBody = stillSameBeforeWrite ? bodyMarkdownRef.current : rawBody;
      const latestLinks = stillSameBeforeWrite
        ? computeReconciledLinksOut(latestRawBody, finalId)
        : reconciledLinks;

      if (
        !stillSameBeforeWrite &&
        !awaitedFailedForeignSave &&
        lastSavedStateRef.current &&
        lastSavedStateRef.current.id === finalId &&
        lastSavedStateRef.current.seq >= snapshotSeq &&
        lastSavedStateRef.current.title === latestRawTitle &&
        lastSavedStateRef.current.body === latestRawBody
      ) {
        if (inFlightSaveCountRef.current === 0 && !dirtyRef.current) {
          setSaveState('saved');
          clearSlowPersist();
        }
        return { ok: true, itemId: finalId };
      }

      const nextTitle = latestRawTitle || deriveTitleFromBody(latestRawBody, fallbackTitleRef.current);
      const patch: Record<string, unknown> = {
        title: nextTitle,
        body: latestRawBody,
      };
      if (latestLinks !== null) {
        patch.linksOut = latestLinks;
      }

      inFlightSaveCountRef.current += 1;
      if (stillSameBeforeWrite) {
        setSaveState('saving');
      }
      if (isMountedRef.current) {
        armSlowPersist();
      }
      let saveFailed = false;
      const updatePromise = window.kapsula.updateItem(finalId, patch);
      const guard = updatePromise.then(
        () => {},
        () => {}
      );
      const saveEntry: PendingNoteSaveEntry = {
        ownerInstanceId: studioInstanceIdRef.current!,
        ownerSessionSeq: writeSessionSeq,
        promise: guard,
        title: latestRawTitle,
        body: latestRawBody,
        ok: false,
      };
      inFlightUpdatePromiseRef.current = guard;
      inFlightNoteSavesById.set(finalId, saveEntry);
      try {
        const updated = await updatePromise;
        saveEntry.ok = Boolean(updated);
        lastSavedStateRef.current = {
          id: finalId,
          seq: latestSeq,
          title: latestRawTitle,
          body: latestRawBody,
        };
        const stillSameItem = (persistedDraftIdRef.current || itemRef.current.id) === finalId;
        const sameWriteSession = noteSessionSeqRef.current === writeSessionSeq;
        const userTypedMeanwhile =
          dirtyRef.current &&
          sameWriteSession &&
          stillSameItem &&
          (editSeqRef.current !== latestSeq ||
            titleRef.current.trim() !== latestRawTitle ||
            bodyMarkdownRef.current !== latestRawBody);
        if (!userTypedMeanwhile && stillSameItem && sameWriteSession) {
          dirtyRef.current = false;
        }
        if (updated) onItemUpdatedRef.current(updated);
        if (userTypedMeanwhile) {
          dirtyRef.current = true;
          setSaveState('saving');
          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(() => {
            void flushDraft(finalId);
          }, 300);
          return { ok: true, itemId: finalId };
        }
        return { ok: true, itemId: finalId };
      } catch {
        saveFailed = true;
        if (
          (persistedDraftIdRef.current || itemRef.current.id) === finalId &&
          noteSessionSeqRef.current === writeSessionSeq
        ) {
          dirtyRef.current = true;
          setSaveState('error');
        }
        return { ok: false, itemId: finalId };
      } finally {
        if (inFlightUpdatePromiseRef.current === guard) {
          inFlightUpdatePromiseRef.current = null;
        }
        if (inFlightNoteSavesById.get(finalId) === saveEntry) {
          inFlightNoteSavesById.delete(finalId);
        }
        inFlightSaveCountRef.current = Math.max(0, inFlightSaveCountRef.current - 1);
        if (!saveFailed && !dirtyRef.current && inFlightSaveCountRef.current === 0) {
          setSaveState('saved');
          clearSlowPersist();
        } else if (saveFailed) {
          clearSlowPersist();
        }
      }
    },
    [computeReconciledLinksOut, armSlowPersist, clearSlowPersist, syncMarkdownFromEditor]
  );

  const flushDraftRef = useRef(flushDraft);
  flushDraftRef.current = flushDraft;
  const syncMarkdownFromEditorRef = useRef(syncMarkdownFromEditor);
  syncMarkdownFromEditorRef.current = syncMarkdownFromEditor;

  // Flush changes when switching item or unmounting BEFORE useEditor's useEffect cleanup destroys editor
  useLayoutEffect(() => {
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
      syncMarkdownFromEditorRef.current();
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      markdownSyncPendingRef.current = false;
      if (liveBodyTimerRef.current) {
        window.clearTimeout(liveBodyTimerRef.current);
        liveBodyTimerRef.current = null;
      }
      if (dirtyRef.current || activePendingSaveRef.current !== null) {
        const flushId = persistedDraftIdRef.current || closedItemId;
        void flushDraftRef.current(flushId, closedWasDraft && !persistedDraftIdRef.current);
      }
    };
  }, [item.id, isDraft]);

  // Track synchronous mount/session ownership per itemId (eliminates render-to-effect gap on A -> B -> A / A -> C -> A)
  useLayoutEffect(() => {
    const prevLayoutSession = prevLayoutSessionRef.current;
    const isSamePromotedDraft = Boolean(
      prevLayoutSession?.isDraft && !isDraft && persistedDraftIdRef.current === item.id
    );
    prevLayoutSessionRef.current = { id: item.id, isDraft };
    if (!isSamePromotedDraft) {
      layoutSessionSeqRef.current += 1;
    }
    const curToken = layoutSessionSeqRef.current;
    const instanceId = studioInstanceIdRef.current!;

    if (!isSamePromotedDraft && !isDraft && item.id !== '__draft__') {
      const existingPending = inFlightNoteSavesById.get(item.id);
      if (
        existingPending &&
        (existingPending.ownerInstanceId !== instanceId ||
          existingPending.ownerSessionSeq !== curToken)
      ) {
        pendingTransitionSaveRef.current = { itemId: item.id, entry: existingPending };
      } else {
        pendingTransitionSaveRef.current = null;
      }
    } else {
      pendingTransitionSaveRef.current = null;
    }

    const registeredId = !isDraft && item.id !== '__draft__' ? item.id : null;
    if (registeredId) {
      activeMountedNoteOwnerById.set(registeredId, { instanceId, layoutToken: curToken });
    }
    return () => {
      if (registeredId) {
        const curOwner = activeMountedNoteOwnerById.get(registeredId);
        if (
          curOwner &&
          curOwner.instanceId === instanceId &&
          curOwner.layoutToken === curToken
        ) {
          activeMountedNoteOwnerById.delete(registeredId);
        }
      }
    };
  }, [item.id, isDraft]);

  // Sync editor when selecting a different item (skip overwriting live buffer ONLY on draft->persisted promotion)
  useEffect(() => {
    const prevSession = prevEffectSessionRef.current;
    const isSamePromotedDraft = Boolean(
      prevSession?.isDraft && !isDraft && persistedDraftIdRef.current === item.id
    );
    prevEffectSessionRef.current = { id: item.id, isDraft };

    const fallbackInitialSave =
      !initialMountConsumedRef.current &&
      initialPendingMountRef.current &&
      initialPendingMountRef.current.itemId === item.id &&
      initialPendingMountRef.current.entry.ownerInstanceId !== studioInstanceIdRef.current
        ? initialPendingMountRef.current.entry
        : undefined;
    initialMountConsumedRef.current = true;
    initialPendingMountRef.current = null;

    const transitionSave =
      pendingTransitionSaveRef.current && pendingTransitionSaveRef.current.itemId === item.id
        ? pendingTransitionSaveRef.current.entry
        : undefined;
    pendingTransitionSaveRef.current = null;

    let pendingSaveCleanup: (() => void) | null = null;
    if (!isSamePromotedDraft) {
      noteSessionSeqRef.current += 1;
      const curSession = noteSessionSeqRef.current;
      persistedDraftIdRef.current = isDraft ? null : item.id;
      isDraftRef.current = isDraft;
      sessionMediaMetaRef.current = item.mediaMeta;
      const rawPendingSave = !isDraft
        ? (inFlightNoteSavesById.get(item.id) ?? fallbackInitialSave ?? transitionSave)
        : undefined;
      const pendingSave =
        rawPendingSave &&
        (rawPendingSave.ownerInstanceId !== studioInstanceIdRef.current ||
          rawPendingSave.ownerSessionSeq !== curSession)
          ? rawPendingSave
          : undefined;
      activePendingSaveRef.current = pendingSave ?? null;
      const initTitle = isDraft ? '' : pendingSave ? pendingSave.title : item.title || '';
      setTitle(initTitle);
      titleRef.current = initTitle;
      setTags(item.tags || []);
      tagsRef.current = item.tags || [];
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
      setQuickRevertSnapshot(null);
      beautifyUndoStackRef.current = [];
      setHistoryOpen(false);
      setInlineLightboxItem(null);
      setBubbleLinkEditing(false);
      setBubbleLinkUrl('');
      setBubbleColorOpen(false);
      setAiMenuOpen(false);
      setMoreMenuOpen(false);
      setBeautifying(false);
      setTranscribing(false);
      setExtractingVoiceTasks(false);
      setRestoringRevId(null);
      setInsertingImage(false);
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      markdownSyncPendingRef.current = false;
      if (liveBodyTimerRef.current) {
        window.clearTimeout(liveBodyTimerRef.current);
        liveBodyTimerRef.current = null;
      }
      const nextBody = pendingSave ? pendingSave.body : item.body || '';
      bodyMarkdownRef.current = nextBody;
      setLiveBody(nextBody);
      dirtyRef.current = false;
      if (pendingSave) {
        setSaveState('saving');
        let detached = false;
        pendingSaveCleanup = () => {
          detached = true;
        };
        void pendingSave.promise.finally(() => {
          if (activePendingSaveRef.current === pendingSave) {
            activePendingSaveRef.current = null;
          }
          if (
            detached ||
            noteSessionSeqRef.current !== curSession ||
            (persistedDraftIdRef.current || itemRef.current.id) !== item.id
          ) {
            return;
          }
          if (!pendingSave.ok) {
            dirtyRef.current = true;
            if (lastSavedStateRef.current?.id === item.id) {
              lastSavedStateRef.current = null;
            }
            setSaveState('error');
            clearSlowPersist();
          } else if (!dirtyRef.current && inFlightSaveCountRef.current === 0) {
            setSaveState('saved');
            clearSlowPersist();
          }
        });
      } else {
        setSaveState('saved');
        clearSlowPersist();
      }

      if (editor) {
        if (loadingItemTimerRef.current) {
          window.clearTimeout(loadingItemTimerRef.current);
          loadingItemTimerRef.current = null;
        }
        loadingItemRef.current = true;
        editor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
        loadingItemRef.current = false;
        if (isDraft) {
          loadingItemTimerRef.current = window.setTimeout(() => {
            loadingItemTimerRef.current = null;
            if (!editor.isDestroyed) {
              editor.commands.focus('end');
            }
          }, 15);
        }
      }
    }

    let cancelled = false;
    if (!isDraft) {
      const loadId = item.id;
      const loadSession = noteSessionSeqRef.current;
      window.kapsula
        .listRevisions(loadId)
        .then((list) => {
          if (
            !cancelled &&
            noteSessionSeqRef.current === loadSession &&
            (persistedDraftIdRef.current || itemRef.current.id) === loadId
          ) {
            setRevisions(list);
          }
        })
        .catch(() => {
          if (!cancelled && noteSessionSeqRef.current === loadSession) setRevisions([]);
        });
      window.kapsula
        .getRelatedItems(loadId)
        .then((rel) => {
          if (
            !cancelled &&
            noteSessionSeqRef.current === loadSession &&
            (persistedDraftIdRef.current || itemRef.current.id) === loadId
          ) {
            setRelatedState(rel);
          }
        })
        .catch(() => {
          if (!cancelled && noteSessionSeqRef.current === loadSession) {
            setRelatedState({ related: [], backlinks: [] });
          }
        });
    } else {
      setRevisions([]);
      setRelatedState({ related: [], backlinks: [] });
    }
    return () => {
      cancelled = true;
      pendingSaveCleanup?.();
      if (loadingItemTimerRef.current) {
        window.clearTimeout(loadingItemTimerRef.current);
        loadingItemTimerRef.current = null;
        loadingItemRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, isDraft]);

  useEffect(() => {
    setTags(item.tags || []);
  }, [item.tags]);

  // Live sync external enrichment updates when user hasn't modified this note or has in-flight save
  useEffect(() => {
    if (
      isDraft ||
      persistedDraftIdRef.current !== item.id ||
      dirtyRef.current ||
      inFlightSaveCountRef.current > 0 ||
      inFlightNoteSavesById.has(item.id) ||
      activePendingSaveRef.current !== null
    ) {
      return;
    }
    const extTitle = item.title || '';
    if (extTitle && extTitle !== titleRef.current) {
      setTitle(extTitle);
      titleRef.current = extTitle;
    }
    const extBody = item.body || '';
    if (editor && extBody !== bodyMarkdownRef.current) {
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      markdownSyncPendingRef.current = false;
      bodyMarkdownRef.current = extBody;
      setLiveBody(extBody);
      if (loadingItemTimerRef.current) {
        window.clearTimeout(loadingItemTimerRef.current);
        loadingItemTimerRef.current = null;
      }
      loadingItemRef.current = true;
      editor.commands.setContent(extBody, { contentType: 'markdown', emitUpdate: false });
      loadingItemRef.current = false;
    }
  }, [item.id, item.updatedAt, item.title, item.body, editor, isDraft]);

  useLayoutEffect(() => {
    const el = titleTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, layoutMode, item.id]);

    // Refresh TipTap placeholder text immediately when locale switches
    useEffect(() => {
      if (editor && !editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr);
      }
    }, [editor, locale]);

    // Reset floating link input on collapse & flush pending markdown on editor blur
  useEffect(() => {
    if (!editor) return;
    const onSelectionUpdate = () => {
      if (editor.state.selection.empty) {
        setBubbleLinkEditing(false);
      }
    };
    const onBlur = () => {
      syncMarkdownFromEditor();
      if (dirtyRef.current) {
        void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
      }
    };
    editor.on('selectionUpdate', onSelectionUpdate);
    editor.on('blur', onBlur);
    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
      editor.off('blur', onBlur);
    };
  }, [editor, flushDraft, syncMarkdownFromEditor]);

  // Ctrl+S / Cmd+S immediate synchronous flush
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.code === 'KeyS' || e.key.toLowerCase() === 's')
      ) {
        e.preventDefault();
        syncMarkdownFromEditor();
        void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [flushDraft, syncMarkdownFromEditor]);

  // Keep active keyboard-selected slash item scrolled into view
  useEffect(() => {
    if (slashQuery === null || !slashListRef.current) return;
    const activeEl = slashListRef.current.querySelector('[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashQuery]);

  const handleCloseStudio = useCallback(async () => {
    syncMarkdownFromEditor();
    const curTitle = titleRef.current.trim();
    const curBody = bodyMarkdownRef.current.trim();
    const curItem = itemRef.current;

    if (isDraftRef.current && !persistedDraftIdRef.current && !curTitle && !curBody) {
      onCancelDraftRef.current?.();
      onCloseRef.current?.();
      return;
    }

    const flushRes = await flushDraft(persistedDraftIdRef.current || curItem.id);

    // Clean up auto-created blank note only if it has no metadata (tags/reminder/annotations/links)
    const effectiveId = flushRes.itemId || persistedDraftIdRef.current || curItem.id;
    const isEmptyUntouched =
      !curBody &&
      isUntitledPlaceholderTitle(curTitle) &&
      !curItem.imagePath &&
      !curItem.mediaPath &&
      !curItem.url &&
      !(curItem.tags?.length) &&
      !curItem.remindAt &&
      !(curItem.annotations?.length) &&
      !(curItem.linksOut?.length) &&
      tagsRef.current.length === 0 &&
      draftRemindAtRef.current == null;
    if (isEmptyUntouched && effectiveId && !isDraftRef.current) {
      onDeleteRef.current(effectiveId);
    }
    onCloseRef.current?.();
  }, [flushDraft, syncMarkdownFromEditor]);
  handleCloseStudioRef.current = handleCloseStudio;

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
    editSeqRef.current += 1;
    setSaveState('saving');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushDraft(persistedDraftIdRef.current || itemRef.current.id);
    }, 420);
  };

  const applyMetaPatch = async (patch: Record<string, unknown>) => {
    const sessionBefore = noteSessionSeqRef.current;
    const targetIdBefore = persistedDraftIdRef.current || itemRef.current.id;
    const wasDraftBefore = isDraftRef.current && !persistedDraftIdRef.current;

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
    if ('tags' in patch && Array.isArray(patch.tags)) {
      const nextTags = patch.tags as string[];
      setTags(nextTags);
      tagsRef.current = nextTags;
    }

    let effectiveId = targetIdBefore;
    if (wasDraftBefore) {
      dirtyRef.current = true;
      const flushRes = await flushDraft(targetIdBefore, true);
      if (
        noteSessionSeqRef.current !== sessionBefore ||
        !flushRes.ok ||
        !flushRes.itemId ||
        flushRes.itemId.startsWith('__draft__')
      ) {
        return;
      }
      effectiveId = flushRes.itemId;
    } else if (dirtyRef.current) {
      const flushRes = await flushDraft(targetIdBefore);
      if (!flushRes.ok) return;
      effectiveId =
        noteSessionSeqRef.current === sessionBefore
          ? flushRes.itemId || persistedDraftIdRef.current || itemRef.current.id
          : flushRes.itemId || targetIdBefore;
    }
    if (!effectiveId || effectiveId.startsWith('__draft__')) return;

    while (inFlightUpdatePromiseRef.current) {
      await inFlightUpdatePromiseRef.current.catch(() => {});
    }
    const updatePromise = window.kapsula.updateItem(effectiveId, patch);
    const guard = updatePromise.then(
      () => {},
      () => {}
    );
    inFlightUpdatePromiseRef.current = guard;
    try {
      const updated = await updatePromise;
      if (updated) onItemUpdatedRef.current(updated);
    } finally {
      if (inFlightUpdatePromiseRef.current === guard) {
        inFlightUpdatePromiseRef.current = null;
      }
    }
  };

  const refreshRevisions = async (expectedId?: string, expectedSessionSeq?: number) => {
    const sessionBefore = expectedSessionSeq ?? noteSessionSeqRef.current;
    const effectiveId = expectedId ?? (persistedDraftIdRef.current || itemRef.current.id);
    if (!effectiveId || effectiveId.startsWith('__draft__')) return [];
    const list = await window.kapsula.listRevisions(effectiveId);
    if (
      noteSessionSeqRef.current === sessionBefore &&
      (persistedDraftIdRef.current || itemRef.current.id) === effectiveId
    ) {
      setRevisions(list);
    }
    return list;
  };

  const handleOpenHistoryModal = async () => {
    const sessionBefore = noteSessionSeqRef.current;
    const targetId = persistedDraftIdRef.current || itemRef.current.id;
    if (dirtyRef.current) {
      await flushDraft(targetId);
    }
    if (noteSessionSeqRef.current !== sessionBefore) return;
    const effectiveId = persistedDraftIdRef.current || itemRef.current.id;
    await refreshRevisions(effectiveId, sessionBefore).catch(() => []);
    if (noteSessionSeqRef.current !== sessionBefore) return;
    setHistoryOpen(true);
  };

  const togglePreset = (presetId: TextTransformPreset) => {
    setSelectedPresets((prev) =>
      prev.includes(presetId) ? prev.filter((p) => p !== presetId) : [...prev, presetId]
    );
  };

  const handleBeautify = async (presetsArg?: TextTransformPreset[]) => {
    const startEditor = editorRef.current;
    if (!startEditor || startEditor.isDestroyed || beautifying) return;
    const presets: TextTransformPreset[] =
      Array.isArray(presetsArg) && presetsArg.length > 0
        ? presetsArg
        : selectedPresets.length > 0
          ? selectedPresets
          : ['structure'];

    const rawMd = syncMarkdownFromEditor().trim();
    if (!rawMd) {
      toast.info(t('note.studio.writeFirstToast'));
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const prevTitle = titleRef.current;
    const prevBody = rawMd;
    const sessionBefore = noteSessionSeqRef.current;
    const seqBefore = editSeqRef.current;
    const targetIdBefore = persistedDraftIdRef.current || itemRef.current.id;
    const wasDraftBefore = isDraftRef.current && !persistedDraftIdRef.current;

    setBeautifying(true);
    setMoreMenuOpen(false);
    let appliedBeautifyToEditor = false;
    try {
      let effectiveId = targetIdBefore;
      if (wasDraftBefore) {
        dirtyRef.current = true;
        const flushRes = await flushDraft(targetIdBefore, true);
        if (
          noteSessionSeqRef.current !== sessionBefore ||
          !flushRes.ok ||
          !flushRes.itemId ||
          flushRes.itemId.startsWith('__draft__')
        ) {
          return;
        }
        effectiveId = flushRes.itemId;
      }

      if (
        !effectiveId ||
        effectiveId.startsWith('__draft__') ||
        noteSessionSeqRef.current !== sessionBefore
      ) {
        return;
      }
      if (editSeqRef.current !== seqBefore) {
        if (dirtyRef.current && saveTimerRef.current === null) {
          saveTimerRef.current = window.setTimeout(() => {
            void flushDraft(effectiveId);
          }, 420);
        }
        return;
      }

      const res = await window.kapsula.transformText({
        itemId: effectiveId,
        text: rawMd,
        preset: presets[0],
        presets,
      });

      const curEditor = editorRef.current;
      if (
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        noteSessionSeqRef.current !== sessionBefore ||
        !curEditor ||
        curEditor.isDestroyed
      ) {
        return;
      }
      if (editSeqRef.current !== seqBefore) {
        if (dirtyRef.current && saveTimerRef.current === null) {
          saveTimerRef.current = window.setTimeout(() => {
            void flushDraft(effectiveId);
          }, 420);
        }
        return;
      }

      const didChange =
        res.changed !== undefined
          ? res.changed
          : Boolean(res.formattedText && res.formattedText.trim() !== rawMd.trim());

      if (!didChange || !res.formattedText?.trim()) {
        if (dirtyRef.current) {
          void flushDraft(effectiveId);
        }
        const reasonMsg =
          res.fallbackReason === 'no_ai_key'
            ? t('note.studio.ai.noChangesLocal')
            : res.fallbackReason === 'cloud_error'
              ? t('note.studio.ai.noChangesError')
              : res.fallbackReason === 'secret_detected'
                ? t('note.studio.ai.noChangesSecret')
                : t('note.studio.ai.noChanges');
        toast.info(reasonMsg);
        return;
      }

      loadingItemRef.current = true;
      curEditor.commands.setContent(res.formattedText, {
        contentType: 'markdown',
        emitUpdate: false,
      });
      loadingItemRef.current = false;
      appliedBeautifyToEditor = true;

      const nextMd = curEditor.getMarkdown();
      markdownSyncPendingRef.current = false;
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      bodyMarkdownRef.current = nextMd;
      setLiveBody(nextMd);
      const nextTitle =
        isGenericDraftTitle(titleRef.current) && res.titleSuggestion
          ? res.titleSuggestion
          : titleRef.current.trim() || deriveTitleFromBody(nextMd, fallbackTitleRef.current);
      if (nextTitle !== titleRef.current) {
        setTitle(nextTitle);
        titleRef.current = nextTitle;
      }

      dirtyRef.current = false;
      setSaveState('saved');

      while (inFlightUpdatePromiseRef.current || inFlightNoteSavesById.has(effectiveId)) {
        const pendingByItem = inFlightNoteSavesById.get(effectiveId);
        const pending =
          inFlightUpdatePromiseRef.current ??
          (pendingByItem &&
          (pendingByItem.ownerInstanceId !== studioInstanceIdRef.current ||
            pendingByItem.ownerSessionSeq !== sessionBefore)
            ? pendingByItem.promise
            : undefined);
        if (pending) await pending.catch(() => {});
        else break;
      }
      if (
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        noteSessionSeqRef.current !== sessionBefore
      ) {
        return;
      }

      if (editSeqRef.current === seqBefore) {
        setSaveState('saving');
      }
      const updatePromise = window.kapsula.updateItem(effectiveId, {
        title: nextTitle,
        body: nextMd,
        ...(res.summary ? { summary: res.summary } : {}),
        skipAutoRevision: true,
      });
      const guard = updatePromise.then(
        () => {},
        () => {}
      );
      const saveEntry: PendingNoteSaveEntry = {
        ownerInstanceId: studioInstanceIdRef.current!,
        ownerSessionSeq: sessionBefore,
        promise: guard,
        title: nextTitle,
        body: nextMd,
        ok: false,
      };
      inFlightUpdatePromiseRef.current = guard;
      inFlightNoteSavesById.set(effectiveId, saveEntry);
      let updated: VaultItem | null = null;
      try {
        updated = await updatePromise;
        saveEntry.ok = Boolean(updated);
        lastSavedStateRef.current = {
          id: effectiveId,
          seq: seqBefore,
          title: nextTitle,
          body: nextMd,
        };
      } finally {
        if (inFlightUpdatePromiseRef.current === guard) {
          inFlightUpdatePromiseRef.current = null;
        }
        if (inFlightNoteSavesById.get(effectiveId) === saveEntry) {
          inFlightNoteSavesById.delete(effectiveId);
        }
      }

      if (updated) onItemUpdatedRef.current(updated);
      if (
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        noteSessionSeqRef.current !== sessionBefore
      ) {
        return;
      }
      if (updated) {
        if (editSeqRef.current === seqBefore) {
          dirtyRef.current = false;
          setSaveState('saved');
          clearSlowPersist();
        }
      } else {
        dirtyRef.current = true;
        setSaveState('error');
        clearSlowPersist();
      }

      const revs = await refreshRevisions(effectiveId, sessionBefore);
      if (
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        noteSessionSeqRef.current !== sessionBefore
      ) {
        return;
      }
      beautifyUndoStackRef.current = [...beautifyUndoStackRef.current, { title: prevTitle, body: prevBody }];
      setQuickRevertSnapshot({ title: prevTitle, body: prevBody });
      setQuickRevertRevId(
        res.preRevisionId ??
          revs.find((r) => r.source === 'beautify')?.id ??
          revs[0]?.id ??
          '__snapshot__'
      );
      playTactileTick(soundEnabled, 'success');
      toast.success(t('note.studio.beautifiedToast'), {
        description: res.usedCloud
          ? t('note.studio.beautifiedAiDesc')
          : t('note.studio.beautifiedLocalDesc'),
      });
    } catch (err) {
      if (noteSessionSeqRef.current === sessionBefore) {
        if (appliedBeautifyToEditor) {
          dirtyRef.current = true;
          setSaveState('error');
          clearSlowPersist();
        }
        toast.error(friendlyErrorMessage(err, t('note.studio.beautifyFailed'), locale));
      }
    } finally {
      if (noteSessionSeqRef.current === sessionBefore) {
        setBeautifying(false);
      }
    }
  };

  const handleTranscribeVoice = async (extractTasks = false) => {
    const curEditor = editorRef.current;
    if (!curEditor || curEditor.isDestroyed || transcribing || extractingVoiceTasks) return;
    const sessionBefore = noteSessionSeqRef.current;
    const seqBefore = editSeqRef.current;
    const effectiveId = persistedDraftIdRef.current || itemRef.current.id;
    const mediaPath = itemRef.current.mediaPath;
    const mediaDurationSec = itemRef.current.mediaDurationSec;
    if (!effectiveId || effectiveId.startsWith('__draft__') || !mediaPath) return;

    if (extractTasks) setExtractingVoiceTasks(true);
    else setTranscribing(true);

    const isStillSameSession = () =>
      noteSessionSeqRef.current === sessionBefore &&
      (persistedDraftIdRef.current || itemRef.current.id) === effectiveId;

    try {
      const res = await transcribeItemWithWavFallback(
        {
          id: effectiveId,
          mediaPath,
          mediaDurationSec,
        },
        { extractTasks }
      );

      if (!res.ok) {
        if (!isStillSameSession()) return;
        if (extractTasks && syncMarkdownFromEditor().trim()) {
          // Graceful fallback: transform existing transcript text into a checklist
          await handleBeautify(['tasks']);
          return;
        }
        toast.error(
          res.error || t('note.studio.transcribeFailedLong')
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
        const checklistBlock = `## ${t('note.studio.tasksHeading')}\n${res.extractedTasks.map((task) => `- [ ] ${task}`).join('\n')}`;
        nextBody = nextBody.trim() ? `${nextBody.trim()}\n\n${checklistBlock}` : checklistBlock;
        const patched = await window.kapsula.updateItem(effectiveId, { body: nextBody });
        if (patched) res.item = patched;
      }

      if (res.item) onItemUpdatedRef.current(res.item);

      const edAfter = editorRef.current;
      if (
        !isStillSameSession() ||
        !edAfter ||
        edAfter.isDestroyed ||
        editSeqRef.current !== seqBefore
      ) {
        return;
      }

      if (nextBody) {
        loadingItemRef.current = true;
        edAfter.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
        loadingItemRef.current = false;
        const normalizedMd = edAfter.getMarkdown();
        if (markdownSyncTimerRef.current !== null) {
          window.clearTimeout(markdownSyncTimerRef.current);
          markdownSyncTimerRef.current = null;
        }
        markdownSyncPendingRef.current = false;
        bodyMarkdownRef.current = normalizedMd;
        setLiveBody(normalizedMd);
      }

      if (res.item?.title && res.item.title !== titleRef.current) {
        setTitle(res.item.title);
        titleRef.current = res.item.title;
      }

      dirtyRef.current = false;
      setSaveState('saved');
      await refreshRevisions(effectiveId, sessionBefore);
      if (!isStillSameSession()) return;
      playTactileTick(soundEnabled, 'success');
      toast.success(
        extractTasks ? t('note.studio.audioTasksExtracted') : t('cards.transcribed')
      );
    } catch (err) {
      if (noteSessionSeqRef.current === sessionBefore) {
        toast.error(
          friendlyErrorMessage(err, t('note.studio.audioTranscribeFailed'), locale)
        );
      }
    } finally {
      if (noteSessionSeqRef.current === sessionBefore) {
        setTranscribing(false);
        setExtractingVoiceTasks(false);
      }
    }
  };

  const handleQuickRevert = async (revisionId?: string) => {
    const startEditor = editorRef.current;
    const sessionBefore = noteSessionSeqRef.current;
    const seqBefore = editSeqRef.current;
    const effectiveId = persistedDraftIdRef.current || itemRef.current.id;
    const itemSnapshot = itemRef.current;
    const isQuickHeaderRevert = !revisionId;
    const stackTop =
      isQuickHeaderRevert && beautifyUndoStackRef.current.length > 0
        ? beautifyUndoStackRef.current[beautifyUndoStackRef.current.length - 1]
        : null;
    const snap = stackTop ?? quickRevertSnapshot;
    const targetRevId =
      revisionId ||
      (snap ? '__snapshot__' : undefined) ||
      quickRevertRevId ||
      revisions[0]?.id;
    if (!targetRevId || !startEditor || startEditor.isDestroyed || !effectiveId || effectiveId.startsWith('__draft__')) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setRestoringRevId(targetRevId);
    try {
      const currentBodyBefore = syncMarkdownFromEditor();
      let reverted: VaultItem | null = null;

      if (targetRevId !== '__snapshot__') {
        try {
          reverted = await window.kapsula.revertRevision(effectiveId, targetRevId);
        } catch (err) {
          if (!isQuickHeaderRevert || !snap) throw err;
        }
      }

      if (
        noteSessionSeqRef.current !== sessionBefore ||
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        editSeqRef.current !== seqBefore
      ) {
        if (reverted) onItemUpdatedRef.current(reverted);
        return;
      }

      const dbRevertMatchedCurrentOrFailed =
        isQuickHeaderRevert &&
        snap !== null &&
        (!reverted ||
          (reverted.body.trim() === currentBodyBefore.trim() &&
            snap.body.trim() !== currentBodyBefore.trim()) ||
          (snap.title.trim() !== '' && reverted.title !== snap.title));

      if (targetRevId === '__snapshot__' || dbRevertMatchedCurrentOrFailed) {
        if (snap) {
          const fallbackTitle =
            snap.title.trim() || deriveTitleFromBody(snap.body, fallbackTitleRef.current);
          const patched = await window.kapsula.updateItem(effectiveId, {
            title: fallbackTitle,
            body: snap.body,
            skipAutoRevision: true,
          });
          reverted = patched ?? { ...itemSnapshot, title: fallbackTitle, body: snap.body };
        }
      }

      if (!reverted) return;
      onItemUpdatedRef.current(reverted);

      const edAfter = editorRef.current;
      if (
        noteSessionSeqRef.current !== sessionBefore ||
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId ||
        !edAfter ||
        edAfter.isDestroyed ||
        editSeqRef.current !== seqBefore
      ) {
        return;
      }

      const nextBody = reverted.body || '';
      loadingItemRef.current = true;
      edAfter.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
      loadingItemRef.current = false;
      markdownSyncPendingRef.current = false;
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
      bodyMarkdownRef.current = nextBody;
      setLiveBody(nextBody);
      setTitle(reverted.title || '');
      titleRef.current = reverted.title || '';
      dirtyRef.current = false;
      setSaveState('saved');
      clearSlowPersist();
      if (isQuickHeaderRevert && beautifyUndoStackRef.current.length > 0) {
        const nextStack = beautifyUndoStackRef.current.slice(0, -1);
        beautifyUndoStackRef.current = nextStack;
        const nextTop = nextStack[nextStack.length - 1] ?? null;
        setQuickRevertSnapshot(nextTop);
        setQuickRevertRevId(nextTop ? '__snapshot__' : null);
      } else {
        beautifyUndoStackRef.current = [];
        setQuickRevertRevId(null);
        setQuickRevertSnapshot(null);
      }
      setHistoryOpen(false);
      await refreshRevisions(effectiveId, sessionBefore);
      if (
        noteSessionSeqRef.current !== sessionBefore ||
        (persistedDraftIdRef.current || itemRef.current.id) !== effectiveId
      ) {
        return;
      }
      playTactileTick(soundEnabled, 'soft');
      toast.success(t('note.studio.versionRestored'));
    } catch (err) {
      if (noteSessionSeqRef.current === sessionBefore) {
        toast.error(friendlyErrorMessage(err, t('note.studio.versionRestoreFailed'), locale));
      }
    } finally {
      if (noteSessionSeqRef.current === sessionBefore) {
        setRestoringRevId(null);
      }
    }
  };

  const applyNoteTemplate = useCallback(
    (tpl: NoteTemplate, replaceEntireDoc = false) => {
      if (!editor) return;
      const existingMd = syncMarkdownFromEditor().trim();
      if (replaceEntireDoc || !existingMd) {
        editor.commands.setContent(tpl.body, { contentType: 'markdown' });
      } else {
        editor.chain().focus().insertContent(`\n\n${tpl.body}`, { contentType: 'markdown' }).run();
      }
      const nextMd = editor.getMarkdown();
      markdownSyncPendingRef.current = false;
      if (markdownSyncTimerRef.current !== null) {
        window.clearTimeout(markdownSyncTimerRef.current);
        markdownSyncTimerRef.current = null;
      }
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
    [editor, flushDraft, soundEnabled, syncMarkdownFromEditor]
  );

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return slashCommands;
    return slashCommands.filter((cmd) =>
      `${cmd.label} ${cmd.hint} ${cmd.keywords}`.toLowerCase().includes(slashQuery)
    );
  }, [slashQuery, slashCommands]);

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
      const tpl = noteTemplates.find((tplEntry) => tplEntry.id === tplId);
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
        void handleBeautify(selectedPresets.length > 0 ? selectedPresets : ['structure']);
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
      { value: '', label: t('nav.noBoard') },
      ...focusBoards.map((b) => ({ value: b.id, label: b.name, dotColor: b.color })),
    ],
    [focusBoards, t]
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], dateLocale))
      .map(([tag]) => tag);
  }, [availableTags, allItemsForLinks, dateLocale]);

  const effectiveOrbits = useMemo(() => {
    const extra = createdOrbits.filter((c) => !orbits.some((o) => o.id === c.id));
    return extra.length > 0 ? [...orbits, ...extra] : orbits;
  }, [orbits, createdOrbits]);
  const activeOrbitId = isDraft && !persistedDraftIdRef.current ? draftOrbit : item.orbit || '';
  const activeRemindAt = isDraft && !persistedDraftIdRef.current ? draftRemindAt : item.remindAt;
  const isInNotesHub = item.mediaMeta?.inNotesHub === true;

  const handleCopyNote = async () => {
    const cleanTitle = titleRef.current.trim();
    const cleanBody = syncMarkdownFromEditor().trim();
    const combined = [cleanTitle, cleanBody].filter(Boolean).join('\n\n');
    if (!combined) {
      toast.info(t('note.studio.emptyCopyInfo'));
      return;
    }
    try {
      await window.kapsula.copyText(combined);
      playTactileTick(soundEnabled, 'soft');
      toast.success(t('note.studio.noteCopied'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('error.copyFailed'), locale));
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

  const bodyStats = useMemo(() => {
    const plain = stripMarkdownPreview(liveBody).trim();
    if (!plain) return { words: 0, chars: 0 };
    const words = plain.split(/\s+/).filter(Boolean).length;
    return { words, chars: plain.length };
  }, [liveBody]);

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

      {/* Redesigned Serene Editorial Document Header — clean hierarchy, dedicated AI, zero duplicates */}
      <div
        data-testid="note-studio-header"
        className={`flex items-center justify-between gap-3 h-[50px] border-b border-[var(--k-border-hairline)]/75 shrink-0 ${
          presentation === 'modal'
            ? 'bg-[var(--k-bg-surface-1)] px-4 sm:px-5'
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
                aria-label={t('note.studio.backToList')}
                className="k-interactive k-focus-ring inline-flex items-center gap-1.5 h-7.5 pl-2 pr-2 rounded-lg text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
              >
                <ArrowLeft weight="bold" className="w-3.5 h-3.5 shrink-0" />
                <span>{t('common.back')}</span>
                <span className="k-mono text-[10px] text-[var(--k-ink-muted)] px-1 py-0.25 rounded bg-[var(--k-bg-surface-2)]/85 ml-0.5 hidden sm:inline">
                  Esc
                </span>
              </button>
              <span className="w-px h-3.5 bg-[var(--k-border-hairline)] shrink-0" />
            </>
          ) : null}

          {/* Section Chip Selector with Inline Section Creation */}
          <SectionPickerPopover
            triggerVariant="chip"
            orbits={effectiveOrbits}
            value={activeOrbitId}
            emptyOptionLabel={t('nav.noSection')}
            emptyOptionKind="none"
            onOrbitCreated={(created) => {
              setCreatedOrbits((prev) =>
                prev.some((o) => o.id === created.id) ? prev : [...prev, created]
              );
            }}
            onChange={(val) => void applyMetaPatch({ orbit: val })}
            data-testid="note-studio-orbit-breadcrumb"
          />

          {/* Subtle Relative Date & Save Status (calm: only shows Saving if persistence takes > 900ms) */}
          <span
            className={`text-[11.5px] k-tabular truncate hidden @[480px]:inline ${
              saveState === 'error' ? 'text-[var(--k-danger)]' : 'text-[var(--k-ink-muted)]/85'
            }`}
          >
            {saveState === 'error'
              ? t('note.studio.statusError')
              : saveState === 'saving' && persistingSlow
                ? t('note.studio.statusSaving')
                : !isDraft
                  ? `· ${formatRelativeDate(item.contentUpdatedAt || item.createdAt, locale)}`
                  : t('note.studio.statusNew')}
          </span>
        </div>

        {/* Right: Focused, Uncluttered Action Group (Zero Duplicate Controls) */}
        <div className="flex items-center gap-1 shrink-0 k-no-drag">
          {quickRevertRevId || quickRevertSnapshot ? (
            <button
              type="button"
              data-testid="studio-revert-original-btn"
              onClick={() => void handleQuickRevert()}
              title={t('note.studio.revertOriginal')}
              aria-label={t('note.studio.revertOriginal')}
              className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] font-medium text-[var(--k-accent)] hover:border-[var(--k-border-strong)] cursor-pointer mr-0.5"
            >
              <ArrowCounterClockwise weight="bold" className="w-3.5 h-3.5" />
              <span className="hidden @[560px]:inline">{t('note.studio.revertOriginal')}</span>
            </button>
          ) : null}

          {/* Dedicated AI Assistant Popover (promoted out of the overflow `...` menu) */}
          <PopoverSurface
            open={aiMenuOpen}
            onOpenChange={setAiMenuOpen}
            align="end"
            widthClass="w-[290px] !p-2.5"
            trigger={
              <button
                type="button"
                data-testid="studio-ai-menu-btn"
                title={t('note.studio.ai.heading')}
                aria-label={t('note.studio.ai.heading')}
                className={`k-interactive k-focus-ring inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border text-[12px] font-medium cursor-pointer ${
                  beautifying || aiMenuOpen
                    ? 'border-[var(--k-accent)]/45 bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                    : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/65 text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]'
                }`}
              >
                {beautifying ? (
                  <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin text-[var(--k-accent)]" />
                ) : (
                  <Sparkle weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                )}
                <span className="hidden @[500px]:inline">{t('note.studio.aiShort')}</span>
              </button>
            }
          >
            <div className="space-y-1.5">
              <div className="px-1 pt-0.5 pb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                <Sparkle weight="fill" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                <span>{t('note.studio.ai.heading')}</span>
              </div>

              <div className="flex flex-col gap-1">
                {presetOptions.map((opt) => {
                  const checked = selectedPresets.includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      data-testid={`beautify-preset-${opt.id}`}
                      disabled={beautifying}
                      onClick={() => togglePreset(opt.id)}
                      className={`k-interactive w-full flex items-start gap-2.5 rounded-xl px-2.5 py-1.5 text-left cursor-pointer border transition-colors ${
                        checked
                          ? 'bg-[var(--k-accent-soft)]/80 border-[var(--k-accent)]/35 text-[var(--k-ink-primary)]'
                          : 'bg-transparent border-transparent hover:bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)]'
                      } disabled:opacity-60`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 inline-flex items-center justify-center w-4 h-4 rounded-[5px] border shrink-0 transition-colors ${
                          checked
                            ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                            : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-transparent'
                        }`}
                      >
                        <Check weight="bold" className="w-2.5 h-2.5" />
                      </span>
                      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                        <span className="whitespace-normal leading-tight text-[12.5px] font-medium">
                          {opt.label}
                        </span>
                        <span className="whitespace-normal leading-snug text-[11px] text-[var(--k-ink-muted)]">
                          {opt.desc}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                data-testid="studio-beautify-btn"
                disabled={beautifying || selectedPresets.length === 0}
                onClick={() => {
                  setAiMenuOpen(false);
                  void handleBeautify(selectedPresets);
                }}
                className={`mt-1 k-interactive w-full flex items-center justify-center gap-1.5 h-8 px-3 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium hover:brightness-105 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  beautifying ? 'k-beautify-shimmer' : ''
                }`}
              >
                {beautifying ? (
                  <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin shrink-0" />
                ) : (
                  <Sparkle weight="fill" className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>
                  {beautifying
                    ? t('note.studio.beautifying')
                    : selectedPresets.length > 1
                      ? t('note.studio.ai.applyCount', { count: selectedPresets.length })
                      : t('note.studio.ai.apply')}
                </span>
              </button>
            </div>
          </PopoverSurface>

          {!isDraft ? (
            <>
              <button
                type="button"
                data-no-press-scale="true"
                data-active={optimisticPinned ? 'true' : 'false'}
                data-testid="studio-favorite-btn"
                onClick={() => {
                  const next = !optimisticPinned;
                  setOptimisticPinned(next);
                  void applyMetaPatch({ isPinned: next });
                }}
                aria-label={optimisticPinned ? t('note.studio.removeFavorite') : t('note.studio.addFavorite')}
                title={optimisticPinned ? t('note.studio.removeFavorite') : t('note.studio.addFavorite')}
                className={`k-icon-toggle k-focus-ring inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg cursor-pointer ${
                  optimisticPinned
                    ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                    : 'text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                }`}
              >
                <Star
                  key={optimisticPinned ? 'star-on' : 'star-off'}
                  weight={optimisticPinned ? 'fill' : 'regular'}
                  className={`w-4 h-4 ${optimisticPinned ? 'k-icon-pop' : ''}`}
                />
              </button>

              <button
                type="button"
                data-no-press-scale="true"
                data-active={optimisticMuted ? 'true' : 'false'}
                data-testid="studio-mute-btn"
                onClick={() => {
                  const next = !optimisticMuted;
                  setOptimisticMuted(next);
                  void applyMetaPatch({ isMuted: next });
                }}
                aria-label={optimisticMuted ? t('cards.unmuteHint') : t('cards.muteHint')}
                title={optimisticMuted ? t('cards.unmuteHint') : t('cards.muteHint')}
                className={`k-icon-toggle k-focus-ring inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg cursor-pointer ${
                  optimisticMuted
                    ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                    : 'text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                }`}
              >
                <EyeSlash
                  key={optimisticMuted ? 'mute-on' : 'mute-off'}
                  weight={optimisticMuted ? 'fill' : 'regular'}
                  className={`w-4 h-4 ${optimisticMuted ? 'k-icon-pop' : ''}`}
                />
              </button>
            </>
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

          {/* Single authoritative Version History button (duplicate removed from overflow menu) */}
          {!isDraft && (revisions.length > 0 || Boolean(liveBody.trim())) ? (
            <button
              type="button"
              data-testid="studio-history-btn"
              title={
                revisions.length > 0
                  ? t('note.studio.versionHistoryCount', { count: revisions.length })
                  : t('rev.title')
              }
              aria-label={t('rev.title')}
              onClick={() => void handleOpenHistoryModal()}
              className="k-interactive relative inline-flex items-center justify-center gap-1 h-7.5 px-2 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <ClockCounterClockwise className="w-4 h-4 shrink-0" />
              {revisions.length > 0 ? (
                <span className="text-[11px] font-medium k-tabular text-[var(--k-ink-secondary)]">
                  {revisions.length}
                </span>
              ) : null}
            </button>
          ) : null}

          {/* Lean Overflow `...` Menu — Zero Duplicates, Zero Clutter */}
          <PopoverSurface
            open={moreMenuOpen}
            onOpenChange={setMoreMenuOpen}
            align="end"
            widthClass="w-[236px] !p-1.5"
            trigger={
              <button
                type="button"
                data-testid="studio-more-menu-btn"
                aria-label={t('common.moreActions')}
                title={t('common.moreActions')}
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
                <span>{t('cards.ctx.copyText')}</span>
              </button>

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
                <span>{showVoiceStudio ? t('note.studio.hideDictation') : t('note.studio.startDictation')}</span>
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
                <span>{t('note.studio.insertPhoto')}</span>
              </button>

              {focusBoards.length > 0 ? (
                <div className="px-2 py-1.5 mt-1 space-y-1 border-t border-[var(--k-border-hairline)]">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {t('workspace.view.board')}
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
                  {item.dna === 'note' || item.dna === 'snippet' ? (
                    <button
                      type="button"
                      data-testid="studio-toggle-notes-hub-btn"
                      onClick={() => {
                        const nextInNotes = !isInNotesHub;
                        setMoreMenuOpen(false);
                        void (async () => {
                          try {
                            await applyMetaPatch({
                              mediaMeta: { ...(item.mediaMeta ?? {}), inNotesHub: nextInNotes },
                            });
                            toast.success(
                              t(
                                nextInNotes
                                  ? 'notes.hub.addedToNotesToast'
                                  : 'notes.hub.removedFromNotesToast'
                              )
                            );
                          } catch (err) {
                            toast.error(friendlyErrorMessage(err, undefined, locale));
                          }
                        })();
                      }}
                      className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                    >
                      <NotePencil className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0" />
                      <span>
                        {t(isInNotesHub ? 'notes.hub.removeFromNotes' : 'notes.hub.addToNotes')}
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      void applyMetaPatch({ isArchived: !item.isArchived });
                    }}
                    className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-[var(--k-bg-surface-2)] text-left cursor-pointer"
                  >
                    <Archive className="w-3.5 h-3.5 text-[var(--k-ink-secondary)]" />
                    <span>{item.isArchived ? t('workspace.returnFromArchive') : t('note.studio.toArchive')}</span>
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
                    <span>{t('workspace.toTrashShort')}</span>
                  </button>
                </>
              ) : null}
            </div>
          </PopoverSurface>

          {presentation === 'modal' && onToggleExpandedModal ? (
            <button
              type="button"
              data-testid="note-studio-expand-btn"
              onClick={onToggleExpandedModal}
              aria-label={
                expandedModal ? t('note.studio.exitFullscreen') : t('note.studio.expandFullscreen')
              }
              title={
                expandedModal ? t('note.studio.exitFullscreen') : t('note.studio.expandFullscreen')
              }
              className="k-interactive k-focus-ring inline-flex items-center justify-center w-7.5 h-7.5 rounded-lg text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
            >
              {expandedModal ? (
                <ArrowsInSimple weight="bold" className="w-4 h-4" />
              ) : (
                <ArrowsOutSimple weight="bold" className="w-4 h-4" />
              )}
            </button>
          ) : null}

          {presentation === 'modal' && onClose ? (
            <>
              <span className="w-px h-4 bg-[var(--k-border-hairline)] mx-0.5 shrink-0" />
              <button
                type="button"
                data-testid="note-studio-close"
                onClick={() => void handleCloseStudio()}
                aria-label={t('note.studio.closeNote')}
                title={t('note.studio.closeEsc')}
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
              ? expandedModal
                ? 'max-w-[820px] mx-auto px-6 sm:pl-14 sm:pr-10 py-7'
                : 'max-w-[740px] mx-auto px-6 sm:pl-14 sm:pr-9 py-6'
              : 'max-w-[780px] mx-auto px-6 sm:pl-14 sm:pr-10 py-8'
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
                const curEd = editorRef.current;
                if (!curEd || curEd.isDestroyed) return;
                syncMarkdownFromEditor();
                const sessionBefore = noteSessionSeqRef.current;
                const seqBefore = editSeqRef.current;
                const wasDraftBefore = isDraftRef.current && !persistedDraftIdRef.current;
                const effectiveIdBefore = persistedDraftIdRef.current || itemRef.current.id;
                const titleBefore = titleRef.current.trim();
                const bodyBefore = bodyMarkdownRef.current;
                const orbitSnapshot = draftOrbitRef.current || itemRef.current.orbit || undefined;
                const boardSnapshot = draftBoardIdRef.current ?? itemRef.current.focusBoardId;
                const remindSnapshot = draftRemindAtRef.current ?? itemRef.current.remindAt;
                const tagsSnapshot = [...tagsRef.current];
                const mediaMetaSnapshot = sessionMediaMetaRef.current;
                const dictatedBody = (res.formattedText || res.transcript || '').trim();
                const combinedBody =
                  bodyBefore.trim() && dictatedBody
                    ? `${bodyBefore.trim()}\n\n${dictatedBody}`
                    : dictatedBody || bodyBefore;

                let existingIdForAttach = effectiveIdBefore;
                if (wasDraftBefore) {
                  while (inflightCreateRef.current) {
                    await inflightCreateRef.current.catch(() => {});
                  }
                  const alreadyCreatedId =
                    (noteSessionSeqRef.current === sessionBefore ? persistedDraftIdRef.current : null) ||
                    createdDraftIdBySessionRef.current.get(sessionBefore) ||
                    null;

                  if (alreadyCreatedId) {
                    if (!isMountedRef.current || noteSessionSeqRef.current !== sessionBefore) {
                      if (dictatedBody) {
                        const updated = await window.kapsula
                          .updateItem(alreadyCreatedId, {
                            body: combinedBody,
                            mediaMeta: {
                              ...(mediaMetaSnapshot ?? {}),
                              waveformPeaks: wav.peaks,
                              transcript: res.transcript,
                            },
                          })
                          .catch(() => null);
                        if (updated) onItemUpdatedRef.current(updated);
                      }
                      return;
                    }
                    existingIdForAttach = alreadyCreatedId;
                  } else {
                    const effectiveTitle =
                      (!isGenericDraftTitle(titleBefore) ? titleBefore : '') ||
                      res.titleSuggestion ||
                      titleBefore ||
                      undefined;
                    let createdItem: VaultItem | null = null;
                    let userTypedMeanwhileAfterCreate = false;
                    let createFailed = false;
                    let createTask!: Promise<void>;
                    createTask = (async () => {
                      inFlightSaveCountRef.current += 1;
                      armSlowPersist();
                      try {
                        const created = await window.kapsula.capture({
                          audioBase64: wav.wavBase64,
                          audioMime: wav.mime,
                          audioDurationSec: wav.durationSec,
                          title: effectiveTitle,
                          text: combinedBody,
                          orbitOverride: orbitSnapshot,
                          focusBoardId: boardSnapshot,
                          remindAt: remindSnapshot,
                          tags: tagsSnapshot,
                          mediaMeta: {
                            ...(mediaMetaSnapshot ?? {}),
                            waveformPeaks: wav.peaks,
                            transcript: res.transcript,
                          },
                        });
                        if (!created) {
                          createFailed = true;
                          if (
                            isMountedRef.current &&
                            itemRef.current.id === '__draft__' &&
                            noteSessionSeqRef.current === sessionBefore
                          ) {
                            dirtyRef.current = true;
                            setSaveState('error');
                          }
                          return;
                        }
                        createdItem = created;
                        createdDraftIdBySessionRef.current.set(sessionBefore, created.id);
                        if (createdDraftIdBySessionRef.current.size > 32) {
                          const oldestKey = createdDraftIdBySessionRef.current.keys().next().value;
                          if (oldestKey !== undefined) {
                            createdDraftIdBySessionRef.current.delete(oldestKey);
                          }
                        }
                        lastSavedStateRef.current = {
                          id: created.id,
                          seq: seqBefore,
                          title: titleBefore,
                          body: bodyBefore,
                        };
                        if (
                          isMountedRef.current &&
                          noteSessionSeqRef.current === sessionBefore &&
                          itemRef.current.id === '__draft__'
                        ) {
                          persistedDraftIdRef.current = created.id;
                          isDraftRef.current = false;
                          userTypedMeanwhileAfterCreate =
                            dirtyRef.current &&
                            (editSeqRef.current !== seqBefore ||
                              titleRef.current.trim() !== titleBefore ||
                              bodyMarkdownRef.current !== bodyBefore);
                          if (!userTypedMeanwhileAfterCreate) {
                            dirtyRef.current = false;
                          }
                        } else {
                          onItemUpdatedRef.current(created);
                        }
                      } catch (err) {
                        createFailed = true;
                        if (
                          isMountedRef.current &&
                          itemRef.current.id === '__draft__' &&
                          noteSessionSeqRef.current === sessionBefore
                        ) {
                          dirtyRef.current = true;
                          setSaveState('error');
                          toast.error(friendlyErrorMessage(err, undefined, localeRef.current));
                        }
                      } finally {
                        inFlightSaveCountRef.current = Math.max(0, inFlightSaveCountRef.current - 1);
                        if (inflightCreateRef.current === createTask) {
                          inflightCreateRef.current = null;
                        }
                        if (!createFailed && !dirtyRef.current && inFlightSaveCountRef.current === 0) {
                          setSaveState('saved');
                          clearSlowPersist();
                        } else if (createFailed) {
                          clearSlowPersist();
                        }
                      }
                    })();
                    inflightCreateRef.current = createTask;
                    await createTask;

                    if (!createdItem) return;
                    const persisted: VaultItem = createdItem;
                    if (
                      !isMountedRef.current ||
                      noteSessionSeqRef.current !== sessionBefore ||
                      (persistedDraftIdRef.current || itemRef.current.id) !== persisted.id
                    ) {
                      return;
                    }

                    const edNow = editorRef.current;
                    if (!edNow || edNow.isDestroyed) {
                      onDraftPersistedRef.current?.(persisted);
                      return;
                    }

                    if (!userTypedMeanwhileAfterCreate) {
                      loadingItemRef.current = true;
                      const renderedBody = persisted.body || combinedBody;
                      edNow.commands.setContent(renderedBody, {
                        contentType: 'markdown',
                        emitUpdate: false,
                      });
                      loadingItemRef.current = false;

                      const nextMd = edNow.getMarkdown();
                      markdownSyncPendingRef.current = false;
                      if (markdownSyncTimerRef.current !== null) {
                        window.clearTimeout(markdownSyncTimerRef.current);
                        markdownSyncTimerRef.current = null;
                      }
                      bodyMarkdownRef.current = nextMd;
                      setLiveBody(nextMd);
                      const resolvedTitle = persisted.title || titleBefore;
                      if (persisted.title) {
                        setTitle(persisted.title);
                        titleRef.current = persisted.title;
                      }
                      lastSavedStateRef.current = {
                        id: persisted.id,
                        seq: editSeqRef.current,
                        title: resolvedTitle,
                        body: nextMd,
                      };
                      dirtyRef.current = false;
                      setSaveState('saved');
                    } else if (dictatedBody) {
                      edNow.chain().focus().insertContent(`\n\n${dictatedBody}`, { contentType: 'markdown' }).run();
                      syncMarkdownFromEditor();
                      dirtyRef.current = true;
                      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
                      saveTimerRef.current = window.setTimeout(() => {
                        void flushDraft(persisted.id);
                      }, 300);
                    }

                    onDraftPersistedRef.current?.(persisted);
                    playTactileTick(soundEnabled, 'success');
                    toast.success(t('note.studio.voiceAndAudioSaved'));
                    return;
                  }
                }

                if (!existingIdForAttach || existingIdForAttach.startsWith('__draft__')) return;
                await window.kapsula.saveRevision(existingIdForAttach, 'voice');
                const edAfterRev = editorRef.current;
                if (
                  !isMountedRef.current ||
                  noteSessionSeqRef.current !== sessionBefore ||
                  (persistedDraftIdRef.current || itemRef.current.id) !== existingIdForAttach ||
                  !edAfterRev ||
                  edAfterRev.isDestroyed
                ) {
                  return;
                }
                const inserted = res.formattedText || res.transcript;
                if (inserted) {
                  if (!syncMarkdownFromEditor().trim()) {
                    edAfterRev.commands.setContent(inserted, { contentType: 'markdown' });
                  } else {
                    edAfterRev.chain().focus().insertContent(`\n\n${inserted}`, { contentType: 'markdown' }).run();
                  }
                  if (res.titleSuggestion && isGenericDraftTitle(titleRef.current)) {
                    setTitle(res.titleSuggestion);
                    titleRef.current = res.titleSuggestion;
                  }
                  const nextMd = edAfterRev.getMarkdown();
                  markdownSyncPendingRef.current = false;
                  if (markdownSyncTimerRef.current !== null) {
                    window.clearTimeout(markdownSyncTimerRef.current);
                    markdownSyncTimerRef.current = null;
                  }
                  bodyMarkdownRef.current = nextMd;
                  setLiveBody(nextMd);
                  dirtyRef.current = true;
                  await flushDraft(existingIdForAttach);
                  if (!isMountedRef.current || noteSessionSeqRef.current !== sessionBefore) return;
                  await refreshRevisions(existingIdForAttach, sessionBefore);
                  if (!isMountedRef.current || noteSessionSeqRef.current !== sessionBefore) return;
                  playTactileTick(soundEnabled, 'success');
                }
                if (isMountedRef.current && noteSessionSeqRef.current === sessionBefore) {
                  toast.success(t('note.studio.voiceAndAudioAttached'));
                }
              }}
              onFallbackSaveAudio={async (wav) => {
                setShowVoiceStudio(false);
                syncMarkdownFromEditor();
                const sessionBefore = noteSessionSeqRef.current;
                const seqBefore = editSeqRef.current;
                const wasDraftBefore = isDraftRef.current && !persistedDraftIdRef.current;
                const titleBefore = titleRef.current.trim();
                const bodyBefore = bodyMarkdownRef.current;
                const orbitSnapshot = draftOrbitRef.current || itemRef.current.orbit || undefined;
                const boardSnapshot = draftBoardIdRef.current ?? itemRef.current.focusBoardId;
                const remindSnapshot = draftRemindAtRef.current ?? itemRef.current.remindAt;
                const tagsSnapshot = [...tagsRef.current];
                const mediaMetaSnapshot = sessionMediaMetaRef.current;

                if (wasDraftBefore) {
                  while (inflightCreateRef.current) {
                    await inflightCreateRef.current.catch(() => {});
                  }
                  const alreadyCreatedId =
                    (noteSessionSeqRef.current === sessionBefore ? persistedDraftIdRef.current : null) ||
                    createdDraftIdBySessionRef.current.get(sessionBefore) ||
                    null;

                  if (alreadyCreatedId) {
                    const updated = await window.kapsula
                      .updateItem(alreadyCreatedId, {
                        mediaMeta: { ...(mediaMetaSnapshot ?? {}), waveformPeaks: wav.peaks },
                      })
                      .catch(() => null);
                    if (updated) onItemUpdatedRef.current(updated);
                    if (isMountedRef.current && noteSessionSeqRef.current === sessionBefore) {
                      toast.success(t('note.studio.audioSaved'));
                    }
                    return;
                  }

                  let createdItem: VaultItem | null = null;
                  let createFailed = false;
                  let createTask!: Promise<void>;
                  createTask = (async () => {
                    inFlightSaveCountRef.current += 1;
                    armSlowPersist();
                    try {
                      const created = await window.kapsula.capture({
                        audioBase64: wav.wavBase64,
                        audioMime: wav.mime,
                        audioDurationSec: wav.durationSec,
                        ...(titleBefore ? { title: titleBefore } : {}),
                        ...(bodyBefore.trim() ? { text: bodyBefore } : {}),
                        source: 'vault_ui',
                        orbitOverride: orbitSnapshot,
                        focusBoardId: boardSnapshot,
                        remindAt: remindSnapshot,
                        tags: tagsSnapshot,
                        mediaMeta: { ...(mediaMetaSnapshot ?? {}), waveformPeaks: wav.peaks },
                      });
                      if (!created) {
                        createFailed = true;
                        if (
                          isMountedRef.current &&
                          itemRef.current.id === '__draft__' &&
                          noteSessionSeqRef.current === sessionBefore
                        ) {
                          dirtyRef.current = true;
                          setSaveState('error');
                        }
                        return;
                      }
                      createdItem = created;
                      createdDraftIdBySessionRef.current.set(sessionBefore, created.id);
                      if (createdDraftIdBySessionRef.current.size > 32) {
                        const oldestKey = createdDraftIdBySessionRef.current.keys().next().value;
                        if (oldestKey !== undefined) {
                          createdDraftIdBySessionRef.current.delete(oldestKey);
                        }
                      }
                      lastSavedStateRef.current = {
                        id: created.id,
                        seq: seqBefore,
                        title: titleBefore,
                        body: bodyBefore,
                      };
                      if (
                        isMountedRef.current &&
                        noteSessionSeqRef.current === sessionBefore &&
                        itemRef.current.id === '__draft__'
                      ) {
                        persistedDraftIdRef.current = created.id;
                        isDraftRef.current = false;
                        const userTypedMeanwhile =
                          dirtyRef.current &&
                          (editSeqRef.current !== seqBefore ||
                            titleRef.current.trim() !== titleBefore ||
                            bodyMarkdownRef.current !== bodyBefore);
                        if (!userTypedMeanwhile) {
                          dirtyRef.current = false;
                        }
                        onDraftPersistedRef.current?.(created);
                        if (userTypedMeanwhile) {
                          dirtyRef.current = true;
                          setSaveState('saving');
                          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
                          saveTimerRef.current = window.setTimeout(() => {
                            void flushDraft(created.id);
                          }, 300);
                        }
                      } else {
                        onItemUpdatedRef.current(created);
                      }
                    } catch (err) {
                      createFailed = true;
                      if (
                        isMountedRef.current &&
                        itemRef.current.id === '__draft__' &&
                        noteSessionSeqRef.current === sessionBefore
                      ) {
                        dirtyRef.current = true;
                        setSaveState('error');
                        toast.error(friendlyErrorMessage(err, undefined, localeRef.current));
                      }
                    } finally {
                      inFlightSaveCountRef.current = Math.max(0, inFlightSaveCountRef.current - 1);
                      if (inflightCreateRef.current === createTask) {
                        inflightCreateRef.current = null;
                      }
                      if (!createFailed && !dirtyRef.current && inFlightSaveCountRef.current === 0) {
                        setSaveState('saved');
                        clearSlowPersist();
                      } else if (createFailed) {
                        clearSlowPersist();
                      }
                    }
                  })();
                  inflightCreateRef.current = createTask;
                  await createTask;
                  if (createdItem && isMountedRef.current && noteSessionSeqRef.current === sessionBefore) {
                    toast.success(t('note.studio.audioSaved'));
                  }
                  return;
                }

                const created = await window.kapsula.capture({
                  audioBase64: wav.wavBase64,
                  audioMime: wav.mime,
                  audioDurationSec: wav.durationSec,
                  source: 'vault_ui',
                  orbitOverride: orbitSnapshot,
                  mediaMeta: { ...(mediaMetaSnapshot ?? {}), waveformPeaks: wav.peaks },
                });
                if (!created) return;
                onItemUpdatedRef.current(created);
                if (isMountedRef.current && noteSessionSeqRef.current === sessionBefore) {
                  toast.success(t('note.studio.audioSaved'));
                }
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
          ) : (item.mediaMeta?.cachedVideoFile || item.mediaMeta?.youtubeVideoId) ? (
            <InlineReferenceVideo
              cachedVideoFile={item.mediaMeta?.cachedVideoFile}
              youtubeVideoId={item.mediaMeta?.youtubeVideoId}
              posterPath={item.thumbPath || item.imagePath}
              heightClass="max-h-[320px]"
            />
          ) : null}

          {imageUrl && !isVideoMedia && !item.mediaMeta?.cachedVideoFile && !item.mediaMeta?.youtubeVideoId ? (
            <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] overflow-hidden">
              <div className="relative max-h-[300px] overflow-hidden flex items-center justify-center bg-[var(--k-bg-surface-2)]">
                <img
                  src={imageUrl}
                  alt={item.title}
                  className="max-h-[300px] w-auto object-contain"
                />
                <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                  <CopySlotPill
                    label={t('cards.photoLabel')}
                    copiedLabel={t('common.copied')}
                    widthPx={104}
                    heightPx={28}
                    onCopy={() => window.kapsula.copyImage(item.imagePath || item.thumbPath || '')}
                  />
                  {onOpenShotLightbox ? (
                    <button
                      type="button"
                      aria-label={t('note.studio.openFullscreen')}
                      title={t('note.studio.openFullscreen')}
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
                    {t('note.studio.ocrTitle')}
                  </summary>
                  <div className="mt-2 flex items-start justify-between gap-2 k-selectable">
                    <p className="m-0 whitespace-pre-wrap leading-relaxed">{item.ocrText}</p>
                    <CopySlotPill
                      label={t('note.studio.textLabel')}
                      copiedLabel={t('common.done')}
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
                      <span>{transcribing ? t('cards.transcribing') : t('cards.transcribeBtn')}</span>
                    </button>
                    <span className="text-[11.5px] text-[var(--k-ink-muted)]">
                      {t('note.studio.transcribeHint')}
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
                      <span>{transcribing ? t('cards.transcribing') : t('note.studio.retranscribe')}</span>
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
                      <span>{extractingVoiceTasks ? t('note.studio.extractingTasks') : t('note.studio.extractTasks')}</span>
                    </button>
                  </div>
                )}
              </div>

              {item.mediaMeta?.transcript &&
              item.mediaMeta.transcript.trim() !== liveBody.trim() ? (
                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2 text-[12.5px] text-[var(--k-ink-secondary)] k-selectable">
                  <span className="font-medium text-[var(--k-ink-muted)] mr-1.5">{t('note.studio.transcriptLabel')}</span>
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
                  label={t('dna.link')}
                  copiedLabel={t('common.done')}
                  widthPx={84}
                  heightPx={28}
                  onCopy={() => window.kapsula.copyText(item.url || '')}
                />
                <button
                  type="button"
                  onClick={() => void window.kapsula.openExternal(item.url || '')}
                  className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  <span>{t('common.open')}</span>
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
                      item.mediaMeta?.pageCount ? t('common.pagesShort', { count: item.mediaMeta.pageCount }) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || t('dna.document')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void window.kapsula.openMediaFile(item.mediaPath!)}
                  className="k-interactive h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  {t('common.open')}
                </button>
                <button
                  type="button"
                  onClick={() => void window.kapsula.revealMediaFile(item.mediaPath!)}
                  aria-label={t('cards.showInFolder')}
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
              placeholder={t('common.noTitle')}
              className="w-full resize-none overflow-hidden bg-transparent border-none outline-none text-[28px] sm:text-[31px] font-bold tracking-[-0.006em] leading-[1.22] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]/55 k-selectable"
            />

            {/* Quiet Metadata & Smart Tags (insert moved to cursor-following Notion `+` gutter + always-reachable bottom dock) */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3.5 border-b border-[var(--k-border-hairline)]/65">
              <InlineTagEditor
                tags={tags}
                availableTags={resolvedAvailableTags}
                onChange={(nextTags) => {
                  setTags(nextTags);
                  tagsRef.current = nextTags;
                  void applyMetaPatch({ tags: nextTags });
                }}
              />
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
                    {t('note.studio.startFromTemplate')}
                  </span>
                  {noteTemplates.map((tpl) => {
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
                    aria-label={t('note.studio.applyLink')}
                    title={t('note.studio.applyLink')}
                    className="k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] cursor-pointer"
                  >
                    <Check weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  {toolbarState?.link ? (
                    <button
                      type="button"
                      aria-label={t('note.studio.removeLink')}
                      title={t('note.studio.removeLink')}
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
                    aria-label={t('common.cancel')}
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
                    title={`${t('note.studio.toolbar.bold')} (${isMacPlatform(window.kapsula?.platform) ? '⌘B' : 'Ctrl+B'})`}
                    aria-label={t('note.studio.toolbar.bold')}
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
                    title={`${t('note.studio.toolbar.italic')} (${isMacPlatform(window.kapsula?.platform) ? '⌘I' : 'Ctrl+I'})`}
                    aria-label={t('note.studio.toolbar.italic')}
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
                    title={`${t('note.studio.toolbar.underline')} (${isMacPlatform(window.kapsula?.platform) ? '⌘U' : 'Ctrl+U'})`}
                    aria-label={t('note.studio.toolbar.underline')}
                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                    className={`k-interactive inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.underline
                        ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <TextUnderline weight="bold" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t('note.studio.toolbar.strike')}
                    aria-label={t('note.studio.toolbar.strike')}
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
                    title={t('note.studio.toolbar.code')}
                    aria-label={t('note.studio.toolbar.code')}
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
                    data-no-press-scale="true"
                    title={t('note.studio.toolbar.textColor')}
                    aria-label={t('note.studio.toolbar.textColor')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setBubbleColorOpen((v) => !v)}
                    className={`k-interactive inline-flex flex-col items-center justify-center w-7 h-7 rounded-lg cursor-pointer ${
                      toolbarState?.textColor || bubbleColorOpen
                        ? 'bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)]'
                        : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                    }`}
                  >
                    <span
                      className="text-[12px] font-bold leading-none"
                      style={
                        toolbarState?.textColor
                          ? {
                              color:
                                TEXT_COLOR_SWATCHES.find((s) => s.key === toolbarState?.textColor)?.dot ??
                                'var(--k-accent)',
                            }
                          : undefined
                      }
                    >
                      A
                    </span>
                    <span
                      className="w-3.5 h-[2.5px] rounded-full mt-0.5"
                      style={{
                        background:
                          TEXT_COLOR_SWATCHES.find((s) => s.key === toolbarState?.textColor)?.dot ??
                          'linear-gradient(90deg, #ef4444 0%, #f59e0b 33%, #22c55e 66%, #3b82f6 100%)',
                      }}
                    />
                  </button>
                  {bubbleColorOpen ? (
                    <div className="flex items-center gap-0.5 px-1 border-l border-[var(--k-border-hairline)]">
                      {TEXT_COLOR_SWATCHES.map((sw) => (
                        <button
                          key={sw.key}
                          type="button"
                          title={locale === 'en' ? sw.labelEn : sw.labelRu}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            if (toolbarState?.textColor === sw.key) {
                              editor.chain().focus().unsetTextColor().run();
                            } else {
                              editor.chain().focus().setTextColor(sw.key).run();
                            }
                            setBubbleColorOpen(false);
                          }}
                          className={`k-interactive w-5 h-5 rounded-md flex items-center justify-center hover:bg-[var(--k-bg-surface-2)] cursor-pointer ${
                            toolbarState?.textColor === sw.key ? 'ring-1 ring-[var(--k-ink-primary)]' : ''
                          }`}
                        >
                          <span
                            className="w-3 h-3 rounded-full ring-1 ring-black/15"
                            style={{ backgroundColor: sw.dot }}
                          />
                        </button>
                      ))}
                      {toolbarState?.textColor ? (
                        <button
                          type="button"
                          title={t('note.studio.toolbar.defaultColor')}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            editor.chain().focus().unsetTextColor().run();
                            setBubbleColorOpen(false);
                          }}
                          className="k-interactive w-5 h-5 rounded-md flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          <X weight="bold" className="w-2.5 h-2.5" />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    title={t('note.studio.toolbar.highlight')}
                    aria-label={t('note.studio.toolbar.highlight')}
                    onClick={() => editor.chain().focus().toggleHighlight({ color: 'amber' }).run()}
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
                    title={t('note.studio.toolbar.h2')}
                    aria-label={t('note.studio.toolbar.h2')}
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
                    title={t('note.studio.toolbar.link')}
                    aria-label={t('note.studio.toolbar.link')}
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

          {/* TipTap Rich Markdown Canvas with Notion-style cursor-following `+` gutter */}
          <div ref={setEditorBoundaryEl} className="relative min-w-0">
            <BlockInsertGutter
              editor={editor}
              containerEl={editorBoundaryEl}
              insertingImage={insertingImage}
              noteTemplates={noteTemplates}
              onPickImage={() => imageInputRef.current?.click()}
              onStartDictation={() => setShowVoiceStudio(true)}
              onOpenAiMenu={() => setAiMenuOpen(true)}
              onApplyTemplate={(tpl) => applyNoteTemplate(tpl)}
            />
            <EditorContent editor={editor} />
            <ProseCaretOverlay editor={editor} containerEl={editorBoundaryEl} />
            <EditorBlockContextMenu
              editor={editor}
              containerEl={editorBoundaryEl}
              onOpenImageLightbox={(src, alt) =>
                openInlineImageLightboxRef.current({
                  src,
                  alt,
                  localFilename: src.startsWith('kapsula-media://local/')
                    ? src.slice('kapsula-media://local/'.length)
                    : null,
                })
              }
            />
          </div>

          {/* Backlinks & Similar Notes — Clearly Separated */}
          {!isDraft && (relatedState.backlinks.length > 0 || relatedState.related.length > 0) ? (
            <div className="pt-4 border-t border-[var(--k-border-hairline)]/70 flex flex-col gap-3">
              {relatedState.backlinks.length > 0 ? (
                <div data-testid="note-studio-backlinks" className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-accent)] flex items-center gap-1.5">
                    <LinkSimple weight="bold" className="w-3.5 h-3.5" />
                    <span>{t('note.studio.backlinks', { count: relatedState.backlinks.length })}</span>
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
                    {t('note.studio.related', { count: relatedState.related.length })}
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

      {/* Always-Reachable Bottom Formatting & Quick-Insert Dock */}
      <NoteFormatDock
        editor={editor}
        state={toolbarState}
        insertingImage={insertingImage}
        noteTemplates={noteTemplates}
        wordCount={bodyStats.words}
        charCount={bodyStats.chars}
        onPickImage={() => imageInputRef.current?.click()}
        onStartDictation={() => setShowVoiceStudio(true)}
        onOpenAiMenu={() => setAiMenuOpen(true)}
        onApplyTemplate={(tpl) => applyNoteTemplate(tpl)}
        onOpenLinkEditor={() => {
          handleOpenBubbleLink();
        }}
      />

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
                      : { opacity: 0, y: -4 }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0 }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, y: -3 }
                  }
                  transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
                  style={portalPlacement.style}
                  className="k-popover-card fixed z-[135] p-1.5"
                >
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {t('note.studio.commandsAndTemplates')}
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
                      : { opacity: 0, y: -4 }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0 }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, y: -3 }
                  }
                  transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
                  style={portalPlacement.style}
                  className="k-popover-card fixed z-[135] p-1.5"
                >
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {t('note.studio.linkWithNote')}
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
