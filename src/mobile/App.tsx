import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCircleUp, Cloud, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Toaster, toast } from 'sonner';
import type { AppLocale } from '@shared/i18n/core';
import type { MobileDictKey } from '@shared/i18n/mobile-dict';
import { APP_VERSION, computeVersionCodeFromSemver } from '@shared/app-version';
import { isDoneColumn, toggleMarkdownTaskInBody } from '@shared/task-helpers';
import type { SyncStatus } from '@shared/sync-contract';
import type {
  AppearanceConfig,
  CalendarEvent,
  FocusBoard,
  OrbitDef,
  SecretCopyField,
  TaskBoardColumn,
  ThemeMode,
  VaultItem,
  VaultTaskEntry,
} from '@shared/types';
import { KapsulaEmblem } from '@renderer/components/ui/KapsulaEmblem';
import { useFoldLayout } from './hooks/useFoldLayout';
import { useKeyboardState } from './hooks/useKeyboardState';
import { consumeTopBackHandler } from './lib/back-stack';
import { MobileMediaCacheContext } from './lib/media-cache-context';
import {
  extractTasksFromMobileItem,
  polishMobileNoteText,
  shouldPromptAiSettings,
  transcribeMobileVoiceItem,
} from './lib/mobile-ai';
import {
  applyMobileThemeAndAppearance,
  persistAppearanceLocal,
  readInitialAppearance,
} from './lib/mobile-appearance';
import { buildMobileDiagnosticsReport } from './lib/mobile-diagnostics';
import {
  evaluateAutoLockChangeGuard,
  evaluateBiometricToggleGuard,
  makeSafeUploadName,
  type MobileTabId,
} from './lib/mobile-helpers';
import {
  getMobileOnboardingPresets,
  getUrlLocaleOverride,
  MobileI18nProvider,
  resolveMobileLocale,
  setRuntimeMobileLocale,
  tm,
  writeStoredMobileLocale,
} from './lib/mobile-i18n';
import {
  checkForMobileUpdate,
  GITHUB_RELEASES_PAGE_URL,
  isSelfUpdateAllowed,
  type MobileUpdateCheckResult,
} from './lib/mobile-updater';
import {
  isNativeExternalFlowInFlight,
  mobileBridge,
  type NativeAppVersion,
  type NativeFoldState,
  type NativeKeyboardState,
  type SharedIntentPayload,
} from './native/bridge';
import { MobileVaultStore, type MobileAiConfig } from './storage/mobile-store';
import { MobileSyncEngine } from './sync/mobile-sync-engine';
import { toDateIso } from './lib/date-utils';
import {
  DRAFT_NOTE_ID,
  type MaterializeDraftInput,
  type NoteDraftBuffer,
  type QuickCaptureTab,
} from './lib/note-draft-types';
import { FeedView } from './components/FeedView';
import {
  MOBILE_NAV_TABS,
  MobileBottomDock,
  MobileNavRail,
} from './components/MobileBottomDock';

