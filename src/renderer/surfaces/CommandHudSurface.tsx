import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import Highlight from '@tiptap/extension-highlight';
import { toast } from 'sonner';
import {
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowUUpRight,
  CalendarBlank,
  Camera,
  Check,
  CheckCircle,
  CheckSquare,
  CircleNotch,
  ClipboardText,
  Code,
  FileText,
  Fingerprint,
  GlobeSimple,
  ImageSquare,
  KeyReturn,
  LinkSimple,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Microphone,
  NotePencil,
  PaperPlaneTilt,
  Plus,
  PushPin,
  ShieldCheck,
  Sparkle,
  Star,
  TextHTwo,
} from '@phosphor-icons/react';
import type {
  CalendarEvent,
  OrbitDef,
  SettingsState,
  TotpCodeSnapshot,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { decodeHtmlEntities } from '@shared/html-entities';
import { useI18n } from '@shared/i18n/react';
import { parseRussianEvent } from '@shared/russian-event-parser';
import { isMacPlatform } from '@shared/shortcuts';
import { extractInlineMediaFilenames } from '@shared/sync-contract';
import { isStandaloneTaskSource } from '@shared/task-helpers';
import '../styles/editor.css';
import { hydrateAppearanceFromSettings } from '../lib/appearance';
import {
  formatDateCompact,
  formatRelativeDate,
  friendlyErrorMessage,
  getDnaHumanLabel,
  getMediaUrl,
  transcribeItemWithWavFallback,
} from '../lib/format';
import { ShotLightbox } from '../components/cards/ShotLightbox';
import {
  KapsulaImage,
  extractImageFilesFromDataTransfer,
  saveAndInsertImageFiles,
  type KapsulaImageLightboxInfo,
} from '../components/editor/KapsulaImageNode';
import { ProseCaretOverlay } from '../components/editor/ProseCaretOverlay';
import { WikiLink } from '../components/editor/WikiLinkNode';
import { AnimatedCheckbox } from '../components/ui/AnimatedCheckbox';
import { CopySlotPill } from '../components/ui/CopySlotPill';
import { KapsulaEmblem } from '../components/ui/KapsulaEmblem';
import { SectionIcon } from '../components/ui/SectionIcon';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { SectionPickerPopover } from '../components/ui/SectionPickerPopover';
import { VoiceRecorderStudio } from '../components/ui/VoiceRecorderStudio';
import { WaveformAudioPlayer } from '../components/ui/WaveformAudioPlayer';

type HudTab = 'search' | 'capture' | 'vault' | 'today' | 'important';

interface CommandHudSurfaceProps {
  settings: SettingsState;
  onSettingsUpdated: (next: SettingsState) => void;
}

const HUD_TAB_ORDER: HudTab[] = ['search', 'capture', 'vault', 'today', 'important'];

interface HudSlideCustom {
  dir: number;
  skip: boolean;
}

const HUD_TAB_SLIDE_VARIANTS = {
  enter: ({ dir, skip }: HudSlideCustom) =>
    skip
      ? { opacity: 1, transform: 'translate3d(0px, 0, 0)' }
      : { opacity: 0, transform: `translate3d(${dir * 18}px, 0, 0)` },
  center: { opacity: 1, transform: 'translate3d(0px, 0, 0)' },
  exit: ({ dir, skip }: HudSlideCustom) =>
    skip
      ? { opacity: 0, transform: 'translate3d(0px, 0, 0)' }
      : { opacity: 0, transform: `translate3d(${-dir * 14}px, 0, 0)` },
};

/* ---------- Helper: Structured Mini Markdown Preview (for Important Tab Cards) ---------- */

type MiniPreviewLine =
  | { kind: 'task'; done: boolean; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'text'; text: string };

function cleanInlineSyntax(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/!\[[^\]]*\]\((?:<[^>]+>|[^()\s]+(?:\([^)]*\))*)(?:\s+"[^"]*")?\)/g, '')
    .replace(/kapsula-media:\/\/local\/[^\s)"'<>`?#]+/gi, '')
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^()\s]+(?:\([^)]*\))*)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/\\([[\]*_`])/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMiniPreviewLines(raw: string, maxLines = 3): MiniPreviewLine[] {
  const src = (raw || '').replace(/```[\s\S]*?```/g, '');
  const out: MiniPreviewLine[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    if (out.length >= maxLines) break;
    const trimmed = rawLine.trim();
    if (!trimmed || /^---+$/.test(trimmed)) continue;

    const taskMatch = /^[-*•]\s+(?:\\\[|\[)([ xX])(?:\\\]|\])\s+(.+)$/.exec(trimmed);
    if (taskMatch) {
      const text = cleanInlineSyntax(taskMatch[2] ?? '');
      if (text) {
        out.push({ kind: 'task', done: (taskMatch[1] ?? '').toLowerCase() === 'x', text });
      }
      continue;
    }

    const bulletMatch = /^(?:[-*•]|\d+\.)\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      const text = cleanInlineSyntax(bulletMatch[1] ?? '');
      if (text) out.push({ kind: 'bullet', text });
      continue;
    }

    const clean = cleanInlineSyntax(trimmed.replace(/^#{1,6}\s+/, '').replace(/^>\s+/, ''));
    if (clean) out.push({ kind: 'text', text: clean });
  }
  return out;
}

const CompactStructuredPreview: React.FC<{ item: VaultItem }> = ({ item }) => {
  const { t } = useI18n();
  const lines = useMemo(
    () => parseMiniPreviewLines(item.body || item.summary || item.url || '', 3),
    [item.body, item.summary, item.url]
  );
  const inlineImageCount = useMemo(
    () => extractInlineMediaFilenames(item.body).length,
    [item.body]
  );

  if (lines.length === 0) {
    if (inlineImageCount > 0 || item.thumbPath || item.imagePath) {
      return (
        <div className="inline-flex items-center gap-1 text-[11px] text-[var(--k-ink-muted)]">
          <ImageSquare className="w-3 h-3" />
          <span>{inlineImageCount > 1 ? t('hud.photosCount', { count: inlineImageCount }) : t('dna.image')}</span>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {lines.map((line, idx) => {
        if (line.kind === 'task') {
          return (
            <div key={idx} className="flex items-start gap-1.5 text-[11.5px] leading-snug min-w-0">
              <span
                aria-hidden="true"
                className={`mt-[2px] w-3 h-3 rounded-[3px] border shrink-0 inline-flex items-center justify-center ${
                  line.done
                    ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                    : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)]'
                }`}
              >
                {line.done ? <Check weight="bold" className="w-2 h-2" /> : null}
              </span>
              <span
                className={`truncate ${
                  line.done
                    ? 'line-through text-[var(--k-ink-muted)]'
                    : 'text-[var(--k-ink-secondary)]'
                }`}
              >
                {line.text}
              </span>
            </div>
          );
        }
        if (line.kind === 'bullet') {
          return (
            <div key={idx} className="flex items-start gap-1.5 text-[11.5px] leading-snug min-w-0">
              <span
                aria-hidden="true"
                className="mt-[6px] w-1 h-1 rounded-full bg-[var(--k-accent)] shrink-0"
              />
              <span className="truncate text-[var(--k-ink-secondary)]">{line.text}</span>
            </div>
          );
        }
        return (
          <div key={idx} className="text-[11.5px] leading-snug text-[var(--k-ink-secondary)] truncate">
            {line.text}
          </div>
        );
      })}
    </div>
  );
};

/* ---------- Helper: Live 1-Click TOTP 2FA Copy Pill ---------- */

function formatTotpDisplay(code: string): string {
  const digits = code.replace(/\s+/g, '');
  if (digits.length === 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return digits;
}

interface HudTotpCopyPillProps {
  itemId: string;
  unlocked: boolean;
  wipeSeconds: number;
  onLocked: () => void;
}

const HudTotpCopyPill: React.FC<HudTotpCopyPillProps> = ({
  itemId,
  unlocked,
  wipeSeconds,
  onLocked,
}) => {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<TotpCodeSnapshot | null>(null);
  const [copiedJustNow, setCopiedJustNow] = useState(false);

  const fetchCode = useCallback(async () => {
    if (!unlocked) {
      setSnapshot(null);
      return;
    }
    try {
      const next = await window.kapsula.getTotpCode(itemId);
      setSnapshot(next);
    } catch {
      setSnapshot(null);
    }
  }, [itemId, unlocked]);

  useEffect(() => {
    if (!unlocked) {
      setSnapshot(null);
      return;
    }
    void fetchCode();
    const timer = window.setInterval(() => {
      setSnapshot((prev) => {
        if (!prev) return null;
        if (prev.remainingSec <= 1) {
          void fetchCode();
          return { ...prev, remainingSec: prev.period };
        }
        return { ...prev, remainingSec: prev.remainingSec - 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [unlocked, fetchCode]);

  const handleCopyTotp = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!unlocked) {
      onLocked();
      return;
    }
    try {
      const r = await window.kapsula.copySecretField(itemId, 'totp');
      if (r.locked) {
        onLocked();
        return;
      }
      if (r.ok) {
        setCopiedJustNow(true);
        const w = r.wipeSeconds ?? wipeSeconds;
        toast.success(
          w > 0 ? t('vault.totpCopiedWipe', { seconds: w }) : t('vault.totpCopied')
        );
        window.setTimeout(() => setCopiedJustNow(false), 1600);
      }
    } catch {
      toast.error(t('vault.totpCopyError'));
    }
  };

  const urgent = Boolean(snapshot && snapshot.remainingSec <= 5);

  return (
    <button
      type="button"
      data-testid="hud-totp-copy-btn"
      onClick={(e) => void handleCopyTotp(e)}
      title={t('vault.totpTitle')}
      className={`k-interactive k-mono k-tabular h-[28px] px-2.5 rounded-lg border text-[11.5px] font-medium inline-flex items-center gap-1.5 shrink-0 cursor-pointer select-none ${
        copiedJustNow
          ? 'bg-[var(--k-emerald-soft)] border-[var(--k-emerald)]/40 text-[var(--k-emerald)]'
          : 'bg-[var(--k-accent-soft)] border-[var(--k-accent)]/35 text-[var(--k-accent)] hover:bg-[var(--k-accent)] hover:text-[var(--k-ink-on-accent)]'
      }`}
    >
      {copiedJustNow ? (
        <>
          <Check weight="bold" className="w-3.5 h-3.5 shrink-0" />
          <span>{t('common.done')}</span>
        </>
      ) : unlocked && snapshot ? (
        <>
          <span className="tracking-[0.04em] font-semibold">
            {formatTotpDisplay(snapshot.code)}
          </span>
          <span
            className={`px-1 py-0.5 rounded text-[10px] leading-none font-semibold ${
              urgent
                ? 'bg-[var(--k-amber-soft)] text-[var(--k-amber)]'
                : 'bg-[var(--k-bg-surface-1)]/80 text-[var(--k-ink-secondary)]'
            }`}
          >
            {snapshot.remainingSec} {t('common.secUnit')}
          </span>
        </>
      ) : (
        <span>{t('vault.totpLabel')}</span>
      )}
    </button>
  );
};

/* ---------- Main Command HUD Surface ---------- */

export const CommandHudSurface: React.FC<CommandHudSurfaceProps> = ({
  settings,
  onSettingsUpdated,
}) => {
  const { t, locale, dateLocale } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const prefersReduced = useReducedMotion();
  const isMac = isMacPlatform(window.kapsula?.platform);
  const fallbackNoteTitleRef = useRef(t('dna.note'));
  fallbackNoteTitleRef.current = t('dna.note');
  const hudPlaceholderRef = useRef(isMac ? t('hud.pastedMac') : t('hud.pastedWin'));
  hudPlaceholderRef.current = isMac ? t('hud.pastedMac') : t('hud.pastedWin');

  useEffect(() => {
    hydrateAppearanceFromSettings(settings.appearance, settings.theme);
  }, [settings.appearance, settings.theme]);

  const [tabState, setTabState] = useState<{ active: HudTab; dir: number; instant: boolean }>({
    active: 'search',
    dir: 1,
    instant: false,
  });
  const tab = tabState.active;

  const [search, setSearch] = useState('');
  const [vaultSearch, setVaultSearch] = useState('');
  const [selectedValue, setSelectedValue] = useState('');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [allItems, setAllItems] = useState<VaultItem[]>([]);
  const [orbits, setOrbits] = useState<OrbitDef[]>([]);
  const [tasks, setTasks] = useState<VaultTaskEntry[]>([]);
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [clipPreview, setClipPreview] = useState<{ hasImage: boolean; text: string }>({
    hasImage: false,
    text: '',
  });

  // Right-pane live editor state
  const [editorTitle, setEditorTitle] = useState('');
  const [editorLiveBody, setEditorLiveBody] = useState('');
  const [editorSaveState, setEditorSaveState] = useState<'saved' | 'saving'>('saved');
  const [hudTranscribingId, setHudTranscribingId] = useState<string | null>(null);
  const [hudInsertingImage, setHudInsertingImage] = useState(false);
  const [hudPickingImage, setHudPickingImage] = useState(false);
  const [hudLightboxItem, setHudLightboxItem] = useState<VaultItem | null>(null);

  // Capture tab state
  const [draftText, setDraftText] = useState('');
  const [draftOrbit, setDraftOrbit] = useState('');
  const [captureOrbitMenuOpen, setCaptureOrbitMenuOpen] = useState(false);
  const captureOrbitMenuOpenRef = useRef(false);
  const [dismissedEventText, setDismissedEventText] = useState<string | null>(null);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [savingCapture, setSavingCapture] = useState(false);
  const [todayQuickTask, setTodayQuickTask] = useState('');

  // Vault PIN & Biometric state inside HUD
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [unlockingPin, setUnlockingPin] = useState(false);
  const [unlockingBiometric, setUnlockingBiometric] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const captureInputRef = useRef<HTMLTextAreaElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const hudTitleRef = useRef<HTMLTextAreaElement | null>(null);
  const hudImageInputRef = useRef<HTMLInputElement | null>(null);
  const [hudEditorHostEl, setHudEditorHostEl] = useState<HTMLDivElement | null>(null);

  const searchRef = useRef(search);
  searchRef.current = search;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;

  // Editor autosave refs (race-free flush + self-overwrite protection)
  const editorItemIdRef = useRef<string | null>(null);
  const editorTitleRef = useRef('');
  const editorBodyRef = useRef('');
  const dirtyItemIdRef = useRef<string | null>(null);
  const savingItemIdRef = useRef<string | null>(null);
  const loadingEditorRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const activeItem = useMemo(() => {
    if (!selectedValue.startsWith('item:')) return null;
    const id = selectedValue.slice(5).toLowerCase();
    return items.find((i) => i.id.toLowerCase() === id) ?? null;
  }, [items, selectedValue]);

  const activeItemRef = useRef<VaultItem | null>(activeItem);
  activeItemRef.current = activeItem;

  const shouldProtectHud = Boolean(
    settings.enableScreenProtection !== false &&
      (tab === 'vault' || (tab === 'search' && activeItem?.dna === 'secret'))
  );
  const shouldProtectHudRef = useRef(shouldProtectHud);
  shouldProtectHudRef.current = shouldProtectHud;

  const patchLocalItem = useCallback((updated: VaultItem) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    setAllItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
  }, []);

  const flushHudEditorSave = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const targetId = dirtyItemIdRef.current;
    if (!targetId) {
      if (!savingItemIdRef.current) setEditorSaveState('saved');
      return;
    }

    // Snapshot & clear dirty synchronously so fast switching never double-saves or contaminates
    dirtyItemIdRef.current = null;
    savingItemIdRef.current = targetId;
    const nextTitle = editorTitleRef.current.trim();
    const nextBody = editorBodyRef.current;
    const fallbackTitle =
      itemsRef.current.find((i) => i.id === targetId)?.title ||
      allItemsRef.current.find((i) => i.id === targetId)?.title ||
      fallbackNoteTitleRef.current;

    try {
      const updated = await window.kapsula.updateItem(targetId, {
        title: nextTitle || fallbackTitle,
        body: nextBody,
      });
      const stillSameAndTyped =
        editorItemIdRef.current === targetId &&
        (editorTitleRef.current.trim() !== nextTitle || editorBodyRef.current !== nextBody);

      if (updated) {
        patchLocalItem(updated);
      }

      if (stillSameAndTyped) {
        dirtyItemIdRef.current = targetId;
        setEditorSaveState('saving');
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          void flushHudEditorSave();
        }, 300);
      }
    } catch {
      // ignore transient save errors
    } finally {
      if (savingItemIdRef.current === targetId) {
        savingItemIdRef.current = null;
      }
      if (!dirtyItemIdRef.current) {
        setEditorSaveState('saved');
      }
    }
  }, [patchLocalItem]);

  const flushHudEditorSaveRef = useRef(flushHudEditorSave);
  flushHudEditorSaveRef.current = flushHudEditorSave;

  const setTab = useCallback((next: HudTab, instant = false) => {
    void flushHudEditorSaveRef.current();
    setTabState((prev) => {
      if (prev.active === next) return prev;
      const fromIdx = HUD_TAB_ORDER.indexOf(prev.active);
      const toIdx = HUD_TAB_ORDER.indexOf(next);
      return { active: next, dir: toIdx >= fromIdx ? 1 : -1, instant };
    });
  }, []);

  const openHudLightboxRef = useRef<(info: KapsulaImageLightboxInfo) => void>(() => {});
  openHudLightboxRef.current = (info) => {
    const cur = activeItemRef.current;
    if (!cur) return;
    setHudLightboxItem({
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

  const navigateHudWikiRef = useRef<(linkTitle: string, targetId?: string | null) => void>(() => {});
  navigateHudWikiRef.current = (linkTitle, targetId) => {
    const lower = linkTitle.trim().toLowerCase();
    const target =
      (targetId ? allItemsRef.current.find((c) => c.id === targetId) : undefined) ??
      allItemsRef.current.find((c) => c.title.trim().toLowerCase() === lower);
    if (!target) {
      toast.info(tRef.current('note.studio.notFoundLink', { title: linkTitle }));
      return;
    }
    void flushHudEditorSaveRef.current();
    if (itemsRef.current.some((it) => it.id === target.id)) {
      setSelectedValue(`item:${target.id.toLowerCase()}`);
    } else {
      void window.kapsula.focusVaultItem(target.id);
      void window.kapsula.closeHud();
    }
  };

  const hudInsertImagesRef = useRef<(files: File[], insertPos?: number | null) => Promise<void>>(
    async () => {}
  );

  const hudEditor = useEditor({
    extensions: [
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
      TaskItem.configure({
        nested: true,
      }),
      Typography,
      Highlight,
      Placeholder.configure({
        placeholder: () => hudPlaceholderRef.current,
      }),
      KapsulaImage.configure({
        compact: true,
        onOpenLightbox: (info) => openHudLightboxRef.current(info),
      }),
      WikiLink.configure({
        onNavigate: (linkTitle, targetId) => navigateHudWikiRef.current(linkTitle, targetId),
      }),
    ],
    content: '',
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'k-prose k-prose-hud min-h-[120px] pb-6',
        'data-testid': 'hud-right-editor',
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
        void hudInsertImagesRef.current(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = extractImageFilesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void hudInsertImagesRef.current(files, coords?.pos ?? null);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (loadingEditorRef.current) return;
      const curId = editorItemIdRef.current;
      if (!curId) return;
      const md = ed.getMarkdown();
      editorBodyRef.current = md;
      setEditorLiveBody(md);
      dirtyItemIdRef.current = curId;
      setEditorSaveState('saving');
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void flushHudEditorSaveRef.current();
      }, 350);
    },
  });

  hudInsertImagesRef.current = async (files, insertPos) => {
    if (!hudEditor || files.length === 0) return;
    const count = await saveAndInsertImageFiles(hudEditor, files, {
      insertPos,
      onBeforeSave: () => setHudInsertingImage(true),
      onAfterSave: () => setHudInsertingImage(false),
    });
    if (count > 0) {
      toast.success(
        count === 1
          ? tRef.current('hud.photoAddedOne')
          : tRef.current('hud.photoAddedMany', { count })
      );
    }
  };

  useEffect(() => {
    if (hudEditor && !hudEditor.isDestroyed) {
      hudEditor.view.dispatch(hudEditor.state.tr);
    }
  }, [hudEditor, locale]);

  const hudToolbarState = useEditorState({
    editor: hudEditor,
    selector: (ctx) => ({
      h2: ctx.editor?.isActive('heading', { level: 2 }) ?? false,
      bullet: ctx.editor?.isActive('bulletList') ?? false,
      task: ctx.editor?.isActive('taskList') ?? false,
      canUndo: ctx.editor?.can().undo() ?? false,
      canRedo: ctx.editor?.can().redo() ?? false,
    }),
  });

  // Load/switch active item into HUD right-pane TipTap editor
  useEffect(() => {
    const prevId = editorItemIdRef.current;
    const nextItem = activeItem && activeItem.dna !== 'secret' ? activeItem : null;
    const nextId = nextItem?.id ?? null;

    if (prevId && prevId !== nextId && dirtyItemIdRef.current === prevId) {
      void flushHudEditorSave();
    }

    if (!nextItem) {
      editorItemIdRef.current = null;
      return;
    }

    const isSwitched = prevId !== nextId;
    if (!isSwitched) {
      // Same item updated externally: never overwrite while user is typing or save is in-flight
      if (dirtyItemIdRef.current === nextId || savingItemIdRef.current === nextId) return;
      const extTitle = nextItem.title || '';
      if (extTitle !== editorTitleRef.current) {
        setEditorTitle(extTitle);
        editorTitleRef.current = extTitle;
      }
      const extBody = nextItem.body || '';
      if (hudEditor && extBody !== editorBodyRef.current) {
        editorBodyRef.current = extBody;
        setEditorLiveBody(extBody);
        loadingEditorRef.current = true;
        hudEditor.commands.setContent(extBody, { contentType: 'markdown', emitUpdate: false });
        window.setTimeout(() => {
          loadingEditorRef.current = false;
        }, 12);
      }
      return;
    }

    editorItemIdRef.current = nextId;
    const initTitle = nextItem.title || '';
    const initBody = nextItem.body || '';
    setEditorTitle(initTitle);
    editorTitleRef.current = initTitle;
    editorBodyRef.current = initBody;
    setEditorLiveBody(initBody);
    setEditorSaveState('saved');

    if (hudEditor) {
      loadingEditorRef.current = true;
      hudEditor.commands.setContent(initBody, { contentType: 'markdown', emitUpdate: false });
      window.setTimeout(() => {
        loadingEditorRef.current = false;
      }, 12);
    }
  }, [activeItem, hudEditor, flushHudEditorSave]);

  useLayoutEffect(() => {
    const el = hudTitleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editorTitle, activeItem?.id]);

  // Flush editor save on window blur (e.g. clicking away from HUD)
  useEffect(() => {
    const onBlur = () => {
      void flushHudEditorSaveRef.current();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const loadHudData = useCallback(async (searchQuery = '') => {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = startOfDay.getTime() + 86_400_000;
      const trimmedSearch = searchQuery.trim();

      const [fetchedSearch, fetchedAll, fetchedOrbits, fetchedTasks, fetchedEvents, clip] =
        await Promise.all([
          window.kapsula.queryVault({
            includeArchived: false,
            includeSecrets: true,
            search: trimmedSearch || undefined,
            limit: 120,
          }),
          trimmedSearch
            ? window.kapsula.queryVault({
                includeArchived: false,
                includeSecrets: true,
                limit: 120,
              })
            : Promise.resolve(null),
          window.kapsula.listOrbits(),
          window.kapsula.listTasks(),
          window.kapsula.listCalendarEvents({ startAt: startOfDay.getTime(), endAt: endOfDay }),
          window.kapsula.getHudClipboardPreview().catch(() => ({ hasImage: false, text: '' })),
        ]);
      setItems(fetchedSearch);
      setAllItems(fetchedAll ?? fetchedSearch);
      setOrbits(fetchedOrbits);
      setTasks(fetchedTasks);
      setTodayEvents(fetchedEvents);
      setClipPreview(clip);
    } catch {
      // ignore transient startup races
    }
  }, []);

  useEffect(() => {
    void loadHudData('');
    const unsubs = [
      window.kapsula.onHudOpened(() => {
        void flushHudEditorSaveRef.current();
        setSearch('');
        setVaultSearch('');
        setSelectedValue('');
        searchRef.current = '';
        setRecordingVoice(false);
        setCaptureOrbitMenuOpen(false);
        captureOrbitMenuOpenRef.current = false;
        setHudPickingImage(false);
        setHudLightboxItem(null);
        void window.kapsula.setHudPreventClose(false);
        void window.kapsula.setScreenProtection?.(shouldProtectHudRef.current);
        void loadHudData('');
        window.setTimeout(() => {
          if (tabRef.current === 'search') searchInputRef.current?.focus();
          else if (tabRef.current === 'capture') captureInputRef.current?.focus();
        }, 20);
      }),
      window.kapsula.onVaultItemUpserted(() => void loadHudData(searchRef.current)),
      window.kapsula.onVaultItemDeleted(() => void loadHudData(searchRef.current)),
      window.kapsula.onVaultBatchSynced(() => void loadHudData(searchRef.current)),
      window.kapsula.onOrbitsChanged(() => void loadHudData(searchRef.current)),
      window.kapsula.onCalendarChanged(() => void loadHudData(searchRef.current)),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }, [loadHudData]);

  // Bilingual RU↔EN backend query on typing
  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadHudData(search);
    }, 80);
    return () => window.clearTimeout(t);
  }, [search, loadHudData]);

  // Refresh HUD vault items whenever PIN state or lock status changes so secret subtitles never show stale lock messages
  useEffect(() => {
    void loadHudData(searchRef.current);
  }, [settings.hasMasterPin, settings.vaultUnlocked, loadHudData]);

  // Keep current selection stable across autosave refreshes; only auto-select first when selection is missing
  useEffect(() => {
    if (tab !== 'search') return;
    if (items.length === 0) {
      setSelectedValue('cmd:new-note');
      return;
    }
    setSelectedValue((prev) => {
      if (
        prev.startsWith('item:') &&
        items.some((it) => it.id.toLowerCase() === prev.slice(5).toLowerCase())
      ) {
        return prev;
      }
      return `item:${items[0]!.id.toLowerCase()}`;
    });
  }, [items, tab]);

  const activeParsedEvent = useMemo(() => {
    const clean = draftText.trim();
    if (clean.length < 5 || /^https?:\/\/\S+$/i.test(clean) || dismissedEventText === clean) {
      return null;
    }
    const parsed = parseRussianEvent(clean, Date.now(), undefined, locale);
    return parsed?.isEventIntent ? parsed : null;
  }, [draftText, dismissedEventText, locale]);

  // Engage screen protection ONLY when HUD is viewing Vault tab or a secret in Search tab
  useEffect(() => {
    void window.kapsula.setScreenProtection?.(shouldProtectHud);
    return () => {
      void window.kapsula.setScreenProtection?.(false);
    };
  }, [shouldProtectHud]);

  // Keep HUD open while recording voice, typing PIN, prompting Touch ID, picking an image, or transcribing
  useEffect(() => {
    void window.kapsula.setHudPreventClose(
      recordingVoice ||
        unlockingPin ||
        unlockingBiometric ||
        hudPickingImage ||
        hudTranscribingId !== null
    );
  }, [recordingVoice, unlockingPin, unlockingBiometric, hudPickingImage, hudTranscribingId]);

  const handleHudPasteBack = useCallback(async (target: VaultItem) => {
    await flushHudEditorSaveRef.current();
    const isCurrentEdited = editorItemIdRef.current === target.id;
    const latestBody = isCurrentEdited ? editorBodyRef.current : target.body;
    const latestTitle = isCurrentEdited ? editorTitleRef.current : target.title;
    const payload = target.url || latestBody || latestTitle;
    const pasted = await window.kapsula.pasteBackFromHud(payload, false);
    if (!pasted && isMacPlatform(window.kapsula?.platform)) {
      toast.info(t('hud.accessibilityHint'));
    }
  }, [t]);

  // Crisp Focus State Machine & Global HUD Shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inRightPane = Boolean(
        rightPaneRef.current &&
          document.activeElement &&
          rightPaneRef.current.contains(document.activeElement)
      );

      if (e.key === 'Escape') {
        if (hudLightboxItem) {
          e.preventDefault();
          setHudLightboxItem(null);
          return;
        }
        if (captureOrbitMenuOpenRef.current) {
          e.preventDefault();
          return;
        }
        if (recordingVoice) {
          e.preventDefault();
          setRecordingVoice(false);
          return;
        }
        if (tab === 'search' && inRightPane) {
          e.preventDefault();
          e.stopPropagation();
          void flushHudEditorSaveRef.current();
          searchInputRef.current?.focus();
          return;
        }
        e.preventDefault();
        void window.kapsula.setScreenProtection?.(false);
        void flushHudEditorSaveRef.current().finally(() => {
          void window.kapsula.closeHud();
        });
        return;
      }

      // Tab from search bar jumps straight into right-pane live editor
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        tab === 'search' &&
        !inRightPane &&
        activeItem &&
        activeItem.dna !== 'secret' &&
        hudEditor
      ) {
        e.preventDefault();
        hudEditor.commands.focus('end');
        return;
      }

      if ((e.ctrlKey || e.metaKey) && ['1', '2', '3', '4', '5'].includes(e.key)) {
        e.preventDefault();
        const map: Record<string, HudTab> = {
          '1': 'search',
          '2': 'capture',
          '3': 'vault',
          '4': 'today',
          '5': 'important',
        };
        const nextTab = map[e.key];
        if (nextTab) setTab(nextTab, true);
        return;
      }
    };

    // Intercept Ctrl/Cmd+Enter in capture phase BEFORE cmdk's Enter handler can hijack it and close the HUD
    const onKeyCapture = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'Enter' &&
        tab === 'search' &&
        selectedValue.startsWith('item:')
      ) {
        e.preventDefault();
        e.stopPropagation();
        const targetKey = selectedValue.slice(5).toLowerCase();
        const target = items.find((i) => i.id.toLowerCase() === targetKey);
        if (!target) return;
        if (target.dna === 'secret') {
          if (settings.hasMasterPin && !settings.vaultUnlocked) {
            setTab('vault', true);
            return;
          }
          void window.kapsula.copySecret(target.id).then((res) => {
            if (res.ok) {
              toast.success(
                res.wipeSeconds > 0
                  ? t('hud.copiedWipe', { seconds: res.wipeSeconds })
                  : t('common.copied')
              );
              void window.kapsula.closeHud();
            }
          });
        } else {
          void handleHudPasteBack(target);
        }
      }
    };

    window.addEventListener('keydown', onKeyCapture, { capture: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, { capture: true });
      window.removeEventListener('keydown', onKey);
    };
  }, [
    items,
    selectedValue,
    tab,
    recordingVoice,
    hudLightboxItem,
    activeItem,
    hudEditor,
    setTab,
    handleHudPasteBack,
    settings.hasMasterPin,
    settings.vaultUnlocked,
  ]);

  const handleHudTitleChange = (val: string) => {
    const clean = val.replace(/\r?\n/g, ' ');
    setEditorTitle(clean);
    editorTitleRef.current = clean;
    const curId = editorItemIdRef.current;
    if (!curId) return;
    dirtyItemIdRef.current = curId;
    setEditorSaveState('saving');
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushHudEditorSaveRef.current();
    }, 350);
  };

  const handleHudTranscribeVoice = async (target: VaultItem) => {
    if (!target.mediaPath || hudTranscribingId) return;
    setHudTranscribingId(target.id);
    try {
      const res = await transcribeItemWithWavFallback(target);
      if (!res.ok) {
        toast.error(
          res.error || t('cards.transcribeFailed')
        );
        return;
      }
      const nextBody = res.item?.body || res.transcript || '';
      if (res.item) patchLocalItem(res.item);
      if (editorItemIdRef.current === target.id && hudEditor && nextBody) {
        loadingEditorRef.current = true;
        hudEditor.commands.setContent(nextBody, { contentType: 'markdown', emitUpdate: false });
        loadingEditorRef.current = false;
        editorBodyRef.current = nextBody;
        setEditorLiveBody(nextBody);
        if (res.item?.title) {
          setEditorTitle(res.item.title);
          editorTitleRef.current = res.item.title;
        }
        dirtyItemIdRef.current = null;
        setEditorSaveState('saved');
      }
      toast.success(t('cards.transcribed'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('cards.transcribeFailed'), locale));
    } finally {
      setHudTranscribingId(null);
    }
  };

  const allSecretItems = useMemo(
    () => allItems.filter((i) => i.dna === 'secret').slice(0, 60),
    [allItems]
  );

  const secretItems = useMemo(() => {
    const q = vaultSearch.trim().toLowerCase();
    if (!q) return allSecretItems.slice(0, 30);
    return allSecretItems
      .filter((sec) => {
        const hay = [
          sec.title,
          sec.secretMeta?.service,
          sec.secretMeta?.loginHint,
          sec.secretMeta?.cardBrand,
          sec.secretMeta?.last4,
          sec.summary,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 30);
  }, [allSecretItems, vaultSearch]);

  const pinnedItems = useMemo(
    () => allItems.filter((i) => i.isPinned && i.dna !== 'secret').slice(0, 20),
    [allItems]
  );

  const openTasks = useMemo(
    () => tasks.filter((t) => !t.done).slice(0, 20),
    [tasks]
  );

  const tasksCountByItemId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      counts.set(task.itemId, (counts.get(task.itemId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  const todayScheduleEntries = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const endMs = startMs + 86_400_000;
    const linkedIds = new Set(
      todayEvents.map((ev) => ev.linkedItemId).filter((id): id is string => Boolean(id))
    );
    const merged: Array<{
      id: string;
      title: string;
      color: string;
      startAt: number;
      allDay: boolean;
      linkedItemId: string | null;
    }> = todayEvents.map((ev) => ({
      id: ev.id,
      title: ev.title,
      color: ev.color || 'var(--k-accent)',
      startAt: ev.startAt,
      allDay: ev.allDay,
      linkedItemId: ev.linkedItemId ?? null,
    }));
    for (const item of allItems) {
      if (
        item.remindAt !== null &&
        item.remindAt >= startMs &&
        item.remindAt < endMs &&
        !linkedIds.has(item.id)
      ) {
        merged.push({
          id: `rem-${item.id}`,
          title: item.title || t('cal.kind.reminder'),
          color: 'var(--k-amber)',
          startAt: item.remindAt,
          allDay: false,
          linkedItemId: item.id,
        });
      }
    }
    return merged.sort((a, b) => a.startAt - b.startAt);
  }, [todayEvents, allItems]);

  const isVaultLocked = Boolean(settings.hasMasterPin && !settings.vaultUnlocked);

  const handleSaveCapture = async () => {
    const clean = draftText.trim();
    if (!clean || savingCapture) return;
    setSavingCapture(true);
    try {
      const isUrlOnly = /^https?:\/\/\S+$/i.test(clean);
      const isDismissed = dismissedEventText === clean;
      const item = await window.kapsula.capture({
        text: clean,
        url: isUrlOnly ? clean : undefined,
        orbitOverride: draftOrbit || undefined,
        remindAt: activeParsedEvent?.startAt ?? null,
        skipAutoCalendar: isDismissed || undefined,
        calendarEventOverride:
          activeParsedEvent && !isUrlOnly && !isDismissed ? activeParsedEvent : undefined,
        source: 'hud',
      });
      setDraftText('');
      setDismissedEventText(null);
      toast.success(
        activeParsedEvent && !isUrlOnly && !isDismissed && item.dna !== 'secret'
          ? t('hud.savedWithCalendar')
          : t('hud.savedToKapsula')
      );
      await loadHudData(search);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('composer.saveFailed'), locale));
    } finally {
      setSavingCapture(false);
    }
  };

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinInput.trim() || unlockingPin) return;
    setUnlockingPin(true);
    setPinError(null);
    try {
      const ok = await window.kapsula.unlockVaultPin(pinInput.trim());
      if (ok) {
        setPinInput('');
        toast.success(t('pin.unlockedHud'));
        const fresh = await window.kapsula.getSettings();
        onSettingsUpdated(fresh);
        void loadHudData(searchRef.current);
      } else {
        setPinError(t('pin.wrongDot'));
      }
    } catch (err) {
      setPinError(friendlyErrorMessage(err, t('pin.verifyFailed'), locale));
    } finally {
      setUnlockingPin(false);
    }
  };

  const handleUnlockBiometric = async () => {
    if (unlockingBiometric || unlockingPin) return;
    setUnlockingBiometric(true);
    setPinError(null);
    await window.kapsula.setHudPreventClose(true);
    try {
      const res = await window.kapsula.promptBiometricUnlock();
      if (res.ok) {
        setPinInput('');
        toast.success(t('pin.unlockedHud'));
        const fresh = await window.kapsula.getSettings();
        onSettingsUpdated(fresh);
        void loadHudData(searchRef.current);
      } else if (res.error) {
        setPinError(res.error);
      }
    } catch (err) {
      setPinError(friendlyErrorMessage(err, t('pin.bioFailed'), locale));
    } finally {
      setUnlockingBiometric(false);
    }
  };

  const tabOptions = [
    { value: 'search' as HudTab, label: t('hud.tab.search'), icon: <MagnifyingGlass className="w-3.5 h-3.5" /> },
    { value: 'capture' as HudTab, label: t('hud.tab.capture'), icon: <NotePencil className="w-3.5 h-3.5" /> },
    { value: 'vault' as HudTab, label: t('hud.tab.vault'), icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { value: 'today' as HudTab, label: t('hud.tab.today'), icon: <CalendarBlank className="w-3.5 h-3.5" /> },
    { value: 'important' as HudTab, label: t('hud.tab.important'), icon: <Star className="w-3.5 h-3.5" /> },
  ];

  const renderSecretQuickPills = (item: VaultItem) => {
    const kind = item.secretMeta?.kind;
    const isCard = kind === 'bank_card';
    const defaultLabel = isCard
      ? t('secret.sheet.cardNumberLabel')
      : kind === 'api_key'
        ? t('vault.keyLabel')
        : kind === 'seed'
          ? t('vault.phraseLabel')
          : kind === 'note'
            ? t('vault.noteLabel')
            : t('vault.passwordLabel');
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
        {item.secretMeta?.hasTotp ? (
          <HudTotpCopyPill
            itemId={item.id}
            unlocked={!isVaultLocked}
            wipeSeconds={settings.clipboardAutoWipeSeconds ?? 30}
            onLocked={() => setTab('vault')}
          />
        ) : null}
        <CopySlotPill
          label={defaultLabel}
          copiedLabel={t('common.done')}
          wipeSeconds={settings.clipboardAutoWipeSeconds ?? 30}
          tone="default"
          widthPx={isCard ? 128 : 124}
          heightPx={28}
          onCopy={async () => {
            const r = await window.kapsula.copySecretField(item.id, 'secretValue');
            if (r.locked) {
              setTab('vault');
              return false;
            }
            const w = r.wipeSeconds ?? settings.clipboardAutoWipeSeconds ?? 30;
            return r.ok ? (w > 0 ? w : true) : false;
          }}
        />
        {isCard && item.secretMeta?.expiry ? (
          <CopySlotPill
            label={item.secretMeta.expiry}
            copiedLabel={t('common.done')}
            widthPx={86}
            heightPx={28}
            onCopy={async () => {
              const r = await window.kapsula.copySecretField(item.id, 'expiry');
              if (r.locked) {
                setTab('vault');
                return false;
              }
              if (r.ok) toast.success(t('vault.cardExpiryCopied'));
              return r.ok;
            }}
          />
        ) : null}
        {isCard && item.secretMeta?.hasCvv ? (
          <CopySlotPill
            label="CVV"
            copiedLabel={t('common.done')}
            wipeSeconds={settings.clipboardAutoWipeSeconds ?? 30}
            widthPx={98}
            heightPx={28}
            onCopy={async () => {
              const r = await window.kapsula.copySecretField(item.id, 'cvv');
              if (r.locked) {
                setTab('vault');
                return false;
              }
              const w = r.wipeSeconds ?? settings.clipboardAutoWipeSeconds ?? 30;
              return r.ok ? (w > 0 ? w : true) : false;
            }}
          />
        ) : null}
        {!isCard && item.secretMeta?.hasLogin ? (
          <CopySlotPill
            label={t('vault.login')}
            copiedLabel={t('common.done')}
            widthPx={90}
            heightPx={28}
            onCopy={async () => {
              const r = await window.kapsula.copySecretField(item.id, 'login');
              if (r.locked) {
                setTab('vault');
                return false;
              }
              return r.ok;
            }}
          />
        ) : null}
      </div>
    );
  };

  const activeVoiceEmptyTranscript = Boolean(
    activeItem &&
      activeItem.dna === 'voice' &&
      activeItem.mediaPath &&
      !(editorLiveBody || activeItem.mediaMeta?.transcript || '').trim()
  );

  return (
    <div data-testid="command-hud" className="w-full h-full p-4 bg-transparent">
      {/* Hidden file picker for HUD inline images */}
      <input
        ref={hudImageInputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="hud-image-file-input"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          setHudPickingImage(false);
          if (picked.length > 0) {
            void hudInsertImagesRef.current(picked);
          }
        }}
      />

      {/* 100% Solid Opaque Outer HUD Shell (zero bleed-through from background windows) */}
      <div className="w-full h-full flex flex-col rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-canvas)] text-[var(--k-ink-primary)] shadow-[var(--k-shadow-hud)] overflow-hidden">
        {/* Top Bar: Symmetric 3-column grid keeps 5 Navigation Tabs dead-center */}
        <div className="k-drag-region grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-2.5 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] shrink-0">
          <div className="justify-self-start flex items-center gap-2 shrink-0">
            <KapsulaEmblem size={20} />
            <span className="text-[12.5px] font-semibold tracking-tight text-[var(--k-ink-primary)]">
              Kapsula
            </span>
          </div>

          <div className="k-no-drag justify-self-center">
            <SegmentedControl<HudTab>
              value={tab}
              onChange={(next) => {
                setTab(next, false);
                window.setTimeout(() => {
                  if (next === 'search') searchInputRef.current?.focus();
                  if (next === 'capture') captureInputRef.current?.focus();
                }, 30);
              }}
              options={tabOptions}
              size="sm"
            />
          </div>

          <div className="k-no-drag justify-self-end flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                void flushHudEditorSave().finally(() => {
                  void window.kapsula.windowAction('open-vault');
                  void window.kapsula.closeHud();
                });
              }}
              className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <ArrowSquareOut className="w-3.5 h-3.5" />
              {t('hud.windowBtn')}
            </button>
            <button
              type="button"
              onClick={() => {
                void flushHudEditorSave().finally(() => {
                  void window.kapsula.closeHud();
                });
              }}
              className="k-interactive k-mono text-[10.5px] text-[var(--k-ink-muted)] px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              Esc
            </button>
          </div>
        </div>

        {/* Body per Tab (GPU translate3d pane transitions; instant on Ctrl+1..5 shortcuts) */}
        <div className="relative flex-1 min-h-0 overflow-hidden bg-[var(--k-bg-canvas)]">
          <AnimatePresence
            initial={false}
            custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
          >
            {tab === 'search' ? (
              <motion.div
                key="tab-search"
                custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
                variants={HUD_TAB_SLIDE_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  tabState.instant || prefersReduced
                    ? { duration: 0 }
                    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }
                }
                className="absolute inset-0 flex overflow-hidden"
              >
                {/* Left Column: cmdk wraps ONLY search input + results list */}
                <div className="w-[310px] shrink-0 border-r border-[var(--k-border-hairline)] bg-[var(--k-bg-canvas)] flex flex-col overflow-hidden">
                  <Command
                    shouldFilter={false}
                    value={selectedValue}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                    onValueChange={(nextVal) => {
                      if (nextVal !== selectedValue) {
                        void flushHudEditorSave();
                        setSelectedValue(nextVal);
                      }
                    }}
                    className="flex-1 min-h-0 flex flex-col overflow-hidden"
                  >
                    <div className="flex items-center gap-2 px-3.5 h-11 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] shrink-0">
                      <MagnifyingGlass className="w-4 h-4 text-[var(--k-ink-muted)] shrink-0" />
                      <Command.Input
                        ref={searchInputRef}
                        data-testid="hud-search-input"
                        autoFocus
                        value={search}
                        onValueChange={setSearch}
                        placeholder={t('hud.searchPlaceholder')}
                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
                      />
                    </div>

                    <Command.List
                      style={{
                        maskImage:
                          'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
                        WebkitMaskImage:
                          'linear-gradient(to bottom, #000 calc(100% - 14px), transparent 100%)',
                      }}
                      className="flex-1 min-h-0 overflow-y-auto px-2 pt-2 pb-4 flex flex-col gap-1 bg-[var(--k-bg-canvas)]"
                    >
                      {items.length > 0 ? (
                        <Command.Group
                          heading={search.trim() ? t('hud.foundCount', { count: items.length }) : t('hud.recentItems')}
                          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-[var(--k-ink-muted)]"
                        >
                          {items.slice(0, 35).map((item) => {
                            const rowIcon =
                              item.dna === 'secret' ? (
                                <ShieldCheck
                                  weight="fill"
                                  className="w-3.5 h-3.5 text-[var(--k-emerald)] shrink-0"
                                />
                              ) : item.dna === 'link' ? (
                                <GlobeSimple
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0"
                                />
                              ) : item.dna === 'shot' ? (
                                <ImageSquare
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-info)] shrink-0"
                                />
                              ) : item.dna === 'voice' ? (
                                <Microphone
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0"
                                />
                              ) : item.dna === 'snippet' ? (
                                <Code
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-violet)] shrink-0"
                                />
                              ) : item.dna === 'doc' ? (
                                <FileText
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-amber)] shrink-0"
                                />
                              ) : (
                                <NotePencil
                                  weight="duotone"
                                  className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0"
                                />
                              );
                            const rowValue = `item:${item.id.toLowerCase()}`;
                            const isRowSelected = selectedValue.toLowerCase() === rowValue;
                            return (
                              <Command.Item
                                key={item.id}
                                value={rowValue}
                                data-active={isRowSelected ? 'true' : undefined}
                                onSelect={() => {
                                  void flushHudEditorSave().finally(() => {
                                    void window.kapsula.focusVaultItem(item.id);
                                    void window.kapsula.closeHud();
                                  });
                                }}
                                className={`flex items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] cursor-pointer transition-colors duration-[90ms] ${
                                  isRowSelected
                                    ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                                    : 'hover:bg-[var(--k-bg-surface-2)]/70 aria-selected:bg-[var(--k-accent-soft)] aria-selected:text-[var(--k-accent)]'
                                }`}
                              >
                                <span className="inline-flex items-center gap-2 min-w-0">
                                  {rowIcon}
                                  <span className="truncate font-medium">
                                    {item.title || getDnaHumanLabel(item, locale)}
                                  </span>
                                </span>
                                <span className="text-[10.5px] text-[var(--k-ink-muted)] shrink-0">
                                  {getDnaHumanLabel(item, locale)}
                                </span>
                              </Command.Item>
                            );
                          })}
                        </Command.Group>
                      ) : (
                        <div className="px-3 py-6 text-center text-[12px] text-[var(--k-ink-muted)]">
                          {t('hud.nothingFound')}
                        </div>
                      )}
                    </Command.List>
                  </Command>

                  {/* Docked Quick Actions Footer (100% solid opaque surface) */}
                  <div className="shrink-0 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] p-2 flex flex-col gap-0.5">
                    <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      {t('hud.actionsHeading')}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void flushHudEditorSave().finally(() => {
                          void window.kapsula.windowAction('open-vault-new-note');
                          void window.kapsula.closeHud();
                        });
                      }}
                      className="k-interactive flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--k-ink-primary)] hover:bg-[var(--k-accent-soft)] hover:text-[var(--k-accent)] text-left cursor-pointer"
                    >
                      <NotePencil
                        weight="duotone"
                        className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0"
                      />
                      <span>{t('hud.newNoteInEditor')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await window.kapsula.captureClipboard();
                        toast.success(t('workspace.toast.pastedClipboard'));
                        await loadHudData(search);
                      }}
                      className="k-interactive flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--k-ink-primary)] hover:bg-[var(--k-accent-soft)] hover:text-[var(--k-accent)] text-left cursor-pointer"
                    >
                      <ClipboardText
                        weight="duotone"
                        className="w-3.5 h-3.5 text-[var(--k-ink-secondary)] shrink-0"
                      />
                      <span>{t('workspace.pasteClipboard')}</span>
                    </button>
                  </div>
                </div>

                {/* Right Pane: OUTSIDE <Command> so cmdk NEVER hijacks ArrowUp/ArrowDown/Enter! */}
                <div
                  ref={rightPaneRef}
                  data-testid="hud-right-pane"
                  className="flex-1 min-w-0 bg-[var(--k-bg-surface-1)] flex flex-col overflow-hidden"
                >
                  {activeItem ? (
                    activeItem.dna === 'secret' ? (
                      <div className="flex-1 min-h-0 flex flex-col justify-between p-4 overflow-y-auto">
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--k-ink-muted)]">
                            <span className="px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] font-medium">
                              {getDnaHumanLabel(activeItem, locale)}
                            </span>
                            <span>
                              {formatRelativeDate(
                                activeItem.contentUpdatedAt || activeItem.createdAt,
                                locale
                              )}
                            </span>
                          </div>

                          <div className="text-[16px] font-semibold leading-snug text-[var(--k-ink-primary)]">
                            {activeItem.title || getDnaHumanLabel(activeItem, locale)}
                          </div>

                          {isVaultLocked ? (
                            <div
                              data-testid="hud-search-secret-locked"
                              className="flex flex-col items-start gap-3 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] p-4"
                            >
                              <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--k-ink-primary)]">
                                <LockKey weight="fill" className="w-4 h-4 text-[var(--k-amber)] shrink-0" />
                                <span>{t('hud.vaultLockedHeading')}</span>
                              </div>
                              <div className="text-[12px] text-[var(--k-ink-secondary)] leading-relaxed">
                                {t('hud.vaultLockedSub')}
                              </div>
                              <button
                                type="button"
                                onClick={() => setTab('vault')}
                                className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                              >
                                {t('vault.unlockButton')}
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3.5">
                              <div className="flex items-center gap-2 text-[12.5px] text-[var(--k-emerald)]">
                                <ShieldCheck weight="fill" className="w-4 h-4 shrink-0" />
                                <span>
                                  {activeItem.secretMeta?.kind === 'bank_card'
                                    ? [
                                        activeItem.secretMeta.loginHint || t('vault.type.bank_card'),
                                        activeItem.secretMeta.expiry
                                          ? t('secret.sheet.expiryField', { value: activeItem.secretMeta.expiry })
                                          : t('vault.cardNoExpiry'),
                                      ].join(' · ')
                                    : t('hud.vaultItemLabel', { hint: activeItem.secretMeta?.loginHint || t('dna.vault') })}
                                </span>
                              </div>
                              {renderSecretQuickPills(activeItem)}
                            </div>
                          )}
                        </div>

                        <div className="pt-3 mt-3 border-t border-[var(--k-border-hairline)] flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void window.kapsula.focusVaultItem(activeItem.id);
                              void window.kapsula.closeHud();
                            }}
                            className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                          >
                            {t('hud.openInVault')}
                          </button>
                          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--k-ink-muted)]">
                            <KeyReturn className="w-3 h-3" /> {t('hud.enterToOpen')}
                          </span>
                        </div>
                      </div>
                    ) : (
                      /* Live Rich TipTap Editor for ALL Non-Secret Items */
                      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                        {/* Top Compact Meta + Mini Formatting Toolbar */}
                        <div className="px-4 py-2 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] flex items-center justify-between gap-2 shrink-0">
                          <div className="inline-flex items-center gap-0.5 rounded-lg bg-[var(--k-bg-surface-2)] p-0.5 border border-[var(--k-border-hairline)]">
                            <button
                              type="button"
                              title={t('hud.headingBtn')}
                              aria-label={t('hud.headingBtn')}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() =>
                                hudEditor?.chain().focus().toggleHeading({ level: 2 }).run()
                              }
                              className={`k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md cursor-pointer ${
                                hudToolbarState?.h2
                                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-ink-primary)]'
                              }`}
                            >
                              <TextHTwo
                                weight={hudToolbarState?.h2 ? 'bold' : 'regular'}
                                className="w-3.5 h-3.5"
                              />
                            </button>
                            <button
                              type="button"
                              title={t('hud.bulletList')}
                              aria-label={t('hud.listShort')}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => hudEditor?.chain().focus().toggleBulletList().run()}
                              className={`k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md cursor-pointer ${
                                hudToolbarState?.bullet
                                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-ink-primary)]'
                              }`}
                            >
                              <ListBullets
                                weight={hudToolbarState?.bullet ? 'bold' : 'regular'}
                                className="w-3.5 h-3.5"
                              />
                            </button>
                            <button
                              type="button"
                              title={t('hud.checklist')}
                              aria-label={t('hud.checklist')}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => hudEditor?.chain().focus().toggleTaskList().run()}
                              className={`k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md cursor-pointer ${
                                hudToolbarState?.task
                                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                                  : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-ink-primary)]'
                              }`}
                            >
                              <CheckSquare
                                weight={hudToolbarState?.task ? 'bold' : 'regular'}
                                className="w-3.5 h-3.5"
                              />
                            </button>
                            <button
                              type="button"
                              data-testid="hud-insert-image-btn"
                              disabled={hudInsertingImage}
                              title={isMac ? t('hud.insertPhotoMac') : t('hud.insertPhotoWin')}
                              aria-label={t('note.studio.insertPhoto')}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setHudPickingImage(true);
                                const resetAfterFocus = () => {
                                  window.setTimeout(() => setHudPickingImage(false), 350);
                                };
                                window.addEventListener('focus', resetAfterFocus, { once: true });
                                hudImageInputRef.current?.click();
                              }}
                              className="k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-accent)] cursor-pointer disabled:opacity-50"
                            >
                              {hudInsertingImage ? (
                                <CircleNotch weight="bold" className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ImageSquare className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <span className="w-px h-3.5 bg-[var(--k-border-hairline)] mx-0.5" />
                            <button
                              type="button"
                              title={isMac ? t('hud.undoMac') : t('hud.undoWin')}
                              aria-label={t('common.undo')}
                              disabled={!hudToolbarState?.canUndo}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => hudEditor?.chain().focus().undo().run()}
                              className="k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-35"
                            >
                              <ArrowUUpLeft className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              title={isMac ? t('hud.redoMac') : t('hud.redoWin')}
                              aria-label={t('hud.redo')}
                              disabled={!hudToolbarState?.canRedo}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => hudEditor?.chain().focus().redo().run()}
                              className="k-interactive inline-flex items-center justify-center w-6.5 h-6 rounded-md text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-3)] hover:text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-35"
                            >
                              <ArrowUUpRight className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-[var(--k-ink-muted)] shrink-0">
                            <span
                              data-testid="hud-editor-save-state"
                              className={`px-2 py-0.5 rounded-full font-medium k-tabular ${
                                editorSaveState === 'saving'
                                  ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)]'
                                  : 'bg-[var(--k-bg-surface-2)] text-[var(--k-ink-muted)]'
                              }`}
                            >
                              {editorSaveState === 'saving' ? t('common.saving') : t('common.saved')}
                            </span>
                            <span className="hidden sm:inline">
                              {formatRelativeDate(
                                activeItem.contentUpdatedAt || activeItem.createdAt,
                                locale
                              )}
                            </span>
                          </div>
                        </div>

                        {/* Scrollable Live Document Canvas */}
                        <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-7 flex flex-col gap-2.5 bg-[var(--k-bg-surface-1)]">
                          {/* Borderless Editable Title */}
                          <textarea
                            ref={hudTitleRef}
                            rows={1}
                            data-testid="hud-editor-title"
                            value={editorTitle}
                            onChange={(e) => handleHudTitleChange(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                hudEditor?.commands.focus();
                              }
                            }}
                            placeholder={t('hud.titlePlaceholder')}
                            className="w-full resize-none overflow-hidden bg-transparent border-none outline-none text-[16px] font-semibold tracking-[-0.004em] leading-snug text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] k-selectable shrink-0"
                          />

                          {/* Voice Audio Player + AI Transcribe CTA when empty */}
                          {activeItem.dna === 'voice' && activeItem.mediaPath ? (
                            <div className="flex flex-col gap-2 shrink-0">
                              <WaveformAudioPlayer
                                src={getMediaUrl(activeItem.mediaPath)}
                                fallbackDurationSec={activeItem.mediaDurationSec}
                                peaks={activeItem.mediaMeta?.waveformPeaks}
                                seedKey={activeItem.id}
                                compact
                              />
                              {activeVoiceEmptyTranscript ? (
                                <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--k-accent)]/25 bg-[var(--k-accent-soft)] px-3 py-2">
                                  <span className="text-[11.5px] text-[var(--k-ink-secondary)]">
                                    {t('hud.audioNotTranscribed')}
                                  </span>
                                  <button
                                    type="button"
                                    data-testid="hud-voice-transcribe-btn"
                                    disabled={hudTranscribingId === activeItem.id}
                                    onClick={() => void handleHudTranscribeVoice(activeItem)}
                                    className="k-interactive inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11.5px] font-medium cursor-pointer disabled:opacity-65 shrink-0"
                                  >
                                    {hudTranscribingId === activeItem.id ? (
                                      <CircleNotch
                                        weight="bold"
                                        className="w-3.5 h-3.5 animate-spin"
                                      />
                                    ) : (
                                      <Sparkle weight="fill" className="w-3.5 h-3.5" />
                                    )}
                                    <span>
                                      {hudTranscribingId === activeItem.id
                                        ? t('cards.transcribing')
                                        : t('cards.transcribeBtn')}
                                    </span>
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Cover Image Thumbnail (for shots / links with cover) */}
                          {(activeItem.thumbPath || activeItem.imagePath) &&
                          activeItem.dna !== 'voice' ? (
                            <button
                              type="button"
                              onClick={() => setHudLightboxItem(activeItem)}
                              className="rounded-xl overflow-hidden border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] max-h-[140px] shrink-0 cursor-zoom-in block w-full"
                            >
                              <img
                                src={
                                  getMediaUrl(activeItem.thumbPath || activeItem.imagePath) ||
                                  undefined
                                }
                                alt={activeItem.title}
                                className="w-full max-h-[140px] object-cover block"
                              />
                            </button>
                          ) : null}

                          {/* External URL Bar for Links */}
                          {activeItem.url ? (
                            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 py-1.5 shrink-0">
                              <span className="inline-flex items-center gap-1.5 min-w-0 text-[11.5px] text-[var(--k-ink-secondary)] truncate">
                                <LinkSimple className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                                <span className="truncate">{activeItem.url}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => void window.kapsula.openExternal(activeItem.url!)}
                                className="k-interactive shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[11px] font-medium text-[var(--k-ink-primary)] hover:text-[var(--k-accent)] cursor-pointer"
                              >
                                <ArrowSquareOut className="w-3 h-3" />
                                <span>{t('hud.goBtn')}</span>
                              </button>
                            </div>
                          ) : null}

                          {/* Subtle Summary Fallback when body is empty on links/docs/shots */}
                          {!editorLiveBody.trim() &&
                          activeItem.summary &&
                          activeItem.summary.trim() !== (activeItem.title || '').trim() &&
                          activeItem.dna !== 'note' ? (
                            <div className="rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-2.5 py-2 text-[12px] text-[var(--k-ink-secondary)] leading-relaxed shrink-0">
                              {cleanInlineSyntax(activeItem.summary)}
                            </div>
                          ) : null}

                          {/* Live TipTap Markdown Canvas */}
                          <div ref={setHudEditorHostEl} className="relative flex-1 min-h-0">
                            <EditorContent editor={hudEditor} className="min-h-full" />
                            <ProseCaretOverlay editor={hudEditor} containerEl={hudEditorHostEl} />
                          </div>
                        </div>

                        {/* Bottom Action Footer (100% solid opaque) */}
                        <div className="px-4 py-2.5 border-t border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] flex flex-wrap items-center justify-between gap-2 shrink-0">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                void flushHudEditorSave().finally(() => {
                                  void window.kapsula.focusVaultItem(activeItem.id);
                                  void window.kapsula.closeHud();
                                });
                              }}
                              className="k-interactive h-7.5 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                            >
                              {t('common.open')}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleHudPasteBack(activeItem)}
                              className="k-interactive h-7.5 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                            >
                              {t('hud.pasteToActiveWindow')}
                            </button>
                          </div>
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--k-ink-muted)]">
                            <KeyReturn className="w-3 h-3" /> {t('hud.tabEditHint')}{' '}
                            {isMacPlatform(window.kapsula?.platform) ? '⌘+Enter' : 'Ctrl+Enter'} —{' '}
                            {t('hud.pasteWord')}
                          </span>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center text-[var(--k-ink-muted)] gap-2 p-6">
                      <KapsulaEmblem size={32} />
                      <div className="text-[13.5px] font-medium text-[var(--k-ink-secondary)]">
                        {t('hud.emptyTitle')}
                      </div>
                      <div className="text-[12px] max-w-[300px]">
                        {t('hud.emptyDesc')}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : null}

            {tab === 'capture' ? (
              <motion.div
                key="tab-capture"
                custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
                variants={HUD_TAB_SLIDE_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  tabState.instant || prefersReduced
                    ? { duration: 0 }
                    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }
                }
                className="absolute inset-0 p-4 flex flex-col gap-3 overflow-y-auto bg-[var(--k-bg-canvas)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-semibold text-[var(--k-ink-primary)]">
                    {t('hud.captureHeading')}
                  </div>
                  <div className="flex items-center gap-2">
                    <SectionPickerPopover
                      orbits={orbits}
                      value={draftOrbit}
                      onChange={setDraftOrbit}
                      onOrbitCreated={(created) =>
                        setOrbits((prev) =>
                          prev.some((o) => o.id === created.id) ? prev : [...prev, created]
                        )
                      }
                      onOpenChange={(next) => {
                        captureOrbitMenuOpenRef.current = next;
                        setCaptureOrbitMenuOpen(next);
                      }}
                      emptyOptionLabel={t('hud.autoByMeaning')}
                      emptyOptionKind="auto"
                      size="sm"
                      align="end"
                      data-testid="hud-capture-section-picker"
                    />
                  </div>
                </div>

                {recordingVoice ? (
                  <VoiceRecorderStudio
                    mode="capture_audio"
                    onAudioCaptured={async (wav) => {
                      await window.kapsula.capture({
                        audioBase64: wav.wavBase64,
                        audioMime: wav.mime,
                        audioDurationSec: wav.durationSec,
                        orbitOverride: draftOrbit || undefined,
                        mediaMeta: { waveformPeaks: wav.peaks },
                        source: 'hud',
                      });
                      setRecordingVoice(false);
                      toast.success(t('hud.voiceSaved'));
                      await loadHudData(search);
                    }}
                    onFallbackSaveAudio={async (wav) => {
                      await window.kapsula.capture({
                        audioBase64: wav.wavBase64,
                        audioMime: wav.mime,
                        audioDurationSec: wav.durationSec,
                        orbitOverride: draftOrbit || undefined,
                        mediaMeta: { waveformPeaks: wav.peaks },
                        source: 'hud',
                      });
                      setRecordingVoice(false);
                      toast.success(t('note.studio.audioSaved'));
                    }}
                    onCancel={() => setRecordingVoice(false)}
                  />
                ) : (
                  <textarea
                    ref={captureInputRef}
                    data-testid="hud-capture-input"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void handleSaveCapture();
                        return;
                      }
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveCapture();
                      }
                    }}
                    placeholder={t('hud.capturePlaceholder')}
                    className="k-selectable flex-1 min-h-[160px] w-full resize-none rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] p-3.5 text-[13.5px] leading-relaxed text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none focus:border-[var(--k-border-focus)]"
                  />
                )}

                {activeParsedEvent ? (
                  <div className="flex items-center gap-2 rounded-xl border border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)] px-3 py-2 text-[12px] text-[var(--k-ink-primary)]">
                    <CalendarBlank weight="fill" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                    <span className="truncate">
                      {t('hud.calendarWillAdd')} <strong>{activeParsedEvent.label}</strong>
                      {activeParsedEvent.location ? ` · ${activeParsedEvent.location}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDismissedEventText(draftText.trim())}
                      className="ml-auto text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
                    >
                      {t('hud.removeBadge')}
                    </button>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRecordingVoice((v) => !v)}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                    >
                      <Microphone weight="duotone" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                      {t('hud.recordVoice')}
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await window.kapsula.captureScreen({ reopenHud: true });
                          toast.success(t('hud.screenshotSaved'));
                          await loadHudData(search);
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, t('hud.screenshotFailed'), locale));
                        }
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                    >
                      <Camera weight="duotone" className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                      {t('hud.screenShotBtn')}
                    </button>

                    {clipPreview.text || clipPreview.hasImage ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await window.kapsula.captureClipboard({
                            orbitOverride: draftOrbit || undefined,
                          });
                          toast.success(t('hud.clipboardSaved'));
                          await loadHudData(search);
                        }}
                        className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                      >
                        <ClipboardText className="w-3.5 h-3.5" />
                        {t('hud.pasteClipboardBtn')}
                      </button>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    title={t('composer.enterHint')}
                    disabled={!draftText.trim() || savingCapture}
                    onClick={() => void handleSaveCapture()}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-4 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default cursor-pointer"
                  >
                    <PaperPlaneTilt weight="fill" className="w-3.5 h-3.5" />
                    {t('hud.saveShortcutBtn', { shortcut: 'Enter' })}
                  </button>
                </div>
              </motion.div>
            ) : null}

            {tab === 'vault' ? (
              <motion.div
                key="tab-vault"
                custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
                variants={HUD_TAB_SLIDE_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  tabState.instant || prefersReduced
                    ? { duration: 0 }
                    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }
                }
                className="absolute inset-0 p-4 flex flex-col gap-3 overflow-y-auto bg-[var(--k-bg-canvas)]"
              >
                {isVaultLocked ? (
                  <form
                    onSubmit={handleUnlockPin}
                    className="my-auto mx-auto w-full max-w-[340px] rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] p-5 flex flex-col gap-3 text-center"
                  >
                    <div className="w-10 h-10 rounded-full bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] flex items-center justify-center mx-auto">
                      <LockKey weight="fill" className="w-5 h-5" />
                    </div>
                    <div className="text-[14px] font-semibold">{t('hud.vaultPinTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('hud.vaultPinSub')}
                    </div>
                    <input
                      type="password"
                      value={pinInput}
                      onChange={(e) => setPinInput(e.target.value)}
                      placeholder={t('hud.pinPlaceholder')}
                      autoFocus
                      className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-center k-mono text-[14px] outline-none focus:border-[var(--k-border-focus)]"
                    />
                    {pinError ? (
                      <div className="text-[11.5px] text-[var(--k-danger)]">{pinError}</div>
                    ) : null}
                    <button
                      type="submit"
                      disabled={unlockingPin || unlockingBiometric || !pinInput.trim()}
                      className="k-interactive h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                    >
                      {t('vault.unlockButton')}
                    </button>
                    {settings.biometricUnlockAvailable && settings.biometricUnlockEnabled ? (
                      <button
                        type="button"
                        data-testid="hud-unlock-biometric-btn"
                        disabled={unlockingBiometric || unlockingPin}
                        onClick={() => void handleUnlockBiometric()}
                        className="k-interactive h-9 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] text-[12.5px] font-medium inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <Fingerprint className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                        <span>
                          {unlockingBiometric
                            ? t('pin.bioPrompt')
                            : isMac
                              ? t('pin.bioTouchId')
                              : t('pin.bioGeneric')}
                        </span>
                      </button>
                    ) : null}
                  </form>
                ) : allSecretItems.length === 0 ? (
                  <div className="my-auto text-center text-[13px] text-[var(--k-ink-muted)]">
                    {t('hud.vaultEmpty')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 h-8 focus-within:border-[var(--k-border-focus)]">
                      <MagnifyingGlass className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                      <input
                        type="text"
                        value={vaultSearch}
                        onChange={(e) => setVaultSearch(e.target.value)}
                        placeholder={t('hud.vaultSearchPlaceholder')}
                        data-testid="hud-vault-search-input"
                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
                      />
                    </div>
                    <div className="text-[11.5px] text-[var(--k-ink-muted)] flex items-center justify-between">
                      <span>
                        {settings.clipboardAutoWipeSeconds > 0
                          ? t('hud.vaultQuickCopyWipe', { seconds: settings.clipboardAutoWipeSeconds })
                          : t('hud.vaultQuickCopyOff')}
                      </span>
                    </div>
                    {secretItems.length === 0 ? (
                      <div className="py-6 text-center text-[12.5px] text-[var(--k-ink-muted)]">
                        {t('hud.vaultNotFound', { query: vaultSearch })}
                      </div>
                    ) : null}
                    {secretItems.map((sec) => {
                      const isCard = sec.secretMeta?.kind === 'bank_card';
                      const subtitle = isCard
                        ? [
                            sec.secretMeta?.loginHint || '••••',
                            sec.secretMeta?.expiry
                              ? t('secret.sheet.expiryField', { value: sec.secretMeta.expiry })
                              : t('vault.cardNoExpiry'),
                          ].join(' · ')
                        : sec.secretMeta?.loginHint || sec.summary;
                      return (
                        <div
                          key={sec.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3.5 py-2.5"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              void window.kapsula.focusVaultItem(sec.id);
                              void window.kapsula.closeHud();
                            }}
                            className="min-w-0 flex-1 text-left cursor-pointer group/sec"
                          >
                            <div className="text-[13px] font-medium truncate text-[var(--k-ink-primary)] group-hover/sec:text-[var(--k-accent)] transition-colors duration-120">
                              {sec.title}
                            </div>
                            <div className="k-mono text-[11px] text-[var(--k-ink-muted)] truncate">
                              {subtitle}
                            </div>
                          </button>
                          {renderSecretQuickPills(sec)}
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            ) : null}

            {tab === 'today' ? (
              <motion.div
                key="tab-today"
                custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
                variants={HUD_TAB_SLIDE_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  tabState.instant || prefersReduced
                    ? { duration: 0 }
                    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }
                }
                className="absolute inset-0 p-4 flex flex-col gap-3 overflow-y-auto bg-[var(--k-bg-canvas)]"
              >
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const clean = todayQuickTask.trim();
                    if (!clean) return;
                    await window.kapsula.capture({
                      text: `- [ ] ${clean}`,
                      remindAt: Date.now() + 3_600_000,
                      source: 'hud',
                    });
                    setTodayQuickTask('');
                    toast.success(t('hud.taskAdded'));
                    await loadHudData(search);
                  }}
                  className="flex items-center gap-2 shrink-0"
                >
                  <input
                    value={todayQuickTask}
                    onChange={(e) => setTodayQuickTask(e.target.value)}
                    placeholder={t('hud.quickTaskPlaceholder')}
                    className="flex-1 h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <button
                    type="submit"
                    disabled={!todayQuickTask.trim()}
                    className="k-interactive h-9 px-3 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium inline-flex items-center gap-1 cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                  >
                    <Plus weight="bold" className="w-3.5 h-3.5" />
                    {t('common.add')}
                  </button>
                </form>

                {todayScheduleEntries.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      {t('hud.eventsToday')}
                    </div>
                    {todayScheduleEntries.map((ev) => (
                      <div
                        key={ev.id}
                        onClick={() => {
                          if (ev.linkedItemId) {
                            void window.kapsula.focusVaultItem(ev.linkedItemId);
                          } else {
                            void window.kapsula.windowAction('open-vault-calendar');
                          }
                          void window.kapsula.closeHud();
                        }}
                        className="k-interactive hover:border-[var(--k-border-strong)] cursor-pointer flex items-center justify-between gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: ev.color || 'var(--k-accent)' }}
                          />
                          <span className="text-[12.5px] font-medium truncate">{ev.title}</span>
                        </div>
                        <span className="k-mono text-[11px] text-[var(--k-ink-muted)] shrink-0">
                          {ev.allDay
                            ? t('common.allDay')
                            : new Date(ev.startAt).toLocaleTimeString(dateLocale, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {t('hud.openTasksCount', { count: openTasks.length })}
                  </div>
                  {openTasks.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--k-border-hairline)] p-4 text-center text-[12.5px] text-[var(--k-ink-muted)] flex items-center justify-center gap-2">
                      <CheckCircle className="w-4 h-4 text-[var(--k-emerald)]" />
                      {t('hud.allTasksDone')}
                    </div>
                  ) : (
                    openTasks.map((taskItem) => (
                      <div
                        key={taskItem.id}
                        className="flex items-center gap-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 py-2"
                      >
                        <AnimatedCheckbox
                          size="sm"
                          checked={taskItem.done}
                          onChange={async (next) => {
                            const prevDone = taskItem.done;
                            setTasks((prev) =>
                              prev.map((row) => (row.id === taskItem.id ? { ...row, done: next } : row))
                            );
                            try {
                              await window.kapsula.toggleTask({
                                itemId: taskItem.itemId,
                                sourceType: taskItem.sourceType,
                                taskIndex: taskItem.taskIndex,
                                done: next,
                              });
                              await loadHudData(search);
                            } catch (err) {
                              setTasks((prev) =>
                                prev.map((row) =>
                                  row.id === taskItem.id ? { ...row, done: prevDone } : row
                                )
                              );
                              toast.error(friendlyErrorMessage(err, undefined, locale));
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void window.kapsula.focusVaultItem(taskItem.itemId);
                            void window.kapsula.closeHud();
                          }}
                          className="flex-1 text-left min-w-0 cursor-pointer"
                        >
                          <div className="text-[12.5px] text-[var(--k-ink-primary)] truncate">
                            {taskItem.text}
                          </div>
                          {!isStandaloneTaskSource(taskItem, tasksCountByItemId.get(taskItem.itemId) ?? 1) && taskItem.itemTitle ? (
                            <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                              {taskItem.itemTitle}
                            </div>
                          ) : null}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            ) : null}

            {tab === 'important' ? (
              <motion.div
                key="tab-important"
                custom={{ dir: tabState.dir, skip: tabState.instant || Boolean(prefersReduced) }}
                variants={HUD_TAB_SLIDE_VARIANTS}
                initial="enter"
                animate="center"
                exit="exit"
                transition={
                  tabState.instant || prefersReduced
                    ? { duration: 0 }
                    : { duration: 0.16, ease: [0.23, 1, 0.32, 1] }
                }
                className="absolute inset-0 p-4 flex flex-col gap-3 overflow-y-auto bg-[var(--k-bg-canvas)]"
              >
                <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-[var(--k-ink-primary)]">
                      {t('hud.currentClipboard')}
                    </div>
                    <div className="text-[11.5px] text-[var(--k-ink-muted)] truncate">
                      {clipPreview.hasImage
                        ? t('hud.clipboardHasImage')
                        : clipPreview.text
                          ? clipPreview.text
                          : t('hud.clipboardEmptyOrProtected')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const saved = await window.kapsula.captureClipboard();
                      if (saved) {
                        toast.success(t('hud.snatchedToast'));
                        await loadHudData(search);
                      } else {
                        toast.info(t('hud.clipboardNothingNew'));
                      }
                    }}
                    className="k-interactive shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[12px] font-medium cursor-pointer"
                  >
                    <Sparkle weight="fill" className="w-3.5 h-3.5" />
                    {t('hud.saveClipboardBtn')}
                  </button>
                </div>

                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                  {t('hud.pinnedCount', { count: pinnedItems.length })}
                </div>

                {pinnedItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--k-border-hairline)] p-5 text-center text-[12.5px] text-[var(--k-ink-muted)]">
                    {t('hud.pinnedHint')}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {pinnedItems.map((item) => {
                      const orb = orbits.find((o) => o.id === item.orbit);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            void window.kapsula.focusVaultItem(item.id);
                            void window.kapsula.closeHud();
                          }}
                          className="transition-[border-color,background-color,box-shadow] duration-150 text-left rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)]/45 p-3 flex flex-col gap-1.5 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--k-ink-muted)]">
                            <span className="inline-flex items-center gap-1 truncate">
                              <PushPin weight="fill" className="w-3 h-3 text-[var(--k-accent)]" />
                              {orb ? (
                                <>
                                  <SectionIcon
                                    name={orb.icon}
                                    className="w-3 h-3"
                                    color={orb.color}
                                  />
                                  <span className="truncate">{orb.name}</span>
                                </>
                              ) : (
                                getDnaHumanLabel(item, locale)
                              )}
                            </span>
                            <span className="k-tabular shrink-0">
                              {formatDateCompact(item.createdAt, locale)}
                            </span>
                          </div>
                          <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                            {item.title}
                          </div>
                          <CompactStructuredPreview item={item} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* HUD Inline Photo Lightbox */}
      <ShotLightbox item={hudLightboxItem} onClose={() => setHudLightboxItem(null)} />
    </div>
  );
};
