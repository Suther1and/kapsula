import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import Highlight from '@tiptap/extension-highlight';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowSquareOut,
  Bell,
  Camera,
  Check,
  CheckSquare,
  ClockCounterClockwise,
  Code,
  Copy,
  FileText,
  FolderSimple,
  Highlighter,
  Image as ImageIcon,
  Lightbulb,
  LinkSimple,
  ListBullets,
  PushPin,
  Quotes,
  RocketLaunch,
  Sparkle,
  SpinnerGap,
  SunHorizon,
  Swatches,
  Tag,
  TextB,
  TextHTwo,
  TextItalic,
  Trash,
  UsersThree,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { NOTE_TEMPLATES, type NoteTemplate } from '@shared/note-templates';
import { extractWikiLinkTitles } from '@shared/task-helpers';
import type {
  FocusBoard,
  ItemRevision,
  ItemRevisionSource,
  OrbitDef,
  VaultItem,
} from '@shared/types';
import { formatRelativeDate, formatReminderStamp } from '@renderer/lib/format';
import {
  buildInlineMediaMarkdownUrl,
  KapsulaImage,
  WikiLink,
} from '../lib/mobile-tiptap-extensions';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { MobileAudioPlayer } from './MobileAudioPlayer';
import { MobileMediaImage } from './MobileMediaImage';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';

export const DRAFT_NOTE_ID = '__kapsula_new_draft__';

export interface NoteDraftBuffer {
  title: string;
  body: string;
  rev: number;
}

export interface MaterializeDraftInput {
  title: string;
  body: string;
  orbit: string;
  focusBoardId: string | null;
  isPinned: boolean;
  tags: string[];
  remindAt: number | null;
}

interface MobileNoteEditorProps {
  item: VaultItem;
  allItems?: VaultItem[];
  draft?: NoteDraftBuffer;
  orbits: OrbitDef[];
  boards: FocusBoard[];
  showBackButton: boolean;
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  ensureMediaUrl: (localName?: string | null) => Promise<string | null>;
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  onOpenImage: (src: string, caption?: string) => void;
  onOpenItem?: (itemId: string) => void;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
  onCreateBoard?: (name: string, color: string) => Promise<string>;
  onMaterializeDraft?: (input: MaterializeDraftInput) => Promise<VaultItem>;
  onDraftChange: (itemId: string, draft: NoteDraftBuffer) => void;
  onDraftSaved: (itemId: string, savedRev: number) => void;
  onSave: (
    itemId: string,
    patch: Partial<
      Pick<
        VaultItem,
        'title' | 'body' | 'orbit' | 'focusBoardId' | 'isPinned' | 'tags' | 'remindAt' | 'linksOut'
      >
    >
  ) => Promise<void>;
  onInsertInlinePhoto?: (source: 'camera' | 'gallery') => Promise<string | null>;
  onAttachPhoto?: (itemId: string, source: 'camera' | 'gallery') => Promise<void>;
  listRevisions?: (itemId: string) => ItemRevision[];
  onRevertRevision?: (itemId: string, revisionId: string) => Promise<VaultItem | null>;
  onTranscribeVoice?: (item: VaultItem) => Promise<void>;
  onExtractTasks?: (item: VaultItem) => Promise<void>;
  onPolishNote?: (item: VaultItem) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onBack?: () => void;
}

function countWords(title: string, body: string): number {
  const combined = `${title} ${body}`
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#*`~>\-\[\]()]/g, ' ')
    .trim();
  if (!combined) return 0;
  return combined.split(/\s+/).filter(Boolean).length;
}

const REVISION_SOURCE_LABELS: Record<ItemRevisionSource, string> = {
  auto: 'Автосохранение',
  manual: 'Вручную',
  beautify: 'До ИИ',
  dictate: 'До диктовки',
  voice: 'До расшифровки',
  restore: 'До отката',
  sync_conflict: 'Конфликт синхронизации',
};

function computeSimpleLineDiff(
  oldText: string,
  currentText: string
): Array<{ kind: 'same' | 'removed' | 'added'; text: string }> {
  const oldLines = (oldText || '').split(/\r?\n/).slice(0, 60);
  const curLines = (currentText || '').split(/\r?\n/).slice(0, 60);
  const oldSet = new Set(oldLines.map((l) => l.trim()).filter(Boolean));
  const curSet = new Set(curLines.map((l) => l.trim()).filter(Boolean));
  const rows: Array<{ kind: 'same' | 'removed' | 'added'; text: string }> = [];

  for (const line of oldLines) {
    const t = line.trim();
    if (!t) continue;
    rows.push({ kind: curSet.has(t) ? 'same' : 'added', text: line });
  }
  for (const line of curLines) {
    const t = line.trim();
    if (!t) continue;
    if (!oldSet.has(t)) {
      rows.push({ kind: 'removed', text: line });
    }
  }
  return rows.slice(0, 40);
}

interface DockedTrigger {
  mode: 'slash' | 'wiki';
  query: string;
  from: number;
  to: number;
}

