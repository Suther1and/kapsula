import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import NumberFlow from '@number-flow/react';
import { toast } from 'sonner';
import {
  Archive,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowsClockwise,
  ArrowUp,
  CalendarBlank,
  Check,
  CheckSquare,
  CirclesFour,
  ClipboardText,
  CloudCheck,
  CloudSlash,
  CloudWarning,
  EyeSlash,
  FunnelSimple,
  GridFour,
  Image as ImageIcon,
  Info,
  ListBullets,
  LockKey,
  LockSimpleOpen,
  MagnifyingGlass,
  Minus,
  Moon,
  NotePencil,
  PencilSimple,
  Plus,
  PushPin,
  SidebarSimple,
  SlidersHorizontal,
  Sparkle,
  Square,
  SquaresFour,
  Stack,
  Sun,
  Swatches,
  Trash,
  Tray,
  X,
} from '@phosphor-icons/react';
import type { SyncStatus } from '@shared/sync-contract';
import type {
  AppUpdaterState,
  CalendarEvent,
  FocusBoard,
  OrbitDef,
  SettingsState,
  VaultItem,
  VaultTaskEntry,
  ViewLayoutMode,
} from '@shared/types';
import { SECTION_COLOR_PALETTE, SECTION_ICON_CHOICES } from '@shared/constants';
import { useI18n } from '@shared/i18n/react';
import { matchesBilingualHaystack } from '@shared/bilingual-search';
import { truncateAtWordBoundary } from '@shared/html-entities';
import { isDedicatedNote, isMediaItem } from '@shared/item-helpers';
import { formatShortcutCompact, isMacPlatform } from '@shared/shortcuts';
import { toggleMarkdownTaskInBody } from '@shared/task-helpers';
import { KapsulaEmblem } from '../components/ui/KapsulaEmblem';
import { GlobalSearchPopover } from '../components/ui/GlobalSearchPopover';
import { PopoverSurface } from '../components/ui/PopoverSurface';
import { SelectMenu } from '../components/ui/SelectMenu';
import { TooltipHint } from '../components/ui/TooltipHint';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { getSectionIconLabels, SectionIcon } from '../components/ui/SectionIcon';
import {
  ContextMenuSurface,
  type ContextMenuEntry,
} from '../components/ui/ContextMenuSurface';
import { ModalDialog } from '../components/ui/ModalDialog';
import { OmniComposer } from '../components/studio/OmniComposer';
import { MemoryCardRouter } from '../components/cards/MemoryCardRouter';
import type { TasksViewMode } from '../components/studio/TasksHubView';
import type { SettingsTab } from '../components/modals/SettingsModal';

const QuickLookModal = lazy(() =>
  import('../components/ui/QuickLookModal').then((m) => ({ default: m.QuickLookModal }))
);
const ShotLightbox = lazy(() =>
  import('../components/cards/ShotLightbox').then((m) => ({ default: m.ShotLightbox }))
);
const NoteStudio = lazy(() =>
  import('../components/studio/NoteStudio').then((m) => ({ default: m.NoteStudio }))
);
const SecretStudioSheet = lazy(() =>
  import('../components/studio/SecretStudioSheet').then((m) => ({ default: m.SecretStudioSheet }))
);
const TasksHubView = lazy(() =>
  import('../components/studio/TasksHubView').then((m) => ({ default: m.TasksHubView }))
);
const CalendarHubView = lazy(() =>
  import('../components/studio/CalendarHubView').then((m) => ({ default: m.CalendarHubView }))
);
const ReferenceBoardCanvas = lazy(() =>
  import('../components/studio/ReferenceBoardCanvas').then((m) => ({
    default: m.ReferenceBoardCanvas,
  }))
);
const NotesHubView = lazy(() =>
  import('../components/studio/NotesHubView').then((m) => ({ default: m.NotesHubView }))
);
const MediaHubView = lazy(() =>
  import('../components/studio/MediaHubView').then((m) => ({ default: m.MediaHubView }))
);
const MemoryAssistantDrawer = lazy(() =>
  import('../components/modals/MemoryAssistantDrawer').then((m) => ({
    default: m.MemoryAssistantDrawer,
  }))
);
const NewSecretModal = lazy(() =>
  import('../components/modals/NewSecretModal').then((m) => ({ default: m.NewSecretModal }))
);
const OnboardingModal = lazy(() =>
  import('../components/modals/OnboardingModal').then((m) => ({ default: m.OnboardingModal }))
);
const SettingsModal = lazy(() =>
  import('../components/modals/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const UnlockPinDialog = lazy(() =>
  import('../components/modals/UnlockPinDialog').then((m) => ({ default: m.UnlockPinDialog }))
);
const SynthesizeNotesModal = lazy(() =>
  import('../components/modals/SynthesizeNotesModal').then((m) => ({
    default: m.SynthesizeNotesModal,
  }))
);
const SmartTriageModal = lazy(() =>
  import('../components/modals/SmartTriageModal').then((m) => ({ default: m.SmartTriageModal }))
);

function useMountOnce(active: boolean): boolean {
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active && !mounted) {
      setMounted(true);
    }
  }, [active, mounted]);
  return active || mounted;
}
import { hydrateAppearanceFromSettings } from '../lib/appearance';
import {
  HIDEABLE_NAV_SECTIONS,
  HIDEABLE_SECTION_LABEL_KEYS,
  PRIMARY_NAV_SECTIONS,
  readHiddenNavSections,
  readPrimaryNavOrder,
  resetPrimaryNavOrder,
  SIDEBAR_PREFS_EVENT,
  writeHiddenNavSections,
  writePrimaryNavOrder,
  type HideableNavSection,
  type PrimaryNavSection,
} from '../lib/sidebar-prefs';
import { formatRelativeDate, friendlyErrorMessage, stripMarkdownPreview } from '../lib/format';

interface StudioWorkspaceProps {
  settings: SettingsState;
  onSettingsUpdated: (next: SettingsState) => void;
}

type NavView =
  | { type: 'flow' }
  | { type: 'notes' }
  | { type: 'media' }
  | { type: 'tasks' }
  | { type: 'calendar' }
  | { type: 'secrets' }
  | { type: 'archive' }
  | { type: 'trash' }
  | { type: 'orbit'; orbitId: string }
  | { type: 'board'; boardId: string };

type SortMode = 'flow' | 'created_desc' | 'updated_desc' | 'title_asc' | 'media_first';
type QuickDnaFilter = 'all' | 'link' | 'note' | 'voice';
type SecretKindFilter = 'all' | 'bank_card' | 'password' | 'api_key' | 'note';

interface SectionEditorState {
  kind: 'orbit' | 'board';
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  description: string;
  color: string;
  icon: string;
}

type DropPosition = 'before' | 'after';
type SidebarDropTarget<T extends string = string> = { id: T; position: DropPosition };

function hasDragType(e: React.DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(type);
}

function computeDropPosition(e: React.DragEvent<HTMLElement>): DropPosition {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function reorderByDrop<T>(
  list: readonly T[],
  fromIdx: number,
  toIdx: number,
  position: DropPosition
): T[] | null {
  if (fromIdx === -1 || toIdx === -1) return null;
  const rawInsert = position === 'before' ? toIdx : toIdx + 1;
  const insertIdx = fromIdx < rawInsert ? rawInsert - 1 : rawInsert;
  if (insertIdx === fromIdx) return null;
  const next = [...list];
  const [moved] = next.splice(fromIdx, 1);
  if (moved === undefined) return null;
  next.splice(insertIdx, 0, moved);
  return next;
}

function isSameNav(a: NavView, b: NavView): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'orbit' && b.type === 'orbit') return a.orbitId === b.orbitId;
  if (a.type === 'board' && b.type === 'board') return a.boardId === b.boardId;
  return true;
}

function getChronologyTime(item: VaultItem): number {
  return item.createdAt;
}

function makeBlankDraftItem(orbit: string, focusBoardId: string | null): VaultItem {
  const now = Date.now();
  return {
    id: '__draft__',
    dna: 'note',
    subKind: null,
    orbit,
    modeCaptured: 'autopilot',
    focusBoardId,
    title: '',
    body: '',
    summary: '',
    url: null,
    domain: null,
    platform: null,
    imagePath: null,
    thumbPath: null,
    mediaPath: null,
    mediaType: null,
    mediaDurationSec: null,
    mediaMeta: { inNotesHub: true },
    ogImageUrl: null,
    ocrText: '',
    extractedActions: [],
    colorPalette: [],
    hasEncryptedPayload: false,
    secretMeta: null,
    tags: [],
    source: 'vault_ui',
    externalId: null,
    contentHash: '',
    aiStatus: 'local',
    aiConfidence: null,
    isPinned: false,
    isArchived: false,
    isDemo: false,
    remindAt: null,
    remindedAt: null,
    createdAt: now,
    updatedAt: now,
    contentUpdatedAt: now,
    deletedAt: null,
    canvasX: null,
    canvasY: null,
    canvasW: null,
    canvasH: null,
    canvasFrame: null,
    annotations: [],
    linksOut: [],
  };
}

const MASONRY_ROW_UNIT_PX = 4;

type PendingTaskToggle = {
  itemId: string;
  sourceType: 'markdown' | 'voice_action';
  taskIndex: number;
  done: boolean;
  seq: number;
};

function applyOptimisticTaskToItem(
  item: VaultItem,
  sourceType: 'markdown' | 'voice_action',
  taskIndex: number,
  done: boolean
): VaultItem {
  if (sourceType === 'markdown') {
    const toggled = toggleMarkdownTaskInBody(item.body || '', taskIndex, done);
    if (!toggled || toggled.body === item.body) return item;
    return { ...item, body: toggled.body };
  }
  const prevMeta = item.mediaMeta ?? {};
  const checked = new Set(
    Array.isArray(prevMeta.checkedActionIndices) ? prevMeta.checkedActionIndices : []
  );
  if (done) checked.add(taskIndex);
  else checked.delete(taskIndex);
  const nextIndices = Array.from(checked).sort((a, b) => a - b);
  return {
    ...item,
    mediaMeta: {
      ...prevMeta,
      checkedActionIndices: nextIndices,
    },
  };
}

const FEED_PAGE_SIZE = 80;
const SERVER_ITEM_PAGE = 2000;

const masonryMeasureCallbacks = new WeakMap<Element, () => void>();
let sharedMasonryObserver: ResizeObserver | null = null;
function getSharedMasonryObserver(): ResizeObserver | null {
  if (sharedMasonryObserver) return sharedMasonryObserver;
  if (typeof ResizeObserver === 'undefined') return null;
  sharedMasonryObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      masonryMeasureCallbacks.get(entry.target)?.();
    }
  });
  return sharedMasonryObserver;
}

interface MasonryCardCellProps {
  children: React.ReactNode;
}

const MasonryCardCell: React.FC<MasonryCardCellProps> = React.memo(({ children }) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [rowSpan, setRowSpan] = useState<number>(36);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => {
      const h = Math.ceil(inner.getBoundingClientRect().height);
      const next = Math.max(1, Math.ceil(h / MASONRY_ROW_UNIT_PX));
      setRowSpan((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = getSharedMasonryObserver();
    if (!ro) return;
    masonryMeasureCallbacks.set(inner, measure);
    ro.observe(inner);
    return () => {
      masonryMeasureCallbacks.delete(inner);
      ro.unobserve(inner);
    };
  }, []);

  return (
    <div
      ref={outerRef}
      style={{ gridRowEnd: `span ${rowSpan}` }}
      className="min-w-0"
    >
      <div ref={innerRef} style={{ paddingBottom: 'var(--k-grid-gap)' }}>
        {children}
      </div>
    </div>
  );
});