const CalendarView = lazy(() =>
  import('./components/CalendarView').then((m) => ({ default: m.CalendarView }))
);
const NotesView = lazy(() =>
  import('./components/NotesView').then((m) => ({ default: m.NotesView }))
);
const TasksView = lazy(() =>
  import('./components/TasksView').then((m) => ({ default: m.TasksView }))
);
const VaultView = lazy(() =>
  import('./components/VaultView').then((m) => ({ default: m.VaultView }))
);
const MobileImageLightbox = lazy(() =>
  import('./components/MobileImageLightbox').then((m) => ({ default: m.MobileImageLightbox }))
);
const MobileSearchOverlay = lazy(() =>
  import('./components/MobileSearchOverlay').then((m) => ({ default: m.MobileSearchOverlay }))
);
const MobileWelcomeSheet = lazy(() =>
  import('./components/MobileWelcomeSheet').then((m) => ({ default: m.MobileWelcomeSheet }))
);
const QuickCaptureSheet = lazy(() =>
  import('./components/QuickCaptureSheet').then((m) => ({ default: m.QuickCaptureSheet }))
);
const SettingsCloudSheet = lazy(() =>
  import('./components/SettingsCloudSheet').then((m) => ({ default: m.SettingsCloudSheet }))
);
const ShareTargetSheet = lazy(() =>
  import('./components/ShareTargetSheet').then((m) => ({ default: m.ShareTargetSheet }))
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

function readInitialTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem('kapsula_mobile_theme');
    return raw === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

type PendingMobileTaskToggle = {
  itemId: string;
  sourceType: 'markdown' | 'voice_action';
  taskIndex: number;
  done: boolean;
  columnId?: string;
  seq: number;
};

function applyOptimisticMobileTaskToItem(
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
  return {
    ...item,
    mediaMeta: {
      ...prevMeta,
      checkedActionIndices: Array.from(checked).sort((a, b) => a - b),
    },
  };
}

export const App: React.FC = () => {
  const fold = useFoldLayout();
  const { keyboardOpen } = useKeyboardState();

  // Persistent singletons for offline store + E2EE sync engine
  const storeRef = useRef<MobileVaultStore | null>(null);
  const syncRef = useRef<MobileSyncEngine | null>(null);
  if (!storeRef.current) {
    storeRef.current = new MobileVaultStore();
  }
  if (!syncRef.current) {
    syncRef.current = new MobileSyncEngine({ store: storeRef.current });
  }
  const store = storeRef.current;
  const syncEngine = syncRef.current;

  const flushEditorRef = useRef<(() => Promise<void>) | null>(null);
  const seenShareIdsRef = useRef<Set<string>>(new Set());
  const seenAuthCallbacksRef = useRef<Set<string>>(new Set());
  const inFlightAuthCallbacksRef = useRef<Set<string>>(new Set());

  // Boot & data state
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trashedItems, setTrashedItems] = useState<VaultItem[]>([]);
  const [archivedItems, setArchivedItems] = useState<VaultItem[]>([]);
  const [orbits, setOrbits] = useState<OrbitDef[]>([]);
  const [boards, setBoards] = useState<FocusBoard[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [tasks, setTasks] = useState<VaultTaskEntry[]>([]);
  const [taskColumns, setTaskColumns] = useState<TaskBoardColumn[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => syncEngine.getStatus());

  // Fold-continuous navigation & selection state (lifted above compact/expanded switch!)
  const [activeTab, setActiveTab] = useState<MobileTabId>('feed');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrbitId, setSelectedOrbitId] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [selectedFeedItemId, setSelectedFeedItemId] = useState<string | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, NoteDraftBuffer>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedDateIso, setSelectedDateIso] = useState<string>(() => toDateIso(new Date()));
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);

  // Settings, Custom Color Engine, AI, Locale & Vault Security state
  const [locale, setLocaleState] = useState<AppLocale>(() => resolveMobileLocale());
  const userLocaleOverrideRef = useRef<AppLocale | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [appearance, setAppearance] = useState<AppearanceConfig>(readInitialAppearance);
  const t = useCallback(
    (key: MobileDictKey, params?: Record<string, string | number>) => tm(key, params, locale),
    [locale]
  );
  const handleChangeLocale = useCallback(
    (next: AppLocale) => {
      userLocaleOverrideRef.current = next;
      setLocaleState(next);
      writeStoredMobileLocale(next);
      setRuntimeMobileLocale(next);
      void store.setLocale(next);
    },
    [store]
  );
  const [biometricEnabled, setBiometricEnabled] = useState(true);
  const [hasMasterPin, setHasMasterPin] = useState(false);
  const [pinLockoutRemainingSec, setPinLockoutRemainingSec] = useState(0);
  const [autoLockMinutes, setAutoLockMinutes] = useState(5);
  const autoLockMinutesRef = useRef(autoLockMinutes);
  autoLockMinutesRef.current = autoLockMinutes;
  const [wipeSeconds, setWipeSeconds] = useState(30);
  const [aiConfig, setAiConfig] = useState<MobileAiConfig>({
    provider: 'local',
    hasGoogleKey: false,
    hasOpenRouterKey: false,
  });
  const [vaultLocked, setVaultLocked] = useState(true);
  const vaultLockedRef = useRef(true);
  const [sensitiveOverlayVisible, setSensitiveOverlayVisible] = useState(false);

  useEffect(() => {
    vaultLockedRef.current = vaultLocked;
    syncEngine.setVaultLockedProvider(() => vaultLockedRef.current || store.isVaultLocked());
  }, [vaultLocked, store, syncEngine]);

  // Modals / Sheets / Lightbox / Share Queue / First-run Welcome
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureTab, setCaptureTab] = useState<QuickCaptureTab>('text');
  const [vaultCreateSignal, setVaultCreateSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    'cloud' | 'appearance' | 'structure'
  >('cloud');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [shareQueue, setShareQueue] = useState<SharedIntentPayload[]>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; caption?: string } | null>(
    null
  );
  const mountSearch = useMountOnce(searchOpen);
  const mountWelcome = useMountOnce(welcomeOpen);
  const mountCapture = useMountOnce(captureOpen);
  const mountShare = useMountOnce(shareQueue.length > 0);
  const mountSettings = useMountOnce(settingsOpen);
  const mountLightbox = useMountOnce(Boolean(lightboxImage));

  // App Version & In-App Updates state
  const [appVersion, setAppVersion] = useState<NativeAppVersion>({
    versionName: APP_VERSION,
    versionCode: computeVersionCodeFromSemver(APP_VERSION),
  });
  const [updateInfo, setUpdateInfo] = useState<MobileUpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);

  const openSettingsAt = useCallback((sec: 'cloud' | 'appearance' | 'structure' = 'cloud') => {
    setSettingsInitialSection(sec);
    setSettingsOpen(true);
  }, []);

  const handleAuthCallbackUrl = useCallback(
    async (rawUrl: string) => {
      const clean = rawUrl.trim();
      if (!clean || seenAuthCallbacksRef.current.has(clean) || inFlightAuthCallbacksRef.current.has(clean)) {
        return;
      }
      inFlightAuthCallbacksRef.current.add(clean);
      try {
        const res = await syncEngine.completeOAuthCallback(clean);
        if (!res.ok) {
          mobileBridge.haptic('error');
          toast.error(res.error || t('toast.googleError'));
          return;
        }
        seenAuthCallbacksRef.current.add(clean);
        mobileBridge.haptic('success');
        if (res.needsPassphraseSetup) {
          toast.success(t('toast.googleNeedsSetup'));
          openSettingsAt('cloud');
        } else if (res.needsPassphraseUnlock) {
          toast.success(t('toast.googleNeedsUnlock'));
          openSettingsAt('cloud');
        } else {
          toast.success(t('toast.googleSuccess'));
        }
      } finally {
        inFlightAuthCallbacksRef.current.delete(clean);
      }
    },
    [syncEngine, openSettingsAt, t]
  );

  const handleCheckUpdates = useCallback(
    async (manual = true) => {
      if (!isSelfUpdateAllowed(appVersion)) return;
      setUpdateChecking(true);
      try {
        const res = await checkForMobileUpdate({
          currentVersion: appVersion.versionName,
          currentVersionCode: appVersion.versionCode,
        });
        setUpdateInfo(res);
        if (manual) {
          if (res.status === 'update_available' && res.latestVersion) {
            mobileBridge.haptic('success');
            toast.success(t('toast.updateFound', { version: res.latestVersion }));
          } else if (res.status === 'up_to_date') {
            mobileBridge.haptic('light');
            toast(t('toast.updateLatest'));
          } else if (res.error) {
            mobileBridge.haptic('error');
            toast.error(res.error);
          }
        }
      } finally {
        setUpdateChecking(false);
      }
    },
    [appVersion, t]
  );

  const handleInstallUpdate = useCallback(async () => {
    if (!isSelfUpdateAllowed(appVersion) || !updateInfo?.apkUrl) return;
    if (!updateInfo.sha256) {
      await mobileBridge.openExternalUrl(updateInfo.releaseUrl || GITHUB_RELEASES_PAGE_URL);
      return;
    }
    setUpdateInstalling(true);
    setUpdateDownloadPercent(1);
    try {
      const res = await mobileBridge.downloadAndInstallApk(updateInfo.apkUrl, updateInfo.sha256);
      if (!res.ok) {
        mobileBridge.haptic('error');
        toast.error(res.error || t('toast.updateInstallErr'));
      } else {
        mobileBridge.haptic('success');
        toast.success(t('toast.updateOpeningInstaller'));
      }
    } finally {
      setUpdateInstalling(false);
      setUpdateDownloadPercent(null);
    }
  }, [appVersion, updateInfo, t]);

  const enqueueSharesUnique = useCallback((incoming: SharedIntentPayload[]) => {
    const fresh: SharedIntentPayload[] = [];
    for (const s of incoming) {
      if (!s?.id || seenShareIdsRef.current.has(s.id)) continue;
      seenShareIdsRef.current.add(s.id);
      fresh.push(s);
    }
    if (fresh.length > 0) {
      setShareQueue((prev) => [...prev, ...fresh]);
    }
  }, []);

  const pendingMobileTogglesRef = useRef<Map<string, PendingMobileTaskToggle>>(new Map());
  const mobileToggleSeqRef = useRef(0);

  const refreshFromStore = useCallback(() => {
    const rawItems = store.listItems({ includeSecrets: true });
    const rawTasks = store.listVaultTasks();
    const pending = pendingMobileTogglesRef.current;

    const nextItems =
      pending.size === 0
        ? rawItems
        : rawItems.map((it) => {
            let patched = it;
            pending.forEach((entry) => {
              if (entry.itemId === it.id) {
                patched = applyOptimisticMobileTaskToItem(
                  patched,
                  entry.sourceType,
                  entry.taskIndex,
                  entry.done
                );
              }
            });
            return patched;
          });

    const nextTasks =
      pending.size === 0
        ? rawTasks
        : rawTasks.map((t) => {
            const key = `${t.itemId}:${t.sourceType}:${t.taskIndex}`;
            const entry = pending.get(key);
            if (!entry) return t;
            return {
              ...t,
              done: entry.done,
              columnId: entry.columnId ?? t.columnId,
            };
          });

    const nextTrashed = store.listTrashedItems();
    const nextArchived = store.listArchivedItems();
    const nextOrbits = store.listOrbits();
    setItems(nextItems);
    setTrashedItems(nextTrashed);
    setArchivedItems(nextArchived);
    setOrbits(nextOrbits);
    setBoards(store.listBoards());
    setEvents(store.listCalendarEvents());
    setTasks(nextTasks);
    setTaskColumns(store.listTaskBoardColumns());
    setAiConfig(store.getMobileAiConfig());
    setHasMasterPin(store.hasMasterPin());
    setPinLockoutRemainingSec(store.getPinLockoutRemainingSec());

    // Keep appearance in sync with cloud workspace_prefs
    const storedAppearance = store.getAppearanceConfig();
    if (store.getSyncState('appearance_config_json')) {
      setAppearance((prev) => {
        const prevJson = JSON.stringify(prev);
        const nextJson = JSON.stringify(storedAppearance);
        if (prevJson === nextJson) return prev;
        persistAppearanceLocal(storedAppearance);
        return storedAppearance;
      });
    }

    // Keep UI locale in sync with store/remote workspace_prefs (URL ?lang= seeds initial locale unless user switched)
    const persistedLocale = store.getPersistedLocale();
    if (userLocaleOverrideRef.current !== null) {
      if (persistedLocale && persistedLocale !== userLocaleOverrideRef.current) {
        userLocaleOverrideRef.current = persistedLocale;
        setRuntimeMobileLocale(persistedLocale);
        setLocaleState(persistedLocale);
      }
    } else {
      const urlLockedLocale = getUrlLocaleOverride();
      const nextLocale = urlLockedLocale ?? store.getLocale();
      setLocaleState((prev) => (prev === nextLocale ? prev : nextLocale));
    }

    // Dismiss first-run welcome sheet automatically if vault gained data via sync or seeding
    if (
      nextItems.length > 0 ||
      nextOrbits.length > 0 ||
      nextTrashed.length > 0 ||
      nextArchived.length > 0
    ) {
      setWelcomeOpen(false);
    }
  }, [store]);

  const handleToggleTaskOptimistic = useCallback(
    async (task: VaultTaskEntry) => {
      const nextDone = !task.done;
      const cols = taskColumns.length > 0 ? taskColumns : store.listTaskBoardColumns();
      const doneColId = cols.find((c) => isDoneColumn(c.id, cols))?.id ?? 'done';
      const inboxColId = cols.find((c) => !isDoneColumn(c.id, cols))?.id ?? cols[0]?.id ?? 'inbox';
      const nextColumnId = nextDone ? doneColId : inboxColId;
      const key = `${task.itemId}:${task.sourceType}:${task.taskIndex}`;
      const seq = ++mobileToggleSeqRef.current;

      pendingMobileTogglesRef.current.set(key, {
        itemId: task.itemId,
        sourceType: task.sourceType,
        taskIndex: task.taskIndex,
        done: nextDone,
        columnId: nextColumnId,
        seq,
      });

      // Instant 0ms optimistic update BEFORE awaiting IndexedDB persistence
      setTasks((prev) =>
        prev.map((row) =>
          row.itemId === task.itemId &&
          row.sourceType === task.sourceType &&
          row.taskIndex === task.taskIndex
            ? { ...row, done: nextDone, columnId: nextColumnId }
            : row
        )
      );
      setItems((prev) =>
        prev.map((it) =>
          it.id === task.itemId
            ? applyOptimisticMobileTaskToItem(it, task.sourceType, task.taskIndex, nextDone)
            : it
        )
      );

      try {
        await store.toggleVaultTask(task);
        const cur = pendingMobileTogglesRef.current.get(key);
        if (cur && cur.seq === seq) {
          pendingMobileTogglesRef.current.delete(key);
        }
      } catch (err) {
        const cur = pendingMobileTogglesRef.current.get(key);
        if (cur && cur.seq === seq) {
          pendingMobileTogglesRef.current.delete(key);
        }
        refreshFromStore();
        throw err;
      }
    },
    [store, taskColumns, refreshFromStore]
  );

  const handleToggleMarkdownTaskOptimistic = useCallback(
    async (itemId: string, taskIndex: number, nextDone: boolean) => {
      const existingTask = tasks.find(
        (t) => t.itemId === itemId && t.sourceType === 'markdown' && t.taskIndex === taskIndex
      );
      if (existingTask) {
        await handleToggleTaskOptimistic({ ...existingTask, done: !nextDone });
        return;
      }
      const targetItem = items.find((it) => it.id === itemId);
      if (!targetItem) return;
      const synthetic: VaultTaskEntry = {
        id: `${itemId}:md:${taskIndex}`,
        itemId,
        itemTitle: targetItem.title || '',
        sourceType: 'markdown',
        taskIndex,
        text: '',
        done: !nextDone,
        orbit: targetItem.orbit || null,
        remindAt: targetItem.remindAt ?? null,
        updatedAt: targetItem.updatedAt,
      };
      await handleToggleTaskOptimistic(synthetic);
    },
    [tasks, items, handleToggleTaskOptimistic]
  );

  const handleUpdateItemOptimistic = useCallback(
    async (
      id: string,
      patch: Partial<Pick<VaultItem, 'orbit' | 'focusBoardId' | 'isPinned' | 'title' | 'body'>>
    ) => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
      try {
        await store.updateItem(id, patch);
      } catch (err) {
        refreshFromStore();
        throw err;
      }
    },
    [store, refreshFromStore]
  );

  // Apply theme + custom color engine tokens + dynamic system bars color synchronously
  useEffect(() => {
    try {
      localStorage.setItem('kapsula_mobile_theme', theme);
    } catch {
      // ignore
    }
    applyMobileThemeAndAppearance(theme, appearance);
  }, [theme, appearance]);

  const handleChangeAppearance = useCallback(
    (patch: Partial<AppearanceConfig>) => {
      setAppearance((prev) => {
        const next: AppearanceConfig = { ...prev, ...patch };
        persistAppearanceLocal(next);
        void store.saveAppearanceConfig(next);
        return next;
      });
    },
    [store]
  );

  // FLAG_SECURE whenever Vault is unlocked/visible (including Global Search when unlocked) OR one-time Recovery Key is shown
  useEffect(() => {
    const shouldSecure =
      (!vaultLocked && (activeTab === 'vault' || searchOpen)) || sensitiveOverlayVisible;
    void mobileBridge.setScreenSecure(shouldSecure);
  }, [vaultLocked, activeTab, searchOpen, sensitiveOverlayVisible]);

  // Foreground idle auto-lock timer for Vault
  useEffect(() => {
    if (vaultLocked || autoLockMinutes <= 0 || (!biometricEnabled && !hasMasterPin)) return;
    const timeoutMs = autoLockMinutes * 60_000;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let lastReset = 0;

    const arm = () => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        store.lockVault();
        setVaultLocked(true);
      }, timeoutMs);
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastReset < 1000) return;
      lastReset = now;
      arm();
    };

    arm();
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
    return () => {
      if (timerId) clearTimeout(timerId);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('touchstart', onActivity);
    };
  }, [vaultLocked, autoLockMinutes, biometricEnabled, hasMasterPin]);

  // Boot Store, Sync Engine, Share Target & App Lifecycle
  useEffect(() => {
    let active = true;
    let prevSyncUserId: string | null = syncEngine.getStatus().userId;
    const unsubStore = store.subscribe(() => {
      if (!active) return;
      refreshFromStore();
      if (!store.hasMasterPin() && !store.isVaultLocked() && store.getSyncState('pref_biometric_vault') === '0') {
        setVaultLocked(false);
      }
    });
    const unsubSync = syncEngine.onStatusChanged((st) => {
      if (!active) return;
      setSyncStatus(st);
      if (prevSyncUserId && !st.userId && st.state === 'signed_out') {
        setHasMasterPin(false);
        if (!store.hasMasterPin()) {
          setVaultLocked(false);
        }
      }
      prevSyncUserId = st.userId;
    });

    const boot = async () => {
      await syncEngine.init();
      if (!active) return;

      const savedBio = store.getSyncState('pref_biometric_vault');
      const bioOn = savedBio !== '0';
      const pinSet = store.hasMasterPin();
      setBiometricEnabled(bioOn);
      setHasMasterPin(pinSet);
      setPinLockoutRemainingSec(store.getPinLockoutRemainingSec());
      const shouldLock = bioOn || pinSet;
      if (shouldLock) store.lockVault();
      setVaultLocked(shouldLock);

      const savedWipe = Number(store.getSyncState('pref_wipe_seconds') || '30');
      if (savedWipe === 15 || savedWipe === 30 || savedWipe === 60) {
        setWipeSeconds(savedWipe);
      }

      const savedAutoLock = store.getSyncState('pref_auto_lock_minutes');
      if (savedAutoLock !== null) {
        const parsed = Number(savedAutoLock);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 120) {
          setAutoLockMinutes(parsed);
        }
      }

      refreshFromStore();
      const statusNow = syncEngine.getStatus();
      setSyncStatus(statusNow);

      // Show sleek skippable welcome sheet ONLY on truly empty first-run vault
      const onboarded = store.getSyncState('pref_onboarded') === '1';
      const isTrulyEmpty =
        store.listItems({ includeSecrets: true }).length === 0 &&
        store.listOrbits().length === 0 &&
        store.listTrashedItems().length === 0;
      if (!onboarded && isTrulyEmpty && statusNow.state === 'signed_out') {
        setWelcomeOpen(true);
      }

      const dismissedVer = store.getSyncState('dismissed_update_version');
      if (dismissedVer) {
        setDismissedUpdateVersion(dismissedVer);
      }

      const installedVer = await mobileBridge.getAppVersion();
      if (active && installedVer?.versionName) {
        setAppVersion(installedVer);
      }

      setReady(true);

      const shares = await mobileBridge.consumePendingShares();
      if (active && shares.length > 0) {
        enqueueSharesUnique(shares);
      }

      const pendingAuthUrl = await mobileBridge.consumePendingAuthCallback();
      if (active && pendingAuthUrl) {
        void handleAuthCallbackUrl(pendingAuthUrl);
      }

      if (active && mobileBridge.isNativeAndroid() && isSelfUpdateAllowed(installedVer)) {
        silentUpdateTimer = setTimeout(() => {
          if (!active) return;
          void checkForMobileUpdate({
            currentVersion: installedVer.versionName,
            currentVersionCode: installedVer.versionCode,
          }).then((res) => {
            if (active && res.status === 'update_available') {
              setUpdateInfo(res);
            }
          });
        }, 3000);
      }
    };

    let silentUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    void boot();

    const offShare = mobileBridge.onShareReceived((payload) => {
      if (active) enqueueSharesUnique([payload]);
    });

    const offAuthCallback = mobileBridge.onAuthCallbackUrl((url) => {
      if (active) void handleAuthCallbackUrl(url);
    });

    const offApkProgress = mobileBridge.onApkDownloadProgress((percent) => {
      if (active) setUpdateDownloadPercent(percent);
    });

    const offLifecycle = mobileBridge.onAppLifecycle((state) => {
      if (!active) return;
      if (state === 'paused') {
        void flushEditorRef.current?.();
        if (
          !isNativeExternalFlowInFlight() &&
          autoLockMinutesRef.current > 0 &&
          (store.getSyncState('pref_biometric_vault') !== '0' || store.hasMasterPin())
        ) {
          store.lockVault();
          setVaultLocked(true);
        }
      } else if (state === 'resumed') {
        syncEngine.handleAppResume();
        void mobileBridge.consumePendingShares().then((shares) => {
          if (active && shares.length > 0) enqueueSharesUnique(shares);
        });
        void mobileBridge.consumePendingAuthCallback().then((pendingUrl) => {
          if (active && pendingUrl) void handleAuthCallbackUrl(pendingUrl);
        });
      }
    });

    if (typeof window !== 'undefined' && !mobileBridge.isNativeAndroid()) {
      (window as unknown as Record<string, unknown>).__kapsulaMobile = {
        store,
        syncEngine,
        refresh: refreshFromStore,
        triggerShare: (payload: SharedIntentPayload) => enqueueSharesUnique([payload]),
        setKeyboardState: (detail: NativeKeyboardState) =>
          window.dispatchEvent(new CustomEvent('kapsula:keyboard-state', { detail })),
        setFoldState: (detail: NativeFoldState) =>
          window.dispatchEvent(new CustomEvent('kapsula:fold-state', { detail })),
      };
    }

    return () => {
      active = false;
      if (silentUpdateTimer) clearTimeout(silentUpdateTimer);
      unsubStore();
      unsubSync();
      offShare();
      offAuthCallback();
      offApkProgress();
      offLifecycle();
    };
  }, [store, syncEngine, refreshFromStore, enqueueSharesUnique, handleAuthCallbackUrl]);

  // Step-by-step Android system Back gesture handler
  const backStateRef = useRef({
    hasShare: false,
    welcomeOpen: false,
    captureOpen: false,
    settingsOpen: false,
    searchOpen: false,
    isExpanded: false,
    activeTab: 'feed' as MobileTabId,
    activeNoteId: null as string | null,
    selectedFeedItemId: null as string | null,
    selectedTaskId: null as string | null,
    selectedSecretId: null as string | null,
  });
  backStateRef.current = {
    hasShare: shareQueue.length > 0,
    welcomeOpen,
    captureOpen,
    settingsOpen,
    searchOpen,
    isExpanded: fold.isExpanded,
    activeTab,
    activeNoteId,
    selectedFeedItemId,
    selectedTaskId,
    selectedSecretId,
  };

  useEffect(() => {
    return mobileBridge.onBackPressed(() => {
      if (consumeTopBackHandler()) {
        return;
      }
      const s = backStateRef.current;
      if (s.hasShare) {
        setShareQueue((prev) => prev.slice(1));
        return;
      }
      if (s.welcomeOpen) {
        setWelcomeOpen(false);
        void store.setSyncState('pref_onboarded', '1');
        return;
      }
      if (s.captureOpen) {
        setCaptureOpen(false);
        return;
      }
      if (s.settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (s.searchOpen) {
        setSearchQuery('');
        setSearchOpen(false);
        return;
      }
      if (s.activeTab === 'notes') {
        const target = !s.isExpanded && s.activeNoteId ? 'closeNote' : 'feed';
        void Promise.resolve()
          .then(() => flushEditorRef.current?.())
          .catch(() => undefined)
          .finally(() => {
            if (target === 'closeNote') setActiveNoteId(null);
            else setActiveTab('feed');
          });
        return;
      }
      if (s.activeTab === 'feed' && s.selectedFeedItemId) {
        setSelectedFeedItemId(null);
        return;
      }
      if (s.activeTab === 'tasks' && s.selectedTaskId) {
        setSelectedTaskId(null);
        return;
      }
      if (s.activeTab === 'vault' && s.selectedSecretId) {
        setSelectedSecretId(null);
        return;
      }
      if (s.activeTab !== 'feed') {
        setActiveTab('feed');
        return;
      }
      void mobileBridge.minimizeApp();
    });
  }, [store]);

  // Delete handlers with reversible Trash & 5-second Undo toast!
  const handleDeleteItemWithUndo = useCallback(
    async (id: string, label?: string) => {
      const raw = store.getRawItem(id);
      if (!raw) return;
      await store.deleteItem(id);
      setNoteDrafts((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast(label ?? t('common.movedToTrash'), {
        duration: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            void store.restoreItem(id);
            mobileBridge.haptic('success');
            toast.success(t('common.restored'));
          },
        },
      });
    },
    [store, t]
  );

  const handleBulkDeleteWithUndo = useCallback(
    async (ids: string[]) => {
      const validIds = ids.filter((id) => Boolean(store.getRawItem(id)));
      for (const id of validIds) {
        await store.deleteItem(id);
      }
      if (validIds.length === 0) return;
      toast(t('common.movedMultipleToTrash', { count: validIds.length }), {
        duration: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            void Promise.all(validIds.map((id) => store.restoreItem(id))).then(() => {
              mobileBridge.haptic('success');
              toast.success(t('common.itemsRestored'));
            });
          },
        },
      });
    },
    [store, t]
  );

  const handleDeleteEventWithUndo = useCallback(
    async (id: string) => {
      const raw = store.getRawCalendarEvent(id);
      if (!raw) return;
      const snapshot = { ...raw };
      await store.deleteCalendarEvent(id);
      toast(t('toast.eventDeleted'), {
        duration: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            void store.restoreRawCalendarEvent(snapshot);
            mobileBridge.haptic('success');
            toast.success(t('toast.eventRestored'));
          },
        },
      });
    },
    [store, t]
  );

  const handleDeleteTaskWithUndo = useCallback(
    async (task: VaultTaskEntry) => {
      const snapshot = await store.deleteVaultTask(task);
      if (!snapshot) return;
      toast(t('toast.taskDeleted'), {
        duration: 5000,
        action: {
          label: t('common.undo'),
          onClick: () => {
            void store.restoreRawItem(snapshot);
            mobileBridge.haptic('success');
            toast.success(t('toast.taskRestored'));
          },
        },
      });
    },
    [store, t]
  );

  // Unlock Vault via Android BiometricPrompt with fail-closed Master PIN fallback
  const handleUnlockVault = useCallback(async (): Promise<{
    ok: boolean;
    needsPinFallback?: boolean;
    error?: string;
  }> => {
    if (!biometricEnabled && !hasMasterPin) {
      store.localCrypto.setPinProtectedMode(false);
      setVaultLocked(false);
      return { ok: true };
    }
    if (!biometricEnabled && hasMasterPin) {
      return { ok: false, needsPinFallback: true };
    }
    const res = await mobileBridge.authenticateBiometric(
      t('biometric.vaultTitle'),
      t('biometric.vaultSubtitle')
    );
    if (res.ok) {
      const vdkRes = await store.unlockVaultWithBiometric();
      if (!vdkRes.ok) {
        return { ok: false, needsPinFallback: true };
      }
      setVaultLocked(false);
      return { ok: true };
    }
    if (res.reason === 'no_device_credential' || res.reason === 'hardware_unavailable') {
      return { ok: false, needsPinFallback: true, error: res.error };
    }
    if (res.error) {
      toast.error(res.error);
    }
    return { ok: false, error: res.error };
  }, [biometricEnabled, hasMasterPin, store, t]);

  const handleUnlockWithPin = useCallback(
    async (
      pin: string
    ): Promise<{ ok: boolean; lockoutRemainingSec: number; error?: string }> => {
      const res = await store.unlockVaultWithPin(pin);
      setPinLockoutRemainingSec(res.lockoutRemainingSec);
      if (res.ok) {
        setVaultLocked(false);
        return { ok: true, lockoutRemainingSec: 0 };
      }
      return res;
    },
    [store]
  );

  const handleCopySecretField = useCallback(
    async (itemId: string, field: SecretCopyField): Promise<number | null> => {
      const val = await store.getSecretFieldValue(itemId, field);
      if (!val) return null;
      const shouldWipe =
        field === 'secretValue' ||
        field === 'cvv' ||
        field === 'notes' ||
        field === 'totp';
      const res = await mobileBridge.copySensitive(val, shouldWipe ? wipeSeconds : 0, shouldWipe);
      return res.ok ? (shouldWipe ? res.wipeSeconds : 0) : null;
    },
    [store, wipeSeconds]
  );

  const handleDraftChange = useCallback((itemId: string, draft: NoteDraftBuffer) => {
    setNoteDrafts((prev) => ({ ...prev, [itemId]: draft }));
  }, []);

  const handleDraftSaved = useCallback((itemId: string, savedRev: number) => {
    setNoteDrafts((prev) => {
      const cur = prev[itemId];
      if (!cur || cur.rev !== savedRev) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  const handleMaterializeDraft = useCallback(
    async (input: MaterializeDraftInput): Promise<VaultItem> => {
      const created = await store.createItem({
        dna: 'note',
        title: input.title,
        body: input.body,
        orbit: input.orbit,
        focusBoardId: input.focusBoardId,
        isPinned: input.isPinned,
        tags: input.tags,
        remindAt: input.remindAt,
        preserveEmptyTitle: true,
      });
      setNoteDrafts((prev) => {
        if (!prev[DRAFT_NOTE_ID]) return prev;
        const next = { ...prev };
        delete next[DRAFT_NOTE_ID];
        return next;
      });
      return created;
    },
    [store]
  );

  // Inline note image insertion via store.putMedia -> returns localName for KapsulaImage TipTap node
  const handleInsertInlinePhoto = useCallback(
    async (source: 'camera' | 'gallery'): Promise<string | null> => {
      const file =
        source === 'camera'
          ? await mobileBridge.capturePhoto()
          : (await mobileBridge.pickFile('image/*', false))[0] ?? null;
      if (!file) return null;
      const bytes = await mobileBridge.readNativeFileBytes(file);
      const localName = makeSafeUploadName('shot', file.name, file.mime);
      await store.putMedia(localName, file.mime, bytes);
      return localName;
    },
    [store]
  );

  const handleAttachPhotoToNote = useCallback(
    async (itemId: string, source: 'camera' | 'gallery') => {
      const localName = await handleInsertInlinePhoto(source);
      if (!localName) return;
      await store.updateItem(itemId, { imagePath: localName, thumbPath: localName });
      mobileBridge.haptic('success');
      toast.success(t('toast.photoAttached'));
    },
    [store, handleInsertInlinePhoto, t]
  );

  // Voice AI transcription, task extraction & text polish (personal key -> built-in cloud proxy)
  const handleTranscribeVoice = useCallback(
    async (item: VaultItem) => {
      const res = await transcribeMobileVoiceItem(store, item, undefined, syncEngine);
      if (!res.ok) {
        toast.error(res.error || t('toast.transcribeError'), {
          action: shouldPromptAiSettings(res.error)
            ? {
                label: t('toast.setupAiAction'),
                onClick: () => openSettingsAt('appearance'),
              }
            : undefined,
        });
        return;
      }
      mobileBridge.haptic('success');
      const tasksAdded = res.extractedTasks?.length ?? 0;
      toast.success(
        tasksAdded > 0
          ? t('toast.transcribeDoneWithTasks', { count: tasksAdded })
          : t('toast.transcribeDone')
      );
    },
    [store, syncEngine, openSettingsAt, t]
  );

  const handleExtractTasks = useCallback(
    async (item: VaultItem) => {
      const res = await extractTasksFromMobileItem(store, item, syncEngine);
      if (!res.ok) {
        toast.error(res.error || t('toast.extractTasksError'), {
          action: shouldPromptAiSettings(res.error)
            ? {
                label: t('toast.setupAiAction'),
                onClick: () => openSettingsAt('appearance'),
              }
            : undefined,
        });
        return;
      }
      mobileBridge.haptic('success');
      if (res.tasks.length === 0) {
        toast(t('toast.extractTasksEmpty'));
      } else {
        toast.success(t('toast.extractTasksDone', { count: res.tasks.length }));
      }
    },
    [store, syncEngine, openSettingsAt, t]
  );

  const handlePolishNote = useCallback(
    async (item: VaultItem) => {
      const res = await polishMobileNoteText(store, item, syncEngine);
      if (!res.ok) {
        toast.error(res.error || t('toast.polishError'), {
          action: shouldPromptAiSettings(res.error)
            ? {
                label: t('toast.setupAiAction'),
                onClick: () => openSettingsAt('appearance'),
              }
            : undefined,
        });
        return;
      }
      mobileBridge.haptic('success');
      toast.success(t('toast.polishDone'));
    },
    [store, syncEngine, openSettingsAt, t]
  );

  const handleCopyDiagnostics = useCallback(async () => {
    const notesCount = items.filter((it) => it.dna === 'note').length;
    const secretsCount = items.filter((it) => it.dna === 'secret').length;
    const report = buildMobileDiagnosticsReport({
      appVersionName: appVersion.versionName,
      appVersionCode: appVersion.versionCode,
      platform: mobileBridge.isNativeAndroid() ? 'android' : 'web',
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
      foldMode: fold.isExpanded ? 'expanded' : 'compact',
      foldPosture: fold.posture,
      itemCounts: {
        activeTotal: items.length,
        notes: notesCount,
        secrets: secretsCount,
        tasksTotal: tasks.length,
        eventsTotal: events.length,
        orbits: orbits.length,
        boards: boards.length,
        trashed: trashedItems.length,
        archived: archivedItems.length,
      },
      syncStatus,
      aiConfig,
    });
    await mobileBridge.copyPlain(report);
    mobileBridge.haptic('success');
    toast.success(t('toast.diagnosticsCopied'));
  }, [
    appVersion,
    fold.isExpanded,
    fold.posture,
    items,
    tasks.length,
    events.length,
    orbits.length,
    boards.length,
    trashedItems.length,
    archivedItems.length,
    syncStatus,
    aiConfig,
    t,
  ]);

  const handleCreateOrbitQuick = useCallback(
    async (name: string, color: string): Promise<string> => {
      const created = await store.createOrbit({ name, color });
      return created.id;
    },
    [store]
  );

  const handleCreateBoardQuick = useCallback(
    async (name: string, color: string): Promise<string> => {
      const created = await store.createBoard({ name, color });
      return created.id;
    },
    [store]
  );

  const handleConfirmShare = useCallback(
    async (data: {
      share: SharedIntentPayload;
      title: string;
      body: string;
      url: string | null;
      orbit: string;
      focusBoardId: string | null;
    }) => {
      const files = data.share.files ?? [];
      const imageFiles = files.filter((f) => f.mime.startsWith('image/'));
      const nonImageFiles = files.filter((f) => !f.mime.startsWith('image/'));

      let firstCreatedId: string | null = null;

      if (imageFiles.length > 0 || nonImageFiles.length === 0) {
        let imagePath: string | null = null;
        const galleryPaths: string[] = [];
        for (const img of imageFiles) {
          const bytes = await mobileBridge.readNativeFileBytes(img);
          const localName = makeSafeUploadName('shot', img.name, img.mime);
          await store.saveMediaFile(localName, img.mime, bytes);
          if (!imagePath) imagePath = localName;
          else galleryPaths.push(localName);
        }

        const created = await store.createItem({
          dna: imagePath ? 'shot' : data.url ? 'link' : 'note',
          title: data.title,
          body: data.body,
          url: data.url,
          orbit: data.orbit,
          focusBoardId: data.focusBoardId,
          imagePath,
          thumbPath: imagePath,
          mediaMeta: galleryPaths.length > 0 ? { galleryPaths } : null,
          source: 'vault_ui',
        });
        firstCreatedId = created.id;
      }

      for (let i = 0; i < nonImageFiles.length; i++) {
        const f = nonImageFiles[i]!;
        const bytes = await mobileBridge.readNativeFileBytes(f);
        const isAudio = f.mime.startsWith('audio/');
        const prefix = isAudio ? 'voice' : 'doc';
        const localName = makeSafeUploadName(prefix, f.name, f.mime);
        await store.saveMediaFile(localName, f.mime, bytes);
        const created = await store.createItem({
          dna: isAudio ? 'voice' : 'doc',
          title: nonImageFiles.length === 1 && imageFiles.length === 0 ? data.title : f.name,
          body: i === 0 && imageFiles.length === 0 ? data.body : '',
          url: i === 0 && imageFiles.length === 0 ? data.url : null,
          orbit: data.orbit,
          focusBoardId: data.focusBoardId,
          mediaPath: localName,
          mediaType: f.mime,
          mediaMeta: { fileName: f.name, fileSize: f.size },
          source: 'vault_ui',
        });
        if (!firstCreatedId) firstCreatedId = created.id;
      }

      setActiveTab('feed');
      setSelectedFeedItemId(
        typeof window !== 'undefined' && window.innerWidth >= 600 ? firstCreatedId : null
      );
      if (syncStatus.state === 'synced' || syncStatus.state === 'offline') {
        void syncEngine.syncNow().catch(() => {});
      }
    },
    [store, syncEngine, syncStatus.state]
  );

  const ensureMediaUrl = useCallback(
    (localName?: string | null) => store.ensureMediaObjectUrl(localName),
    [store]
  );

  const mediaCacheCtx = useMemo(
    () => ({
      retainMediaUrl: (localName?: string | null) => store.retainMediaUrl(localName),
      releaseMediaUrl: (localName?: string | null) => store.releaseMediaUrl(localName),
    }),
    [store]
  );

  const activeTasksCount = useMemo(() => tasks.filter((t) => !t.done).length, [tasks]);

  const syncDotColor =
    syncStatus.state === 'synced'
      ? 'var(--k-emerald)'
      : syncStatus.state === 'syncing'
        ? 'var(--k-accent)'
        : syncStatus.state === 'offline' || syncStatus.state === 'error'
          ? 'var(--k-amber)'
          : 'var(--k-ink-muted)';

  const isCloudConnected =
    syncStatus.state === 'synced' ||
    syncStatus.state === 'syncing' ||
    syncStatus.state === 'offline';

  const isFullscreenCompactNote =
    !fold.isExpanded && activeTab === 'notes' && Boolean(activeNoteId);

  // Floating bottom dock hides cleanly during fullscreen note editing, global search, or open keyboard!
  const showBottomDock =
    !fold.isExpanded && !isFullscreenCompactNote && !searchOpen && !keyboardOpen;
  const showCaptureOrb = !(activeTab === 'vault' && vaultLocked);

  // Fold vertical hinge alignment when half-opened in Book mode
  const hingeListWidthPx =
    fold.isExpanded &&
    fold.isSeparating &&
    fold.hingeOrientation === 'vertical' &&
    fold.hingeBounds &&
    fold.hingeBounds.left > 280
      ? fold.hingeBounds.left - 78
      : null;

  const hingeRightOffsetPx =
    fold.isExpanded &&
    fold.isSeparating &&
    fold.hingeOrientation === 'vertical' &&
    fold.hingeBounds
      ? fold.hingeBounds.right
      : 0;

  const activeNavTab = MOBILE_NAV_TABS.find((tab) => tab.id === activeTab);
  const currentTabTitle = activeNavTab ? t(activeNavTab.labelKey) : t('app.name');
  const currentShare = shareQueue[0] ?? null;

  // Bottom toasts: cleanly above floating dock when visible; in fullscreen compact editor,
  // place cleanly above BOTH the bottom formatting toolbar (~49px) and docked `/`·`[[` tray (~46px)
  // so toasts cover NEITHER the top metadata chips NOR the bottom editor controls!
  const compactToastBottom = isFullscreenCompactNote
    ? keyboardOpen
      ? 58
      : 112
    : showBottomDock
      ? 78
      : 14;

  if (!ready) {
    return (
      <MobileI18nProvider locale={locale} onLocaleChange={handleChangeLocale}>
        <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-[var(--k-bg-canvas)] text-[var(--k-ink-secondary)]">
          <KapsulaEmblem size={36} />
          <span className="text-[13px]">{t('app.loading')}</span>
        </div>
      </MobileI18nProvider>
    );
  }

  const toasterElement = (
    <Toaster
      position={fold.isExpanded ? 'bottom-right' : 'bottom-center'}
      offset={fold.isExpanded ? { bottom: 62, right: 20 } : { bottom: compactToastBottom }}
      mobileOffset={{ bottom: compactToastBottom, left: 14, right: 14 }}
      visibleToasts={1}
      duration={2800}
      theme={theme}
      className="z-[10000]"
      style={{ zIndex: 10000 }}
      toastOptions={{
        style: {
          background: 'var(--k-bg-surface-1)',
          color: 'var(--k-ink-primary)',
          border: '1px solid var(--k-border-strong)',
          borderRadius: '18px',
          boxShadow: 'var(--k-shadow-popover)',
        },
      }}
    />
  );

  return (
    <MobileI18nProvider locale={locale} onLocaleChange={handleChangeLocale}>
    <MobileMediaCacheContext.Provider value={mediaCacheCtx}>
    <div
      data-testid="kapsula-mobile-root"
      data-fold-mode={fold.isExpanded ? 'expanded' : 'compact'}
      data-fold-posture={fold.posture}
      data-keyboard-open={keyboardOpen ? 'true' : 'false'}
      className="h-full w-full flex bg-[var(--k-bg-canvas)] text-[var(--k-ink-primary)] overflow-hidden"
    >
      {/* Toasts — portaled to document.body above Base UI drawers, single clean toast never overlapping header/editor controls */}
      {typeof document !== 'undefined' ? createPortal(toasterElement, document.body) : toasterElement}

      {/* ==================== EXPANDED FOLD: UPGRADED NAVIGATION RAIL ==================== */}
      {fold.isExpanded ? (
        <MobileNavRail
          activeTab={activeTab}
          activeTasksCount={activeTasksCount}
          syncStatus={syncStatus}
          syncDotColor={syncDotColor}
          onSelectTab={setActiveTab}
          onQuickCapture={() => {
            setCaptureTab('text');
            setCaptureOpen(true);
          }}
          onOpenSettings={() => openSettingsAt('cloud')}
        />
      ) : null}

      {/* ==================== MAIN SHELL COLUMN ==================== */}
      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
        {!isFullscreenCompactNote ? (
          <header className="shrink-0 bg-[var(--k-bg-canvas)] border-b border-[var(--k-border-hairline)]">
            <div className="h-[52px] px-4 flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                {!fold.isExpanded ? <KapsulaEmblem size={22} /> : null}
                <h1 className="text-[17px] font-bold tracking-[-0.015em] text-[var(--k-ink-primary)] truncate">
                  {currentTabTitle}
                </h1>
              </div>

              {fold.isExpanded ? (
                <div className="relative flex-1 max-w-md mx-2 flex items-center gap-1.5">
                  <div className="relative flex-1 min-w-0">
                    <MagnifyingGlass className="w-4 h-4 text-[var(--k-ink-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      data-testid="mobile-search-input"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t('header.searchPlaceholder')}
                      className="w-full h-9 pl-9 pr-8 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13px] text-[var(--k-ink-primary)]"
                    />
                    {searchQuery ? (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        aria-label={t('header.clearSearch')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--k-ink-muted)]"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    data-testid="expanded-global-search-btn"
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setSearchOpen(true);
                    }}
                    className="k-tap px-2.5 h-9 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] shrink-0"
                  >
                    {t('header.everywhere')}
                  </button>
                </div>
              ) : null}

              <div className="flex items-center gap-1.5 shrink-0">
                {!fold.isExpanded ? (
                  <button
                    type="button"
                    data-testid="mobile-search-toggle"
                    onClick={() => {
                      mobileBridge.haptic('light');
                      setSearchOpen(true);
                    }}
                    aria-label={t('common.search')}
                    className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
                  >
                    <MagnifyingGlass className="w-4 h-4" />
                  </button>
                ) : null}

                <button
                  type="button"
                  data-testid="header-cloud-btn"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    openSettingsAt('cloud');
                  }}
                  aria-label={t('nav.cloudAndSettings')}
                  className="k-tap inline-flex items-center gap-1.5 px-2.5 h-9 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-primary)]"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: syncDotColor }}
                  />
                  <Cloud className="w-4 h-4 text-[var(--k-ink-secondary)]" />
                  {fold.isExpanded ? (
                    <span>
                      {syncStatus.state === 'synced'
                        ? t('header.cloud')
                        : syncStatus.state === 'syncing'
                          ? t('header.syncing')
                          : syncStatus.state === 'offline'
                            ? t('header.offline')
                            : t('header.setup')}
                    </span>
                  ) : null}
                </button>
              </div>
            </div>
          </header>
        ) : null}

        {!isFullscreenCompactNote &&
        isSelfUpdateAllowed(appVersion) &&
        updateInfo?.status === 'update_available' &&
        updateInfo.latestVersion &&
        updateInfo.apkUrl &&
        dismissedUpdateVersion !== updateInfo.latestVersion ? (
          <div
            data-testid="mobile-update-banner"
            className="shrink-0 px-3.5 py-2 bg-[var(--k-accent-soft)] border-b border-[var(--k-border-focus)] flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <ArrowCircleUp weight="duotone" className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
              <span className="text-[12px] font-medium text-[var(--k-ink-primary)] truncate">
                {t('header.updateAvailable', { version: updateInfo.latestVersion })}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={updateInstalling}
                onClick={() => void handleInstallUpdate()}
                className="k-tap px-2.5 h-7 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[11.5px] font-semibold disabled:opacity-60"
              >
                {updateInstalling
                  ? updateDownloadPercent !== null
                    ? `${updateDownloadPercent}%`
                    : t('header.updateDownloading')
                  : t('header.updateNow')}
              </button>
              <button
                type="button"
                aria-label={t('header.updateDismissAria')}
                onClick={() => {
                  const ver = updateInfo.latestVersion!;
                  setDismissedUpdateVersion(ver);
                  void store.setSyncState('dismissed_update_version', ver);
                }}
                className="k-tap inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--k-ink-secondary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        <main className="flex-1 min-h-0 relative overflow-hidden">
          {activeTab === 'feed' ? (
            <FeedView
              items={items}
              orbits={orbits}
              boards={boards}
              isExpanded={fold.isExpanded}
              hingeListWidthPx={hingeListWidthPx}
              hingeRightOffsetPx={hingeRightOffsetPx}
              searchQuery={searchQuery}
              selectedOrbitId={selectedOrbitId}
              selectedBoardId={selectedBoardId}
              selectedItemId={selectedFeedItemId}
              onSelectOrbit={setSelectedOrbitId}
              onSelectBoard={setSelectedBoardId}
              onSelectItem={setSelectedFeedItemId}
              onOpenInNotes={(id) => {
                setActiveNoteId(id);
                setSelectedFeedItemId(null);
                setActiveTab('notes');
              }}
              onOpenImage={(src, caption) => setLightboxImage({ src, caption })}
              onCreateOrbit={handleCreateOrbitQuick}
              onCreateBoard={handleCreateBoardQuick}
              onUpdateItem={handleUpdateItemOptimistic}
              onToggleMarkdownTask={handleToggleMarkdownTaskOptimistic}
              onDeleteItem={(id) => handleDeleteItemWithUndo(id, t('common.movedToTrash'))}
              onBulkDeleteItems={handleBulkDeleteWithUndo}
              onTranscribeVoice={handleTranscribeVoice}
              onExtractTasks={handleExtractTasks}
              onQuickCapture={() => {
                setCaptureTab('text');
                setCaptureOpen(true);
              }}
              ensureMediaUrl={ensureMediaUrl}
            />
          ) : null}

          {activeTab === 'notes' ? (
            <Suspense fallback={null}>
              <NotesView
                items={items}
                orbits={orbits}
                boards={boards}
                isExpanded={fold.isExpanded}
                hingeListWidthPx={hingeListWidthPx}
                hingeRightOffsetPx={hingeRightOffsetPx}
                searchQuery={searchQuery}
                selectedOrbitId={selectedOrbitId}
                activeNoteId={activeNoteId}
                noteDrafts={noteDrafts}
                ensureMediaUrl={ensureMediaUrl}
                flushEditorRef={flushEditorRef}
                onSelectOrbit={setSelectedOrbitId}
                onSelectNote={setActiveNoteId}
                onOpenImage={(src, caption) => setLightboxImage({ src, caption })}
                onCreateOrbit={handleCreateOrbitQuick}
                onCreateBoard={handleCreateBoardQuick}
                onMaterializeDraft={handleMaterializeDraft}
                onDraftChange={handleDraftChange}
                onDraftSaved={handleDraftSaved}
                onSaveNote={async (id, patch) => {
                  await store.updateItem(id, patch);
                }}
                onInsertInlinePhoto={handleInsertInlinePhoto}
                onAttachPhoto={handleAttachPhotoToNote}
                listRevisions={(id) => store.listItemRevisions(id)}
                onRevertRevision={(itemId, revId) => store.revertItemToRevision(itemId, revId)}
                onTranscribeVoice={handleTranscribeVoice}
                onExtractTasks={handleExtractTasks}
                onPolishNote={handlePolishNote}
                onOpenExternalItem={(id) => {
                  setSelectedFeedItemId(id);
                  setActiveTab('feed');
                }}
                onDeleteNote={(id) => handleDeleteItemWithUndo(id, t('common.movedToTrash'))}
              />
            </Suspense>
          ) : null}

          {activeTab === 'tasks' ? (
            <Suspense fallback={null}>
              <TasksView
                tasks={tasks}
                items={items}
                orbits={orbits}
                columns={taskColumns}
                isExpanded={fold.isExpanded}
                hingeRightOffsetPx={hingeRightOffsetPx}
                searchQuery={searchQuery}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onToggleTask={handleToggleTaskOptimistic}
                onAddQuickTask={async (text, orbit, dueAt, columnId, priority) => {
                  await store.addQuickTask(text, orbit, dueAt, columnId, priority);
                }}
                onEditTaskText={async (task, nextText) => {
                  await store.updateVaultTaskText(task, nextText);
                }}
                onDeleteTask={handleDeleteTaskWithUndo}
                onMoveTaskOnBoard={async (input) => {
                  await store.moveTaskOnBoard(input);
                }}
                onUpdateTaskMeta={async (input) => {
                  await store.updateTaskMeta(input);
                }}
                onSaveColumns={async (cols) => {
                  await store.saveTaskBoardColumns(cols);
                }}
                onOpenNote={(itemId) => {
                  setActiveNoteId(itemId);
                  setActiveTab('notes');
                }}
                onCreateOrbit={handleCreateOrbitQuick}
              />
            </Suspense>
          ) : null}

          {activeTab === 'calendar' ? (
            <Suspense fallback={null}>
              <CalendarView
                events={events}
                tasks={tasks}
                isExpanded={fold.isExpanded}
                isWide={fold.isWide}
                hingeRightOffsetPx={hingeRightOffsetPx}
                searchQuery={searchQuery}
                selectedDateIso={selectedDateIso}
                onSelectDateIso={setSelectedDateIso}
                onSaveEvent={(input) => store.upsertCalendarEvent(input)}
                onDeleteEvent={handleDeleteEventWithUndo}
                onToggleTask={handleToggleTaskOptimistic}
              />
            </Suspense>
          ) : null}

          {activeTab === 'vault' ? (
            <Suspense fallback={null}>
              <VaultView
                items={items}
                orbits={orbits}
                isExpanded={fold.isExpanded}
                hingeRightOffsetPx={hingeRightOffsetPx}
                searchQuery={searchQuery}
                vaultLocked={vaultLocked}
                biometricEnabled={biometricEnabled}
                hasMasterPin={hasMasterPin}
                pinLockoutRemainingSec={pinLockoutRemainingSec}
                wipeSeconds={wipeSeconds}
                selectedSecretId={selectedSecretId}
                openCreateSignal={vaultCreateSignal}
                onSelectSecret={setSelectedSecretId}
                onUnlockVault={handleUnlockVault}
                onUnlockWithPin={handleUnlockWithPin}
                onOpenSecuritySettings={() => openSettingsAt('appearance')}
                onLockVault={() => {
                  store.lockVault();
                  setVaultLocked(true);
                }}
                onRevealSecret={(id) => store.revealSecret(id)}
                onCopySecretField={handleCopySecretField}
                onUpsertSecret={(input) => store.upsertSecret(input)}
                onDeleteSecret={(id) => handleDeleteItemWithUndo(id, t('common.secretMovedToTrash'))}
                onCreateOrbit={handleCreateOrbitQuick}
              />
            </Suspense>
          ) : null}
        </main>
      </div>

      {/* ==================== COMPACT FOLD: FLAGSHIP FLOATING GLASS DOCK + PAIRED + ORB ==================== */}
      <MobileBottomDock
        visible={showBottomDock}
        activeTab={activeTab}
        activeTasksCount={activeTasksCount}
        showCaptureOrb={showCaptureOrb}
        onSelectTab={setActiveTab}
        onQuickCapture={() => {
          if (activeTab === 'vault' && !vaultLocked) {
            setVaultCreateSignal((n) => n + 1);
            return;
          }
          setCaptureTab('text');
          setCaptureOpen(true);
        }}
        onQuickVoiceCapture={() => {
          setCaptureTab('voice');
          setCaptureOpen(true);
        }}
      />

      {/* ==================== FULL-HEIGHT GLOBAL SEARCH OVERLAY ==================== */}
      {mountSearch ? (
        <Suspense fallback={null}>
          <MobileSearchOverlay
            open={searchOpen}
            query={searchQuery}
            items={items}
            tasks={tasks}
            events={events}
            orbits={orbits}
            vaultLocked={vaultLocked}
            onChangeQuery={setSearchQuery}
            onClose={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            onOpenItem={(item) => {
              setSearchOpen(false);
              setSearchQuery('');
              if (item.dna === 'note') {
                setActiveNoteId(item.id);
                setActiveTab('notes');
              } else {
                setSelectedFeedItemId(item.id);
                setActiveTab('feed');
              }
            }}
            onOpenTask={(task) => {
              setSearchOpen(false);
              setSearchQuery('');
              setSelectedTaskId(task.id);
              setActiveTab('tasks');
            }}
            onToggleTask={(task) => void handleToggleTaskOptimistic(task).catch(() => {})}
            onOpenEvent={(ev) => {
              setSearchOpen(false);
              setSearchQuery('');
              setSelectedDateIso(toDateIso(new Date(ev.startAt)));
              setActiveTab('calendar');
            }}
            onOpenSecret={(sec) => {
              setSearchOpen(false);
              setSearchQuery('');
              setSelectedSecretId(sec.id);
              setActiveTab('vault');
            }}
            onUnlockVault={async () => {
              const res = await handleUnlockVault();
              if (!res.ok && res.needsPinFallback) {
                setSearchOpen(false);
                setActiveTab('vault');
              }
              return res.ok;
            }}
          />
        </Suspense>
      ) : null}

      {/* ==================== SHEETS, LIGHTBOX & SYSTEM OVERLAYS ==================== */}
      {mountWelcome ? (
        <Suspense fallback={null}>
          <MobileWelcomeSheet
            open={welcomeOpen}
            isExpanded={fold.isExpanded}
            hingeRightOffsetPx={hingeRightOffsetPx}
            theme={theme}
            onChangeTheme={setTheme}
            onComplete={async ({ selectedOrbits, createWelcomeNote }) => {
              for (const o of selectedOrbits) {
                await store.createOrbit({
                  name: o.name,
                  color: o.color,
                  icon: o.icon,
                  description: o.description,
                });
              }
              if (createWelcomeNote) {
                const { welcomeNote } = getMobileOnboardingPresets(locale);
                await store.createItem({
                  dna: 'note',
                  title: welcomeNote.title,
                  summary: welcomeNote.summary,
                  body: welcomeNote.body,
                  tags: welcomeNote.tags,
                });
              }
              await store.setSyncState('pref_onboarded', '1');
              setWelcomeOpen(false);
            }}
            onOpenCloud={() => {
              void store.setSyncState('pref_onboarded', '1');
              setWelcomeOpen(false);
              openSettingsAt('cloud');
            }}
            onSkip={() => {
              void store.setSyncState('pref_onboarded', '1');
              setWelcomeOpen(false);
            }}
          />
        </Suspense>
      ) : null}

      {mountCapture ? (
        <Suspense fallback={null}>
          <QuickCaptureSheet
            open={captureOpen}
            initialTab={captureTab}
            isExpanded={fold.isExpanded}
            hingeRightOffsetPx={hingeRightOffsetPx}
            orbits={orbits}
            boards={boards}
            onClose={() => setCaptureOpen(false)}
            onCreateOrbit={handleCreateOrbitQuick}
            onCreateBoard={handleCreateBoardQuick}
            onSaveText={async (data) => {
              await store.createItem({
                dna: data.url ? 'link' : 'note',
                title: data.title,
                body: data.body,
                url: data.url,
                orbit: data.orbit,
                focusBoardId: data.focusBoardId,
              });
            }}
            onSaveMedia={async (data) => {
              await store.saveMediaFile(data.fileName, data.mime, data.bytes);
              await store.createItem({
                dna: data.kind,
                title: data.title,
                body: data.body,
                orbit: data.orbit,
                focusBoardId: data.focusBoardId,
                imagePath: data.kind === 'shot' ? data.fileName : null,
                thumbPath: data.kind === 'shot' ? data.fileName : null,
                mediaPath: data.kind !== 'shot' ? data.fileName : null,
                mediaType: data.mime,
                mediaDurationSec: data.durationSec ?? null,
                mediaMeta:
                  data.kind === 'voice'
                    ? { waveformPeaks: data.peaks }
                    : data.kind === 'doc'
                      ? { fileName: data.title, fileSize: data.bytes.byteLength }
                      : null,
              });
            }}
            onOpenVaultAdd={() => {
              setActiveTab('vault');
              setVaultCreateSignal((n) => n + 1);
              if (vaultLocked) {
                void handleUnlockVault();
              }
            }}
          />
        </Suspense>
      ) : null}

      {mountShare ? (
        <Suspense fallback={null}>
          <ShareTargetSheet
            share={currentShare}
            isExpanded={fold.isExpanded}
            hingeRightOffsetPx={hingeRightOffsetPx}
            isCloudConnected={isCloudConnected}
            orbits={orbits}
            boards={boards}
            onClose={() => setShareQueue((prev) => prev.slice(1))}
            onCreateOrbit={handleCreateOrbitQuick}
            onCreateBoard={handleCreateBoardQuick}
            onConfirmSave={handleConfirmShare}
          />
        </Suspense>
      ) : null}

      {mountSettings ? (
        <Suspense fallback={null}>
          <SettingsCloudSheet
        open={settingsOpen}
        initialSection={settingsInitialSection}
        isExpanded={fold.isExpanded}
        keyboardOpen={keyboardOpen}
        hingeRightOffsetPx={hingeRightOffsetPx}
        theme={theme}
        appearance={appearance}
        biometricEnabled={biometricEnabled}
        hasMasterPin={hasMasterPin}
        vaultLocked={vaultLocked}
        autoLockMinutes={autoLockMinutes}
        wipeSeconds={wipeSeconds}
        aiConfig={aiConfig}
        syncStatus={syncStatus}
        syncEngine={syncEngine}
        appVersion={appVersion}
        updateInfo={updateInfo}
        updateChecking={updateChecking}
        updateDownloadPercent={updateDownloadPercent}
        updateInstalling={updateInstalling}
        orbits={orbits}
        boards={boards}
        trashedItems={trashedItems}
        archivedItems={archivedItems}
        onClose={() => setSettingsOpen(false)}
        onChangeTheme={setTheme}
        onChangeAppearance={handleChangeAppearance}
        onCheckUpdates={() => handleCheckUpdates(true)}
        onInstallUpdate={handleInstallUpdate}
        onCopyDiagnostics={handleCopyDiagnostics}
        onChangeBiometric={async (enabled) => {
          const guard = evaluateBiometricToggleGuard(enabled, {
            hasMasterPin,
            biometricEnabled,
            vaultLocked,
          });
          if (guard.action === 'reject') {
            mobileBridge.haptic('error');
            toast.error(guard.message);
            return;
          }
          if (guard.action === 'require_biometric') {
            const verified = await mobileBridge.authenticateBiometric(
              t('biometric.disableTitle'),
              t('biometric.vaultSubtitle')
            );
            if (!verified.ok) {
              mobileBridge.haptic('error');
              toast.error(verified.error || t('biometric.disableCancel'));
              return;
            }
          } else if (enabled && hasMasterPin) {
            const verified = await mobileBridge.authenticateBiometric(
              t('biometric.vaultTitle'),
              t('biometric.vaultSubtitle')
            );
            if (!verified.ok) {
              mobileBridge.haptic('error');
              toast.error(verified.error || t('bridge.biometricFailed'));
              return;
            }
          }
          await store.setSyncState('pref_biometric_vault', enabled ? '1' : '0');
          if (enabled && hasMasterPin) {
            await store.enableBiometricVdkWrap();
          } else if (!enabled) {
            await store.disableBiometricVdkWrap();
          }
          setBiometricEnabled(enabled);
          if (!enabled && !hasMasterPin) setVaultLocked(false);
        }}
        onSetMasterPin={async (pin, currentPin) => {
          if (store.hasMasterPin()) {
            const verify = await store.unlockVaultWithPin(currentPin ?? '');
            setPinLockoutRemainingSec(verify.lockoutRemainingSec);
            if (!verify.ok) {
              mobileBridge.haptic('error');
              throw new Error(
                verify.lockoutRemainingSec > 0
                  ? t('biometric.tooManyAttempts', { sec: verify.lockoutRemainingSec })
                  : verify.error || t('biometric.wrongCurrentPin')
              );
            }
          } else if (biometricEnabled) {
            const verified = await mobileBridge.authenticateBiometric(
              t('biometric.setupPinTitle'),
              t('biometric.vaultSubtitle')
            );
            if (!verified.ok) {
              mobileBridge.haptic('error');
              throw new Error(verified.error || t('biometric.setupPinCancel'));
            }
          }
          await store.setMasterPin(pin);
          setHasMasterPin(true);
        }}
        onRemoveMasterPin={async (currentPin) => {
          if (store.hasMasterPin()) {
            const verify = await store.unlockVaultWithPin(currentPin ?? '');
            setPinLockoutRemainingSec(verify.lockoutRemainingSec);
            if (!verify.ok) {
              mobileBridge.haptic('error');
              throw new Error(
                verify.lockoutRemainingSec > 0
                  ? t('biometric.tooManyAttempts', { sec: verify.lockoutRemainingSec })
                  : verify.error || t('biometric.wrongCurrentPin')
              );
            }
          }
          await store.removeMasterPin();
          setHasMasterPin(false);
          if (!biometricEnabled) setVaultLocked(false);
        }}
        onChangeAutoLockMinutes={async (minutes) => {
          const guard = evaluateAutoLockChangeGuard(minutes, {
            hasMasterPin,
            biometricEnabled,
            vaultLocked,
          });
          if (!guard.allowed) {
            mobileBridge.haptic('error');
            toast.error(guard.message);
            return;
          }
          setAutoLockMinutes(minutes);
          await store.setSyncState('pref_auto_lock_minutes', String(minutes));
        }}
        onChangeWipeSeconds={async (sec) => {
          setWipeSeconds(sec);
          await store.setSyncState('pref_wipe_seconds', String(sec));
        }}
        onSaveAiConfig={async (patch) => {
          const updated = await store.setMobileAiConfig(patch);
          setAiConfig(updated);
        }}
        onCreateOrbit={async (name, color) => {
          await store.createOrbit({ name, color });
        }}
        onUpdateOrbit={async (id, patch) => {
          await store.updateOrbit(id, patch);
        }}
        onDeleteOrbit={async (id) => {
          await store.deleteOrbit(id);
          if (selectedOrbitId === id) setSelectedOrbitId(null);
        }}
        onCreateBoard={async (name, color) => {
          await store.createBoard({ name, color });
        }}
        onUpdateBoard={async (id, patch) => {
          await store.updateBoard(id, patch);
        }}
        onDeleteBoard={async (id) => {
          await store.deleteBoard(id);
          if (selectedBoardId === id) setSelectedBoardId(null);
        }}
        onRestoreTrashedItem={async (id) => {
          await store.restoreItem(id);
        }}
        onPurgeTrashedItem={async (id) => {
          await store.purgeItemPermanently(id);
        }}
        onEmptyTrash={async () => (await store.emptyTrash()).purgedCount}
        onUnarchiveItem={async (id) => {
          await store.updateItem(id, { isArchived: false });
        }}
        onSensitiveOverlayChange={setSensitiveOverlayVisible}
          />
        </Suspense>
      ) : null}

      {mountLightbox ? (
        <Suspense fallback={null}>
          <MobileImageLightbox
            src={lightboxImage?.src ?? null}
            caption={lightboxImage?.caption}
            onClose={() => setLightboxImage(null)}
          />
        </Suspense>
      ) : null}
    </div>
    </MobileMediaCacheContext.Provider>
    </MobileI18nProvider>
  );
};