export const MobileNoteEditor: React.FC<MobileNoteEditorProps> = ({
  item,
  allItems = [],
  draft,
  orbits,
  boards,
  showBackButton,
  isExpanded,
  hingeRightOffsetPx = 0,
  ensureMediaUrl,
  flushRef,
  onOpenImage,
  onOpenItem,
  onCreateOrbit,
  onCreateBoard,
  onMaterializeDraft,
  onDraftChange,
  onDraftSaved,
  onSave,
  onInsertInlinePhoto,
  onAttachPhoto,
  listRevisions,
  onRevertRevision,
  onTranscribeVoice,
  onExtractTasks,
  onPolishNote,
  onDelete,
  onBack,
}) => {
  const isDraftMode = item.id === DRAFT_NOTE_ID;
  const initialTitle = draft?.title ?? item.title ?? '';
  const initialBody = draft?.body ?? item.body ?? '';

  const [title, setTitle] = useState(initialTitle);
  const [bodySnapshot, setBodySnapshot] = useState(initialBody);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'draft'>(
    isDraftMode ? 'draft' : 'saved'
  );
  const [tagDraft, setTagDraft] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [activeTagIdx, setActiveTagIdx] = useState(-1);
  const tagBlurSuppressRef = useRef(false);

  // Local metadata state for uncommitted drafts before materialization
  const [localOrbit, setLocalOrbit] = useState(item.orbit || '');
  const [localBoardId, setLocalBoardId] = useState<string | null>(item.focusBoardId ?? null);
  const [localPinned, setLocalPinned] = useState(Boolean(item.isPinned));
  const [localTags, setLocalTags] = useState<string[]>(item.tags ?? []);
  const [localRemindAt, setLocalRemindAt] = useState<number | null>(item.remindAt ?? null);

  // Pickers, sheets, docked tray & AI busy states
  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false);
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [dockedTrigger, setDockedTrigger] = useState<DockedTrigger | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [extractingTasks, setExtractingTasks] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!photoSheetOpen && toolbarRef.current) {
      toolbarRef.current.scrollLeft = 0;
    }
  }, [photoSheetOpen, item.id]);

  const itemIdRef = useRef(item.id);
  const materializedIdRef = useRef<string | null>(isDraftMode ? null : item.id);
  const materializingPromiseRef = useRef<Promise<string | null> | null>(null);
  const materializedSnapRef = useRef<{ title: string; body: string } | null>(null);
  const sessionGenRef = useRef(0);
  const titleRef = useRef(initialTitle);
  const bodyRef = useRef(initialBody);
  const draftRevRef = useRef(draft?.rev ?? 0);
  const dirtyRef = useRef(false);
  const deletedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingEditorRef = useRef(false);
  const titleAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const metaRef = useRef({
    orbit: localOrbit,
    focusBoardId: localBoardId,
    isPinned: localPinned,
    tags: localTags,
    remindAt: localRemindAt,
  });
  metaRef.current = {
    orbit: localOrbit,
    focusBoardId: localBoardId,
    isPinned: localPinned,
    tags: localTags,
    remindAt: localRemindAt,
  };

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onMaterializeRef = useRef(onMaterializeDraft);
  onMaterializeRef.current = onMaterializeDraft;
  const onDraftSavedRef = useRef(onDraftSaved);
  onDraftSavedRef.current = onDraftSaved;
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;
  const onOpenItemRef = useRef(onOpenItem);
  onOpenItemRef.current = onOpenItem;
  const ensureMediaUrlRef = useRef(ensureMediaUrl);
  ensureMediaUrlRef.current = ensureMediaUrl;
  const onOpenImageRef = useRef(onOpenImage);
  onOpenImageRef.current = onOpenImage;

  const effOrbit = isDraftMode && !materializedIdRef.current ? localOrbit : item.orbit || '';
  const effBoardId =
    isDraftMode && !materializedIdRef.current ? localBoardId : item.focusBoardId ?? null;
  const effPinned = isDraftMode && !materializedIdRef.current ? localPinned : Boolean(item.isPinned);
  const effTags = isDraftMode && !materializedIdRef.current ? localTags : item.tags;
  const effRemindAt =
    isDraftMode && !materializedIdRef.current ? localRemindAt : item.remindAt ?? null;

  const selectedOrbit = useMemo(
    () => orbits.find((o) => o.id === effOrbit) ?? null,
    [orbits, effOrbit]
  );
  const selectedBoard = useMemo(
    () => boards.find((b) => b.id === effBoardId) ?? null,
    [boards, effBoardId]
  );

  const autoResizeTitle = useCallback(() => {
    const el = titleAreaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(32, el.scrollHeight)}px`;
  }, []);

  useLayoutEffect(() => {
    autoResizeTitle();
  }, [title, showBackButton, autoResizeTitle]);

  const ensureMaterializedId = useCallback(
    async (forceEvenIfEmpty = false, expectedGen = sessionGenRef.current): Promise<string | null> => {
      if (sessionGenRef.current !== expectedGen) return null;
      if (materializedIdRef.current) return materializedIdRef.current;
      if (materializingPromiseRef.current) return materializingPromiseRef.current;
      const hasContent = Boolean(titleRef.current.trim() || bodyRef.current.trim());
      if (!forceEvenIfEmpty && !hasContent) return null;
      if (!onMaterializeRef.current) return null;

      const snapTitle = titleRef.current.trim();
      const snapBody = bodyRef.current;
      const snapMeta = { ...metaRef.current };
      materializedSnapRef.current = { title: snapTitle, body: snapBody };

      const p = (async () => {
        const created = await onMaterializeRef.current!({
          title: snapTitle,
          body: snapBody,
          orbit: snapMeta.orbit,
          focusBoardId: snapMeta.focusBoardId,
          isPinned: snapMeta.isPinned,
          tags: snapMeta.tags,
          remindAt: snapMeta.remindAt,
        });
        if (sessionGenRef.current === expectedGen) {
          materializedIdRef.current = created.id;
          itemIdRef.current = created.id;
        }
        return created.id;
      })();

      materializingPromiseRef.current = p;
      try {
        return await p;
      } finally {
        if (materializingPromiseRef.current === p) {
          materializingPromiseRef.current = null;
        }
      }
    },
    []
  );

  const flushSave = useCallback(async () => {
    const gen = sessionGenRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    while (
      gen === sessionGenRef.current &&
      !deletedRef.current &&
      (dirtyRef.current || Boolean(materializingPromiseRef.current))
    ) {
      dirtyRef.current = false;

      const savedRev = draftRevRef.current;
      const rawTitle = titleRef.current.trim();
      const rawBody = bodyRef.current;

      if (!materializedIdRef.current) {
        if (!rawTitle && !rawBody.trim() && !materializingPromiseRef.current) {
          setSaveState('draft');
          return;
        }
        const realId = await ensureMaterializedId(false, gen);
        if (!realId || gen !== sessionGenRef.current) return;
        const snap = materializedSnapRef.current;
        const hasNewerEdits =
          !snap ||
          titleRef.current.trim() !== snap.title ||
          bodyRef.current !== snap.body;
        if (hasNewerEdits) {
          dirtyRef.current = true;
          continue;
        }
        onDraftSavedRef.current(DRAFT_NOTE_ID, savedRev);
        onDraftSavedRef.current(realId, savedRev);
        if (!dirtyRef.current && gen === sessionGenRef.current) {
          setSaveState('saved');
        }
        continue;
      }

      const id = materializedIdRef.current;
      await onSaveRef.current(id, { title: rawTitle, body: rawBody });
      if (gen !== sessionGenRef.current) return;
      if (titleRef.current.trim() !== rawTitle || bodyRef.current !== rawBody) {
        dirtyRef.current = true;
        continue;
      }
      onDraftSavedRef.current(id, savedRev);
      if (!dirtyRef.current && gen === sessionGenRef.current) {
        setSaveState('saved');
      }
    }
  }, [ensureMaterializedId]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flushSave;
    return () => {
      if (flushRef.current === flushSave) {
        flushRef.current = null;
      }
    };
  }, [flushRef, flushSave]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void flushSave();
    }, 450);
  }, [flushSave]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
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
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: 'Запиши мысль, / для команд или [[ для ссылки…',
      }),
      Typography,
      Highlight,
      KapsulaImage.configure({
        ensureMediaUrl: (name) => ensureMediaUrlRef.current(name),
        onOpenImage: (src, caption) => onOpenImageRef.current(src, caption),
      }),
      WikiLink.configure({
        onOpenWikiLink: (targetTitle) => {
          const norm = targetTitle.trim().toLowerCase();
          const hit = allItemsRef.current.find(
            (it) => it.dna !== 'secret' && (it.title || '').trim().toLowerCase() === norm
          );
          if (hit) {
            onOpenItemRef.current?.(hit.id);
          } else {
            toast(`Заметка «${targetTitle}» не найдена`);
          }
        },
      }),
    ],
    []
  );

  const detectDockedTrigger = useCallback(
    (ed: NonNullable<ReturnType<typeof useEditor>>) => {
      try {
        const { from } = ed.state.selection;
        if (!ed.state.selection.empty) {
          setDockedTrigger(null);
          return;
        }
        const $from = ed.state.doc.resolve(from);
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\uFFFC', '\uFFFC');
        const wikiMatch = /\[\[([^\]\n]{0,40})$/.exec(textBefore);
        if (wikiMatch) {
          const triggerLen = wikiMatch[0].length;
          setDockedTrigger({
            mode: 'wiki',
            query: wikiMatch[1] ?? '',
            from: from - triggerLen,
            to: from,
          });
          return;
        }
        const slashMatch = /(?:^|\s)\/([^\s/]{0,24})$/.exec(textBefore);
        if (slashMatch) {
          const q = slashMatch[1] ?? '';
          const triggerLen = q.length + 1;
          setDockedTrigger({
            mode: 'slash',
            query: q,
            from: from - triggerLen,
            to: from,
          });
          return;
        }
        setDockedTrigger(null);
      } catch {
        setDockedTrigger(null);
      }
    },
    []
  );

  const editor = useEditor({
    extensions,
    content: initialBody,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'k-prose',
        'data-testid': 'mobile-note-editor-body',
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
        if (anchor) {
          const href = anchor.getAttribute('href');
          if (href && /^(?:https?:\/\/|mailto:|tel:)/i.test(href)) {
            event.preventDefault();
            void mobileBridge.openExternalUrl(href);
            return true;
          }
        }
        return false;
      },
    },
    onSelectionUpdate: ({ editor: ed }) => {
      if (!syncingEditorRef.current) {
        detectDockedTrigger(ed);
      }
    },
    onUpdate: ({ editor: ed }) => {
      if (syncingEditorRef.current) return;
      const md =
        typeof (ed as unknown as { getMarkdown?: () => string }).getMarkdown === 'function'
          ? (ed as unknown as { getMarkdown: () => string }).getMarkdown()
          : ed.getText();
      bodyRef.current = md;
      setBodySnapshot(md);
      draftRevRef.current += 1;
      const activeKey = materializedIdRef.current ?? DRAFT_NOTE_ID;
      onDraftChange(activeKey, {
        title: titleRef.current,
        body: md,
        rev: draftRevRef.current,
      });
      detectDockedTrigger(ed);
      scheduleSave();
    },
  });

  const activeFormat = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      canUndo: Boolean(ed?.can().undo()),
      canRedo: Boolean(ed?.can().redo()),
      h2: Boolean(ed?.isActive('heading', { level: 2 })),
      bold: Boolean(ed?.isActive('bold')),
      italic: Boolean(ed?.isActive('italic')),
      highlight: Boolean(ed?.isActive('highlight')),
      taskList: Boolean(ed?.isActive('taskList')),
      bulletList: Boolean(ed?.isActive('bulletList')),
      blockquote: Boolean(ed?.isActive('blockquote')),
      codeBlock: Boolean(ed?.isActive('codeBlock')),
    }),
  });

  // Switch note OR sync external updates
  useEffect(() => {
    const idChanged = itemIdRef.current !== item.id;
    if (idChanged) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const outDirty = dirtyRef.current && !deletedRef.current;
      const outId = materializedIdRef.current;
      const outTitle = titleRef.current.trim();
      const outBody = bodyRef.current;
      const outMeta = { ...metaRef.current };
      const outRev = draftRevRef.current;
      const outPendingMat = materializingPromiseRef.current;

      sessionGenRef.current += 1;
      materializingPromiseRef.current = null;
      materializedSnapRef.current = null;
      deletedRef.current = false;
      itemIdRef.current = item.id;
      materializedIdRef.current = item.id === DRAFT_NOTE_ID ? null : item.id;
      setDockedTrigger(null);

      if (outDirty && (outTitle || outBody.trim())) {
        void (async () => {
          if (outId) {
            await onSaveRef.current(outId, { title: outTitle, body: outBody });
            onDraftSavedRef.current(outId, outRev);
          } else if (outPendingMat) {
            const createdId = await outPendingMat;
            if (createdId) {
              await onSaveRef.current(createdId, { title: outTitle, body: outBody });
              onDraftSavedRef.current(DRAFT_NOTE_ID, outRev);
              onDraftSavedRef.current(createdId, outRev);
            }
          } else if (onMaterializeRef.current) {
            const created = await onMaterializeRef.current({
              title: outTitle,
              body: outBody,
              orbit: outMeta.orbit,
              focusBoardId: outMeta.focusBoardId,
              isPinned: outMeta.isPinned,
              tags: outMeta.tags,
              remindAt: outMeta.remindAt,
            });
            onDraftSavedRef.current(DRAFT_NOTE_ID, outRev);
            onDraftSavedRef.current(created.id, outRev);
          }
        })();
      }

      const nextT = draft?.title ?? item.title ?? '';
      const nextB = draft?.body ?? item.body ?? '';
      draftRevRef.current = draft?.rev ?? 0;
      titleRef.current = nextT;
      bodyRef.current = nextB;
      dirtyRef.current = false;
      setTitle(nextT);
      setBodySnapshot(nextB);
      setLocalOrbit(item.orbit || '');
      setLocalBoardId(item.focusBoardId ?? null);
      setLocalPinned(Boolean(item.isPinned));
      setLocalTags(item.tags ?? []);
      setLocalRemindAt(item.remindAt ?? null);
      setShowTagInput(false);
      setTagDraft('');
      setActiveTagIdx(-1);
      setSaveState(item.id === DRAFT_NOTE_ID ? 'draft' : 'saved');
      if (editor) {
        syncingEditorRef.current = true;
        editor.commands.setContent(nextB, { contentType: 'markdown' });
        syncingEditorRef.current = false;
      }
      return;
    }

    if (!dirtyRef.current && !draft && item.id !== DRAFT_NOTE_ID) {
      const nextT = item.title ?? '';
      const nextB = item.body ?? '';
      if (nextT !== titleRef.current) {
        titleRef.current = nextT;
        setTitle(nextT);
      }
      if (nextB !== bodyRef.current && editor) {
        bodyRef.current = nextB;
        setBodySnapshot(nextB);
        syncingEditorRef.current = true;
        editor.commands.setContent(nextB, { contentType: 'markdown' });
        syncingEditorRef.current = false;
      }
    }
  }, [
    item.id,
    item.updatedAt,
    item.title,
    item.body,
    item.orbit,
    item.focusBoardId,
    item.isPinned,
    item.tags,
    item.remindAt,
    draft,
    editor,
  ]);

  useEffect(() => {
    return () => {
      if (dirtyRef.current && !deletedRef.current) {
        void flushSave();
      }
    };
  }, [flushSave]);

  const handleTitleChange = (val: string) => {
    const clean = val.replace(/\r?\n/g, ' ');
    setTitle(clean);
    titleRef.current = clean;
    draftRevRef.current += 1;
    const activeKey = materializedIdRef.current ?? DRAFT_NOTE_ID;
    onDraftChange(activeKey, {
      title: clean,
      body: bodyRef.current,
      rev: draftRevRef.current,
    });
    scheduleSave();
  };

  const handleUpdateMeta = async (
    patch: Partial<Pick<VaultItem, 'orbit' | 'focusBoardId' | 'isPinned' | 'tags' | 'remindAt'>>
  ) => {
    const gen = sessionGenRef.current;
    if (patch.orbit !== undefined) setLocalOrbit(patch.orbit);
    if (patch.focusBoardId !== undefined) setLocalBoardId(patch.focusBoardId);
    if (patch.isPinned !== undefined) setLocalPinned(patch.isPinned);
    if (patch.tags !== undefined) setLocalTags(patch.tags);
    if (patch.remindAt !== undefined) setLocalRemindAt(patch.remindAt);

    if (materializedIdRef.current) {
      await onSaveRef.current(materializedIdRef.current, patch);
    } else if (materializingPromiseRef.current) {
      const createdId = await materializingPromiseRef.current;
      if (createdId && sessionGenRef.current === gen && !deletedRef.current) {
        await onSaveRef.current(createdId, patch);
      }
    }
  };

  const handleApplyTemplate = async (tpl: NoteTemplate) => {
    mobileBridge.haptic('success');
    const nextTitle = titleRef.current.trim() || tpl.title;
    setTitle(nextTitle);
    titleRef.current = nextTitle;
    bodyRef.current = tpl.body;
    setBodySnapshot(tpl.body);
    if (editor) {
      syncingEditorRef.current = true;
      editor.commands.setContent(tpl.body, { contentType: 'markdown' });
      syncingEditorRef.current = false;
      editor.commands.focus('end');
    }
    const mergedTags = Array.from(new Set([...effTags, ...tpl.tags])).slice(0, 8);
    setLocalTags(mergedTags);
    draftRevRef.current += 1;
    scheduleSave();
    if (materializedIdRef.current) {
      await onSaveRef.current(materializedIdRef.current, { tags: mergedTags });
    }
  };

  const existingTagPool = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of allItems) {
      if (it.dna === 'secret' || !Array.isArray(it.tags)) continue;
      for (const raw of it.tags) {
        const clean = raw.trim().replace(/^#+/, '');
        if (!clean) continue;
        counts.set(clean, (counts.get(clean) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
      .map(([t]) => t);
  }, [allItems]);

  const tagSuggestions = useMemo(() => {
    const existingSet = new Set(effTags.map((t) => t.toLowerCase()));
    const q = tagDraft.trim().replace(/^#+/, '').toLowerCase();
    const candidates = existingTagPool.filter((t) => !existingSet.has(t.toLowerCase()));
    if (!q) return candidates.slice(0, 10);
    const prefix: string[] = [];
    const sub: string[] = [];
    for (const t of candidates) {
      const lower = t.toLowerCase();
      if (lower.startsWith(q)) prefix.push(t);
      else if (lower.includes(q)) sub.push(t);
    }
    return [...prefix, ...sub].slice(0, 10);
  }, [existingTagPool, effTags, tagDraft]);

  const commitTag = useCallback(
    async (raw: string) => {
      const clean = raw.trim().replace(/^#+/, '').trim();
      setTagDraft('');
      setActiveTagIdx(-1);
      setShowTagInput(false);
      if (!clean) return;
      if (effTags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
        return;
      }
      mobileBridge.haptic('light');
      await handleUpdateMeta({ tags: [...effTags, clean].slice(0, 8) });
    },
    [effTags]
  );

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    const picked =
      activeTagIdx >= 0 && activeTagIdx < tagSuggestions.length
        ? tagSuggestions[activeTagIdx]!
        : tagDraft;
    await commitTag(picked);
  };

  const handleRemoveTag = async (tag: string) => {
    await handleUpdateMeta({ tags: effTags.filter((t) => t !== tag) });
  };

  const handleQuickReminder = async (preset: 'today' | 'tomorrow' | 'threeDays' | 'clear') => {
    if (preset === 'clear') {
      await handleUpdateMeta({ remindAt: null });
      toast('Напоминание снято');
      setReminderSheetOpen(false);
      return;
    }
    const d = new Date();
    if (preset === 'today') {
      d.setHours(Math.max(d.getHours() + 2, 18), 0, 0, 0);
    } else if (preset === 'tomorrow') {
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
    } else {
      d.setDate(d.getDate() + 3);
      d.setHours(10, 0, 0, 0);
    }
    await handleUpdateMeta({ remindAt: d.getTime() });
    mobileBridge.haptic('success');
    toast.success(`Напоминание: ${formatReminderStamp(d.getTime())}`);
    setReminderSheetOpen(false);
  };

  // Inline photo insertion at TipTap cursor (fallback to legacy cover attach only if no inline handler)
  const handleAttachSource = async (source: 'camera' | 'gallery') => {
    setPhotoSheetOpen(false);
    if (onInsertInlinePhoto && editor) {
      const filename = await onInsertInlinePhoto(source);
      if (!filename) return;
      const mediaUrl = buildInlineMediaMarkdownUrl(filename);
      // If cursor is inside a checklist taskItem, insert photo on a standalone paragraph outside
      // the task list so inline image markdown never pollutes checklist / Kanban task titles!
      const $from = editor.state.selection.$from;
      let insideTaskItem = false;
      let outerTaskListDepth = -1;
      for (let d = $from.depth; d >= 1; d -= 1) {
        const nodeName = $from.node(d).type.name;
        if (nodeName === 'taskItem') insideTaskItem = true;
        if (nodeName === 'taskList') outerTaskListDepth = d;
      }
      if (insideTaskItem && outerTaskListDepth >= 1) {
        const insertAfterPos = $from.after(outerTaskListDepth);
        editor
          .chain()
          .focus()
          .insertContentAt(insertAfterPos, [
            {
              type: 'paragraph',
              content: [{ type: 'kapsulaImage', attrs: { src: mediaUrl, alt: 'Фото' } }],
            },
            { type: 'paragraph' },
          ])
          .run();
      } else {
        editor
          .chain()
          .focus()
          .insertContent([
            { type: 'kapsulaImage', attrs: { src: mediaUrl, alt: 'Фото' } },
            { type: 'text', text: ' ' },
          ])
          .run();
      }
      mobileBridge.haptic('success');
      toast.success('Фото вставлено в заметку');
      return;
    }
    if (!onAttachPhoto) return;
    const realId = await ensureMaterializedId(true);
    if (!realId) return;
    await onAttachPhoto(realId, source);
  };

  const insertWikiLinkFromTray = (target: VaultItem) => {
    if (!editor || !dockedTrigger) return;
    const targetTitle = target.title?.trim() || 'Заметка';
    editor
      .chain()
      .focus()
      .deleteRange({ from: dockedTrigger.from, to: dockedTrigger.to })
      .insertContent([
        { type: 'wikiLink', attrs: { title: targetTitle, label: targetTitle } },
        { type: 'text', text: ' ' },
      ])
      .run();
    setDockedTrigger(null);
    mobileBridge.haptic('light');
  };

  const slashSuggestions = useMemo(() => {
    if (dockedTrigger?.mode !== 'slash') return [];
    const q = dockedTrigger.query.trim().toLowerCase();
    const allCmds = [
      { id: 'h2', label: 'Заголовок', keywords: 'h2 заголовок title', run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
      { id: 'task', label: 'Чек-лист', keywords: 'task чек-лист чеклист задача todo', run: () => editor?.chain().focus().toggleTaskList().run() },
      { id: 'bullet', label: 'Список', keywords: 'bullet список list', run: () => editor?.chain().focus().toggleBulletList().run() },
      { id: 'quote', label: 'Цитата', keywords: 'quote цитата', run: () => editor?.chain().focus().toggleBlockquote().run() },
      { id: 'code', label: 'Код', keywords: 'code код блок', run: () => editor?.chain().focus().toggleCodeBlock().run() },
      { id: 'image', label: 'Фото', keywords: 'image photo фото картинка', run: () => setPhotoSheetOpen(true) },
      ...NOTE_TEMPLATES.map((tpl) => ({
        id: `tpl-${tpl.id}`,
        label: `Шаблон: ${tpl.shortLabel}`,
        keywords: `шаблон template ${tpl.label.toLowerCase()}`,
        run: () => void handleApplyTemplate(tpl),
      })),
    ];
    if (!q) return allCmds;
    return allCmds.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q)
    );
  }, [dockedTrigger, editor]);

  const wikiSuggestions = useMemo(() => {
    if (dockedTrigger?.mode !== 'wiki') return [];
    const q = dockedTrigger.query.trim().toLowerCase();
    return allItems
      .filter((it) => {
        if (it.id === item.id || it.id === materializedIdRef.current || it.dna === 'secret') {
          return false;
        }
        const t = (it.title || '').trim();
        if (!t) return false;
        return !q || t.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [dockedTrigger, allItems, item.id]);

  // Backlinks: other items referencing this note by ID or [[Title]]
  const backlinks = useMemo(() => {
    const currentId = materializedIdRef.current ?? item.id;
    if (!currentId || currentId === DRAFT_NOTE_ID) return [];
    const normTitle = (title || item.title || '').trim().toLowerCase();
    return allItems.filter((other) => {
      if (other.id === currentId || other.dna === 'secret') return false;
      if (other.linksOut?.includes(currentId)) return true;
      if (normTitle && other.body && other.body.includes('[[')) {
        const linkedTitles = extractWikiLinkTitles(other.body);
        return linkedTitles.some((t) => t.toLowerCase() === normTitle);
      }
      return false;
    });
  }, [allItems, item.id, item.title, title]);

  const revisions = useMemo(() => {
    if (!historyOpen || !listRevisions || !materializedIdRef.current) return [];
    return listRevisions(materializedIdRef.current);
  }, [historyOpen, listRevisions, item.updatedAt]);

  const activeRevision = useMemo(
    () => revisions.find((r) => r.id === selectedRevisionId) ?? revisions[0] ?? null,
    [revisions, selectedRevisionId]
  );

  const wordsCount = useMemo(() => countWords(title, bodySnapshot), [title, bodySnapshot]);
  const isVoiceNote = item.dna === 'voice' || Boolean(item.mediaType?.startsWith('audio/'));
  const hasVoiceText = Boolean((bodySnapshot || item.mediaMeta?.transcript || '').trim().length > 0);
  const showEmptyTemplates = !title.trim() && !bodySnapshot.trim() && !isVoiceNote;

  const templateIcon = (icon: string) => {
    if (icon === 'UsersThree') return UsersThree;
    if (icon === 'Lightbulb') return Lightbulb;
    if (icon === 'RocketLaunch') return RocketLaunch;
    return SunHorizon;
  };

  const toolbarItems = [
    {
      label: 'Отменить',
      testId: 'note-toolbar-undo',
      active: false,
      disabled: !activeFormat?.canUndo,
      icon: ArrowCounterClockwise,
      run: () => editor?.chain().focus().undo().run(),
    },
    {
      label: 'Повторить',
      testId: 'note-toolbar-redo',
      active: false,
      disabled: !activeFormat?.canRedo,
      icon: ArrowClockwise,
      run: () => editor?.chain().focus().redo().run(),
    },
    {
      label: 'Заголовок',
      active: Boolean(activeFormat?.h2),
      disabled: false,
      icon: TextHTwo,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: 'Жирный',
      active: Boolean(activeFormat?.bold),
      disabled: false,
      icon: TextB,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: 'Курсив',
      active: Boolean(activeFormat?.italic),
      disabled: false,
      icon: TextItalic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: 'Выделение',
      active: Boolean(activeFormat?.highlight),
      disabled: false,
      icon: Highlighter,
      run: () => editor?.chain().focus().toggleHighlight().run(),
    },
    {
      label: 'Чек-лист',
      active: Boolean(activeFormat?.taskList),
      disabled: false,
      icon: CheckSquare,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      label: 'Список',
      active: Boolean(activeFormat?.bulletList),
      disabled: false,
      icon: ListBullets,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Цитата',
      active: Boolean(activeFormat?.blockquote),
      disabled: false,
      icon: Quotes,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      label: 'Код',
      active: Boolean(activeFormat?.codeBlock),
      disabled: false,
      icon: Code,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    ...(onInsertInlinePhoto || onAttachPhoto
      ? [
          {
            label: 'Вставить фото',
            testId: 'note-toolbar-image',
            active: false,
            disabled: false,
            icon: ImageIcon,
            run: () => setPhotoSheetOpen(true),
          },
        ]
      : []),
  ];

  return (
    <div
      data-testid="mobile-note-editor"
      className="flex flex-col h-full min-h-0 overflow-hidden bg-[var(--k-bg-canvas)]"
    >
      {/* Top Action Bar */}
      <div
        data-testid="note-editor-topbar"
        className="flex items-center justify-between gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-2.5 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] shrink-0"
      >
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          {showBackButton && onBack ? (
            <button
              type="button"
              data-testid="note-editor-back"
              onClick={() => {
                void mobileBridge.hideKeyboard();
                void flushSave().finally(() => onBack());
              }}
              aria-label="Назад к списку"
              className="k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-primary)] shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : null}

          <span
            data-testid="note-editor-save-status"
            className="text-[11.5px] sm:text-[12px] text-[var(--k-ink-muted)] whitespace-nowrap shrink-0 inline-flex items-center gap-1"
          >
            {saveState === 'saving' ? (
              <span className="text-[var(--k-accent)] font-medium">Сохраняю…</span>
            ) : saveState === 'draft' && !materializedIdRef.current ? (
              <span>Черновик</span>
            ) : (
              <>
                <Check className="w-3.5 h-3.5 text-[var(--k-emerald)] shrink-0" />
                <span className="hidden min-[380px]:inline">
                  {wordsCount > 0
                    ? `${wordsCount} сл.`
                    : formatRelativeDate(item.contentUpdatedAt || item.updatedAt)}
                </span>
                <span className="min-[380px]:hidden">
                  {wordsCount > 0 ? `${wordsCount} сл.` : 'Сохранено'}
                </span>
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {/* Polish Text button — STRICTLY hidden when text is empty! */}
          {onPolishNote && hasVoiceText && materializedIdRef.current ? (
            <button
              type="button"
              data-testid="note-editor-polish-btn"
              disabled={polishing}
              onClick={async () => {
                await flushSave();
                setPolishing(true);
                try {
                  await onPolishNote({ ...item, id: materializedIdRef.current!, title: titleRef.current, body: bodyRef.current });
                } finally {
                  setPolishing(false);
                }
              }}
              aria-label="Причесать текст"
              className="k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] disabled:opacity-50"
            >
              {polishing ? (
                <SpinnerGap className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkle weight="duotone" className="w-4 h-4" />
              )}
            </button>
          ) : null}

          {/* Revision History button */}
          {listRevisions && materializedIdRef.current ? (
            <button
              type="button"
              data-testid="note-editor-history-btn"
              onClick={() => {
                setSelectedRevisionId(null);
                setHistoryOpen(true);
              }}
              aria-label="История версий"
              className="k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
            >
              <ClockCounterClockwise className="w-4 h-4" />
            </button>
          ) : null}

          <button
            type="button"
            data-testid="note-editor-reminder-btn"
            onClick={() => setReminderSheetOpen(true)}
            aria-label="Напоминание"
            className={`k-tap relative inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl border transition-colors ${
              effRemindAt
                ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                : 'bg-[var(--k-bg-surface-2)] border-transparent text-[var(--k-ink-secondary)]'
            }`}
          >
            <Bell weight={effRemindAt ? 'fill' : 'regular'} className="w-4 h-4" />
          </button>

          {onInsertInlinePhoto || onAttachPhoto ? (
            <button
              type="button"
              data-testid="note-editor-photo-btn"
              onClick={() => setPhotoSheetOpen(true)}
              aria-label="Вставить фото"
              className="k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
            >
              <Camera className="w-4 h-4" />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              mobileBridge.haptic('light');
              void handleUpdateMeta({ isPinned: !effPinned });
            }}
            aria-label={effPinned ? 'Открепить' : 'Закрепить'}
            className={`k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl border transition-colors ${
              effPinned
                ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                : 'bg-[var(--k-bg-surface-2)] border-transparent text-[var(--k-ink-secondary)]'
            }`}
          >
            <PushPin weight={effPinned ? 'fill' : 'regular'} className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              deletedRef.current = true;
              if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
              }
              dirtyRef.current = false;
              if (materializedIdRef.current) {
                void onDelete(materializedIdRef.current);
              } else {
                onBack?.();
              }
            }}
            aria-label="Удалить заметку"
            className="k-tap inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] hover:text-[var(--k-danger)]"
          >
            <Trash className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Metadata Pills */}
      <div className="flex items-center gap-1.5 px-3.5 pr-6 py-2 border-b border-[var(--k-border-hairline)] overflow-x-auto k-no-scrollbar k-scroll-fade-r shrink-0 bg-[var(--k-bg-canvas)]">
        <PickerTriggerChip
          testId="note-orbit-picker"
          colorDot={selectedOrbit?.color}
          icon={
            <FolderSimple
              className="w-3.5 h-3.5 shrink-0"
              style={{ color: selectedOrbit?.color || 'var(--k-accent)' }}
            />
          }
          label={selectedOrbit?.name || 'Без раздела'}
          placeholder={!selectedOrbit}
          onClick={() => setOrbitPickerOpen(true)}
          className="min-h-[34px] py-1 px-2.5 shrink-0 whitespace-nowrap max-w-[180px]"
        />

        <PickerTriggerChip
          testId="note-board-picker"
          colorDot={selectedBoard?.color}
          icon={
            <Swatches
              className="w-3.5 h-3.5 shrink-0"
              style={{ color: selectedBoard?.color || 'var(--k-emerald)' }}
            />
          }
          label={selectedBoard?.name || 'Без холста'}
          placeholder={!selectedBoard}
          onClick={() => setBoardPickerOpen(true)}
          className="min-h-[34px] py-1 px-2.5 shrink-0 whitespace-nowrap max-w-[168px]"
        />

        {effRemindAt ? (
          <button
            type="button"
            onClick={() => setReminderSheetOpen(true)}
            className="k-tap inline-flex items-center gap-1 px-2.5 h-9 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-medium shrink-0"
          >
            <Bell weight="fill" className="w-3 h-3" />
            {formatReminderStamp(effRemindAt)}
          </button>
        ) : null}

        {effTags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => void handleRemoveTag(tag)}
            className="k-tap inline-flex items-center gap-0.5 px-3 h-9 rounded-full border border-[var(--k-border-hairline)] bg-transparent text-[12px] text-[var(--k-ink-secondary)] shrink-0"
            title="Нажми, чтобы убрать тег"
          >
            <span className="opacity-65">#</span>
            <span>{tag}</span>
          </button>
        ))}

        {showTagInput ? (
          <form onSubmit={(e) => void handleAddTag(e)} className="inline-flex items-center shrink-0">
            <input
              autoFocus
              data-testid="mobile-tag-input"
              value={tagDraft}
              onChange={(e) => {
                setTagDraft(e.target.value);
                setActiveTagIdx(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  tagBlurSuppressRef.current = true;
                  setTagDraft('');
                  setActiveTagIdx(-1);
                  setShowTagInput(false);
                  return;
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                  if (tagSuggestions.length > 0 && (e.key === 'ArrowDown' || tagDraft === '')) {
                    e.preventDefault();
                    setActiveTagIdx((prev) => (prev + 1) % tagSuggestions.length);
                  }
                  return;
                }
                if (e.key === 'ArrowUp') {
                  if (tagSuggestions.length > 0) {
                    e.preventDefault();
                    setActiveTagIdx((prev) => (prev <= 0 ? tagSuggestions.length - 1 : prev - 1));
                  }
                }
              }}
              onBlur={() => {
                if (tagBlurSuppressRef.current) {
                  tagBlurSuppressRef.current = false;
                  return;
                }
                const clean = tagDraft.trim().replace(/^#+/, '').trim();
                if (clean) {
                  void commitTag(clean);
                } else {
                  setTagDraft('');
                  setActiveTagIdx(-1);
                  setShowTagInput(false);
                }
              }}
              placeholder="тег…"
              className="w-28 h-8 px-2.5 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-focus)] text-[12px] text-[var(--k-ink-primary)] outline-none"
            />
          </form>
        ) : (
          <button
            type="button"
            data-testid="mobile-add-tag-btn"
            onClick={() => {
              tagBlurSuppressRef.current = false;
              setActiveTagIdx(-1);
              setShowTagInput(true);
            }}
            className="k-tap inline-flex items-center gap-1 px-3 h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-dashed border-[var(--k-border-strong)] text-[12px] text-[var(--k-ink-muted)] shrink-0"
          >
            <Tag className="w-3.5 h-3.5" />
            Тег
          </button>
        )}
      </div>

      {/* Existing-Tag Autocomplete Suggestion Bar (zero clipping, zero blur flicker) */}
      {showTagInput && (tagSuggestions.length > 0 || tagDraft.trim().replace(/^#+/, '').length > 0) ? (
        <div
          data-testid="mobile-tag-suggestions"
          className="flex items-center gap-1.5 px-3.5 py-1.5 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] overflow-x-auto k-no-scrollbar shrink-0"
        >
          <span className="text-[11px] text-[var(--k-ink-muted)] shrink-0">Теги:</span>
          {tagSuggestions.map((tag, idx) => {
            const highlighted = idx === activeTagIdx;
            return (
              <button
                key={tag}
                type="button"
                data-testid={`mobile-tag-suggestion-${tag}`}
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => {
                  e.preventDefault();
                  tagBlurSuppressRef.current = true;
                  void commitTag(tag);
                }}
                onClick={(e) => {
                  e.preventDefault();
                  if (!tagBlurSuppressRef.current) {
                    void commitTag(tag);
                  }
                  tagBlurSuppressRef.current = false;
                }}
                className={`k-tap inline-flex items-center gap-1 px-3 h-9 rounded-lg border text-[12px] font-medium shrink-0 transition-colors ${
                  highlighted
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]'
                }`}
              >
                #{tag}
              </button>
            );
          })}
          {(() => {
            const cleanNew = tagDraft.trim().replace(/^#+/, '').trim();
            if (
              !cleanNew ||
              effTags.some((t) => t.toLowerCase() === cleanNew.toLowerCase()) ||
              tagSuggestions.some((t) => t.toLowerCase() === cleanNew.toLowerCase())
            ) {
              return null;
            }
            return (
              <button
                type="button"
                data-testid="mobile-tag-create-chip"
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => {
                  e.preventDefault();
                  tagBlurSuppressRef.current = true;
                  void commitTag(cleanNew);
                }}
                onClick={(e) => {
                  e.preventDefault();
                  if (!tagBlurSuppressRef.current) {
                    void commitTag(cleanNew);
                  }
                  tagBlurSuppressRef.current = false;
                }}
                className="k-tap inline-flex items-center gap-1 px-3 h-9 rounded-lg border border-[var(--k-border-focus)] bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[12px] font-semibold shrink-0"
              >
                + #{cleanNew}
              </button>
            );
          })()}
        </div>
      ) : null}

      {/* Scrollable Note Content */}
      <div className="flex-1 min-h-0 k-scroll px-4 sm:px-6 pt-3.5 pb-6">
        <div className="max-w-2xl mx-auto">
          <textarea
            ref={titleAreaRef}
            rows={1}
            data-testid="mobile-note-editor-title"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                editor?.commands.focus('start');
              }
            }}
            placeholder="Заголовок заметки…"
            className="w-full bg-transparent border-0 outline-none resize-none overflow-hidden text-[20px] font-bold leading-snug tracking-[-0.004em] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] mb-2.5"
          />

          {/* Quick Template Chips on Empty Draft Notes */}
          {showEmptyTemplates ? (
            <div
              data-testid="mobile-note-templates"
              className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar pb-3"
            >
              {NOTE_TEMPLATES.map((tpl) => {
                const Icon = templateIcon(tpl.icon);
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    data-testid={`note-template-${tpl.id}`}
                    onClick={() => void handleApplyTemplate(tpl)}
                    className="k-tap inline-flex items-center gap-1.5 px-3 h-8 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] shrink-0"
                  >
                    <Icon weight="duotone" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                    <span>{tpl.shortLabel}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {item.url ? (
            <button
              type="button"
              onClick={() => void mobileBridge.openExternalUrl(item.url!)}
              className="k-tap mb-3 w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-left"
            >
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-[var(--k-accent)] truncate">
                  {item.domain || item.url}
                </div>
                <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">{item.url}</div>
              </div>
              <ArrowSquareOut className="w-4 h-4 text-[var(--k-ink-secondary)] shrink-0" />
            </button>
          ) : null}

          <MobileMediaImage
            localName={item.imagePath || item.thumbPath}
            fallbackUrl={item.ogImageUrl}
            ensureMediaUrl={ensureMediaUrl}
            alt={item.title || 'Вложение'}
            onImageClick={(src) => onOpenImage(src, title || item.title || undefined)}
            wrapperClassName="mb-3 rounded-2xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]"
            className="w-full max-h-72 object-cover block"
          />

          {isVoiceNote && item.mediaPath ? (
            <div className="mb-3">
              <MobileAudioPlayer
                mediaPath={item.mediaPath}
                ensureMediaUrl={ensureMediaUrl}
                durationSec={item.mediaDurationSec}
                peaks={item.mediaMeta?.waveformPeaks}
                hasTranscript={hasVoiceText}
                transcribing={transcribing}
                extractingTasks={extractingTasks}
                onTranscribe={
                  onTranscribeVoice
                    ? async () => {
                        setTranscribing(true);
                        try {
                          await onTranscribeVoice(item);
                        } finally {
                          setTranscribing(false);
                        }
                      }
                    : undefined
                }
                onExtractTasks={
                  onExtractTasks
                    ? async () => {
                        setExtractingTasks(true);
                        try {
                          await onExtractTasks({
                            ...item,
                            body: bodyRef.current,
                          });
                        } finally {
                          setExtractingTasks(false);
                        }
                      }
                    : undefined
                }
              />
            </div>
          ) : null}

          <div className="k-mobile-prose">
            <EditorContent editor={editor} />
          </div>

          {/* Backlinks («Обратные ссылки») */}
          {backlinks.length > 0 ? (
            <section
              data-testid="mobile-note-backlinks"
              className="mt-6 pt-4 border-t border-[var(--k-border-hairline)] space-y-2"
            >
              <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                <LinkSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                <span>Обратные ссылки ({backlinks.length})</span>
              </div>
              <div className="space-y-1.5">
                {backlinks.map((linked) => (
                  <button
                    key={linked.id}
                    type="button"
                    onClick={() => onOpenItem?.(linked.id)}
                    className="k-tap w-full text-left flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                      <span className="text-[13.5px] font-medium text-[var(--k-ink-primary)] truncate">
                        {linked.title || 'Без названия'}
                      </span>
                    </div>
                    <ArrowSquareOut className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Docked `/` Slash & `[[` Wiki-Link Suggestion Tray (directly above toolbar — IME safe!) */}
      {dockedTrigger &&
      ((dockedTrigger.mode === 'slash' && slashSuggestions.length > 0) ||
        (dockedTrigger.mode === 'wiki' && wikiSuggestions.length > 0)) ? (
        <div
          data-testid="note-docked-suggestion-tray"
          className="px-2.5 py-1.5 border-t border-[var(--k-border-focus)]/40 bg-[var(--k-bg-surface-1)] flex items-center gap-1.5 overflow-x-auto k-no-scrollbar shrink-0"
        >
          <span className="text-[11px] font-semibold text-[var(--k-accent)] px-1.5 shrink-0">
            {dockedTrigger.mode === 'slash' ? 'Команда:' : 'Ссылка:'}
          </span>
          {dockedTrigger.mode === 'slash'
            ? slashSuggestions.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (editor && dockedTrigger) {
                      editor
                        .chain()
                        .focus()
                        .deleteRange({ from: dockedTrigger.from, to: dockedTrigger.to })
                        .run();
                    }
                    setDockedTrigger(null);
                    cmd.run();
                    mobileBridge.haptic('light');
                  }}
                  className="k-tap px-2.5 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-primary)] shrink-0"
                >
                  {cmd.label}
                </button>
              ))
            : wikiSuggestions.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertWikiLinkFromTray(target)}
                  className="k-tap inline-flex items-center gap-1.5 px-2.5 h-8 rounded-xl bg-[var(--k-accent-soft)] border border-[var(--k-border-focus)]/50 text-[12px] font-medium text-[var(--k-accent)] shrink-0 max-w-[200px]"
                >
                  <LinkSimple className="w-3 h-3 shrink-0" />
                  <span className="truncate">{target.title}</span>
                </button>
              ))}
        </div>
      ) : null}

      {/* Formatting Toolbar with Undo / Redo & Inline Photo */}
      {editor ? (
        <div
          ref={toolbarRef}
          data-testid="note-editor-toolbar"
          className="flex items-center justify-start gap-1 px-2.5 pr-6 py-1.5 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] overflow-x-auto k-no-scrollbar k-scroll-fade-r shrink-0"
        >
          {toolbarItems.map((btn, idx) => {
            const Icon = btn.icon;
            return (
              <React.Fragment key={btn.label}>
                {idx === 2 ? (
                  <span className="w-[1px] h-5 bg-[var(--k-border-hairline)] mx-1 shrink-0" />
                ) : null}
                <button
                  type="button"
                  data-testid={btn.testId}
                  disabled={btn.disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    mobileBridge.haptic('light');
                    btn.run();
                  }}
                  aria-label={btn.label}
                  aria-pressed={btn.active}
                  className={`k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl shrink-0 transition-colors disabled:opacity-35 ${
                    btn.active
                      ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                      : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              </React.Fragment>
            );
          })}
        </div>
      ) : null}

      {/* Revision History Bottom Sheet with Diff Preview & Restore */}
      <BottomSheet
        open={historyOpen}
        title="История версий"
        subtitle={
          revisions.length > 0
            ? `Сохранено снимков: ${revisions.length}`
            : 'Снимки сохраняются автоматически при изменении заметки'
        }
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        maxWidthClass="max-w-lg"
        onClose={() => setHistoryOpen(false)}
      >
        <div data-testid="mobile-revision-history-sheet" className="p-4 space-y-3.5">
          {revisions.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-[var(--k-ink-muted)]">
              Для этой заметки пока нет сохранённых версий.
            </div>
          ) : (
            <>
              {/* Revision Timeline Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar pb-1">
                {revisions.map((rev) => {
                  const active = activeRevision?.id === rev.id;
                  return (
                    <button
                      key={rev.id}
                      type="button"
                      onClick={() => setSelectedRevisionId(rev.id)}
                      className={`k-tap px-3 py-1.5 rounded-xl border text-left shrink-0 ${
                        active
                          ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                          : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                      }`}
                    >
                      <div className="text-[12px] font-semibold">
                        {formatRelativeDate(rev.createdAt)}
                      </div>
                      <div className="text-[10.5px] opacity-80">
                        {REVISION_SOURCE_LABELS[rev.source] ?? 'Снимок'}
                        {rev.deviceName ? ` · ${rev.deviceName}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>

              {activeRevision ? (
                <div className="space-y-3">
                  <div className="rounded-2xl p-3 pb-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-1 max-h-64 overflow-y-auto k-scroll">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)] mb-1.5">
                      Отличия от текущей версии
                    </div>
                    {activeRevision.title && activeRevision.title !== title ? (
                      <div className="text-[12.5px] font-semibold text-[var(--k-emerald)] mb-1">
                        Заголовок: {activeRevision.title}
                      </div>
                    ) : null}
                    {computeSimpleLineDiff(activeRevision.content, bodySnapshot).map((line, i) => {
                      const cleanLine = (line.text || '').replace(
                        /!\[([^\]]*)\]\((?:kapsula-media:\/\/local\/[^)\s]+|blob:[^)\s]+|data:image\/[^)\s]+)\)/gi,
                        (_m, alt: string) => {
                          const a = (alt || '').trim();
                          return a ? `[Фото: ${a}]` : '[Фото]';
                        }
                      );
                      return (
                        <div
                          key={i}
                          className={`text-[12.5px] leading-snug px-2 py-0.5 rounded font-mono whitespace-pre-wrap ${
                            line.kind === 'added'
                              ? 'bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] font-medium'
                              : line.kind === 'removed'
                                ? 'bg-[var(--k-danger-soft)] text-[var(--k-danger)] line-through'
                                : 'text-[var(--k-ink-secondary)]'
                          }`}
                        >
                          {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                          {cleanLine}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="revision-restore-btn"
                      onClick={async () => {
                        if (!onRevertRevision || !materializedIdRef.current) return;
                        const reverted = await onRevertRevision(
                          materializedIdRef.current,
                          activeRevision.id
                        );
                        if (reverted) {
                          titleRef.current = reverted.title;
                          bodyRef.current = reverted.body;
                          setTitle(reverted.title);
                          setBodySnapshot(reverted.body);
                          if (editor) {
                            syncingEditorRef.current = true;
                            editor.commands.setContent(reverted.body, { contentType: 'markdown' });
                            syncingEditorRef.current = false;
                          }
                          setHistoryOpen(false);
                          mobileBridge.haptic('success');
                          toast.success('Версия восстановлена');
                        }
                      }}
                      className="k-tap flex-1 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13.5px] font-semibold"
                    >
                      Восстановить эту версию
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void mobileBridge.copyPlain(activeRevision.content);
                        toast.success('Текст версии скопирован');
                      }}
                      aria-label="Скопировать текст версии"
                      className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </BottomSheet>

      {/* Section & Board Picker Sheets */}
      <MobilePickerSheet
        open={orbitPickerOpen}
        title="Раздел заметки"
        value={effOrbit}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateOrbit)}
        createPlaceholder="Название раздела…"
        onCreateNew={onCreateOrbit}
        options={[
          { value: '', label: 'Без раздела' },
          ...orbits.map((o) => ({
            value: o.id,
            label: o.name,
            color: o.color,
            count: o.itemCount,
          })),
        ]}
        onSelect={(val) => void handleUpdateMeta({ orbit: val })}
        onClose={() => setOrbitPickerOpen(false)}
      />

      <MobilePickerSheet
        open={boardPickerOpen}
        title="Холст заметки"
        value={effBoardId || ''}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateBoard)}
        createPlaceholder="Название холста…"
        onCreateNew={onCreateBoard}
        options={[
          { value: '', label: 'Без холста' },
          ...boards.map((b) => ({
            value: b.id,
            label: b.name,
            color: b.color,
            count: b.itemCount,
          })),
        ]}
        onSelect={(val) => void handleUpdateMeta({ focusBoardId: val || null })}
        onClose={() => setBoardPickerOpen(false)}
      />

      {/* Reminder Quick Sheet */}
      <BottomSheet
        open={reminderSheetOpen}
        title="Напоминание"
        subtitle={
          effRemindAt
            ? `Сейчас: ${formatReminderStamp(effRemindAt)}`
            : 'Заметка появится в календаре и задачах'
        }
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        maxWidthClass="max-w-sm"
        onClose={() => setReminderSheetOpen(false)}
      >
        <div className="p-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleQuickReminder('today')}
            className="k-tap h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] font-medium text-[var(--k-ink-primary)]"
          >
            Сегодня вечером
          </button>
          <button
            type="button"
            onClick={() => void handleQuickReminder('tomorrow')}
            className="k-tap h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] font-medium text-[var(--k-ink-primary)]"
          >
            Завтра в 10:00
          </button>
          <button
            type="button"
            onClick={() => void handleQuickReminder('threeDays')}
            className="k-tap h-11 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13.5px] font-medium text-[var(--k-ink-primary)]"
          >
            Через 3 дня
          </button>
          <button
            type="button"
            disabled={!effRemindAt}
            onClick={() => void handleQuickReminder('clear')}
            className="k-tap h-11 rounded-2xl bg-[var(--k-danger-soft)] text-[13.5px] font-medium text-[var(--k-danger)] disabled:opacity-35"
          >
            Снять
          </button>
        </div>
      </BottomSheet>

      {/* Camera / Gallery Inline Photo Sheet */}
      <BottomSheet
        open={photoSheetOpen}
        title="Вставить фото в текст"
        subtitle="Фото сохранится прямо внутри заметки и синхронизируется с ПК"
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        maxWidthClass="max-w-sm"
        onClose={() => setPhotoSheetOpen(false)}
      >
        <div className="p-4 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => void handleAttachSource('camera')}
            className="k-tap flex flex-col items-center justify-center gap-2 py-5 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] font-semibold text-[14px]"
          >
            <Camera weight="duotone" className="w-6 h-6" />
            <span>Камера</span>
          </button>
          <button
            type="button"
            onClick={() => void handleAttachSource('gallery')}
            className="k-tap flex flex-col items-center justify-center gap-2 py-5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-strong)] text-[var(--k-ink-primary)] font-semibold text-[14px]"
          >
            <ImageIcon weight="duotone" className="w-6 h-6 text-[var(--k-accent)]" />
            <span>Галерея</span>
          </button>
        </div>
      </BottomSheet>
    </div>
  );
};