export const StudioWorkspace: React.FC<StudioWorkspaceProps> = ({
  settings,
  onSettingsUpdated,
}) => {
  const { t, locale, dateLocale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [feedGridAnimRef, enableFeedGridAnim] = useAutoAnimate<HTMLDivElement>({
    duration: prefersReduced ? 0 : 180,
    easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
  });
  const [feedListAnimRef, enableFeedListAnim] = useAutoAnimate<HTMLDivElement>({
    duration: prefersReduced ? 0 : 170,
    easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
  });
  const [feedVisibleCount, setFeedVisibleCount] = useState(FEED_PAGE_SIZE);
  const [hasMoreServerItems, setHasMoreServerItems] = useState(false);
  const loadingMoreServerRef = useRef(false);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const itemsRef = useRef<VaultItem[]>([]);
  itemsRef.current = items;
  const [archivedItems, setArchivedItems] = useState<VaultItem[]>([]);
  const [trashedItems, setTrashedItems] = useState<VaultItem[]>([]);
  const [vaultStats, setVaultStats] = useState<{ archivedCount: number; trashedCount: number }>({
    archivedCount: 0,
    trashedCount: 0,
  });
  const vaultStatsRef = useRef(vaultStats);
  vaultStatsRef.current = vaultStats;
  const archivedLoadedRef = useRef(false);
  const trashedLoadedRef = useRef(false);
  const [orbits, setOrbits] = useState<OrbitDef[]>([]);
  const [boards, setBoards] = useState<FocusBoard[]>([]);
  const [tasks, setTasks] = useState<VaultTaskEntry[]>([]);
  const tasksRef = useRef<VaultTaskEntry[]>([]);
  tasksRef.current = tasks;
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const pendingTaskTogglesRef = useRef<Map<string, PendingTaskToggle>>(new Map());
  const taskToggleSeqRef = useRef(0);

  const applyPendingTaskTogglesToItem = useCallback((item: VaultItem): VaultItem => {
    if (pendingTaskTogglesRef.current.size === 0) return item;
    let next = item;
    pendingTaskTogglesRef.current.forEach((entry) => {
      if (entry.itemId === item.id) {
        next = applyOptimisticTaskToItem(next, entry.sourceType, entry.taskIndex, entry.done);
      }
    });
    return next;
  }, []);

  const applyPendingTaskTogglesToTasks = useCallback((taskList: VaultTaskEntry[]): VaultTaskEntry[] => {
    if (pendingTaskTogglesRef.current.size === 0) return taskList;
    return taskList.map((taskEntry) => {
      const key = `${taskEntry.itemId}:${taskEntry.sourceType}:${taskEntry.taskIndex}`;
      const pending = pendingTaskTogglesRef.current.get(key);
      if (!pending) return taskEntry;
      return {
        ...taskEntry,
        done: pending.done,
        columnId: pending.done ? 'done' : taskEntry.columnId === 'done' ? 'inbox' : taskEntry.columnId,
      };
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [tasksViewMode, setTasksViewMode] = useState<TasksViewMode>(() => {
    try {
      return localStorage.getItem('kapsula.tasks.viewMode') === 'board' ? 'board' : 'list';
    } catch {
      return 'list';
    }
  });
  const [confirmEmptyTrashOpen, setConfirmEmptyTrashOpen] = useState(false);
  const [confirmPurgeItem, setConfirmPurgeItem] = useState<VaultItem | null>(null);
  const [trashActionBusy, setTrashActionBusy] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const [nav, setNav] = useState<NavView>({ type: 'flow' });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const platform = window.kapsula?.platform ?? 'win32';
  const isMac = isMacPlatform(platform);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const showTrafficLights = isMac && !isFullScreen;
  const [layoutMode, setLayoutMode] = useState<ViewLayoutMode>(settings.viewLayout || 'grid');
  const [boardViewOverride, setBoardViewOverride] = useState<ViewLayoutMode | null>(null);
  const effectiveLayoutMode: ViewLayoutMode =
    nav.type === 'board' ? boardViewOverride ?? 'board' : layoutMode;
  const [sortOrder, setSortOrder] = useState<SortMode>('flow');

  const [searchQuery, setSearchQuery] = useState('');
  const [serverSearchIds, setServerSearchIds] = useState<string[] | null>(null);
  const [filterMediaOnly, setFilterMediaOnly] = useState(false);
  const [filterPinnedOnly, setFilterPinnedOnly] = useState(false);
  const [filterUnsortedOnly, setFilterUnsortedOnly] = useState(false);
  const [filterDnaQuick, setFilterDnaQuick] = useState<QuickDnaFilter>('all');
  const [secretKindFilter, setSecretKindFilter] = useState<SecretKindFilter>('all');
  const [notesDraftTrigger, setNotesDraftTrigger] = useState(0);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const lastSelectedIdRef = useRef<string | null>(null);
  const [bulkOrbitMenuOpen, setBulkOrbitMenuOpen] = useState(false);

  const handleHoverItem = useCallback((it: VaultItem | null) => {
    hoveredItemRef.current = it;
  }, []);
  const handleUnlockVaultRequest = useCallback(() => setUnlockOpen(true), []);
  const handleQuickLook = useCallback((it: VaultItem) => setQuickLookItem(it), []);
  const handleOpenShotLightbox = useCallback((it: VaultItem) => setLightboxItem(it), []);

  // Document View (Notes) / Secret Sheet / Modals
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioDraftMode, setStudioDraftMode] = useState(false);
  const [activeItem, setActiveItem] = useState<VaultItem | null>(null);

  const [lightboxItem, setLightboxItem] = useState<VaultItem | null>(null);
  const [quickLookItem, setQuickLookItem] = useState<VaultItem | null>(null);
  const hoveredItemRef = useRef<VaultItem | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [addSecretMenuOpen, setAddSecretMenuOpen] = useState(false);
  const [focusCalendarEventId, setFocusCalendarEventId] = useState<string | null>(null);
  const [calendarCreateTrigger, setCalendarCreateTrigger] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [newSecretOpen, setNewSecretOpen] = useState(false);
  const [newSecretKind, setNewSecretKind] = useState<'bank_card' | 'password' | 'api_key' | 'note'>('bank_card');
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [pendingOpenNewSecretAfterUnlock, setPendingOpenNewSecretAfterUnlock] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [updaterState, setUpdaterState] = useState<AppUpdaterState | null>(null);
  const [synthesizeOpen, setSynthesizeOpen] = useState(false);
  const [synthesizeSeedIds, setSynthesizeSeedIds] = useState<string[] | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);

  const onboardingShouldOpen =
    !loading &&
    !onboardingDismissed &&
    !settings.onboarded &&
    items.length === 0 &&
    (archivedLoadedRef.current ? archivedItems.length : vaultStats.archivedCount) === 0 &&
    (trashedLoadedRef.current ? trashedItems.length : vaultStats.trashedCount) === 0 &&
    orbits.length === 0;
  const mountAssistant = useMountOnce(assistantOpen);
  const mountQuickLook = useMountOnce(Boolean(quickLookItem));
  const mountLightbox = useMountOnce(Boolean(lightboxItem));
  const mountNewSecret = useMountOnce(newSecretOpen);
  const mountUnlock = useMountOnce(unlockOpen);
  const mountOnboarding = useMountOnce(onboardingShouldOpen);
  const mountSettings = useMountOnce(settingsOpen);
  const mountSynthesize = useMountOnce(synthesizeOpen);
  const mountTriage = useMountOnce(triageOpen);

  const [sectionEditor, setSectionEditor] = useState<SectionEditorState | null>(null);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [recoveryKeyVisible, setRecoveryKeyVisible] = useState(false);
  const [hiddenNavSections, setHiddenNavSections] = useState<HideableNavSection[]>(readHiddenNavSections);
  const [primaryNavOrder, setPrimaryNavOrder] = useState<PrimaryNavSection[]>(readPrimaryNavOrder);
  const [customizeSidebarOpen, setCustomizeSidebarOpen] = useState(false);

  const hiddenNavSet = useMemo(() => new Set<HideableNavSection>(hiddenNavSections), [hiddenNavSections]);
  const visiblePrimaryNavSections = useMemo(
    () =>
      primaryNavOrder.filter(
        (sec) => sec === 'flow' || !hiddenNavSet.has(sec as HideableNavSection)
      ),
    [primaryNavOrder, hiddenNavSet]
  );
  const isDefaultPrimaryNavOrder = useMemo(
    () =>
      primaryNavOrder.length === PRIMARY_NAV_SECTIONS.length &&
      PRIMARY_NAV_SECTIONS.every((id, idx) => primaryNavOrder[idx] === id),
    [primaryNavOrder]
  );

  useEffect(() => {
    const syncPrefs = () => {
      setHiddenNavSections(readHiddenNavSections());
      setPrimaryNavOrder(readPrimaryNavOrder());
    };
    window.addEventListener(SIDEBAR_PREFS_EVENT, syncPrefs);
    window.addEventListener('storage', syncPrefs);
    return () => {
      window.removeEventListener(SIDEBAR_PREFS_EVENT, syncPrefs);
      window.removeEventListener('storage', syncPrefs);
    };
  }, []);

  useEffect(() => {
    const activeHiddenKey: HideableNavSection | null =
      nav.type === 'notes' ||
      nav.type === 'media' ||
      nav.type === 'tasks' ||
      nav.type === 'calendar' ||
      nav.type === 'secrets'
        ? nav.type
        : nav.type === 'board'
          ? 'boards'
          : null;
    if (activeHiddenKey && hiddenNavSet.has(activeHiddenKey)) {
      setNav({ type: 'flow' });
    }
  }, [nav, hiddenNavSet]);

  const handleToggleHiddenNavSection = useCallback((section: HideableNavSection) => {
    setHiddenNavSections((prev) => {
      const exists = prev.includes(section);
      const next = exists ? prev.filter((item) => item !== section) : [...prev, section];
      return writeHiddenNavSections(next);
    });
  }, []);

  const handleHideNavSection = useCallback((section: HideableNavSection) => {
    setHiddenNavSections((prev) => {
      if (prev.includes(section)) return prev;
      return writeHiddenNavSections([...prev, section]);
    });
  }, []);

  const handleMovePrimaryNavByStep = useCallback(
    (section: PrimaryNavSection, delta: -1 | 1) => {
      const visIdx = visiblePrimaryNavSections.indexOf(section);
      if (visIdx === -1) return;
      const neighbor = visiblePrimaryNavSections[visIdx + delta];
      if (!neighbor) return;
      const next = [...primaryNavOrder];
      const fromIdx = next.indexOf(section);
      const toIdx = next.indexOf(neighbor);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return;
      next.splice(toIdx, 0, moved);
      setPrimaryNavOrder(writePrimaryNavOrder(next));
    },
    [primaryNavOrder, visiblePrimaryNavSections]
  );

  const handleReorderPrimaryNav = useCallback(
    (fromId: PrimaryNavSection, toId: PrimaryNavSection, position: DropPosition) => {
      if (fromId === toId) return;
      const next = reorderByDrop(
        primaryNavOrder,
        primaryNavOrder.indexOf(fromId),
        primaryNavOrder.indexOf(toId),
        position
      );
      if (!next) return;
      setPrimaryNavOrder(writePrimaryNavOrder(next));
    },
    [primaryNavOrder]
  );

  const [dragPrimaryNavId, setDragPrimaryNavId] = useState<PrimaryNavSection | null>(null);
  const [primaryNavDropTarget, setPrimaryNavDropTarget] =
    useState<SidebarDropTarget<PrimaryNavSection> | null>(null);
  const [dragOrbitId, setDragOrbitId] = useState<string | null>(null);
  const [orbitDropTarget, setOrbitDropTarget] = useState<SidebarDropTarget | null>(null);
  const [dragBoardId, setDragBoardId] = useState<string | null>(null);
  const [boardDropTarget, setBoardDropTarget] = useState<SidebarDropTarget | null>(null);
  const [cardDropTargetId, setCardDropTargetId] = useState<string | null>(null);

  const clearSidebarDragStates = useCallback(() => {
    setDragPrimaryNavId(null);
    setPrimaryNavDropTarget(null);
    setDragOrbitId(null);
    setOrbitDropTarget(null);
    setDragBoardId(null);
    setBoardDropTarget(null);
    setCardDropTargetId(null);
  }, []);

  useEffect(() => {
    window.addEventListener('dragend', clearSidebarDragStates);
    return () => window.removeEventListener('dragend', clearSidebarDragStates);
  }, [clearSidebarDragStates]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarElRef = useRef<HTMLElement | null>(null);
  const feedCanvasRef = useRef<HTMLDivElement | null>(null);
  const studioCloseHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const navRef = useRef(nav);
  navRef.current = nav;

  const isNoteDocumentOpen = Boolean(
    studioOpen && activeItem && (studioDraftMode || activeItem.dna !== 'secret')
  );
  const isSecretSheetOpen = Boolean(
    studioOpen && activeItem && !studioDraftMode && activeItem.dna === 'secret'
  );

  // Vault-only screen protection: keep Notes/Feed/Tasks/Calendar/Settings screenshot-friendly;
  // engage OS screen capture protection ONLY when Vault/Secrets or Recovery Key are actively on screen.
  const isVaultVisible =
    nav.type === 'secrets' || newSecretOpen || isSecretSheetOpen || recoveryKeyVisible;
  const shouldProtectScreen = Boolean(
    settings.enableScreenProtection !== false && isVaultVisible
  );

  useEffect(() => {
    void window.kapsula.setScreenProtection?.(shouldProtectScreen);
  }, [shouldProtectScreen]);

  useEffect(() => {
    return () => {
      void window.kapsula.setScreenProtection?.(false);
    };
  }, []);

  useLayoutEffect(() => {
    if (sidebarElRef.current) {
      sidebarElRef.current.inert = !sidebarOpen;
    }
  }, [sidebarOpen]);

  useLayoutEffect(() => {
    if (feedCanvasRef.current) {
      feedCanvasRef.current.inert = isNoteDocumentOpen;
    }
  }, [isNoteDocumentOpen]);

  const closeStudioCleanly = useCallback(() => {
    if (studioCloseHandlerRef.current) {
      void studioCloseHandlerRef.current();
    } else {
      setStudioOpen(false);
    }
  }, []);

  const navigateTo = useCallback(
    (nextNav: NavView) => {
      if (studioOpen) {
        closeStudioCleanly();
      }
      setNav(nextNav);
    },
    [studioOpen, closeStudioCleanly]
  );

  const handleRegisterStudioClose = useCallback((fn: (() => Promise<void>) | null) => {
    studioCloseHandlerRef.current = fn;
  }, []);

  const handleStudioItemUpdated = useCallback((updated: VaultItem) => {
    setActiveItem(updated);
  }, []);

  const handleStudioDraftPersisted = useCallback((created: VaultItem) => {
    setStudioDraftMode(false);
    setActiveItem(created);
  }, []);

  const handleStudioCancelDraft = useCallback(() => {
    setStudioDraftMode(false);
    setStudioOpen(false);
  }, []);

  const handleStudioSelectRelated = useCallback((rel: VaultItem) => {
    setStudioDraftMode(false);
    setActiveItem(rel);
  }, []);

  const handleStudioClose = useCallback(() => {
    setStudioOpen(false);
  }, []);

  useEffect(() => {
    if (settings.viewLayout && settings.viewLayout !== layoutMode) {
      setLayoutMode(settings.viewLayout);
    }
  }, [settings.viewLayout]);

  useEffect(() => {
    hydrateAppearanceFromSettings(settings.appearance, settings.theme);
  }, [settings.appearance, settings.theme]);

  // Initial data load (active items + lightweight stats; archive/trash load on demand)
  const refreshAll = useCallback(async () => {
    try {
      const needArchived = navRef.current.type === 'archive' || archivedLoadedRef.current;
      const needTrashed = navRef.current.type === 'trash' || trashedLoadedRef.current;
      const [vaultRows, archivedRows, trashedRows, orbitRows, boardRows, taskRows, calRows, stats] =
        await Promise.all([
          window.kapsula.queryVault({ includeSecrets: true, limit: SERVER_ITEM_PAGE }),
          needArchived
            ? window.kapsula.queryVault({
                archivedOnly: true,
                includeSecrets: true,
                limit: 300,
              })
            : Promise.resolve<VaultItem[] | null>(null),
          needTrashed
            ? window.kapsula.queryVault({
                onlyDeleted: true,
                includeSecrets: true,
                limit: 300,
              })
            : Promise.resolve<VaultItem[] | null>(null),
          window.kapsula.listOrbits(),
          window.kapsula.listFocusBoards(),
          window.kapsula.listTasks(),
          window.kapsula.listCalendarEvents(),
          window.kapsula.getStats().catch(() => null),
        ]);
      setItems(vaultRows.filter((row) => !row.isArchived && !row.deletedAt && !row.purgedAt));
      setHasMoreServerItems(vaultRows.length >= SERVER_ITEM_PAGE);
      if (archivedRows !== null) {
        archivedLoadedRef.current = true;
        setArchivedItems(
          archivedRows.filter((row) => row.isArchived && !row.deletedAt && !row.purgedAt)
        );
      }
      if (trashedRows !== null) {
        trashedLoadedRef.current = true;
        setTrashedItems(trashedRows.filter((row) => Boolean(row.deletedAt) && !row.purgedAt));
      }
      if (stats) {
        setVaultStats({
          archivedCount: stats.archivedCount ?? 0,
          trashedCount: stats.trashedCount ?? 0,
        });
      }
      setOrbits(orbitRows);
      setBoards(boardRows);
      setTasks(applyPendingTaskTogglesToTasks(taskRows));
      setCalendarEvents(calRows);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  // Lazy-load archive or trash rows only when the user visits those views
  useEffect(() => {
    if (nav.type === 'archive' && !archivedLoadedRef.current) {
      void window.kapsula
        .queryVault({ archivedOnly: true, includeSecrets: true, limit: 300 })
        .then((rows) => {
          archivedLoadedRef.current = true;
          setArchivedItems(rows.filter((r) => r.isArchived && !r.deletedAt && !r.purgedAt));
        })
        .catch(() => {});
    } else if (nav.type === 'trash' && !trashedLoadedRef.current) {
      void window.kapsula
        .queryVault({ onlyDeleted: true, includeSecrets: true, limit: 300 })
        .then((rows) => {
          trashedLoadedRef.current = true;
          setTrashedItems(rows.filter((r) => Boolean(r.deletedAt) && !r.purgedAt));
        })
        .catch(() => {});
    }
  }, [nav.type]);

  useEffect(() => {
    void refreshAll();
    window.kapsula.getSyncStatus().then(setSyncStatus).catch(() => {});
    const unsubSync = window.kapsula.onSyncStatusUpdated(setSyncStatus);
    const unsubBatch = window.kapsula.onVaultBatchSynced(() => {
      void refreshAll();
    });
    return () => {
      unsubSync();
      unsubBatch();
    };
  }, [refreshAll]);

  const handleOpenItem = useCallback((item: VaultItem) => {
    setStudioDraftMode(false);
    setActiveItem(item);
    setStudioOpen(true);
  }, []);

  const handleOpenBlankDraft = useCallback(() => {
    if (nav.type === 'notes') {
      setNotesDraftTrigger((n) => n + 1);
      return;
    }
    const defaultOrbit = nav.type === 'orbit' ? nav.orbitId : '';
    const defaultBoard = nav.type === 'board' ? nav.boardId : null;
    setActiveItem(makeBlankDraftItem(defaultOrbit, defaultBoard));
    setStudioDraftMode(true);
    setStudioOpen(true);
  }, [nav]);

  const handleOpenBlankDraftRef = useRef(handleOpenBlankDraft);
  handleOpenBlankDraftRef.current = handleOpenBlankDraft;

  // Real-time IPC subscriptions
  useEffect(() => {
    const refreshStatsOnly = () => {
      void window.kapsula
        .getStats()
        .then((st) =>
          setVaultStats({
            archivedCount: st.archivedCount ?? 0,
            trashedCount: st.trashedCount ?? 0,
          })
        )
        .catch(() => {});
    };
    const itemHasTasksOrLoaded = (item: VaultItem) =>
      navRef.current.type === 'tasks' ||
      /\[[ xX]\]/.test(item.body || '') ||
      Boolean(item.mediaMeta?.actionItems?.length) ||
      tasksRef.current.some((t) => t.itemId === item.id);

    const unsubUpsert = window.kapsula.onVaultItemUpserted((rawItem) => {
      const item = applyPendingTaskTogglesToItem(rawItem);
      if (item.purgedAt) {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
        if (archivedLoadedRef.current) {
          setArchivedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (trashedLoadedRef.current) {
          setTrashedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (!archivedLoadedRef.current || !trashedLoadedRef.current) refreshStatsOnly();
      } else if (item.deletedAt) {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
        if (archivedLoadedRef.current) {
          setArchivedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (trashedLoadedRef.current) {
          setTrashedItems((prev) => [item, ...prev.filter((x) => x.id !== item.id)]);
        } else {
          refreshStatsOnly();
        }
      } else if (item.isArchived) {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
        if (trashedLoadedRef.current) {
          setTrashedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (archivedLoadedRef.current) {
          setArchivedItems((prev) => [item, ...prev.filter((x) => x.id !== item.id)]);
        } else {
          refreshStatsOnly();
        }
      } else {
        const wasKnownActive = itemsRef.current.some((x) => x.id === item.id);
        if (archivedLoadedRef.current) {
          setArchivedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (trashedLoadedRef.current) {
          setTrashedItems((prev) => prev.filter((x) => x.id !== item.id));
        }
        if (
          !wasKnownActive &&
          ((!archivedLoadedRef.current && vaultStatsRef.current.archivedCount > 0) ||
            (!trashedLoadedRef.current && vaultStatsRef.current.trashedCount > 0))
        ) {
          refreshStatsOnly();
        }
        setItems((prev) => {
          const idx = prev.findIndex((x) => x.id === item.id);
          if (idx === -1) return [item, ...prev];
          const copy = [...prev];
          copy[idx] = item;
          return copy;
        });
      }
      setActiveItem((prev) => (prev && prev.id === item.id ? item : prev));
      setQuickLookItem((prev) => (prev && prev.id === item.id ? item : prev));
      setLightboxItem((prev) => (prev && prev.id === item.id ? item : prev));
      if (itemHasTasksOrLoaded(item)) {
        void window.kapsula
          .listTasks()
          .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
          .catch(() => {});
      }
    });

    const unsubDelete = window.kapsula.onVaultItemDeleted((id) => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      setArchivedItems((prev) => prev.filter((x) => x.id !== id));
      setTrashedItems((prev) => prev.filter((x) => x.id !== id));
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      setActiveItem((prev) => {
        if (prev && prev.id === id) {
          setStudioOpen(false);
          return null;
        }
        return prev;
      });
      if (trashedLoadedRef.current || navRef.current.type === 'trash') {
        void window.kapsula
          .queryVault({ onlyDeleted: true, includeSecrets: true, limit: 300 })
          .then((rows) => {
            trashedLoadedRef.current = true;
            setTrashedItems(rows.filter((r) => Boolean(r.deletedAt) && !r.purgedAt));
          })
          .catch(() => {});
      }
      if (archivedLoadedRef.current || navRef.current.type === 'archive') {
        void window.kapsula
          .queryVault({ archivedOnly: true, includeSecrets: true, limit: 300 })
          .then((rows) => {
            archivedLoadedRef.current = true;
            setArchivedItems(rows.filter((r) => r.isArchived && !r.deletedAt && !r.purgedAt));
          })
          .catch(() => {});
      }
      if (!trashedLoadedRef.current || !archivedLoadedRef.current) {
        refreshStatsOnly();
      }
      if (navRef.current.type === 'tasks' || tasksRef.current.some((t) => t.itemId === id)) {
        void window.kapsula
          .listTasks()
          .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
          .catch(() => {});
      }
    });

    const unsubOrbits = window.kapsula.onOrbitsChanged(() => {
      void window.kapsula.listOrbits().then(setOrbits).catch(() => {});
    });

    const unsubBoards = window.kapsula.onBoardsChanged(() => {
      void window.kapsula.listFocusBoards().then(setBoards).catch(() => {});
    });

    const unsubCal = window.kapsula.onCalendarChanged(() => {
      void window.kapsula.listCalendarEvents().then(setCalendarEvents).catch(() => {});
      void window.kapsula
        .listTasks()
        .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
        .catch(() => {});
    });

    const unsubFocus = window.kapsula.onFocusItem(async (itemId) => {
      try {
        const found = await window.kapsula.getVaultItem(itemId, { includeDeleted: true });
        if (found) {
          setStudioDraftMode(false);
          setActiveItem(found);
          setStudioOpen(true);
        }
      } catch {
        // ignore
      }
    });

    const unsubNewNote = window.kapsula.onVaultNewNote(() => {
      handleOpenBlankDraftRef.current();
    });

    const unsubOpenCalendar = window.kapsula.onOpenCalendar(() => {
      setStudioOpen(false);
      setNav({ type: 'calendar' });
    });

    const unsubFullScreen = window.kapsula.onWindowFullScreenChanged((fsState) => {
      setIsFullScreen(fsState);
    });
    void window.kapsula.isWindowFullScreen?.().then((fsState) => {
      setIsFullScreen(Boolean(fsState));
    }).catch(() => {});

    const unsubOpenSettings = window.kapsula.onOpenSettings(() => {
      setSettingsOpen(true);
    });

    const unsubFocusSearch = window.kapsula.onFocusSearch(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    const unsubUpdater = window.kapsula.onUpdaterStateChanged?.((nextState) => {
      setUpdaterState(nextState);
    });
    void window.kapsula.getUpdaterState?.().then(setUpdaterState).catch(() => {});

    return () => {
      unsubUpsert();
      unsubDelete();
      unsubOrbits();
      unsubBoards();
      unsubCal();
      unsubFocus();
      unsubNewNote();
      unsubOpenCalendar();
      unsubFullScreen();
      unsubOpenSettings();
      unsubFocusSearch();
      unsubUpdater?.();
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.code === 'KeyF' || e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (mod && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        handleOpenBlankDraft();
      } else if (e.key === ' ' && !mod && !e.altKey && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        const isTyping =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            target.closest('[contenteditable="true"]'));
        if (
          !isTyping &&
          !studioOpen &&
          !lightboxItem &&
          !quickLookItem &&
          !settingsOpen &&
          !newSecretOpen &&
          !triageOpen &&
          !synthesizeOpen &&
          !sectionEditor
        ) {
          const candidate =
            hoveredItemRef.current ??
            (selectedIds.length === 1 ? items.find((x) => x.id === selectedIds[0]) ?? null : null);
          if (candidate && candidate.dna !== 'secret') {
            e.preventDefault();
            setQuickLookItem(candidate);
          }
        }
      } else if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (quickLookItem) {
          setQuickLookItem(null);
          return;
        }
        if (lightboxItem) {
          setLightboxItem(null);
          return;
        }
        if (studioOpen) {
          closeStudioCleanly();
          return;
        }
        if (selectedIds.length > 0) {
          setSelectedIds([]);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    nav.type,
    handleOpenBlankDraft,
    lightboxItem,
    quickLookItem,
    studioOpen,
    settingsOpen,
    newSecretOpen,
    triageOpen,
    synthesizeOpen,
    sectionEditor,
    closeStudioCleanly,
    selectedIds,
    items,
  ]);

  // Debounced bilingual backend search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setServerSearchIds(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.kapsula.queryVault({
          search: q,
          includeSecrets: true,
          limit: 300,
        });
        setServerSearchIds(res.map((r) => r.id));
      } catch {
        setServerSearchIds(null);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // Vault-wide frequency-sorted tags for smart tag autocomplete
  const allVaultTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const list of [items, archivedItems]) {
      for (const entry of list) {
        for (const raw of entry.tags || []) {
          const clean = raw.trim().toLowerCase();
          if (clean) freq.set(clean, (freq.get(clean) ?? 0) + 1);
        }
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
      .map(([tag]) => tag);
  }, [items, archivedItems]);

  // Sidebar live counts
  const orbitMap = useMemo(() => {
    const map = new Map<string, OrbitDef>();
    for (const o of orbits) map.set(o.id, o);
    return map;
  }, [orbits]);

  const counts = useMemo(() => {
    const orbitCounts: Record<string, number> = {};
    const boardCounts: Record<string, number> = {};
    let flowTotal = 0;
    let notesCount = 0;
    let mediaCount = 0;
    let secretCount = 0;
    let unsortedCount = 0;

    for (const item of items) {
      if (item.dna === 'secret') {
        secretCount += 1;
        continue;
      }
      flowTotal += 1;
      if (item.orbit) {
        orbitCounts[item.orbit] = (orbitCounts[item.orbit] ?? 0) + 1;
      } else {
        unsortedCount += 1;
      }
      if (item.focusBoardId) {
        boardCounts[item.focusBoardId] = (boardCounts[item.focusBoardId] ?? 0) + 1;
      }
      if (isDedicatedNote(item)) {
        notesCount += 1;
      }
      if (isMediaItem(item)) {
        mediaCount += 1;
      }
    }

    const openTasksCount = tasks.filter((taskEntry) => !taskEntry.done).length;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const startMs = todayStart.getTime();

    const linkedIdsInEvents = new Set(
      calendarEvents.map((ev) => ev.linkedItemId).filter((id): id is string => Boolean(id)),
    );
    const todayCalendarCount =
      calendarEvents.filter(
        (ev) => !ev.isDone && (ev.endAt >= startMs || ev.startAt >= startMs),
      ).length +
      items.filter(
        (i) =>
          i.remindAt !== null &&
          !i.remindedAt &&
          i.remindAt >= startMs &&
          !linkedIdsInEvents.has(i.id),
      ).length;

    return {
      total: flowTotal,
      notes: notesCount,
      media: mediaCount,
      secrets: secretCount,
      unsorted: unsortedCount,
      openTasks: openTasksCount,
      todayCalendar: todayCalendarCount,
      archived: archivedLoadedRef.current
        ? archivedItems.filter((i) => i.dna !== 'secret').length
        : vaultStats.archivedCount,
      trashed: trashedLoadedRef.current ? trashedItems.length : vaultStats.trashedCount,
      orbits: orbitCounts,
      boards: boardCounts,
    };
  }, [items, archivedItems, trashedItems.length, vaultStats.archivedCount, vaultStats.trashedCount, tasks, calendarEvents]);

  // Filtered & sorted items
  const visibleItems = useMemo(() => {
    const base =
      nav.type === 'archive'
        ? archivedItems
        : nav.type === 'trash'
          ? trashedItems
          : items;
    const q = searchQuery.trim();
    const serverSet = serverSearchIds ? new Set(serverSearchIds) : null;

    const filtered = base.filter((item) => {
      if (nav.type === 'flow') {
        if (item.dna === 'secret') return false;
      } else if (nav.type === 'notes') {
        if (!isDedicatedNote(item)) return false;
      } else if (nav.type === 'media') {
        if (!isMediaItem(item)) return false;
      } else if (nav.type === 'secrets') {
        if (item.dna !== 'secret') return false;
        if (secretKindFilter !== 'all' && item.secretMeta?.kind !== secretKindFilter) {
          return false;
        }
      } else if (nav.type === 'orbit') {
        if (item.dna === 'secret' || item.orbit !== nav.orbitId) return false;
      } else if (nav.type === 'board') {
        if (item.dna === 'secret' || item.focusBoardId !== nav.boardId) return false;
      } else if (nav.type === 'archive') {
        if (item.dna === 'secret') return false;
      }

      if (filterMediaOnly) {
        if (!isMediaItem(item)) return false;
      }
      if (filterPinnedOnly && !item.isPinned) {
        return false;
      }
      if (filterUnsortedOnly && item.orbit) {
        return false;
      }
      if (filterDnaQuick === 'link' && item.dna !== 'link') {
        return false;
      }
      if (filterDnaQuick === 'note' && item.dna !== 'note') {
        return false;
      }
      if (filterDnaQuick === 'voice' && item.dna !== 'voice') {
        return false;
      }

      if (q) {
        if (serverSet && serverSet.has(item.id)) return true;
        const haystack = [
          item.title,
          item.summary,
          item.body,
          item.ocrText,
          item.url,
          item.domain,
          item.tags.join(' '),
          item.secretMeta?.service,
          item.secretMeta?.loginHint,
          item.secretMeta?.cardBrand,
        ]
          .filter(Boolean)
          .join('\n');
        return matchesBilingualHaystack(haystack, q);
      }

      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortOrder === 'flow') {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return getChronologyTime(b) - getChronologyTime(a);
      }
      if (sortOrder === 'created_desc') {
        return b.createdAt - a.createdAt;
      }
      if (sortOrder === 'updated_desc') {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (b.contentUpdatedAt || b.updatedAt) - (a.contentUpdatedAt || a.updatedAt);
      }
      if (sortOrder === 'title_asc') {
        return (a.title || '').localeCompare(b.title || '', dateLocale);
      }
      if (sortOrder === 'media_first') {
        const am = a.dna === 'shot' || a.mediaPath ? 1 : 0;
        const bm = b.dna === 'shot' || b.mediaPath ? 1 : 0;
        if (am !== bm) return bm - am;
        return getChronologyTime(b) - getChronologyTime(a);
      }
      return 0;
    });

    return sorted;
  }, [
    nav,
    items,
    archivedItems,
    trashedItems,
    searchQuery,
    serverSearchIds,
    filterMediaOnly,
    filterPinnedOnly,
    filterUnsortedOnly,
    filterDnaQuick,
    secretKindFilter,
    sortOrder,
    dateLocale,
  ]);

  const activeNavTitle = useMemo(() => {
    switch (nav.type) {
      case 'flow':
        return t('nav.allItems');
      case 'notes':
        return t('nav.notes');
      case 'media':
        return t('nav.media');
      case 'tasks':
        return t('nav.tasks');
      case 'calendar':
        return t('nav.calendar');
      case 'secrets':
        return t('nav.vault');
      case 'archive':
        return t('nav.archive');
      case 'trash':
        return t('nav.trash');
      case 'orbit':
        return orbitMap.get(nav.orbitId)?.name ?? t('nav.sectionFallback');
      case 'board':
        return boards.find((b) => b.id === nav.boardId)?.name ?? t('nav.boardFallback');
    }
  }, [nav, orbitMap, boards, t]);

  const vaultLocked = Boolean(settings.hasMasterPin && !settings.vaultUnlocked);
  const rawWipeSeconds = settings.clipboardAutoWipeSeconds ?? 30;
  const wipeSeconds = rawWipeSeconds === 0 ? 0 : Math.max(5, rawWipeSeconds);
  const soundEnabled = settings.soundTickEnabled;

  const selectableVisibleIds = useMemo(
    () => visibleItems.filter((i) => i.dna !== 'secret').map((i) => i.id),
    [visibleItems],
  );

  useEffect(() => {
    const allowed = new Set(selectableVisibleIds);
    setSelectedIds((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableVisibleIds]);

  const renderedItems = useMemo(
    () => visibleItems.slice(0, feedVisibleCount),
    [visibleItems, feedVisibleCount],
  );

  useEffect(() => {
    setFeedVisibleCount(FEED_PAGE_SIZE);
  }, [
    nav,
    searchQuery,
    filterMediaOnly,
    filterPinnedOnly,
    filterUnsortedOnly,
    filterDnaQuick,
    secretKindFilter,
    sortOrder,
    effectiveLayoutMode,
  ]);

  const loadMoreServerItems = useCallback(async () => {
    if (loadingMoreServerRef.current || !hasMoreServerItems) return;
    loadingMoreServerRef.current = true;
    try {
      const more = await window.kapsula.queryVault({
        includeSecrets: true,
        limit: 1000,
        offset: itemsRef.current.length,
      });
      if (more.length < 1000) {
        setHasMoreServerItems(false);
      }
      if (more.length > 0) {
        setItems((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const extra = more.filter(
            (row) => !seen.has(row.id) && !row.isArchived && !row.deletedAt && !row.purgedAt
          );
          return extra.length > 0 ? [...prev, ...extra] : prev;
        });
        setFeedVisibleCount((prev) => prev + FEED_PAGE_SIZE);
      }
    } catch {
      // ignore transient pagination fetch errors
    } finally {
      loadingMoreServerRef.current = false;
    }
  }, [hasMoreServerItems]);

  const enableAutoAnimate = renderedItems.length <= 60 && !prefersReduced;
  useLayoutEffect(() => {
    enableFeedGridAnim(enableAutoAnimate);
    enableFeedListAnim(enableAutoAnimate);
  }, [enableAutoAnimate, enableFeedGridAnim, enableFeedListAnim]);

  const showFeedPaginationSentinel =
    feedVisibleCount < visibleItems.length ||
    (hasMoreServerItems && nav.type !== 'archive' && nav.type !== 'trash');

  useEffect(() => {
    if (!showFeedPaginationSentinel) return;
    const el = feedSentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (feedVisibleCount < visibleItems.length) {
          setFeedVisibleCount((prev) => Math.min(visibleItems.length, prev + FEED_PAGE_SIZE));
        } else if (hasMoreServerItems && nav.type !== 'archive' && nav.type !== 'trash') {
          void loadMoreServerItems();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showFeedPaginationSentinel, feedVisibleCount, visibleItems.length, hasMoreServerItems, nav.type, loadMoreServerItems]);

  // Handlers
  const handleToggleTheme = async () => {
    const nextTheme = settings.theme === 'light' ? 'dark' : 'light';
    const applyDomTheme = () => {
      document.documentElement.setAttribute('data-theme', nextTheme);
      hydrateAppearanceFromSettings(settings.appearance, nextTheme);
      onSettingsUpdated({ ...settings, theme: nextTheme });
    };

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    if (typeof doc.startViewTransition === 'function') {
      document.documentElement.classList.add('k-theme-switching');
      try {
        const vt = doc.startViewTransition(applyDomTheme);
        void vt.finished.finally(() => {
          document.documentElement.classList.remove('k-theme-switching');
        });
      } catch {
        document.documentElement.classList.remove('k-theme-switching');
        applyDomTheme();
      }
    } else {
      applyDomTheme();
    }

    try {
      const updated = await window.kapsula.updateSettings({ theme: nextTheme });
      onSettingsUpdated(updated);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleLayoutChange = (next: ViewLayoutMode) => {
    if (nav.type === 'board') {
      setBoardViewOverride(next);
      return;
    }
    setLayoutMode(next);
    void window.kapsula
      .updateSettings({ viewLayout: next })
      .then(onSettingsUpdated)
      .catch(() => {});
  };

  const handleOpenItemById = useCallback(
    async (itemId: string) => {
      const existing = items.find((i) => i.id === itemId);
      if (existing) {
        handleOpenItem(existing);
        return;
      }
      try {
        const all = await window.kapsula.queryVault({
          includeSecrets: true,
          includeArchived: true,
          limit: 500,
        });
        const found = all.find((x) => x.id === itemId);
        if (found) handleOpenItem(found);
      } catch {
        // ignore
      }
    },
    [items, handleOpenItem],
  );

  const handleToggleSelect = useCallback(
    (item: VaultItem, shiftKey: boolean) => {
      if (item.dna === 'secret') return;
      setSelectedIds((prev) => {
        if (shiftKey && lastSelectedIdRef.current) {
          const ids = selectableVisibleIds;
          const from = ids.indexOf(lastSelectedIdRef.current);
          const to = ids.indexOf(item.id);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            const merged = new Set(prev);
            for (const rid of ids.slice(start, end + 1)) merged.add(rid);
            return Array.from(merged);
          }
        }
        lastSelectedIdRef.current = item.id;
        return prev.includes(item.id)
          ? prev.filter((id) => id !== item.id)
          : [...prev, item.id];
      });
    },
    [selectableVisibleIds],
  );

  const handleDeleteItem = async (id: string) => {
    try {
      const ok = await window.kapsula.deleteItem(id);
      if (!ok) {
        toast.error(t('workspace.toast.trashFailed'));
        void refreshAll();
        return;
      }
      toast(t('workspace.toast.movedToTrash'), {
        action: {
          label: t('common.undo'),
          onClick: () => {
            void handleRestoreItem(id);
          },
        },
      });
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleRestoreItem = async (id: string) => {
    try {
      const restored = await window.kapsula.restoreItem(id);
      if (!restored) {
        toast.error(t('workspace.toast.restoreFailed'));
        void refreshAll();
        return;
      }
      setTrashedItems((prev) => prev.filter((x) => x.id !== id));
      toast.success(t('workspace.toast.restored'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleUnarchiveItem = async (id: string) => {
    try {
      const updated = await window.kapsula.updateItem(id, { isArchived: false });
      if (updated) {
        setArchivedItems((prev) => prev.filter((x) => x.id !== id));
        toast.success(t('workspace.toast.unarchived'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handlePurgeItem = async (id: string) => {
    setTrashActionBusy(true);
    try {
      const ok = await window.kapsula.purgeItem(id);
      if (!ok) {
        toast.error(t('workspace.toast.purgeFailed'));
        void refreshAll();
        return;
      }
      setTrashedItems((prev) => prev.filter((x) => x.id !== id));
      setConfirmPurgeItem(null);
      toast.success(t('workspace.toast.purged'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setTrashActionBusy(false);
    }
  };

  const handleEmptyTrash = async () => {
    setTrashActionBusy(true);
    try {
      const res = await window.kapsula.emptyTrash();
      setTrashedItems([]);
      setConfirmEmptyTrashOpen(false);
      toast.success(
        res.purgedCount > 0
          ? t('workspace.toast.trashEmptied', { count: res.purgedCount })
          : t('workspace.toast.trashAlreadyEmpty')
      );
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setTrashActionBusy(false);
    }
  };

  const handleTogglePin = async (item: VaultItem) => {
    try {
      await window.kapsula.updateItem(item.id, { isPinned: !item.isPinned });
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleMoveToOrbit = async (itemId: string, orbitId: string) => {
    try {
      const updated = await window.kapsula.updateItem(itemId, { orbit: orbitId });
      if (updated) {
        setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleMoveToBoard = async (itemId: string, boardId: string | null) => {
    try {
      const updated = await window.kapsula.updateItem(itemId, { focusBoardId: boardId });
      if (updated) {
        setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleToggleNotesHub = useCallback(
    async (target: VaultItem, inNotesHub: boolean) => {
      try {
        const updated = await window.kapsula.updateItem(target.id, {
          mediaMeta: { ...(target.mediaMeta ?? {}), inNotesHub },
        });
        if (updated) {
          setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
          setActiveItem((prev) => (prev && prev.id === updated.id ? updated : prev));
        }
        toast.success(
          t(inNotesHub ? 'notes.hub.addedToNotesToast' : 'notes.hub.removedFromNotesToast')
        );
      } catch (err) {
        toast.error(friendlyErrorMessage(err, undefined, locale));
      }
    },
    [locale, t]
  );

  const handleDropItemOnNotes = useCallback(
    async (itemId: string) => {
      let target = items.find((it) => it.id === itemId);
      if (!target) {
        try {
          const rows = await window.kapsula.queryVault({ includeSecrets: false, limit: 500 });
          target = rows.find((it) => it.id === itemId);
        } catch {
          target = undefined;
        }
      }
      if (!target) return;
      if (target.dna !== 'note' && target.dna !== 'snippet') return;
      await handleToggleNotesHub(target, true);
    },
    [items, handleToggleNotesHub]
  );

  const handleDuplicateItem = async (itemId: string) => {
    try {
      const dup = await window.kapsula.duplicateItem(itemId);
      if (dup) toast.success(t('workspace.toast.duplicated'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleExportMarkdown = async (itemId: string) => {
    try {
      const res = await window.kapsula.exportMarkdown(itemId);
      if (res.saved) {
        toast.success(t('workspace.toast.exportedMd'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const executeOptimisticTaskToggle = useCallback(
    async (
      itemId: string,
      sourceType: 'markdown' | 'voice_action',
      taskIndex: number,
      done: boolean,
      opts?: { refreshTasksAfter?: boolean }
    ) => {
      const key = `${itemId}:${sourceType}:${taskIndex}`;
      const seq = ++taskToggleSeqRef.current;
      const prevDone = !done;
      pendingTaskTogglesRef.current.set(key, { itemId, sourceType, taskIndex, done, seq });

      const patchList = (list: VaultItem[]) => {
        let changed = false;
        const next = list.map((it) => {
          if (it.id !== itemId) return it;
          const patched = applyOptimisticTaskToItem(it, sourceType, taskIndex, done);
          if (patched !== it) changed = true;
          return patched;
        });
        return changed ? next : list;
      };

      // Synchronous 0ms optimistic update BEFORE awaiting IPC
      setItems(patchList);
      setArchivedItems(patchList);
      setActiveItem((prev) =>
        prev && prev.id === itemId
          ? applyOptimisticTaskToItem(prev, sourceType, taskIndex, done)
          : prev
      );
      setQuickLookItem((prev) =>
        prev && prev.id === itemId
          ? applyOptimisticTaskToItem(prev, sourceType, taskIndex, done)
          : prev
      );
      setTasks((prev) =>
        prev.map((taskEntry) =>
          taskEntry.itemId === itemId && taskEntry.sourceType === sourceType && taskEntry.taskIndex === taskIndex
            ? {
                ...taskEntry,
                done,
                columnId: done ? 'done' : taskEntry.columnId === 'done' ? 'inbox' : taskEntry.columnId,
              }
            : taskEntry
        )
      );

      try {
        await window.kapsula.toggleTask({
          itemId,
          sourceType,
          taskIndex,
          done,
        });
        const current = pendingTaskTogglesRef.current.get(key);
        if (current && current.seq === seq) {
          pendingTaskTogglesRef.current.delete(key);
        }
        if (opts?.refreshTasksAfter) {
          void window.kapsula
            .listTasks()
            .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
            .catch(() => {});
        }
      } catch (err) {
        const current = pendingTaskTogglesRef.current.get(key);
        if (current && current.seq === seq) {
          pendingTaskTogglesRef.current.delete(key);
          const revertList = (list: VaultItem[]) =>
            list.map((it) =>
              it.id === itemId ? applyOptimisticTaskToItem(it, sourceType, taskIndex, prevDone) : it
            );
          setItems(revertList);
          setArchivedItems(revertList);
          setActiveItem((prev) =>
            prev && prev.id === itemId
              ? applyOptimisticTaskToItem(prev, sourceType, taskIndex, prevDone)
              : prev
          );
          setQuickLookItem((prev) =>
            prev && prev.id === itemId
              ? applyOptimisticTaskToItem(prev, sourceType, taskIndex, prevDone)
              : prev
          );
          setTasks((prev) =>
            prev.map((taskEntry) =>
              taskEntry.itemId === itemId && taskEntry.sourceType === sourceType && taskEntry.taskIndex === taskIndex
                ? { ...taskEntry, done: prevDone }
                : taskEntry
            )
          );
          void window.kapsula
            .listTasks()
            .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
            .catch(() => {});
        }
        toast.error(friendlyErrorMessage(err, undefined, locale));
        throw err;
      }
    },
    [applyPendingTaskTogglesToTasks, locale]
  );

  const handleToggleMarkdownTask = async (
    itemId: string,
    taskIndex: number,
    done: boolean,
  ) => {
    try {
      await executeOptimisticTaskToggle(itemId, 'markdown', taskIndex, done);
    } catch {
      // rollback + error toast handled inside executeOptimisticTaskToggle
    }
  };

  const handleToggleVoiceAction = async (
    itemId: string,
    actionIdx: number,
    done: boolean,
  ) => {
    try {
      await executeOptimisticTaskToggle(itemId, 'voice_action', actionIdx, done);
    } catch {
      // rollback + error toast handled inside executeOptimisticTaskToggle
    }
  };

  const handleToggleVaultTask = useCallback(
    async (task: VaultTaskEntry) => {
      await executeOptimisticTaskToggle(
        task.itemId,
        task.sourceType,
        task.taskIndex,
        !task.done,
        { refreshTasksAfter: true }
      );
    },
    [executeOptimisticTaskToggle]
  );

  const handleCaptureClipboardQuick = async () => {
    try {
      const captured = await window.kapsula.captureClipboard({
        orbitOverride: nav.type === 'orbit' ? nav.orbitId : undefined,
        focusBoardId: nav.type === 'board' ? nav.boardId : undefined,
      });
      if (captured) {
        toast.success(t('workspace.toast.pastedClipboard'));
      } else {
        toast(t('workspace.toast.clipboardEmpty'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  // Bulk actions
  const selectedItems = useMemo(() => {
    const set = new Set(selectedIds);
    return items.filter((i) => set.has(i.id));
  }, [items, selectedIds]);

  const handleBulkMoveOrbit = async (orbitId: string) => {
    setBulkOrbitMenuOpen(false);
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const settled = await Promise.allSettled(
        ids.map((id) => window.kapsula.updateItem(id, { orbit: orbitId }))
      );
      const okCount = settled.filter((r) => r.status === 'fulfilled' && r.value).length;
      const failedCount = ids.length - okCount;
      if (okCount > 0) {
        toast.success(t('workspace.toast.movedCount', { count: okCount }));
      }
      if (failedCount > 0) {
        toast.error(t('common.saveError'));
      }
      if (failedCount === 0) {
        setSelectedIds([]);
      }
      void refreshAll();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleBulkPin = async (pin: boolean) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const settled = await Promise.allSettled(
        ids.map((id) => window.kapsula.updateItem(id, { isPinned: pin }))
      );
      const okCount = settled.filter((r) => r.status === 'fulfilled' && r.value).length;
      const failedCount = ids.length - okCount;
      if (okCount > 0) {
        toast.success(
          pin
            ? t('workspace.toast.pinnedCount', { count: okCount })
            : t('workspace.toast.unpinnedCount', { count: okCount })
        );
      }
      if (failedCount > 0) {
        toast.error(t('common.saveError'));
      }
      if (failedCount === 0) {
        setSelectedIds([]);
      }
      void refreshAll();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      const settled = await Promise.allSettled(ids.map((id) => window.kapsula.deleteItem(id)));
      const deletedIds = ids.filter((_, i) => {
        const res = settled[i];
        return res?.status === 'fulfilled' && res.value === true;
      });
      if (deletedIds.length === 0) {
        toast.error(t('workspace.toast.trashBulkFailed'));
        void refreshAll();
        return;
      }
      if (deletedIds.length < ids.length) {
        toast.error(t('common.saveError'));
      }
      toast(t('workspace.toast.movedToTrashCount', { count: deletedIds.length }), {
        action: {
          label: t('common.undo'),
          onClick: () => {
            void Promise.allSettled(deletedIds.map((id) => window.kapsula.restoreItem(id)))
              .catch(() => {})
              .finally(() => {
                void refreshAll();
              });
          },
        },
      });
      if (deletedIds.length === ids.length) {
        setSelectedIds([]);
      }
      void refreshAll();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  // Orbits & Boards CRUD
  const handleSaveSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sectionEditor) return;
    const trimmed = sectionEditor.name.trim();
    if (!trimmed) {
      toast.error(t('nav.enterName'));
      return;
    }
    setSectionSaving(true);
    try {
      if (sectionEditor.kind === 'orbit') {
        if (sectionEditor.mode === 'create') {
          const created = await window.kapsula.createOrbit({
            name: trimmed,
            description: sectionEditor.description.trim(),
            color: sectionEditor.color,
            icon: sectionEditor.icon,
          });
          setNav({ type: 'orbit', orbitId: created.id });
          toast.success(t('nav.sectionCreated', { name: created.name }));
        } else if (sectionEditor.id) {
          await window.kapsula.updateOrbit(sectionEditor.id, {
            name: trimmed,
            description: sectionEditor.description.trim(),
            color: sectionEditor.color,
            icon: sectionEditor.icon,
          });
          toast.success(t('nav.sectionUpdated'));
        }
      } else {
        if (sectionEditor.mode === 'create') {
          const created = await window.kapsula.createFocusBoard(
            trimmed,
            sectionEditor.color,
            sectionEditor.icon,
            sectionEditor.description.trim(),
          );
          setNav({ type: 'board', boardId: created.id });
          toast.success(t('nav.boardCreated', { name: created.name }));
        } else if (sectionEditor.id) {
          await window.kapsula.updateFocusBoard(sectionEditor.id, {
            name: trimmed,
            description: sectionEditor.description.trim(),
            color: sectionEditor.color,
            icon: sectionEditor.icon,
          });
          toast.success(t('nav.boardUpdated'));
        }
      }
      setSectionEditor(null);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    } finally {
      setSectionSaving(false);
    }
  };

  const handleMoveOrbitByStep = async (orbitId: string, delta: -1 | 1) => {
    const idx = orbits.findIndex((o) => o.id === orbitId);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= orbits.length) return;
    const prevOrbits = orbits;
    const next = [...orbits];
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(targetIdx, 0, moved);
    setOrbits(next);
    try {
      await window.kapsula.reorderOrbits(next.map((o) => o.id));
    } catch (err) {
      setOrbits(prevOrbits);
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleDeleteOrbit = async (orbit: OrbitDef) => {
    try {
      await window.kapsula.deleteOrbit(orbit.id);
      if (nav.type === 'orbit' && nav.orbitId === orbit.id) {
        setNav({ type: 'flow' });
      }
      toast.success(t('nav.sectionDeleted', { name: orbit.name }));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleMoveBoardByStep = async (boardId: string, delta: -1 | 1) => {
    const idx = boards.findIndex((b) => b.id === boardId);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= boards.length) return;
    const prevBoards = boards;
    const next = [...boards];
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(targetIdx, 0, moved);
    setBoards(next);
    try {
      await window.kapsula.reorderFocusBoards(next.map((b) => b.id));
    } catch (err) {
      setBoards(prevBoards);
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleDeleteBoard = async (board: FocusBoard) => {
    try {
      await window.kapsula.deleteFocusBoard(board.id);
      if (nav.type === 'board' && nav.boardId === board.id) {
        setNav({ type: 'flow' });
      }
      toast.success(t('nav.boardDeleted', { name: board.name }));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const activeFiltersCount =
    (filterMediaOnly ? 1 : 0) +
    (filterPinnedOnly ? 1 : 0) +
    (filterUnsortedOnly ? 1 : 0) +
    (filterDnaQuick !== 'all' ? 1 : 0);

  const synthesizeItemsList = useMemo(() => {
    if (synthesizeSeedIds && synthesizeSeedIds.length > 0) {
      const set = new Set(synthesizeSeedIds);
      return items.filter((i) => set.has(i.id));
    }
    return selectedItems;
  }, [items, selectedItems, synthesizeSeedIds]);

  const showFeedToolbar =
    nav.type !== 'notes' &&
    nav.type !== 'media' &&
    nav.type !== 'tasks' &&
    nav.type !== 'calendar' &&
    nav.type !== 'secrets' &&
    nav.type !== 'archive' &&
    nav.type !== 'trash';

  const feedBackgroundMenuEntries: ContextMenuEntry[] = useMemo(
    () => [
      {
        type: 'item',
        id: 'bg-new-note',
        label: t('workspace.newNote'),
        shortcut: isMac ? '⌘N' : 'Ctrl+N',
        icon: <NotePencil className="w-3.5 h-3.5" />,
        onSelect: () => handleOpenBlankDraft(),
      },
      {
        type: 'item',
        id: 'bg-paste',
        label: t('workspace.pasteClipboard'),
        icon: <ClipboardText className="w-3.5 h-3.5" />,
        onSelect: () => void handleCaptureClipboardQuick(),
      },
      { type: 'separator', id: 'bg-sep-1' },
      {
        type: 'item',
        id: 'bg-new-orbit',
        label: t('nav.createSection'),
        icon: <Plus className="w-3.5 h-3.5" />,
        onSelect: () =>
          setSectionEditor({
            kind: 'orbit',
            mode: 'create',
            name: '',
            description: '',
            color: SECTION_COLOR_PALETTE[0]!,
            icon: 'Folder',
          }),
      },
      {
        type: 'item',
        id: 'bg-triage',
        label: t('triage.title'),
        icon: <FunnelSimple className="w-3.5 h-3.5" />,
        onSelect: () => setTriageOpen(true),
      },
      {
        type: 'item',
        id: 'bg-hud',
        label: t('workspace.quickLaunchHint', {
          shortcut:
            formatShortcutCompact(settings.hudShortcut, platform, locale) ||
            formatShortcutCompact('Alt+Space', platform, locale),
        }),
        icon: <Sparkle className="w-3.5 h-3.5" />,
        onSelect: () => void window.kapsula.windowAction('open-hud'),
      },
    ],
    [handleOpenBlankDraft, isMac, platform, settings.hudShortcut, t, locale],
  );

  return (
    <div
      data-testid="studio-workspace"
      className="h-screen w-screen flex flex-row overflow-hidden bg-[var(--k-bg-canvas)] text-[var(--k-ink-primary)] select-none"
    >
      {/* Full-Height Animated Left Sidebar (Linear/Things split-shell: glides width smoothly in lockstep with workspace) */}
      <motion.aside
        ref={sidebarElRef}
        key="workspace-sidebar"
        data-testid="workspace-sidebar"
        aria-hidden={!sidebarOpen}
        initial={false}
        animate={
          sidebarOpen
            ? { width: 244, opacity: 1 }
            : { width: 0, opacity: 0 }
        }
        transition={
          prefersReduced
            ? { duration: 0.08 }
            : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }
        }
        style={{ pointerEvents: sidebarOpen ? 'auto' : 'none' }}
        className={`shrink-0 h-full overflow-hidden bg-[var(--k-bg-rail)] flex flex-col ${
          sidebarOpen ? 'border-r border-[var(--k-border-hairline)]' : ''
        }`}
      >
        <div className="w-[244px] h-full flex flex-col">
          {/* Sidebar Integrated Top Brand Bar (draggable; reserves macOS traffic-light safe zone) */}
          <div
            className={`h-[46px] shrink-0 flex items-center justify-between k-drag-region transition-[padding] duration-150 ${
              showTrafficLights ? 'pl-[82px] pr-3' : 'px-3'
            }`}
          >
            <button
              type="button"
              onClick={() => navigateTo({ type: 'flow' })}
              className="k-no-drag flex items-center gap-2 min-w-0 rounded-lg px-1 py-1 hover:bg-[var(--k-bg-surface-2)]/70 transition-colors cursor-pointer"
            >
              <KapsulaEmblem size={19} className="shrink-0 text-[var(--k-ink-primary)]" />
              <span className="k-display font-semibold text-[13.5px] tracking-[-0.02em] text-[var(--k-ink-primary)]">
                Kapsula
              </span>
            </button>

            <TooltipHint label={t('nav.collapseSidebar')}>
              <button
                type="button"
                data-testid="toggle-sidebar-btn"
                onClick={() => setSidebarOpen(false)}
                className="k-no-drag k-interactive w-7 h-7 rounded-[7px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                aria-label={t('nav.collapseSidebar')}
              >
                <SidebarSimple size={16} />
              </button>
            </TooltipHint>
          </div>

          <div className="flex-1 min-h-0 flex flex-col px-2.5 pb-2.5 pt-1 gap-3">
            {/* Core views pinned cleanly above scrollable sections */}
            <div className="space-y-0.5 shrink-0" data-testid="sidebar-primary-nav-list">
              {visiblePrimaryNavSections.map((sec, visIdx) => {
                const navMeta = (() => {
                  switch (sec) {
                    case 'flow':
                      return {
                        navView: { type: 'flow' } as NavView,
                        icon: <Tray size={16} />,
                        label: t('nav.allItems'),
                        count: counts.total,
                        testId: 'nav-flow',
                      };
                    case 'notes':
                      return {
                        navView: { type: 'notes' } as NavView,
                        icon: <NotePencil size={16} />,
                        label: t('nav.notes'),
                        count: counts.notes,
                        testId: 'nav-notes',
                      };
                    case 'media':
                      return {
                        navView: { type: 'media' } as NavView,
                        icon: <ImageIcon size={16} />,
                        label: t('nav.media'),
                        count: counts.media,
                        testId: 'nav-media',
                      };
                    case 'tasks':
                      return {
                        navView: { type: 'tasks' } as NavView,
                        icon: <CheckSquare size={16} />,
                        label: t('nav.tasks'),
                        count: counts.openTasks,
                        testId: 'nav-tasks',
                      };
                    case 'calendar':
                      return {
                        navView: { type: 'calendar' } as NavView,
                        icon: <CalendarBlank size={16} />,
                        label: t('nav.calendar'),
                        count: counts.todayCalendar,
                        testId: 'nav-calendar',
                      };
                    case 'secrets':
                      return {
                        navView: { type: 'secrets' } as NavView,
                        icon: vaultLocked ? <LockKey size={16} /> : <LockSimpleOpen size={16} />,
                        label: t('nav.vault'),
                        count: counts.secrets,
                        testId: 'nav-secrets',
                      };
                  }
                })();

                const navMenu: ContextMenuEntry[] = [
                  {
                    type: 'item',
                    id: `up-${sec}`,
                    label: t('nav.moveUp'),
                    icon: <ArrowUp className="w-3.5 h-3.5" />,
                    disabled: visIdx === 0,
                    onSelect: () => handleMovePrimaryNavByStep(sec, -1),
                  },
                  {
                    type: 'item',
                    id: `down-${sec}`,
                    label: t('nav.moveDown'),
                    icon: <ArrowDown className="w-3.5 h-3.5" />,
                    disabled: visIdx === visiblePrimaryNavSections.length - 1,
                    onSelect: () => handleMovePrimaryNavByStep(sec, 1),
                  },
                ];
                if (sec !== 'flow') {
                  navMenu.push(
                    { type: 'separator', id: `sep-hide-${sec}` },
                    {
                      type: 'item',
                      id: `hide-${sec}`,
                      label: t('nav.hideFromSidebar'),
                      icon: <EyeSlash className="w-3.5 h-3.5" />,
                      onSelect: () => handleHideNavSection(sec as HideableNavSection),
                    }
                  );
                }

                const dropPosition =
                  primaryNavDropTarget?.id === sec && dragPrimaryNavId !== sec
                    ? primaryNavDropTarget.position
                    : null;
                const isCardDropOver = sec === 'notes' && cardDropTargetId === 'nav-notes';

                return (
                  <ContextMenuSurface key={sec} entries={navMenu}>
                    <SidebarNavButton
                      active={isSameNav(nav, navMeta.navView)}
                      icon={navMeta.icon}
                      label={navMeta.label}
                      count={navMeta.count}
                      testId={navMeta.testId}
                      draggable
                      isDragging={dragPrimaryNavId === sec}
                      isCardDropOver={isCardDropOver}
                      dropPosition={dropPosition}
                      onClick={() => navigateTo(navMeta.navView)}
                      onDragStart={(e) => {
                        setDragPrimaryNavId(sec);
                        setPrimaryNavDropTarget(null);
                        e.dataTransfer.setData('text/kapsula-sidebar-nav', sec);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => {
                        const isCardDrag =
                          !dragPrimaryNavId &&
                          !dragOrbitId &&
                          !dragBoardId &&
                          hasDragType(e, 'text/kapsula-item-id');
                        if (sec === 'notes' && isCardDrag) {
                          if (!hasDragType(e, 'text/kapsula-item-non-note')) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setCardDropTargetId('nav-notes');
                            setPrimaryNavDropTarget(null);
                          }
                          return;
                        }
                        const isNavDrag =
                          Boolean(dragPrimaryNavId) || hasDragType(e, 'text/kapsula-sidebar-nav');
                        if (!isNavDrag || isCardDrag) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragPrimaryNavId === sec) {
                          setPrimaryNavDropTarget(null);
                          return;
                        }
                        const position = computeDropPosition(e);
                        setPrimaryNavDropTarget((prev) =>
                          prev?.id === sec && prev.position === position
                            ? prev
                            : { id: sec, position }
                        );
                        setCardDropTargetId(null);
                      }}
                      onDragLeave={(e) => {
                        const nextTarget = e.relatedTarget as Node | null;
                        if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                        setPrimaryNavDropTarget((prev) => (prev?.id === sec ? null : prev));
                        if (sec === 'notes') {
                          setCardDropTargetId((prev) => (prev === 'nav-notes' ? null : prev));
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedItemId = e.dataTransfer.getData('text/kapsula-item-id');
                        if (sec === 'notes' && droppedItemId && !dragPrimaryNavId) {
                          clearSidebarDragStates();
                          void handleDropItemOnNotes(droppedItemId);
                          return;
                        }
                        const fromId = (dragPrimaryNavId ||
                          e.dataTransfer.getData('text/kapsula-sidebar-nav')) as
                          | PrimaryNavSection
                          | '';
                        const pos =
                          primaryNavDropTarget?.id === sec
                            ? primaryNavDropTarget.position
                            : computeDropPosition(e);
                        clearSidebarDragStates();
                        if (!fromId || fromId === sec) return;
                        handleReorderPrimaryNav(fromId, sec, pos);
                      }}
                      onDragEnd={clearSidebarDragStates}
                    />
                  </ContextMenuSurface>
                );
              })}
            </div>

            {/* Independently scrollable user Sections + Visual Boards */}
            <div className="flex-1 min-h-0 overflow-y-auto k-scroll-hidden space-y-4">
              {/* Sections (Orbits) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                    {t('nav.sections')}
                  </span>
                  <TooltipHint label={t('nav.newSection')}>
                    <button
                      type="button"
                      data-testid="add-orbit-btn"
                      onClick={() =>
                        setSectionEditor({
                          kind: 'orbit',
                          mode: 'create',
                          name: '',
                          description: '',
                          color: SECTION_COLOR_PALETTE[0]!,
                          icon: 'Folder',
                        })
                      }
                      className="k-interactive w-5 h-5 rounded-[6px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      aria-label={t('nav.createSection')}
                    >
                      <Plus size={13} weight="bold" />
                    </button>
                  </TooltipHint>
                </div>

                <div className="space-y-0.5" data-testid="sidebar-orbits-list">
                  {orbits.map((orbit, idx) => {
                    const active = nav.type === 'orbit' && nav.orbitId === orbit.id;
                    const dropPosition =
                      orbitDropTarget?.id === orbit.id && dragOrbitId !== orbit.id
                        ? orbitDropTarget.position
                        : null;
                    const isCardDropOver = cardDropTargetId === `orbit:${orbit.id}`;
                    const orbitMenu: ContextMenuEntry[] = [
                      {
                        type: 'item',
                        id: 'edit',
                        label: t('nav.configureAndRename'),
                        icon: <PencilSimple className="w-3.5 h-3.5" />,
                        onSelect: () =>
                          setSectionEditor({
                            kind: 'orbit',
                            mode: 'edit',
                            id: orbit.id,
                            name: orbit.name,
                            description: orbit.description ?? '',
                            color: orbit.color,
                            icon: orbit.icon || 'Folder',
                          }),
                      },
                      {
                        type: 'item',
                        id: 'up',
                        label: t('nav.moveUp'),
                        icon: <ArrowUp className="w-3.5 h-3.5" />,
                        disabled: idx === 0,
                        onSelect: () => void handleMoveOrbitByStep(orbit.id, -1),
                      },
                      {
                        type: 'item',
                        id: 'down',
                        label: t('nav.moveDown'),
                        icon: <ArrowDown className="w-3.5 h-3.5" />,
                        disabled: idx === orbits.length - 1,
                        onSelect: () => void handleMoveOrbitByStep(orbit.id, 1),
                      },
                      { type: 'separator', id: 'sep-del' },
                      {
                        type: 'item',
                        id: 'delete',
                        label: t('nav.deleteSection'),
                        icon: <Trash className="w-3.5 h-3.5" />,
                        danger: true,
                        onSelect: () => void handleDeleteOrbit(orbit),
                      },
                    ];

                    return (
                      <ContextMenuSurface key={orbit.id} entries={orbitMenu}>
                        <div
                          draggable
                          data-testid={`sidebar-orbit-${orbit.id}`}
                          onDragStart={(e) => {
                            setDragOrbitId(orbit.id);
                            setOrbitDropTarget(null);
                            e.dataTransfer.setData('text/kapsula-sidebar-orbit', orbit.id);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver={(e) => {
                            const isCardDrag =
                              !dragOrbitId &&
                              !dragPrimaryNavId &&
                              !dragBoardId &&
                              hasDragType(e, 'text/kapsula-item-id');
                            if (isCardDrag) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              setCardDropTargetId(`orbit:${orbit.id}`);
                              setOrbitDropTarget(null);
                              return;
                            }
                            const isOrbitDrag =
                              Boolean(dragOrbitId) || hasDragType(e, 'text/kapsula-sidebar-orbit');
                            if (!isOrbitDrag) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dragOrbitId === orbit.id) {
                              setOrbitDropTarget(null);
                              return;
                            }
                            const position = computeDropPosition(e);
                            setOrbitDropTarget((prev) =>
                              prev?.id === orbit.id && prev.position === position
                                ? prev
                                : { id: orbit.id, position }
                            );
                            setCardDropTargetId(null);
                          }}
                          onDragLeave={(e) => {
                            const nextTarget = e.relatedTarget as Node | null;
                            if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                            setOrbitDropTarget((prev) => (prev?.id === orbit.id ? null : prev));
                            setCardDropTargetId((prev) =>
                              prev === `orbit:${orbit.id}` ? null : prev
                            );
                          }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            const droppedItemId = e.dataTransfer.getData('text/kapsula-item-id');
                            if (droppedItemId && !dragOrbitId) {
                              clearSidebarDragStates();
                              await handleMoveToOrbit(droppedItemId, orbit.id);
                              return;
                            }
                            const fromId =
                              dragOrbitId || e.dataTransfer.getData('text/kapsula-sidebar-orbit');
                            const pos =
                              orbitDropTarget?.id === orbit.id
                                ? orbitDropTarget.position
                                : computeDropPosition(e);
                            clearSidebarDragStates();
                            if (!fromId || fromId === orbit.id) return;
                            const next = reorderByDrop(
                              orbits,
                              orbits.findIndex((o) => o.id === fromId),
                              orbits.findIndex((o) => o.id === orbit.id),
                              pos
                            );
                            if (!next) return;
                            setOrbits(next);
                            await window.kapsula.reorderOrbits(next.map((o) => o.id));
                          }}
                          onDragEnd={clearSidebarDragStates}
                          onClick={() => navigateTo({ type: 'orbit', orbitId: orbit.id })}
                          className={`k-interactive group relative flex items-center h-8 px-2 rounded-[8px] cursor-pointer ${
                            active
                              ? 'text-[var(--k-ink-primary)] font-medium'
                              : isCardDropOver
                                ? 'bg-[var(--k-accent-soft)]/80 text-[var(--k-ink-primary)]'
                                : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                          } ${dragOrbitId === orbit.id ? 'opacity-45' : ''}`}
                        >
                          {dropPosition ? <SidebarDropLine position={dropPosition} /> : null}
                          {active ? (
                            <motion.span
                              layoutId="sidebar-active-pill"
                              transition={
                                prefersReduced
                                  ? { duration: 0 }
                                  : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }
                              }
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 rounded-[8px] bg-[var(--k-accent-soft)]"
                            />
                          ) : null}
                          <span className="relative z-10 shrink-0 w-4 h-4 mr-2 flex items-center justify-center">
                            <SectionIcon
                              name={orbit.icon || 'Folder'}
                              color={orbit.color}
                              className="w-[15px] h-[15px]"
                            />
                          </span>
                          <span className="relative z-10 flex-1 min-w-0 truncate text-[13px]">
                            {orbit.name}
                          </span>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSectionEditor({
                                kind: 'orbit',
                                mode: 'edit',
                                id: orbit.id,
                                name: orbit.name,
                                description: orbit.description ?? '',
                                color: orbit.color,
                                icon: orbit.icon || 'Folder',
                              });
                            }}
                            className="relative z-10 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto w-5 h-5 mr-1 rounded-[5px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] transition-opacity shrink-0"
                            aria-label={t('nav.configureSection')}
                          >
                            <PencilSimple size={12} />
                          </button>

                          <span
                            data-testid={`orbit-count-${orbit.id}`}
                            className="relative z-10 shrink-0 w-[26px] text-right text-[11.5px] k-tabular text-[var(--k-ink-muted)]"
                          >
                            <NumberFlow value={counts.orbits[orbit.id] ?? 0} />
                          </span>
                        </div>
                      </ContextMenuSurface>
                    );
                  })}
                  {orbits.length === 0 ? (
                    <div className="px-2 py-2 text-[11.5px] text-[var(--k-ink-muted)]">
                      {t('nav.noSectionsHint')}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Visual Boards (Focus Boards) */}
              {!hiddenNavSet.has('boards') ? (
              <div className="space-y-1">
                <ContextMenuSurface
                  entries={[
                    {
                      type: 'item',
                      id: 'hide-boards',
                      label: t('nav.hideFromSidebar'),
                      icon: <EyeSlash className="w-3.5 h-3.5" />,
                      onSelect: () => handleHideNavSection('boards'),
                    },
                  ]}
                >
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--k-ink-muted)]">
                      {t('nav.boards')}
                    </span>
                    <TooltipHint label={t('nav.newBoard')}>
                      <button
                        type="button"
                        data-testid="add-board-btn"
                        onClick={() =>
                          setSectionEditor({
                            kind: 'board',
                            mode: 'create',
                            name: '',
                            description: '',
                            color: SECTION_COLOR_PALETTE[2]!,
                            icon: 'BookmarkSimple',
                          })
                        }
                        className="k-interactive w-5 h-5 rounded-[6px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                        aria-label={t('nav.createBoard')}
                      >
                        <Plus size={13} weight="bold" />
                      </button>
                    </TooltipHint>
                  </div>
                </ContextMenuSurface>

                <div className="space-y-0.5" data-testid="sidebar-boards-list">
                  {boards.map((board, idx) => {
                    const active = nav.type === 'board' && nav.boardId === board.id;
                    const dropPosition =
                      boardDropTarget?.id === board.id && dragBoardId !== board.id
                        ? boardDropTarget.position
                        : null;
                    const isCardDropOver = cardDropTargetId === `board:${board.id}`;
                    const boardMenu: ContextMenuEntry[] = [
                      {
                        type: 'item',
                        id: 'edit',
                        label: t('nav.configureAndRename'),
                        icon: <PencilSimple className="w-3.5 h-3.5" />,
                        onSelect: () =>
                          setSectionEditor({
                            kind: 'board',
                            mode: 'edit',
                            id: board.id,
                            name: board.name,
                            description: board.description ?? '',
                            color: board.color || SECTION_COLOR_PALETTE[2]!,
                            icon: board.icon || 'BookmarkSimple',
                          }),
                      },
                      {
                        type: 'item',
                        id: 'up',
                        label: t('nav.moveUp'),
                        icon: <ArrowUp className="w-3.5 h-3.5" />,
                        disabled: idx === 0,
                        onSelect: () => void handleMoveBoardByStep(board.id, -1),
                      },
                      {
                        type: 'item',
                        id: 'down',
                        label: t('nav.moveDown'),
                        icon: <ArrowDown className="w-3.5 h-3.5" />,
                        disabled: idx === boards.length - 1,
                        onSelect: () => void handleMoveBoardByStep(board.id, 1),
                      },
                      { type: 'separator', id: 'sep-del' },
                      {
                        type: 'item',
                        id: 'delete',
                        label: t('nav.deleteBoard'),
                        icon: <Trash className="w-3.5 h-3.5" />,
                        danger: true,
                        onSelect: () => void handleDeleteBoard(board),
                      },
                    ];

                    return (
                      <ContextMenuSurface key={board.id} entries={boardMenu}>
                        <div
                          draggable
                          data-testid={`sidebar-board-${board.id}`}
                          onDragStart={(e) => {
                            setDragBoardId(board.id);
                            setBoardDropTarget(null);
                            e.dataTransfer.setData('text/kapsula-sidebar-board', board.id);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver={(e) => {
                            const isCardDrag =
                              !dragBoardId &&
                              !dragOrbitId &&
                              !dragPrimaryNavId &&
                              hasDragType(e, 'text/kapsula-item-id');
                            if (isCardDrag) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              setCardDropTargetId(`board:${board.id}`);
                              setBoardDropTarget(null);
                              return;
                            }
                            const isBoardDrag =
                              Boolean(dragBoardId) || hasDragType(e, 'text/kapsula-sidebar-board');
                            if (!isBoardDrag) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dragBoardId === board.id) {
                              setBoardDropTarget(null);
                              return;
                            }
                            const position = computeDropPosition(e);
                            setBoardDropTarget((prev) =>
                              prev?.id === board.id && prev.position === position
                                ? prev
                                : { id: board.id, position }
                            );
                            setCardDropTargetId(null);
                          }}
                          onDragLeave={(e) => {
                            const nextTarget = e.relatedTarget as Node | null;
                            if (nextTarget && e.currentTarget.contains(nextTarget)) return;
                            setBoardDropTarget((prev) => (prev?.id === board.id ? null : prev));
                            setCardDropTargetId((prev) =>
                              prev === `board:${board.id}` ? null : prev
                            );
                          }}
                          onDrop={async (e) => {
                            e.preventDefault();
                            const droppedItemId = e.dataTransfer.getData('text/kapsula-item-id');
                            if (droppedItemId && !dragBoardId) {
                              clearSidebarDragStates();
                              await handleMoveToBoard(droppedItemId, board.id);
                              return;
                            }
                            const fromId =
                              dragBoardId || e.dataTransfer.getData('text/kapsula-sidebar-board');
                            const pos =
                              boardDropTarget?.id === board.id
                                ? boardDropTarget.position
                                : computeDropPosition(e);
                            clearSidebarDragStates();
                            if (!fromId || fromId === board.id) return;
                            const next = reorderByDrop(
                              boards,
                              boards.findIndex((b) => b.id === fromId),
                              boards.findIndex((b) => b.id === board.id),
                              pos
                            );
                            if (!next) return;
                            setBoards(next);
                            await window.kapsula.reorderFocusBoards(next.map((b) => b.id));
                          }}
                          onDragEnd={clearSidebarDragStates}
                          onClick={() => {
                            setBoardViewOverride(null);
                            navigateTo({ type: 'board', boardId: board.id });
                          }}
                          className={`k-interactive group relative flex items-center h-8 px-2 rounded-[8px] cursor-pointer ${
                            active
                              ? 'text-[var(--k-ink-primary)] font-medium'
                              : isCardDropOver
                                ? 'bg-[var(--k-accent-soft)]/80 text-[var(--k-ink-primary)]'
                                : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
                          } ${dragBoardId === board.id ? 'opacity-45' : ''}`}
                        >
                          {dropPosition ? <SidebarDropLine position={dropPosition} /> : null}
                          {active ? (
                            <motion.span
                              layoutId="sidebar-active-pill"
                              transition={
                                prefersReduced
                                  ? { duration: 0 }
                                  : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }
                              }
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 rounded-[8px] bg-[var(--k-accent-soft)]"
                            />
                          ) : null}
                          <span className="relative z-10 shrink-0 w-4 h-4 mr-2 flex items-center justify-center">
                            <Swatches
                              size={14}
                              weight={active ? 'fill' : 'duotone'}
                              style={{ color: board.color || SECTION_COLOR_PALETTE[2]! }}
                            />
                          </span>
                          <span className="relative z-10 flex-1 min-w-0 truncate text-[13px]">
                            {board.name}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSectionEditor({
                                kind: 'board',
                                mode: 'edit',
                                id: board.id,
                                name: board.name,
                                description: board.description ?? '',
                                color: board.color || SECTION_COLOR_PALETTE[2]!,
                                icon: board.icon || 'BookmarkSimple',
                              });
                            }}
                            className="relative z-10 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto w-5 h-5 mr-1 rounded-[5px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] transition-opacity shrink-0"
                            aria-label={t('nav.configureBoard')}
                          >
                            <PencilSimple size={12} />
                          </button>
                          <span
                            data-testid={`board-count-${board.id}`}
                            className="relative z-10 shrink-0 w-[26px] text-right text-[11.5px] k-tabular text-[var(--k-ink-muted)]"
                          >
                            <NumberFlow value={counts.boards[board.id] ?? 0} />
                          </span>
                        </div>
                      </ContextMenuSurface>
                    );
                  })}
                  {boards.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11.5px] text-[var(--k-ink-muted)]">
                      {t('nav.noBoards')}
                    </div>
                  ) : null}
                </div>
              </div>
              ) : null}
            </div>

            {/* Secondary Utilities: Archive + Trash pinned neatly near footer */}
            <div className="shrink-0 pt-1.5 border-t border-[var(--k-border-hairline)]/80 space-y-0.5">
              {counts.archived > 0 || isSameNav(nav, { type: 'archive' }) ? (
                <SidebarNavButton
                  active={isSameNav(nav, { type: 'archive' })}
                  icon={<Archive size={16} />}
                  label={t('nav.archive')}
                  count={counts.archived}
                  testId="nav-archive"
                  onClick={() => navigateTo({ type: 'archive' })}
                />
              ) : null}
              <SidebarNavButton
                active={isSameNav(nav, { type: 'trash' })}
                icon={<Trash size={16} />}
                label={t('nav.trash')}
                count={counts.trashed}
                testId="nav-trash"
                onClick={() => navigateTo({ type: 'trash' })}
              />
            </div>

            {/* Non-intrusive cloud update pill above sidebar footer */}
            {updaterState &&
            (updaterState.status === 'available' || updaterState.status === 'downloaded') &&
            updaterState.latestVersion &&
            updaterState.dismissedVersion !== updaterState.latestVersion ? (
              <div
                data-testid="sidebar-update-pill"
                className="shrink-0 mb-1.5 flex items-center gap-1 rounded-[9px] border border-[var(--k-accent)]/30 bg-[var(--k-accent-soft)] px-2 py-1 text-[11.5px] text-[var(--k-accent)]"
              >
                <button
                  type="button"
                  onClick={() => {
                    setSettingsInitialTab('appearance');
                    setSettingsOpen(true);
                  }}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left font-medium cursor-pointer truncate"
                >
                  <Sparkle weight="fill" size={12} className="shrink-0" />
                  <span className="truncate k-tabular">
                    {updaterState.status === 'downloaded'
                      ? t('workspace.sidebar.updateReady', { version: updaterState.latestVersion })
                      : t('workspace.sidebar.updateAvailable', { version: updaterState.latestVersion })}
                  </span>
                </button>
                <button
                  type="button"
                  title={t('workspace.sidebar.dismissUpdateTitle')}
                  aria-label={t('workspace.sidebar.dismissUpdateAria')}
                  onClick={() => {
                    void window.kapsula
                      .dismissUpdate(updaterState.latestVersion ?? undefined)
                      .then((next) => {
                        if (next) setUpdaterState(next);
                      })
                      .catch(() => {});
                  }}
                  className="w-4.5 h-4.5 rounded flex items-center justify-center opacity-70 hover:opacity-100 cursor-pointer shrink-0"
                >
                  <X size={11} />
                </button>
              </div>
            ) : null}

            {/* Compact Sidebar Footer: Settings + Customize + Sync + Lock + Theme */}
            <div className="shrink-0 pt-2 border-t border-[var(--k-border-hairline)] flex items-center gap-1">
              <button
                type="button"
                data-testid="open-settings-btn"
                onClick={() => {
                  setSettingsInitialTab('appearance');
                  setSettingsOpen(true);
                }}
                className="k-interactive flex-1 flex items-center gap-2 px-2.5 h-8 rounded-[8px] text-[12.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer min-w-0"
              >
                <CirclesFour size={15} className="shrink-0" />
                <span className="truncate">{t('workspace.sidebar.settings')}</span>
              </button>

              <PopoverSurface
                open={customizeSidebarOpen}
                onOpenChange={setCustomizeSidebarOpen}
                side="top"
                align="start"
                widthClass="w-[228px] !p-2"
                trigger={
                  <button
                    type="button"
                    data-testid="customize-sidebar-btn"
                    title={t('nav.customizeSidebar')}
                    aria-label={t('nav.customizeSidebar')}
                    className={`k-interactive relative w-8 h-8 rounded-[8px] flex items-center justify-center cursor-pointer shrink-0 ${
                      hiddenNavSections.length > 0 || !isDefaultPrimaryNavOrder
                        ? 'text-[var(--k-accent)] bg-[var(--k-accent-soft)]/70'
                        : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]'
                    }`}
                  >
                    <SlidersHorizontal size={15} />
                  </button>
                }
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between px-1 pb-1 border-b border-[var(--k-border-hairline)]">
                    <span className="text-[11.5px] font-semibold text-[var(--k-ink-primary)]">
                      {t('nav.customizeSidebar')}
                    </span>
                    {hiddenNavSections.length > 0 ? (
                      <button
                        type="button"
                        data-testid="customize-sidebar-show-all"
                        onClick={() => setHiddenNavSections(writeHiddenNavSections([]))}
                        className="text-[11px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer"
                      >
                        {t('nav.showAllSidebar')}
                      </button>
                    ) : null}
                  </div>
                  <div className="space-y-0.5">
                    {HIDEABLE_NAV_SECTIONS.map((sec) => {
                      const visible = !hiddenNavSet.has(sec);
                      return (
                        <button
                          key={sec}
                          type="button"
                          data-testid={`customize-sidebar-toggle-${sec}`}
                          onClick={() => handleToggleHiddenNavSection(sec)}
                          className="k-interactive w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-[7px] text-[12px] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                        >
                          <span>{t(HIDEABLE_SECTION_LABEL_KEYS[sec])}</span>
                          <span
                            className={`inline-flex items-center justify-center w-4 h-4 rounded-[5px] border ${
                              visible
                                ? 'bg-[var(--k-accent)] border-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                                : 'border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-transparent'
                            }`}
                          >
                            <Check size={11} weight="bold" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="pt-1 border-t border-[var(--k-border-hairline)]">
                    <button
                      type="button"
                      data-testid="customize-sidebar-reset-order"
                      disabled={isDefaultPrimaryNavOrder}
                      onClick={() => setPrimaryNavOrder(resetPrimaryNavOrder())}
                      className={`k-interactive w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-[7px] text-[11.5px] font-medium ${
                        isDefaultPrimaryNavOrder
                          ? 'text-[var(--k-ink-muted)]/60 cursor-default'
                          : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer'
                      }`}
                    >
                      <ArrowCounterClockwise size={12} />
                      <span>{t('nav.resetOrder')}</span>
                    </button>
                  </div>
                </div>
              </PopoverSurface>

              <TooltipHint
                label={
                  !syncStatus || syncStatus.state === 'signed_out'
                    ? t('workspace.sidebar.syncDisconnected')
                    : syncStatus.state === 'syncing'
                      ? t('workspace.sidebar.syncSyncing')
                      : syncStatus.state === 'synced'
                        ? t('workspace.sidebar.syncSynced')
                        : syncStatus.state === 'offline'
                          ? t('workspace.sidebar.syncOffline')
                          : syncStatus.state === 'needs_passphrase_setup' ||
                              syncStatus.state === 'needs_passphrase_unlock'
                            ? t('workspace.sidebar.syncNeedsPassphrase')
                            : syncStatus.state === 'awaiting_email_confirm'
                              ? t('workspace.sidebar.syncNeedsVerify')
                              : t('workspace.sidebar.syncError')
                }
              >
                <button
                  type="button"
                  data-testid="sync-status-btn"
                  onClick={() => {
                    setSettingsInitialTab('sync');
                    setSettingsOpen(true);
                  }}
                  className="k-interactive relative w-8 h-8 rounded-[8px] flex items-center justify-center text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                  aria-label={t('workspace.sidebar.syncAria')}
                >
                  {syncStatus?.state === 'syncing' ? (
                    <ArrowsClockwise size={15} className="animate-spin text-[var(--k-accent)]" />
                  ) : syncStatus?.state === 'offline' ? (
                    <CloudSlash size={15} className="text-[var(--k-amber)]" />
                  ) : syncStatus?.state === 'error' ? (
                    <CloudWarning size={15} className="text-[var(--k-danger)]" />
                  ) : syncStatus?.state === 'synced' ? (
                    <CloudCheck size={15} className="text-[var(--k-emerald)]" />
                  ) : (
                    <CloudCheck size={15} className="opacity-70" />
                  )}
                  {syncStatus &&
                  (syncStatus.state === 'needs_passphrase_setup' ||
                    syncStatus.state === 'needs_passphrase_unlock' ||
                    syncStatus.state === 'awaiting_email_confirm' ||
                    syncStatus.state === 'error') ? (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-[var(--k-accent)]" />
                  ) : null}
                </button>
              </TooltipHint>

              {settings.hasMasterPin ? (
                <TooltipHint label={vaultLocked ? t('workspace.sidebar.unlockVault') : t('workspace.sidebar.lockVault')}>
                  <button
                    type="button"
                    onClick={() => {
                      if (vaultLocked) {
                        setUnlockOpen(true);
                      } else {
                        void window.kapsula.lockVaultPin();
                        toast(t('workspace.sidebar.vaultLockedToast'));
                      }
                    }}
                    className="k-interactive w-8 h-8 rounded-[8px] flex items-center justify-center text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                    aria-label={vaultLocked ? t('workspace.sidebar.unlockVault') : t('workspace.sidebar.lockVault')}
                  >
                    {vaultLocked ? (
                      <LockKey size={15} className="text-[var(--k-accent)]" />
                    ) : (
                      <LockSimpleOpen size={15} className="text-[var(--k-emerald)]" />
                    )}
                  </button>
                </TooltipHint>
              ) : null}

              <TooltipHint label={settings.theme === 'light' ? t('workspace.sidebar.darkTheme') : t('workspace.sidebar.lightTheme')}>
                <button
                  type="button"
                  data-testid="theme-toggle-btn"
                  onClick={handleToggleTheme}
                  className="k-interactive w-8 h-8 rounded-[8px] flex items-center justify-center text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                  aria-label={t('workspace.sidebar.toggleThemeAria')}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {settings.theme === 'light' ? (
                      <motion.span
                        key="moon"
                        initial={
                          prefersReduced
                            ? { opacity: 0 }
                            : { opacity: 0, transform: 'rotate(-25deg) scale(0.85)' }
                        }
                        animate={
                          prefersReduced
                            ? { opacity: 1 }
                            : { opacity: 1, transform: 'rotate(0deg) scale(1)' }
                        }
                        exit={
                          prefersReduced
                            ? { opacity: 0 }
                            : { opacity: 0, transform: 'rotate(25deg) scale(0.85)' }
                        }
                        transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
                      >
                        <Moon size={15} />
                      </motion.span>
                    ) : (
                      <motion.span
                        key="sun"
                        initial={
                          prefersReduced
                            ? { opacity: 0 }
                            : { opacity: 0, transform: 'rotate(25deg) scale(0.85)' }
                        }
                        animate={
                          prefersReduced
                            ? { opacity: 1 }
                            : { opacity: 1, transform: 'rotate(0deg) scale(1)' }
                        }
                        exit={
                          prefersReduced
                            ? { opacity: 0 }
                            : { opacity: 0, transform: 'rotate(-25deg) scale(0.85)' }
                        }
                        transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
                      >
                        <Sun size={15} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </TooltipHint>
            </div>
          </div>
        </div>
      </motion.aside>

      {/* Right Main Column: Seamless Slim Chrome + Smoothly Reflowing Workspace */}
      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden relative">
        {/* Lightweight Integrated Top Canvas Bar (46px, transparent glass over canvas, zero duplicate icons/titles) */}
        <header className="h-[46px] shrink-0 grid grid-cols-[minmax(112px,1fr)_minmax(220px,400px)_minmax(max-content,1fr)] items-center px-3.5 gap-3 border-b border-[var(--k-border-hairline)] bg-[var(--k-bg-canvas)] k-drag-region">
          {/* Left: Expand sidebar (smoothly revealed when collapsed) + Clean Breadcrumb Title */}
          <div
            data-testid="header-left-group"
            className={`min-w-0 flex items-center gap-2 justify-self-start transition-[padding] duration-150 ${
              showTrafficLights && !sidebarOpen ? 'pl-[68px]' : ''
            }`}
          >
            <AnimatePresence initial={false}>
              {!sidebarOpen ? (
                <motion.div
                  key="expand-sidebar-slot"
                  initial={prefersReduced ? { opacity: 0 } : { opacity: 0, width: 0 }}
                  animate={prefersReduced ? { opacity: 1 } : { opacity: 1, width: 30 }}
                  exit={prefersReduced ? { opacity: 0 } : { opacity: 0, width: 0 }}
                  transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  className="overflow-hidden shrink-0 k-no-drag"
                >
                  <TooltipHint label={t('nav.showPanel')}>
                    <button
                      type="button"
                      data-testid="toggle-sidebar-btn"
                      onClick={() => setSidebarOpen(true)}
                      className="k-interactive w-7.5 h-7.5 rounded-[8px] flex items-center justify-center text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
                      aria-label={t('nav.showSidebar')}
                    >
                      <SidebarSimple size={16} />
                    </button>
                  </TooltipHint>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="flex items-center gap-1.5 min-w-0">
              {nav.type === 'orbit' ? (
                <span className="text-[12.5px] text-[var(--k-ink-muted)] shrink-0">{t('nav.sectionsBreadcrumb')}</span>
              ) : nav.type === 'board' ? (
                <span className="text-[12.5px] text-[var(--k-ink-muted)] shrink-0">{t('nav.boardsBreadcrumb')}</span>
              ) : null}
              <span className="k-display font-semibold text-[14px] tracking-[-0.015em] text-[var(--k-ink-primary)] truncate">
                {activeNavTitle}
              </span>
            </div>
          </div>

          {/* Center: Global Spotlight Search Bar with Live Cross-App Results */}
          <div data-testid="header-center-group" className="relative w-full justify-self-center k-no-drag">
            <div
              className={`relative flex items-center w-full h-8 rounded-[10px] border transition-colors px-2.5 gap-2 ${
                searchFocused
                  ? 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-focus)] shadow-[0_0_0_2px_var(--k-accent-soft)]'
                  : 'bg-[var(--k-bg-surface-1)]/70 border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)]'
              }`}
            >
              <MagnifyingGlass size={14} className="text-[var(--k-ink-muted)] shrink-0" />
              <input
                ref={searchInputRef}
                data-testid="global-search-input"
                type="text"
                value={searchQuery}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('workspace.searchPlaceholder')}
                className="flex-1 min-w-0 bg-transparent text-[12.5px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)] outline-none select-text"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSearchQuery('')}
                  className="k-interactive w-5 h-5 rounded-[6px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] cursor-pointer shrink-0"
                  aria-label={t('common.clearSearch')}
                >
                  <X size={12} weight="bold" />
                </button>
              ) : (
                <span className="k-mono text-[10px] text-[var(--k-ink-muted)] px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-2)]/80 shrink-0 hidden sm:inline">
                  {isMac ? '⌘F' : 'Ctrl+F'}
                </span>
              )}
            </div>

            <GlobalSearchPopover
              open={searchFocused}
              query={searchQuery}
              items={items}
              calendarEvents={calendarEvents}
              tasks={tasks}
              orbits={orbits}
              serverSearchIds={serverSearchIds}
              onClose={() => {
                setSearchFocused(false);
                searchInputRef.current?.blur();
              }}
              onOpenItem={(it) => handleOpenItem(it)}
              onOpenEvent={(ev) => {
                navigateTo({ type: 'calendar' });
                setFocusCalendarEventId(ev.id);
              }}
              onToggleTask={(taskEntry) => {
                void handleToggleVaultTask(taskEntry).catch(() => {});
              }}
              onOpenNewNote={handleOpenBlankDraft}
              onOpenTriage={() => setTriageOpen(true)}
              onOpenAssistant={() => setAssistantOpen(true)}
              onOpenCalendarNew={() => {
                navigateTo({ type: 'calendar' });
                setCalendarCreateTrigger((n) => n + 1);
              }}
            />
          </div>

          {/* Right: Quiet Actions + Window Controls */}
          <div
            data-testid="header-right-group"
            className="flex items-center gap-1 justify-self-end k-no-drag shrink-0"
          >
            <TooltipHint
              label={
                counts.unsorted > 0
                  ? t('workspace.triageTooltipCount', { count: counts.unsorted })
                  : t('workspace.triageTooltip')
              }
            >
              <button
                type="button"
                data-testid="smart-triage-btn"
                onClick={() => setTriageOpen(true)}
                className="k-interactive relative h-7.5 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
              >
                <FunnelSimple size={14} className="text-[var(--k-ink-secondary)]" />
                <span className="hidden xl:inline">{t('workspace.triageButton')}</span>
                {counts.unsorted > 0 ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--k-accent)] shrink-0" />
                ) : null}
              </button>
            </TooltipHint>

            <button
              type="button"
              data-testid="assistant-open-btn"
              onClick={() => setAssistantOpen((v) => !v)}
              className={`k-interactive h-7.5 px-2.5 rounded-[8px] flex items-center gap-1.5 text-[12px] font-medium border cursor-pointer ${
                assistantOpen
                  ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] border-[var(--k-accent)]'
                  : 'bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] border-[var(--k-border-hairline)]'
              }`}
            >
              <Sparkle size={13.5} weight="fill" className={assistantOpen ? '' : 'text-[var(--k-accent)]'} />
              <span>{t('workspace.assistantButton')}</span>
            </button>

            {!isMac ? (
              <>
                <div className="w-px h-4 bg-[var(--k-border-hairline)] mx-1" />

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void window.kapsula.windowAction('minimize')}
                    className="k-interactive w-7 h-7 rounded-[7px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                    aria-label={t('main.menu.minimize')}
                  >
                    <Minus size={13.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.kapsula.windowAction('maximize')}
                    className="k-interactive w-7 h-7 rounded-[7px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                    aria-label={t('common.expand')}
                  >
                    <Square size={11.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.kapsula.windowAction('close')}
                    className="k-interactive w-7 h-7 rounded-[7px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-white hover:bg-[var(--k-danger)] cursor-pointer"
                    aria-label={t('common.close')}
                  >
                    <X size={13.5} />
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </header>

        {/* Main Scrollable Workspace Canvas + Seamless Full-Canvas Note Document View */}
        <div className="flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden">
          <div
            ref={feedCanvasRef}
            aria-hidden={isNoteDocumentOpen}
            className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
          >
            <ContextMenuSurface
              entries={feedBackgroundMenuEntries}
              className={`flex-1 min-w-0 min-h-0 relative ${
                nav.type === 'notes' ? 'overflow-hidden' : 'overflow-y-auto k-scroll-stable'
              }`}
            >
          <main className={nav.type === 'notes' ? 'h-full min-h-0 flex flex-col overflow-hidden' : 'min-h-full'}>
            {nav.type === 'notes' ? (
              <motion.div
                key="nav-notes"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 4px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
                transition={{ duration: 0.13, ease: [0.23, 1, 0.32, 1] }}
                className="flex-1 min-h-0 h-full flex overflow-hidden"
              >
                <Suspense fallback={null}>
                  <NotesHubView
                    items={items}
                    orbits={orbits}
                    focusBoards={boards}
                    globalSearchQuery={searchQuery}
                    serverSearchIds={serverSearchIds}
                    soundEnabled={soundEnabled}
                    createDraftTrigger={notesDraftTrigger}
                    onItemUpdated={(updated) => {
                      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
                    }}
                    onDraftPersisted={(created) => {
                      setItems((prev) =>
                        prev.some((it) => it.id === created.id)
                          ? prev.map((it) => (it.id === created.id ? created : it))
                          : [created, ...prev]
                      );
                    }}
                    onDeleteItem={(id) => void handleDeleteItem(id)}
                    onTogglePin={(it) => void handleTogglePin(it)}
                    onToggleNotesHub={(it, inNotesHub) => void handleToggleNotesHub(it, inNotesHub)}
                    onMoveToOrbit={(id, orbId) => void handleMoveToOrbit(id, orbId)}
                    onMoveToBoard={(id, boardId) => void handleMoveToBoard(id, boardId)}
                    onDuplicateItem={(id) => void handleDuplicateItem(id)}
                    onExportMarkdown={(id) => void handleExportMarkdown(id)}
                    onOpenExternalItem={handleOpenItem}
                    onOpenShotLightbox={setLightboxItem}
                  />
                </Suspense>
              </motion.div>
            ) : nav.type === 'media' ? (
              <motion.div
                key="nav-media"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                style={{ paddingLeft: 'var(--k-page-px)', paddingRight: 'var(--k-page-px)', paddingTop: 'var(--k-page-py)', paddingBottom: 'var(--k-page-py)' }}
                className="max-w-[1360px] mx-auto"
              >
                <Suspense fallback={null}>
                  <MediaHubView
                    items={items}
                    orbits={orbits}
                    focusBoards={boards}
                    searchQuery={searchQuery}
                    serverSearchIds={serverSearchIds}
                    soundEnabled={soundEnabled}
                    onOpenStudio={handleOpenItem}
                    onOpenLightbox={setLightboxItem}
                    onQuickLook={setQuickLookItem}
                    onHoverItem={(it) => {
                      hoveredItemRef.current = it;
                    }}
                    onTogglePin={(it) => void handleTogglePin(it)}
                    onMoveToOrbit={(id, orbId) => void handleMoveToOrbit(id, orbId)}
                    onMoveToBoard={(id, boardId) => void handleMoveToBoard(id, boardId)}
                    onDelete={(id) => void handleDeleteItem(id)}
                    onUpdateCanvasPosition={(itemId, x, y) => {
                      void window.kapsula.updateItem(itemId, { canvasX: x, canvasY: y });
                    }}
                  />
                </Suspense>
              </motion.div>
            ) : nav.type === 'tasks' ? (
              <motion.div
                key="nav-tasks"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                style={{ paddingLeft: 'var(--k-page-px)', paddingRight: 'var(--k-page-px)', paddingTop: 'var(--k-page-py)', paddingBottom: 'var(--k-page-py)' }}
                className={`${tasksViewMode === 'board' ? 'max-w-[1520px]' : 'max-w-[1100px]'} mx-auto transition-[max-width] duration-180`}
              >
                <Suspense fallback={null}>
                  <TasksHubView
                    tasks={tasks}
                    orbits={orbits}
                    viewMode={tasksViewMode}
                    onViewModeChange={setTasksViewMode}
                    onToggleTask={handleToggleVaultTask}
                    onOpenItem={handleOpenItemById}
                    onTasksChanged={() => {
                      void window.kapsula
                        .listTasks()
                        .then((rows) => setTasks(applyPendingTaskTogglesToTasks(rows)))
                        .catch(() => {});
                    }}
                    onAddQuickTask={async (text, columnId) => {
                      const created = await window.kapsula.capture({
                        text: `- [ ] ${text}`,
                        title: truncateAtWordBoundary(text, 72),
                        source: 'vault_ui',
                      });
                      if (created && columnId && columnId !== 'inbox') {
                        await window.kapsula.moveTaskOnBoard({
                          itemId: created.id,
                          taskKey: 'md:0',
                          columnId,
                          boardOrder: Date.now(),
                        });
                      }
                      void window.kapsula.listTasks().then(setTasks).catch(() => {});
                    }}
                  />
                </Suspense>
              </motion.div>
            ) : nav.type === 'calendar' ? (
              <motion.div
                key="nav-calendar"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                style={{ paddingLeft: 'var(--k-page-px)', paddingRight: 'var(--k-page-px)', paddingTop: 'var(--k-page-py)', paddingBottom: 'var(--k-page-py)' }}
                className="max-w-[1260px] mx-auto"
              >
                <Suspense fallback={null}>
                  <CalendarHubView
                    tasks={tasks}
                    items={items}
                    initialEvents={calendarEvents}
                    focusEventId={focusCalendarEventId}
                    openCreateTrigger={calendarCreateTrigger}
                    onFocusEventHandled={() => setFocusCalendarEventId(null)}
                    onOpenItem={handleOpenItemById}
                    onOpenIntegrations={() => {
                      setSettingsInitialTab('integrations');
                      setSettingsOpen(true);
                    }}
                  />
                </Suspense>
              </motion.div>
            ) : (
              <div
                style={{ paddingLeft: 'var(--k-page-px)', paddingRight: 'var(--k-page-px)', paddingTop: 'var(--k-page-py)', paddingBottom: 'var(--k-page-py)' }}
                className="max-w-[1280px] mx-auto space-y-4 @container"
              >
                {/* Streamlined Single-Row Secrets Header */}
                {nav.type === 'secrets' ? (
                  vaultLocked ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] shadow-[var(--k-shadow-card)]">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] flex items-center justify-center shrink-0">
                          <LockKey size={18} />
                        </div>
                        <div>
                          <div className="text-[14px] font-semibold">{t('vault.lockedTitle')}</div>
                          <div className="text-[12px] text-[var(--k-ink-muted)]">
                            {t('vault.lockedDesc')}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid="unlock-vault-btn"
                        onClick={() => setUnlockOpen(true)}
                        className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium hover:bg-[var(--k-accent-hover)] cursor-pointer"
                      >
                        {t('vault.openButton')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <SegmentedControl<SecretKindFilter>
                          size="sm"
                          value={secretKindFilter}
                          onChange={setSecretKindFilter}
                          options={[
                            { value: 'all', label: t('vault.filter.all') },
                            { value: 'bank_card', label: t('vault.filter.cards') },
                            { value: 'password', label: t('vault.filter.passwords') },
                            { value: 'api_key', label: t('vault.filter.keys') },
                            { value: 'note', label: t('vault.filter.notes') },
                          ]}
                        />
                        <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular hidden sm:inline">
                          {wipeSeconds > 0
                            ? t('vault.wipePill', { seconds: wipeSeconds })
                            : t('vault.wipeLocalPill')}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <PopoverSurface
                          open={addSecretMenuOpen}
                          onOpenChange={setAddSecretMenuOpen}
                          align="end"
                          widthClass="w-48 !p-1.5"
                          trigger={
                            <button
                              type="button"
                              data-testid="new-secret-btn"
                              className="k-interactive h-8 px-3.5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Plus size={13} weight="bold" />
                              <span>{t('vault.addButton')}</span>
                            </button>
                          }
                        >
                          <div className="space-y-0.5 text-[12.5px]">
                            {(
                              [
                                ['bank_card', t('vault.type.bank_card')],
                                ['password', t('vault.type.password')],
                                ['api_key', t('vault.type.api_key')],
                                ['note', t('vault.type.note')],
                              ] as const
                            ).map(([kindKey, label]) => (
                              <button
                                key={kindKey}
                                type="button"
                                data-testid={`new-secret-${kindKey}-btn`}
                                onClick={() => {
                                  setAddSecretMenuOpen(false);
                                  setNewSecretKind(kindKey);
                                  setNewSecretOpen(true);
                                }}
                                className="k-interactive w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--k-bg-surface-2)] font-medium cursor-pointer"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </PopoverSurface>

                        {settings.hasMasterPin ? (
                          <button
                            type="button"
                            onClick={() => void window.kapsula.lockVaultPin()}
                            className="k-interactive h-8 px-2.5 rounded-xl border border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                          >
                            {t('vault.lockButton')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                ) : null}

                {/* Archive vs Trash Dedicated Status Banners */}
                {nav.type === 'archive' ? (
                  <div
                    data-testid="archive-banner"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-4 py-3 shadow-[var(--k-shadow-card)]"
                  >
                    <div className="flex items-center gap-2.5 text-[12.5px] text-[var(--k-ink-secondary)]">
                      <Archive weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)] shrink-0" />
                      <span>
                        {t('workspace.archiveBanner')}
                      </span>
                    </div>
                  </div>
                ) : null}

                {nav.type === 'trash' ? (
                  <div
                    data-testid="trash-banner"
                    className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-4 py-3 shadow-[var(--k-shadow-card)]"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 text-[12.5px] text-[var(--k-ink-secondary)]">
                      <Info weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)] shrink-0" />
                      <span className="leading-snug">
                        {t('workspace.trashBanner')}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="empty-trash-btn"
                      disabled={trashedItems.length === 0 || trashActionBusy}
                      onClick={() => setConfirmEmptyTrashOpen(true)}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-xl border border-[var(--k-danger)]/35 bg-[var(--k-danger-soft)] text-[var(--k-danger)] hover:bg-[var(--k-danger)] hover:text-white text-[12px] font-medium whitespace-nowrap cursor-pointer shrink-0 disabled:opacity-45 disabled:pointer-events-none"
                    >
                      <Trash className="w-3.5 h-3.5 shrink-0" />
                      <span>{t('workspace.emptyTrashButton')}</span>
                    </button>
                  </div>
                ) : null}

                {/* Collapsible Compact OmniComposer */}
                {nav.type !== 'archive' && nav.type !== 'trash' && nav.type !== 'secrets' ? (
                  <OmniComposer
                    orbits={orbits}
                    activeOrbitId={nav.type === 'orbit' ? nav.orbitId : null}
                    activeFocusBoardId={nav.type === 'board' ? nav.boardId : null}
                    soundEnabled={soundEnabled}
                    onCaptured={(created, openInStudio) => {
                      if (openInStudio) {
                        handleOpenItem(created);
                      }
                    }}
                    onOpenBlankDraft={handleOpenBlankDraft}
                  />
                ) : null}

                {/* Unified Single-Row Feed Controls + Spring Filter Pills */}
                {showFeedToolbar ? (
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex flex-wrap items-center gap-1" data-testid="feed-quick-filters">
                      {(
                        [
                          {
                            id: 'all',
                            label: t('workspace.filter.all'),
                            active:
                              filterDnaQuick === 'all' &&
                              !filterUnsortedOnly &&
                              !filterMediaOnly &&
                              !filterPinnedOnly,
                            onClick: () => {
                              setFilterDnaQuick('all');
                              setFilterUnsortedOnly(false);
                              setFilterMediaOnly(false);
                              setFilterPinnedOnly(false);
                            },
                          },
                          ...(nav.type === 'flow' && counts.unsorted > 0
                            ? [
                                {
                                  id: 'unsorted',
                                  testId: 'quick-filter-unsorted',
                                  label: t('nav.noSection'),
                                  badge: counts.unsorted,
                                  active: filterUnsortedOnly,
                                  onClick: () => setFilterUnsortedOnly((v) => !v),
                                },
                              ]
                            : []),
                          {
                            id: 'link',
                            testId: 'quick-filter-link',
                            label: t('workspace.filter.links'),
                            active: filterDnaQuick === 'link',
                            onClick: () => setFilterDnaQuick((v) => (v === 'link' ? 'all' : 'link')),
                          },
                          {
                            id: 'note',
                            testId: 'quick-filter-note',
                            label: t('workspace.filter.notes'),
                            active: filterDnaQuick === 'note',
                            onClick: () => setFilterDnaQuick((v) => (v === 'note' ? 'all' : 'note')),
                          },
                          {
                            id: 'voice',
                            testId: 'quick-filter-voice',
                            label: t('workspace.filter.voice'),
                            active: filterDnaQuick === 'voice',
                            onClick: () => setFilterDnaQuick((v) => (v === 'voice' ? 'all' : 'voice')),
                          },
                          {
                            id: 'pinned',
                            testId: 'quick-filter-pinned',
                            label: t('workspace.filter.pinned'),
                            active: filterPinnedOnly,
                            onClick: () => setFilterPinnedOnly((v) => !v),
                          },
                        ] as Array<{
                          id: string;
                          testId?: string;
                          label: string;
                          badge?: number;
                          active: boolean;
                          onClick: () => void;
                        }>
                      ).map((chip) => (
                        <button
                          key={chip.id}
                          type="button"
                          data-testid={chip.testId}
                          onClick={chip.onClick}
                          className={`k-interactive relative h-7 px-2.5 rounded-full text-[11.5px] font-medium cursor-pointer inline-flex items-center gap-1 ${
                            chip.active
                              ? 'bg-[var(--k-accent-soft)] text-[var(--k-accent)] border border-[var(--k-accent)]/35'
                              : 'text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)]/80 border border-transparent'
                          }`}
                        >
                          <span>{chip.label}</span>
                          {chip.badge !== undefined ? (
                            <span className="k-tabular opacity-75 text-[10.5px]">{chip.badge}</span>
                          ) : null}
                        </button>
                      ))}

                      {selectableVisibleIds.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedIds.length === selectableVisibleIds.length) {
                              setSelectedIds([]);
                            } else {
                              setSelectedIds(selectableVisibleIds);
                            }
                          }}
                          className="k-interactive text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer ml-1.5 px-1.5"
                        >
                          {selectedIds.length === selectableVisibleIds.length
                            ? t('workspace.selectToggleOff')
                            : selectedIds.length > 0
                              ? t('workspace.selectResetCount', { count: selectedIds.length })
                              : t('common.select')}
                        </button>
                      ) : null}
                    </div>

                    <div
                      className={`flex items-center gap-2 shrink-0 transition-opacity duration-140 ${
                        assistantOpen ? 'max-[1680px]:opacity-0 max-[1680px]:pointer-events-none' : 'opacity-100'
                      }`}
                    >
                      <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular hidden sm:inline">
                        <NumberFlow value={visibleItems.length} />
                      </span>

                      <SelectMenu
                        value={sortOrder}
                        onChange={(v) => setSortOrder(v as SortMode)}
                        options={[
                          { value: 'flow', label: t('workspace.sort.flow') },
                          { value: 'created_desc', label: t('workspace.sort.createdDesc') },
                          { value: 'updated_desc', label: t('workspace.sort.updatedDesc') },
                          { value: 'title_asc', label: t('workspace.sort.titleAsc') },
                          { value: 'media_first', label: t('workspace.sort.mediaFirst') },
                        ]}
                        size="sm"
                        align="end"
                        className="w-[158px]"
                        data-testid="feed-sort-select"
                      />

                      <SegmentedControl
                        value={effectiveLayoutMode}
                        onChange={handleLayoutChange}
                        options={[
                          { value: 'grid', label: t('workspace.view.grid'), icon: <GridFour size={14} /> },
                          { value: 'list', label: t('workspace.view.list'), icon: <ListBullets size={14} /> },
                          { value: 'board', label: t('workspace.view.board'), icon: <Swatches size={14} /> },
                        ]}
                      />
                    </div>
                  </div>
                ) : null}

                {/* Feed Body transitions cleanly on section change */}
                <motion.div
                  key={
                    nav.type === 'orbit'
                      ? `orbit:${nav.orbitId}`
                      : nav.type === 'board'
                        ? `board:${nav.boardId}`
                        : nav.type
                  }
                  initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                  animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }}
                  transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                >
                {loading ? (
                  <div key="feed-loading" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="h-36 rounded-[14px] bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] animate-pulse"
                      />
                    ))}
                  </div>
                ) : effectiveLayoutMode === 'board' && showFeedToolbar ? (
                  <Suspense fallback={null}>
                    <ReferenceBoardCanvas
                      boardKey={nav.type === 'board' ? nav.boardId : nav.type === 'orbit' ? `orbit-${nav.orbitId}` : 'flow'}
                      items={visibleItems}
                      orbits={orbits}
                      focusBoards={boards}
                      onOpenItem={handleOpenItem}
                      onQuickLook={setQuickLookItem}
                      onUpdatePosition={async (itemId, x, y) => {
                        await window.kapsula.updateItem(itemId, { canvasX: x, canvasY: y });
                      }}
                      onUpdateSize={async (itemId, w) => {
                        await window.kapsula.updateItem(itemId, { canvasW: w });
                      }}
                      onUpdateLinks={async (itemId, linksOut) => {
                        await window.kapsula.updateItem(itemId, { linksOut });
                      }}
                      onTogglePin={handleTogglePin}
                      onMoveToOrbit={handleMoveToOrbit}
                      onMoveToBoard={handleMoveToBoard}
                      onDelete={handleDeleteItem}
                      onCreateBoardNote={handleOpenBlankDraft}
                    />
                  </Suspense>
                ) : visibleItems.length === 0 ? (
                  <div key="feed-empty" className="py-16 px-6 text-center rounded-[16px] border border-dashed border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]/50 space-y-3">
                    <div className="w-11 h-11 mx-auto rounded-[12px] bg-[var(--k-bg-surface-2)] flex items-center justify-center text-[var(--k-ink-muted)]">
                      {nav.type === 'secrets' ? (
                        <LockKey size={22} />
                      ) : nav.type === 'trash' ? (
                        <Trash size={22} />
                      ) : nav.type === 'archive' ? (
                        <Archive size={22} />
                      ) : (
                        <Stack size={22} />
                      )}
                    </div>
                    <div className="text-[14.5px] font-medium">
                      {searchQuery.trim()
                        ? t('workspace.empty.searchTitle')
                        : nav.type === 'secrets'
                          ? t('workspace.empty.vaultTitle')
                          : nav.type === 'archive'
                            ? t('workspace.empty.archiveTitle')
                            : nav.type === 'trash'
                              ? t('workspace.empty.trashTitle')
                              : t('workspace.empty.defaultTitle')}
                    </div>
                    <div className="text-[12.5px] text-[var(--k-ink-muted)] max-w-[440px] mx-auto">
                      {searchQuery.trim()
                        ? t('workspace.empty.searchDesc')
                        : nav.type === 'secrets'
                          ? t('workspace.empty.vaultDesc')
                          : nav.type === 'archive'
                            ? t('workspace.empty.archiveDesc')
                            : nav.type === 'trash'
                              ? t('workspace.empty.trashDesc')
                              : t('workspace.empty.defaultDesc')}
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      {searchQuery.trim() ? (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          className="k-interactive h-8.5 px-3.5 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[12.5px] font-medium cursor-pointer"
                        >
                          {t('workspace.resetSearch')}
                        </button>
                      ) : nav.type === 'secrets' && !vaultLocked ? (
                        <button
                          type="button"
                          onClick={() => {
                            setNewSecretKind('password');
                            setNewSecretOpen(true);
                          }}
                          className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer"
                        >
                          <Plus size={14} weight="bold" />
                          <span>{t('vault.addButton')}</span>
                        </button>
                      ) : nav.type !== 'archive' && nav.type !== 'trash' && nav.type !== 'secrets' ? (
                        <>
                          <button
                            type="button"
                            onClick={handleOpenBlankDraft}
                            className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer"
                          >
                            <NotePencil size={14} />
                            <span>{t('workspace.createNote')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCaptureClipboardQuick()}
                            className="k-interactive inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] text-[12.5px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                          >
                            <ClipboardText size={14} />
                            <span>{t('workspace.pasteFromClipboardShort')}</span>
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : nav.type === 'trash' ? (
                  <div
                    key="feed-trash"
                    data-testid="trash-list-container"
                    className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] divide-y divide-[var(--k-border-hairline)] overflow-hidden shadow-[var(--k-shadow-card)]"
                  >
                    {renderedItems.map((item) => {
                      const orbit = item.orbit ? orbitMap.get(item.orbit) : undefined;
                      const preview =
                        item.dna === 'secret'
                          ? t('dna.encryptedVaultRecord')
                          : stripMarkdownPreview(item.summary || item.body);
                      return (
                        <ContextMenuSurface
                          key={item.id}
                          entries={() => [
                            {
                              type: 'item',
                              id: 'trash-restore',
                              label: t('common.restore'),
                              icon: <ArrowCounterClockwise className="w-3.5 h-3.5" />,
                              onSelect: () => void handleRestoreItem(item.id),
                            },
                            { type: 'separator', id: 'trash-sep' },
                            {
                              type: 'item',
                              id: 'trash-purge',
                              label: t('common.deleteForever'),
                              icon: <Trash className="w-3.5 h-3.5" />,
                              danger: true,
                              onSelect: () => setConfirmPurgeItem(item),
                            },
                          ]}
                        >
                          <div
                            data-testid={`trash-row-${item.id}`}
                            className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--k-bg-surface-2)]/55 transition-colors"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center gap-2 min-w-0">
                                {item.dna === 'secret' ? (
                                  <LockKey className="w-3.5 h-3.5 text-[var(--k-amber)] shrink-0" />
                                ) : (
                                  <NotePencil className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                                )}
                                <span className="text-[13.5px] font-medium text-[var(--k-ink-primary)] truncate">
                                  {item.title || t('common.noTitle')}
                                </span>
                                {orbit ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] text-[10.5px] text-[var(--k-ink-secondary)] shrink-0">
                                    <span
                                      className="w-1.5 h-1.5 rounded-full"
                                      style={{ backgroundColor: orbit.color }}
                                    />
                                    <span>{orbit.name}</span>
                                  </span>
                                ) : null}
                              </div>
                              {preview ? (
                                <div className="text-[12px] text-[var(--k-ink-secondary)] truncate">
                                  {preview}
                                </div>
                              ) : null}
                              <div className="text-[11px] text-[var(--k-ink-muted)] k-tabular">
                                {t('date.deletedWhen', {
                                  when: formatRelativeDate(item.deletedAt ?? item.updatedAt, locale),
                                })}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                data-testid={`trash-restore-${item.id}`}
                                disabled={trashActionBusy}
                                onClick={() => void handleRestoreItem(item.id)}
                                className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-50"
                              >
                                <ArrowCounterClockwise className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                                <span>{t('common.restore')}</span>
                              </button>
                              <button
                                type="button"
                                data-testid={`trash-purge-${item.id}`}
                                disabled={trashActionBusy}
                                onClick={() => setConfirmPurgeItem(item)}
                                className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-danger)]/30 bg-[var(--k-danger-soft)] hover:bg-[var(--k-danger)] hover:text-white text-[12px] font-medium text-[var(--k-danger)] cursor-pointer disabled:opacity-50"
                              >
                                <Trash className="w-3.5 h-3.5" />
                                <span>{t('common.deleteForever')}</span>
                              </button>
                            </div>
                          </div>
                        </ContextMenuSurface>
                      );
                    })}
                  </div>
                ) : nav.type === 'archive' ? (
                  <div
                    key="feed-archive"
                    data-testid="archive-list-container"
                    className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] divide-y divide-[var(--k-border-hairline)] overflow-hidden shadow-[var(--k-shadow-card)]"
                  >
                    {renderedItems.map((item) => {
                      const orbit = item.orbit ? orbitMap.get(item.orbit) : undefined;
                      const preview =
                        item.dna === 'secret'
                          ? t('dna.encryptedVaultRecord')
                          : stripMarkdownPreview(item.summary || item.body);
                      return (
                        <ContextMenuSurface
                          key={item.id}
                          entries={() => [
                            {
                              type: 'item',
                              id: 'arch-open',
                              label: t('common.open'),
                              icon: <PencilSimple className="w-3.5 h-3.5" />,
                              onSelect: () => handleOpenItem(item),
                            },
                            {
                              type: 'item',
                              id: 'arch-unarchive',
                              label: t('workspace.returnFromArchive'),
                              icon: <ArrowCounterClockwise className="w-3.5 h-3.5" />,
                              onSelect: () => void handleUnarchiveItem(item.id),
                            },
                            { type: 'separator', id: 'arch-sep' },
                            {
                              type: 'item',
                              id: 'arch-trash',
                              label: t('workspace.moveToTrash'),
                              icon: <Trash className="w-3.5 h-3.5" />,
                              danger: true,
                              onSelect: () => void handleDeleteItem(item.id),
                            },
                          ]}
                        >
                          <div
                            data-testid={`archive-row-${item.id}`}
                            onClick={() => handleOpenItem(item)}
                            className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--k-bg-surface-2)]/55 transition-colors cursor-pointer"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <Archive className="w-3.5 h-3.5 text-[var(--k-ink-muted)] shrink-0" />
                                <span className="text-[13.5px] font-medium text-[var(--k-ink-primary)] truncate">
                                  {item.title || t('common.noTitle')}
                                </span>
                                {orbit ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-2)] text-[10.5px] text-[var(--k-ink-secondary)] shrink-0">
                                    <span
                                      className="w-1.5 h-1.5 rounded-full"
                                      style={{ backgroundColor: orbit.color }}
                                    />
                                    <span>{orbit.name}</span>
                                  </span>
                                ) : null}
                              </div>
                              {preview ? (
                                <div className="text-[12px] text-[var(--k-ink-secondary)] truncate">
                                  {preview}
                                </div>
                              ) : null}
                            </div>

                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="flex items-center gap-1.5 shrink-0"
                            >
                              <button
                                type="button"
                                data-testid={`archive-restore-${item.id}`}
                                onClick={() => void handleUnarchiveItem(item.id)}
                                className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-primary)] cursor-pointer"
                              >
                                <ArrowCounterClockwise className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                                <span>{t('workspace.returnFromArchive')}</span>
                              </button>
                              <button
                                type="button"
                                data-testid={`archive-trash-${item.id}`}
                                onClick={() => void handleDeleteItem(item.id)}
                                className="k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] hover:border-[var(--k-danger)]/35 hover:bg-[var(--k-danger-soft)] hover:text-[var(--k-danger)] text-[12px] text-[var(--k-ink-secondary)] cursor-pointer"
                              >
                                <Trash className="w-3.5 h-3.5" />
                                <span>{t('workspace.toTrashShort')}</span>
                              </button>
                            </div>
                          </div>
                        </ContextMenuSurface>
                      );
                    })}
                  </div>
                ) : effectiveLayoutMode === 'list' && showFeedToolbar ? (
                  <div
                    key="feed-list"
                    ref={feedListAnimRef}
                    data-testid="feed-list-container"
                    className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] divide-y divide-[var(--k-border-hairline)] overflow-hidden shadow-[var(--k-shadow-card)]"
                  >
                    {renderedItems.map((item) => (
                      <div key={item.id}>
                        <MemoryCardRouter
                          item={item}
                          orbit={item.orbit ? orbitMap.get(item.orbit) : undefined}
                          orbits={orbits}
                          focusBoards={boards}
                          compactList
                          vaultLocked={vaultLocked}
                          wipeSeconds={wipeSeconds}
                          selected={selectedIdSet.has(item.id)}
                          selectionMode={selectedIds.length > 0}
                          onToggleSelect={handleToggleSelect}
                          onOpenStudio={handleOpenItem}
                          onQuickLook={handleQuickLook}
                          onHoverItem={handleHoverItem}
                          onOpenSecretSheet={handleOpenItem}
                          onOpenShotLightbox={handleOpenShotLightbox}
                          onDelete={handleDeleteItem}
                          onTogglePin={handleTogglePin}
                          onToggleNotesHub={handleToggleNotesHub}
                          onMoveToOrbit={handleMoveToOrbit}
                          onMoveToBoard={handleMoveToBoard}
                          onDuplicate={handleDuplicateItem}
                          onExportMarkdown={handleExportMarkdown}
                          onUnlockVaultRequest={handleUnlockVaultRequest}
                          onToggleMarkdownTask={handleToggleMarkdownTask}
                          onToggleVoiceAction={handleToggleVoiceAction}
                        />
                      </div>
                    ))}
                  </div>
                ) : nav.type === 'secrets' ? (
                  <div
                    key="feed-secrets"
                    data-testid="vault-grid-container"
                    style={{ gap: 'var(--k-grid-gap)' }}
                    className="grid grid-cols-1 @[560px]:grid-cols-2 @[880px]:grid-cols-3 items-start"
                  >
                    {renderedItems.map((item) => (
                      <MemoryCardRouter
                        key={item.id}
                        item={item}
                        orbit={item.orbit ? orbitMap.get(item.orbit) : undefined}
                        orbits={orbits}
                        focusBoards={boards}
                        vaultLocked={vaultLocked}
                        wipeSeconds={wipeSeconds}
                        selected={selectedIdSet.has(item.id)}
                        selectionMode={selectedIds.length > 0}
                        onToggleSelect={handleToggleSelect}
                        onOpenStudio={handleOpenItem}
                        onQuickLook={handleQuickLook}
                        onHoverItem={handleHoverItem}
                        onOpenSecretSheet={handleOpenItem}
                        onOpenShotLightbox={handleOpenShotLightbox}
                        onDelete={handleDeleteItem}
                        onTogglePin={handleTogglePin}
                        onToggleNotesHub={handleToggleNotesHub}
                        onMoveToOrbit={handleMoveToOrbit}
                        onMoveToBoard={handleMoveToBoard}
                        onDuplicate={handleDuplicateItem}
                        onExportMarkdown={handleExportMarkdown}
                        onUnlockVaultRequest={handleUnlockVaultRequest}
                        onToggleMarkdownTask={handleToggleMarkdownTask}
                        onToggleVoiceAction={handleToggleVoiceAction}
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    key="feed-grid"
                    ref={feedGridAnimRef}
                    data-testid="feed-grid-container"
                    style={{ gridAutoRows: `${MASONRY_ROW_UNIT_PX}px`, columnGap: 'var(--k-grid-gap)' }}
                    className="grid grid-cols-1 @[560px]:grid-cols-2 @[880px]:grid-cols-3 items-start"
                  >
                    {renderedItems.map((item) => (
                      <MasonryCardCell key={item.id}>
                        <MemoryCardRouter
                          item={item}
                          orbit={item.orbit ? orbitMap.get(item.orbit) : undefined}
                          orbits={orbits}
                          focusBoards={boards}
                          vaultLocked={vaultLocked}
                          wipeSeconds={wipeSeconds}
                          selected={selectedIdSet.has(item.id)}
                          selectionMode={selectedIds.length > 0}
                          onToggleSelect={handleToggleSelect}
                          onOpenStudio={handleOpenItem}
                          onQuickLook={handleQuickLook}
                          onHoverItem={handleHoverItem}
                          onOpenSecretSheet={handleOpenItem}
                          onOpenShotLightbox={handleOpenShotLightbox}
                          onDelete={handleDeleteItem}
                          onTogglePin={handleTogglePin}
                          onToggleNotesHub={handleToggleNotesHub}
                          onMoveToOrbit={handleMoveToOrbit}
                          onMoveToBoard={handleMoveToBoard}
                          onDuplicate={handleDuplicateItem}
                          onExportMarkdown={handleExportMarkdown}
                          onUnlockVaultRequest={handleUnlockVaultRequest}
                          onToggleMarkdownTask={handleToggleMarkdownTask}
                          onToggleVoiceAction={handleToggleVoiceAction}
                        />
                      </MasonryCardCell>
                    ))}
                  </div>
                )}
                {showFeedPaginationSentinel ? (
                  <div ref={feedSentinelRef} aria-hidden="true" className="h-4 w-full" />
                ) : null}
                </motion.div>
              </div>
            )}

            {/* Floating Multi-Select Bulk Action Dock */}
            <AnimatePresence>
              {selectedIds.length > 0 ? (
                <motion.div
                  key="bulk-action-dock"
                  data-testid="bulk-action-dock"
                  initial={
                    prefersReduced
                      ? { opacity: 0, transform: 'translate3d(-50%, 0px, 0)' }
                      : { opacity: 0, transform: 'translate3d(-50%, 18px, 0) scale(0.97)' }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1, transform: 'translate3d(-50%, 0px, 0)' }
                      : { opacity: 1, transform: 'translate3d(-50%, 0px, 0) scale(1)' }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0, transform: 'translate3d(-50%, 0px, 0)' }
                      : { opacity: 0, transform: 'translate3d(-50%, 16px, 0) scale(0.97)' }
                  }
                  transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                  className="fixed bottom-5 left-1/2 z-40 flex items-center gap-2 px-3.5 py-2 rounded-[14px] bg-[var(--k-bg-elevated)] border border-[var(--k-border-strong)] shadow-[var(--k-shadow-sheet)] backdrop-blur-xl"
                >
                  <span className="inline-flex items-center gap-1.5 px-1.5 text-[12.5px] font-semibold whitespace-nowrap shrink-0 k-tabular">
                    <span>{t('workspace.bulk.selected')}</span>
                    <span data-testid="bulk-selected-count">{selectedIds.length}</span>
                  </span>

                  <div className="w-px h-5 bg-[var(--k-border-hairline)]" />

                  {selectedIds.length >= 2 ? (
                    <button
                      type="button"
                      data-testid="bulk-synthesize-btn"
                      onClick={() => {
                        setSynthesizeSeedIds(null);
                        setSynthesizeOpen(true);
                      }}
                      className="k-interactive h-8 px-2.5 rounded-[8px] bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium flex items-center gap-1.5 hover:bg-[var(--k-accent-hover)] cursor-pointer"
                    >
                      <Sparkle size={14} weight="fill" />
                      <span>{t('workspace.bulk.synthesize')}</span>
                    </button>
                  ) : null}

                  <PopoverSurface
                    open={bulkOrbitMenuOpen}
                    onOpenChange={setBulkOrbitMenuOpen}
                    align="center"
                    side="top"
                    widthClass="w-[220px] !p-1.5"
                    trigger={
                      <button
                        type="button"
                        className="k-interactive h-8 px-2.5 rounded-[8px] hover:bg-[var(--k-bg-surface-2)] text-[12.5px] font-medium flex items-center gap-1.5 cursor-pointer"
                      >
                        <SquaresFour size={14} />
                        <span>{t('workspace.bulk.toSection')}</span>
                      </button>
                    }
                  >
                    <div className="space-y-0.5 max-h-[260px] overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => void handleBulkMoveOrbit('')}
                        className="k-interactive w-full text-left px-2.5 py-1.5 rounded-[7px] text-[12.5px] text-[var(--k-ink-muted)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        {t('nav.noSection')}
                      </button>
                      {orbits.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => void handleBulkMoveOrbit(o.id)}
                          className="k-interactive w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[7px] text-[12.5px] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                        >
                          <SectionIcon
                            name={o.icon || 'Folder'}
                            color={o.color}
                            className="w-3.5 h-3.5 shrink-0"
                          />
                          <span className="truncate">{o.name}</span>
                        </button>
                      ))}
                    </div>
                  </PopoverSurface>

                  <button
                    type="button"
                    onClick={() => void handleBulkPin(true)}
                    className="k-interactive h-8 px-2.5 rounded-[8px] hover:bg-[var(--k-bg-surface-2)] text-[12.5px] flex items-center gap-1 cursor-pointer"
                  >
                    <PushPin size={14} />
                    <span>{t('workspace.bulk.pin')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleBulkDelete()}
                    className="k-interactive h-8 px-2.5 rounded-[8px] hover:bg-[var(--k-danger-soft)] text-[var(--k-danger)] text-[12.5px] flex items-center gap-1 cursor-pointer"
                  >
                    <Trash size={14} />
                    <span>{t('common.delete')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    className="k-interactive w-7 h-7 rounded-[7px] flex items-center justify-center text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                    aria-label={t('workspace.bulk.clear')}
                  >
                    <X size={14} />
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </main>
            </ContextMenuSurface>
          </div>

          {/* Variant B — Serene Centered Wide Peek Modal over softly dimmed & blurred feed */}
          <AnimatePresence>
            {isNoteDocumentOpen && activeItem ? (
              <div
                key="studio-document-modal-root"
                data-testid="studio-document-modal-root"
                className="k-no-drag fixed inset-0 z-40 flex items-center justify-center p-6"
              >
                <motion.div
                  key="studio-document-backdrop"
                  data-testid="studio-document-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                  onClick={closeStudioCleanly}
                  className="fixed inset-0 bg-[var(--k-bg-backdrop)] backdrop-blur-[5px]"
                />

                <motion.div
                  key="studio-document-canvas"
                  data-testid="studio-document-canvas"
                  role="dialog"
                  aria-modal="true"
                  aria-label={activeItem.title || t('dna.note')}
                  initial={
                    prefersReduced
                      ? { opacity: 0 }
                      : { opacity: 0, transform: 'translate3d(0, 6px, 0) scale(0.978)' }
                  }
                  animate={
                    prefersReduced
                      ? { opacity: 1 }
                      : {
                          opacity: 1,
                          transform: 'translate3d(0, 0, 0) scale(1)',
                          transition: { duration: 0.175, ease: [0.23, 1, 0.32, 1] },
                        }
                  }
                  exit={
                    prefersReduced
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          transform: 'translate3d(0, 3px, 0) scale(0.986)',
                          transition: { duration: 0.13, ease: [0.23, 1, 0.32, 1] },
                        }
                  }
                  onClick={(e) => e.stopPropagation()}
                  className="relative z-10 w-[min(820px,92vw)] h-[min(84vh,840px)] rounded-2xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] shadow-[var(--k-shadow-sheet)] overflow-hidden flex flex-col"
                >
                  <Suspense fallback={null}>
                    <NoteStudio
                      item={activeItem}
                      isDraft={studioDraftMode}
                      orbits={orbits}
                      focusBoards={boards}
                      allItemsForLinks={items}
                      availableTags={allVaultTags}
                      soundEnabled={soundEnabled}
                      layoutMode="center"
                      presentation="modal"
                      onItemUpdated={handleStudioItemUpdated}
                      onDraftPersisted={handleStudioDraftPersisted}
                      onCancelDraft={handleStudioCancelDraft}
                      onSelectRelatedItem={handleStudioSelectRelated}
                      onDelete={async (id) => {
                        await handleDeleteItem(id);
                        setStudioOpen(false);
                      }}
                      onOpenShotLightbox={(shot) => setLightboxItem(shot)}
                      onRegisterClose={handleRegisterStudioClose}
                      onClose={handleStudioClose}
                    />
                  </Suspense>
                </motion.div>
              </div>
            ) : null}
          </AnimatePresence>
        </div>

        {mountAssistant ? (
          <Suspense fallback={null}>
            <MemoryAssistantDrawer
              open={assistantOpen}
              onClose={() => setAssistantOpen(false)}
              onOpenCitation={(itemId, opts) => {
                if (!opts?.keepAssistantOpen) setAssistantOpen(false);
                void handleOpenItemById(itemId);
              }}
              onSynthesizeFound={(itemIds) => {
                setAssistantOpen(false);
                setSynthesizeSeedIds(itemIds);
                setSynthesizeOpen(true);
              }}
            />
          </Suspense>
        ) : null}
      </div>

      {/* Right Inspector Sheet for Vault Secrets only */}
      <AnimatePresence>
        {isSecretSheetOpen && activeItem ? (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div
              key="studio-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              onClick={closeStudioCleanly}
              className="fixed inset-0 bg-[var(--k-bg-backdrop)] backdrop-blur-[2px]"
            />

            <motion.div
              key="studio-secret-sheet"
              data-testid="studio-side-sheet"
              initial={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: 'translate3d(40px, 0, 0)' }
              }
              animate={
                prefersReduced
                  ? { opacity: 1 }
                  : { opacity: 1, transform: 'translate3d(0px, 0, 0)' }
              }
              exit={
                prefersReduced
                  ? { opacity: 0 }
                  : { opacity: 0, transform: 'translate3d(36px, 0, 0)' }
              }
              transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
              style={{ width: '560px', maxWidth: '92vw' }}
              className="relative z-10 h-full bg-[var(--k-bg-surface-1)] border-l border-[var(--k-border-strong)] shadow-[var(--k-shadow-sheet)] flex flex-col overflow-hidden"
            >
              <Suspense fallback={null}>
                <SecretStudioSheet
                  item={activeItem}
                  orbits={orbits}
                  vaultLocked={vaultLocked}
                  wipeSeconds={wipeSeconds}
                  onUnlockRequest={() => setUnlockOpen(true)}
                  onUpdated={(updated) => setActiveItem(updated)}
                  onDelete={async (id) => {
                    await handleDeleteItem(id);
                    setStudioOpen(false);
                  }}
                  onClose={() => setStudioOpen(false)}
                />
              </Suspense>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      {/* Section (Orbit / Board) Create & Customize Modal */}
      <ModalDialog
        open={Boolean(sectionEditor)}
        onOpenChange={(open) => {
          if (!open) setSectionEditor(null);
        }}
        title={
          sectionEditor
            ? sectionEditor.kind === 'orbit'
              ? sectionEditor.mode === 'create'
                ? t('nav.newSection')
                : t('nav.configureSection')
              : sectionEditor.mode === 'create'
                ? t('nav.newBoard')
                : t('nav.configureBoard')
            : ''
        }
        maxWidthClass="max-w-[500px]"
        topAligned
      >
        {sectionEditor ? (
          <form onSubmit={handleSaveSection} className="p-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-[var(--k-ink-secondary)]">
                {t('nav.sectionNameLabel')}
              </label>
              <input
                type="text"
                autoFocus
                data-testid="section-name-input"
                value={sectionEditor.name}
                onChange={(e) =>
                  setSectionEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))
                }
                placeholder={
                  sectionEditor.kind === 'orbit'
                    ? t('nav.sectionNamePlaceholder')
                    : t('nav.boardNamePlaceholder')
                }
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] text-[13.5px] outline-none select-text"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-[var(--k-ink-secondary)]">
                {t('nav.sectionTriageHintLabel')}
              </label>
              <input
                type="text"
                value={sectionEditor.description}
                onChange={(e) =>
                  setSectionEditor((prev) =>
                    prev ? { ...prev, description: e.target.value } : prev,
                  )
                }
                placeholder={t('nav.sectionTriageHintPlaceholder')}
                className="w-full h-9 px-3 rounded-[9px] bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] text-[13px] outline-none select-text"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[12px] font-medium text-[var(--k-ink-secondary)]">
                {t('nav.color')}
              </label>
              <div className="grid grid-cols-14 gap-2 py-0.5">
                {SECTION_COLOR_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() =>
                      setSectionEditor((prev) => (prev ? { ...prev, color: hex } : prev))
                    }
                    className={`w-[22px] h-[22px] rounded-full transition-[scale,transform] duration-140 cursor-pointer flex items-center justify-center ${
                      sectionEditor.color === hex
                        ? 'ring-[1.5px] ring-[var(--k-ink-primary)] ring-offset-[1.5px] ring-offset-[var(--k-bg-surface-1)]'
                        : 'hover:scale-105'
                    }`}
                    style={{ backgroundColor: hex }}
                    aria-label={t('nav.pickColor', { hex })}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[12px] font-medium text-[var(--k-ink-secondary)]">
                {t('nav.icon')}
              </label>
              <div className="grid grid-cols-8 gap-1.5 max-h-[144px] overflow-y-auto p-1.5 rounded-[10px] bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
                {SECTION_ICON_CHOICES.map((iconKey) => {
                  const selected = sectionEditor.icon === iconKey;
                  const iconLabels = getSectionIconLabels(locale);
                  const title = iconLabels[iconKey] ?? iconKey;
                  return (
                    <button
                      key={iconKey}
                      type="button"
                      title={title}
                      onClick={() =>
                        setSectionEditor((prev) => (prev ? { ...prev, icon: iconKey } : prev))
                      }
                      className={`h-9 rounded-[8px] flex items-center justify-center transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[var(--k-accent-soft)] ring-1 ring-[var(--k-accent)]'
                          : 'hover:bg-[var(--k-bg-surface-3)]'
                      }`}
                    >
                      <SectionIcon
                        name={iconKey}
                        color={selected ? sectionEditor.color : undefined}
                        className="w-[18px] h-[18px]"
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSectionEditor(null)}
                className="k-interactive h-9 px-3.5 rounded-[9px] border border-[var(--k-border-hairline)] text-[13px] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={sectionSaving}
                data-testid="section-save-btn"
                className="k-interactive h-9 px-4 rounded-[9px] bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium hover:bg-[var(--k-accent-hover)] cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
              >
                {sectionEditor.mode === 'create' ? t('common.create') : t('common.save')}
              </button>
            </div>
          </form>
        ) : null}
      </ModalDialog>

      {/* Modals & Drawers */}
      {mountQuickLook ? (
        <Suspense fallback={null}>
          <QuickLookModal
            item={quickLookItem}
            itemsList={visibleItems}
            orbit={quickLookItem?.orbit ? orbitMap.get(quickLookItem.orbit) : undefined}
            onSelectItem={setQuickLookItem}
            onClose={() => setQuickLookItem(null)}
            onEditInStudio={(item) => handleOpenItem(item)}
            onTogglePin={(item) => void handleTogglePin(item)}
          />
        </Suspense>
      ) : null}

      {mountLightbox ? (
        <Suspense fallback={null}>
          <ShotLightbox
            item={lightboxItem}
            onClose={() => setLightboxItem(null)}
            onEditInStudio={(item) => {
              setLightboxItem(null);
              handleOpenItem(item);
            }}
            onSaveAnnotations={async (itemId, annotations) => {
              await window.kapsula.updateItem(itemId, { annotations });
            }}
          />
        </Suspense>
      ) : null}

      {mountNewSecret ? (
        <Suspense fallback={null}>
          <NewSecretModal
            open={newSecretOpen}
            initialKind={newSecretKind}
            onOpenChange={setNewSecretOpen}
            onCreated={(created) => {
              setNewSecretOpen(false);
              handleOpenItem(created);
            }}
          />
        </Suspense>
      ) : null}

      {mountUnlock ? (
        <Suspense fallback={null}>
          <UnlockPinDialog
            open={unlockOpen}
            biometricAvailable={settings.biometricUnlockAvailable}
            biometricEnabled={settings.biometricUnlockEnabled}
            initialLockoutSec={settings.pinLockoutRemainingSec ?? 0}
            onOpenChange={(open) => {
              setUnlockOpen(open);
              if (!open) setPendingOpenNewSecretAfterUnlock(false);
            }}
            onUnlocked={() => {
              setUnlockOpen(false);
              void window.kapsula.getSettings().then(onSettingsUpdated);
              if (pendingOpenNewSecretAfterUnlock) {
                setPendingOpenNewSecretAfterUnlock(false);
                setNewSecretOpen(true);
              }
            }}
          />
        </Suspense>
      ) : null}

      {/* Permanent Purge Single Item Confirmation */}
      <ModalDialog
        open={Boolean(confirmPurgeItem)}
        onOpenChange={(open) => {
          if (!open && !trashActionBusy) setConfirmPurgeItem(null);
        }}
        title={t('workspace.confirmPurge.title')}
        subtitle={t('workspace.confirmPurge.subtitle')}
        maxWidthClass="max-w-[440px]"
      >
        <div className="p-5 flex flex-col gap-4">
          {confirmPurgeItem ? (
            <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3.5 py-2.5 text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
              {confirmPurgeItem.title || t('common.noTitle')}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={trashActionBusy}
              onClick={() => setConfirmPurgeItem(null)}
              className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="confirm-purge-item-btn"
              disabled={trashActionBusy}
              onClick={() => {
                if (confirmPurgeItem) void handlePurgeItem(confirmPurgeItem.id);
              }}
              className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-danger)] text-white text-[13px] font-medium cursor-pointer disabled:opacity-60"
            >
              {trashActionBusy ? t('common.deleting') : t('common.deleteForever')}
            </button>
          </div>
        </div>
      </ModalDialog>

      {/* Empty Trash Confirmation */}
      <ModalDialog
        open={confirmEmptyTrashOpen}
        onOpenChange={(open) => {
          if (!open && !trashActionBusy) setConfirmEmptyTrashOpen(false);
        }}
        title={t('workspace.confirmEmptyTrash.title')}
        subtitle={t('workspace.confirmEmptyTrash.subtitle', { count: trashedItems.length })}
        maxWidthClass="max-w-[440px]"
      >
        <div className="p-5 flex flex-col gap-4">
          <div className="text-[12.5px] text-[var(--k-ink-secondary)] leading-relaxed">
            {t('workspace.confirmEmptyTrash.body')}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={trashActionBusy}
              onClick={() => setConfirmEmptyTrashOpen(false)}
              className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="confirm-empty-trash-btn"
              disabled={trashActionBusy}
              onClick={() => void handleEmptyTrash()}
              className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-danger)] text-white text-[13px] font-medium cursor-pointer disabled:opacity-60"
            >
              {trashActionBusy ? t('workspace.confirmEmptyTrash.busy') : t('workspace.emptyTrashButton')}
            </button>
          </div>
        </div>
      </ModalDialog>

      {/* Universal First-Run Onboarding (shown once on genuinely empty vault) */}
      {mountOnboarding ? (
        <Suspense fallback={null}>
          <OnboardingModal
            open={onboardingShouldOpen}
            settings={settings}
            onSettingsUpdated={onSettingsUpdated}
            onCompleted={({ openSync }) => {
              setOnboardingDismissed(true);
              void refreshAll();
              if (openSync) {
                setSettingsInitialTab('sync');
                setSettingsOpen(true);
              }
            }}
          />
        </Suspense>
      ) : null}

      {mountSettings ? (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialTab={settingsInitialTab}
            settings={settings}
            onSettingsUpdated={onSettingsUpdated}
            onRecoveryKeyVisibleChange={setRecoveryKeyVisible}
            onVaultChanged={() => {
              void refreshAll();
            }}
          />
        </Suspense>
      ) : null}

      {mountSynthesize ? (
        <Suspense fallback={null}>
          <SynthesizeNotesModal
            open={synthesizeOpen}
            onOpenChange={(open) => {
              setSynthesizeOpen(open);
              if (!open) setSynthesizeSeedIds(null);
            }}
            items={synthesizeItemsList}
            orbits={orbits}
            activeOrbitId={nav.type === 'orbit' ? nav.orbitId : null}
            activeFocusBoardId={nav.type === 'board' ? nav.boardId : null}
            onCreated={(created) => {
              setSelectedIds([]);
              setSynthesizeSeedIds(null);
              handleOpenItem(created);
            }}
          />
        </Suspense>
      ) : null}

      {mountTriage ? (
        <Suspense fallback={null}>
          <SmartTriageModal
            open={triageOpen}
            onOpenChange={setTriageOpen}
            orbits={orbits}
            onApplied={() => {
              void refreshAll();
            }}
            onOpenAiSettings={() => {
              setTriageOpen(false);
              setSettingsInitialTab('ai');
              setSettingsOpen(true);
            }}
            onRequestMergeGroup={(group) => {
              setTriageOpen(false);
              setSynthesizeSeedIds(group.itemIds);
              setSynthesizeOpen(true);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
};

const SidebarDropLine: React.FC<{ position: DropPosition }> = ({ position }) => (
  <span
    data-testid="sidebar-drop-line"
    aria-hidden="true"
    className={`pointer-events-none absolute left-2 right-2 h-[2px] rounded-full bg-[var(--k-accent)] z-30 ${
      position === 'before' ? '-top-[2px]' : '-bottom-[2px]'
    }`}
  >
    <span className="absolute -left-[3px] -top-[2px] w-[6px] h-[6px] rounded-full bg-[var(--k-accent)]" />
  </span>
);

interface SidebarNavButtonProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  testId?: string;
  draggable?: boolean;
  isDragging?: boolean;
  isCardDropOver?: boolean;
  dropPosition?: DropPosition | null;
  onClick: () => void;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}

const SidebarNavButton: React.FC<SidebarNavButtonProps> = ({
  active,
  icon,
  label,
  count,
  testId,
  draggable = false,
  isDragging = false,
  isCardDropOver = false,
  dropPosition = null,
  onClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}) => {
  const prefersReduced = useReducedMotion();
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`k-interactive relative w-full flex items-center h-8 px-2 rounded-[8px] cursor-pointer ${
        active
          ? 'text-[var(--k-ink-primary)] font-medium'
          : isCardDropOver
            ? 'bg-[var(--k-accent-soft)]/80 text-[var(--k-ink-primary)]'
            : 'text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)]'
      } ${isDragging ? 'opacity-45' : ''}`}
    >
      {dropPosition ? <SidebarDropLine position={dropPosition} /> : null}
      {active ? (
        <motion.span
          layoutId="sidebar-active-pill"
          transition={
            prefersReduced
              ? { duration: 0 }
              : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }
          }
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[8px] bg-[var(--k-accent-soft)]"
        />
      ) : null}
      <span className="relative z-10 shrink-0 mr-2 flex items-center text-[var(--k-accent)]/85">
        {icon}
      </span>
      <span className="relative z-10 flex-1 min-w-0 text-left truncate text-[13px]">{label}</span>
      <span
        data-count={count}
        className="relative z-10 shrink-0 w-[26px] text-right text-[11.5px] k-tabular text-[var(--k-ink-muted)]"
      >
        <NumberFlow value={count} />
      </span>
    </div>
  );
};
