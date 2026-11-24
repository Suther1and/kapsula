import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  BookOpen,
  Browser,
  CalendarBlank,
  CaretDown,
  Check,
  CheckCircle,
  CloudCheck,
  Copy,
  Cpu,
  Database,
  DownloadSimple,
  EnvelopeSimple,
  FileArchive,
  FileText,
  Fingerprint,
  FolderOpen,
  Key,
  Keyboard,
  Moon,
  Palette,
  PlugsConnected,
  ShieldCheck,
  Sparkle,
  Sun,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type {
  AiProvider,
  AppearanceConfig,
  AppLocale,
  AppUpdaterState,
  BudgetSummary,
  CalendarSyncStatus,
  CloudAiQuotaStatus,
  GlassPreset,
  NativeWindowMaterial,
  SettingsState,
  ThemeMode,
} from '@shared/types';
import { APP_VERSION } from '@shared/app-version';
import { useI18n } from '@shared/i18n/react';
import type { I18nTranslator } from '@shared/i18n/types';
import { isMacPlatform } from '@shared/shortcuts';
import { formatFileSize, friendlyErrorMessage } from '../../lib/format';
import {
  computeThemeTokens,
  contrastRatio,
  getAccentPresets,
  getDarkBgPresets,
  getLightBgPresets,
  getSavedAppearance,
  hexToHsl,
  hslToHex,
  hydrateAppearanceFromSettings,
  normalizeHex,
  resetSavedAppearance,
  setSavedAppearance,
  type UiDensity,
} from '../../lib/appearance';
import {
  HIDEABLE_NAV_SECTIONS,
  HIDEABLE_SECTION_LABEL_KEYS,
  readHiddenNavSections,
  SIDEBAR_PREFS_EVENT,
  writeHiddenNavSections,
  type HideableNavSection,
} from '../../lib/sidebar-prefs';
import { ModalDialog } from '../ui/ModalDialog';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectMenu } from '../ui/SelectMenu';
import { ShortcutRecorder } from '../ui/ShortcutRecorder';
import { SwitchToggle } from '../ui/SwitchToggle';
import { CloudSyncIcon } from '../icons/cloud-sync';
import { PaletteIcon } from '../icons/palette';
import { ShieldCheckIcon } from '../icons/shield-check';
import { LiveIcon } from '../icons/LiveIcon';

const SyncSettingsPanel = lazy(() =>
  import('./SyncSettingsPanel').then((m) => ({ default: m.SyncSettingsPanel }))
);

export type SettingsTab =
  | 'appearance'
  | 'sync'
  | 'security'
  | 'ai'
  | 'integrations'
  | 'data'
  | 'shortcuts'
  | 'general';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;
  settings: SettingsState | null;
  onSettingsUpdated: (next: SettingsState) => void;
  onVaultChanged?: () => void;
  onRecoveryKeyVisibleChange?: (visible: boolean) => void;
}

function normalizeTab(tab: SettingsTab): Exclude<SettingsTab, 'general'> {
  return tab === 'general' ? 'appearance' : tab;
}

function formatSyncTimestamp(
  ts: number | null | undefined,
  t: I18nTranslator['t'],
  dateLocale: string
): string {
  if (!ts) return '';
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 1) return t('date.justNow');
  if (diffMin < 60) return t('date.minutesAgoDot', { count: diffMin });
  return new Date(ts).toLocaleString(dateLocale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const SETTINGS_TAB_VARIANTS = {
  enter: (custom: { dir: number; skip: boolean }) =>
    custom.skip ? { opacity: 1 } : { opacity: 0, x: custom.dir * 16 },
  center: { opacity: 1, x: 0 },
  exit: (custom: { dir: number; skip: boolean }) =>
    custom.skip ? { opacity: 0 } : { opacity: 0, x: custom.dir * -12 },
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onOpenChange,
  initialTab = 'appearance',
  settings,
  onSettingsUpdated,
  onVaultChanged,
  onRecoveryKeyVisibleChange,
}) => {
  const { t, locale, dateLocale, pluralNoun, formatCurrencyUsd } = useI18n();
  const prefersReduced = useReducedMotion();
  const isMac = isMacPlatform(window.kapsula?.platform ?? 'win32');
  const TAB_ORDER: Array<Exclude<SettingsTab, 'general'>> = [
    'appearance',
    'sync',
    'security',
    'ai',
    'integrations',
    'data',
    'shortcuts',
  ];
  const [tab, setTabState] = useState<Exclude<SettingsTab, 'general'>>(() => normalizeTab(initialTab));
  const [tabDir, setTabDir] = useState<1 | -1>(1);
  const setTab = (next: Exclude<SettingsTab, 'general'>) => {
    setTabState((prev) => {
      if (prev === next) return prev;
      const fromIdx = TAB_ORDER.indexOf(prev);
      const toIdx = TAB_ORDER.indexOf(next);
      setTabDir(toIdx >= fromIdx ? 1 : -1);
      return next;
    });
  };
  const [appearance, setAppearance] = useState<AppearanceConfig>(() => getSavedAppearance());
  const [hexDraft, setHexDraft] = useState<string>(() => getSavedAppearance().accentHex);
  const [hiddenNavSections, setHiddenNavSections] = useState<HideableNavSection[]>(readHiddenNavSections);

  useEffect(() => {
    const syncPrefs = () => {
      setHiddenNavSections(readHiddenNavSections());
    };
    window.addEventListener(SIDEBAR_PREFS_EVENT, syncPrefs);
    window.addEventListener('storage', syncPrefs);
    return () => {
      window.removeEventListener(SIDEBAR_PREFS_EVENT, syncPrefs);
      window.removeEventListener('storage', syncPrefs);
    };
  }, []);

  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [cloudQuota, setCloudQuota] = useState<CloudAiQuotaStatus | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [keyProviderTarget, setKeyProviderTarget] = useState<'google_ai_studio' | 'openrouter'>(
    'google_ai_studio'
  );
  const [testingKey, setTestingKey] = useState(false);

  // Google Calendar & iCal
  const [calStatus, setCalStatus] = useState<CalendarSyncStatus | null>(null);
  const [gcalClientIdDraft, setGcalClientIdDraft] = useState('');
  const [gcalIcalDraft, setGcalIcalDraft] = useState('');
  const [calBusy, setCalBusy] = useState(false);
  const [showGcalSetup, setShowGcalSetup] = useState(false);
  const [showCustomGcalClient, setShowCustomGcalClient] = useState(false);

  // Integrations busy state
  const [copiedPairCode, setCopiedPairCode] = useState(false);
  const [clipperPairingInfo, setClipperPairingInfo] = useState<{
    pairingCode: string;
    pairedCount: number;
  } | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);

  // Cloud Updates & Diagnostics
  const [updaterState, setUpdaterState] = useState<AppUpdaterState | null>(null);
  const [diagCopying, setDiagCopying] = useState(false);

  // Security PIN & Cloud Sync one-time Recovery Key
  const [pinDraft, setPinDraft] = useState('');
  const [currentPinDraft, setCurrentPinDraft] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const [freshRecoveryKey, setFreshRecoveryKey] = useState<string | null>(null);

  // Clear one-time Recovery Key from RAM as soon as Settings closes
  useEffect(() => {
    if (!open && freshRecoveryKey) {
      setFreshRecoveryKey(null);
    }
  }, [open, freshRecoveryKey]);

  // Report Recovery Key visibility to StudioWorkspace so screen protection never clobbers Vault underneath
  useEffect(() => {
    const visible = open && Boolean(freshRecoveryKey);
    onRecoveryKeyVisibleChange?.(visible);
    return () => {
      onRecoveryKeyVisibleChange?.(false);
    };
  }, [open, freshRecoveryKey, onRecoveryKeyVisibleChange]);

  // Data tab storage summary & export/import states
  const [storageInfo, setStorageInfo] = useState<{
    itemCount: number;
    mediaFilesCount: number;
    totalBytes: number;
  } | null>(null);
  const [videoCacheInfo, setVideoCacheInfo] = useState<{
    bytesUsed: number;
    fileCount: number;
    limitMb: number;
  } | null>(null);
  const [clearingVideoCache, setClearingVideoCache] = useState(false);
  const [exportingBackup, setExportingBackup] = useState(false);
  const [exportingMdZip, setExportingMdZip] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);

  const refreshCloudQuota = () => {
    setQuotaLoading(true);
    window.kapsula
      .getCloudAiQuota()
      .then(setCloudQuota)
      .catch(() => {})
      .finally(() => setQuotaLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setTab(normalizeTab(initialTab));
    setShowGcalSetup(false);
    setShowCustomGcalClient(false);
    const hydrated = hydrateAppearanceFromSettings(settings?.appearance, settings?.theme);
    setAppearance(hydrated);
    setHexDraft(hydrated.accentHex);

    window.kapsula.getBudget().then(setBudget).catch(() => {});
    refreshCloudQuota();
    window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
    window.kapsula.getVideoCacheStats?.().then(setVideoCacheInfo).catch(() => {});
    window.kapsula.getUpdaterState().then(setUpdaterState).catch(() => {});
    window.kapsula
      .checkForUpdates({ silent: true, maxAgeMs: 10 * 60 * 1000 })
      .then(setUpdaterState)
      .catch(() => {});
    window.kapsula.getClipperPairingInfo?.().then(setClipperPairingInfo).catch(() => {});
    window.kapsula
      .getCalendarStatus()
      .then((st) => {
        setCalStatus(st);
        setGcalClientIdDraft(st.clientId || '');
        setGcalIcalDraft(st.icalUrl || '');
      })
      .catch(() => {});

    if (settings?.aiProvider === 'openrouter' || settings?.aiProvider === 'google_ai_studio') {
      setKeyProviderTarget(settings.aiProvider);
    }

    return window.kapsula.onUpdaterStateChanged((next) => {
      setUpdaterState(next);
    });
  }, [open, initialTab]);

  const accentPresets = useMemo(() => getAccentPresets(locale), [locale]);
  const theme: ThemeMode = settings?.theme ?? 'dark';
  const bgPresets = useMemo(
    () => (theme === 'dark' ? getDarkBgPresets(locale) : getLightBgPresets(locale)),
    [theme, locale]
  );

  const computedPreview = useMemo(
    () => computeThemeTokens(theme, appearance),
    [theme, appearance]
  );

  const accentHue = useMemo(() => {
    const activeHex =
      appearance.accentMode === 'custom'
        ? appearance.accentHex
        : computedPreview.accentHex;
    return Math.round(hexToHsl(activeHex).h);
  }, [appearance.accentMode, appearance.accentHex, computedPreview.accentHex]);

  const accentContrast = useMemo(
    () => contrastRatio(computedPreview.accentHex, computedPreview.inkOnAccent),
    [computedPreview.accentHex, computedPreview.inkOnAccent]
  );

  if (!settings) return null;

  const patch = async (delta: Record<string, unknown>): Promise<boolean> => {
    try {
      const next = await window.kapsula.updateSettings(delta);
      onSettingsUpdated(next);
      return true;
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.saveErr'), locale));
      return false;
    }
  };

  const applyAppearanceChange = (
    next: AppearanceConfig,
    opts?: { immediate?: boolean }
  ) => {
    const applied = setSavedAppearance(next, {
      theme,
      immediate: opts?.immediate ?? false,
    });
    setAppearance(applied);
    if (applied.accentMode === 'preset') {
      const p = accentPresets.find((x) => x.id === applied.accentPreset);
      if (p) setHexDraft(theme === 'light' ? p.swatchLight : p.swatchDark);
    }
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = apiKeyDraft.trim();
    if (!cleaned) return;
    try {
      const next = await window.kapsula.setApiKey(keyProviderTarget, cleaned);
      onSettingsUpdated(next);
      setApiKeyDraft('');
      toast.success(t('settings.ai.keySavedToast'));
      window.kapsula.getBudget().then(setBudget).catch(() => {});
      refreshCloudQuota();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, undefined, locale));
    }
  };

  const handleTestKey = async () => {
    setTestingKey(true);
    try {
      const res = await window.kapsula.testAiKey(
        keyProviderTarget,
        apiKeyDraft.trim() || undefined
      );
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.ai.keyTestErr'), locale));
    } finally {
      setTestingKey(false);
    }
  };

  const handleSetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pinDraft.trim();
    if (clean.length < 4) {
      toast.info(t('settings.security.pinMinError'));
      return;
    }
    const cleanCurrent = currentPinDraft.trim();
    if (settings?.hasMasterPin && !cleanCurrent) {
      toast.info(t('settings.security.currentPinRequired'));
      return;
    }
    setPinSaving(true);
    try {
      await window.kapsula.setMasterPin(clean, settings?.hasMasterPin ? cleanCurrent : undefined);
      const next = await window.kapsula.getSettings();
      onSettingsUpdated(next);
      setPinDraft('');
      setCurrentPinDraft('');
      toast.success(t('settings.security.pinSetToast'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.security.wrongCurrentPin'), locale));
    } finally {
      setPinSaving(false);
    }
  };

  const handleModalOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && freshRecoveryKey) {
      setTab('sync');
      toast.info(t('settings.saveRecoveryFirst'));
      return;
    }
    onOpenChange(nextOpen);
  };

  const handleThemeSwitch = async (nextTheme: ThemeMode) => {
    document.documentElement.setAttribute('data-theme', nextTheme);
    hydrateAppearanceFromSettings(appearance, nextTheme);
    const nextPreview = computeThemeTokens(nextTheme, appearance);
    setHexDraft(nextPreview.accentHex);
    await patch({ theme: nextTheme });
  };

  const handleCopyDiagnostics = async () => {
    setDiagCopying(true);
    try {
      const report = await window.kapsula.getDiagnosticsReport();
      await window.kapsula.copyText(report);
      toast.success(t('settings.diag.copiedToast'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.diag.errToast'), locale));
    } finally {
      setDiagCopying(false);
    }
  };

  const handleCheckUpdates = async () => {
    try {
      const next = await window.kapsula.checkForUpdates();
      setUpdaterState(next);
      if (next.status === 'available' && next.latestVersion) {
        toast.success(t('settings.updates.availableToast', { version: next.latestVersion }));
      } else if (next.status === 'up-to-date') {
        toast.success(t('settings.updates.upToDateToast'));
      } else if (next.status === 'error' && next.error) {
        toast.error(next.error);
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.updates.checkErr'), locale));
    }
  };

  const handleDownloadOrInstallUpdate = async () => {
    if (!updaterState) return;
    try {
      if (updaterState.status === 'downloaded') {
        await window.kapsula.installUpdate();
        return;
      }
      const next = await window.kapsula.downloadUpdate();
      setUpdaterState(next);
      if (next.mode === 'manual-download') {
        toast.success(isMac ? t('settings.updates.openingMac') : t('settings.updates.openingWin'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.updates.downloadErr'), locale));
    }
  };

  const runImport = async (
    key: string,
    fn: () => Promise<{ importedCount: number; skippedCount: number; orbitsCreated: number; errors?: string[] }>,
    emptyMsg: string
  ) => {
    setImportBusy(key);
    try {
      const res = await fn();
      if (res.importedCount === 0 && res.skippedCount === 0 && (!res.errors || res.errors.length === 0)) {
        return;
      }
      const parts = [t('settings.integrations.importedSummary', { imported: res.importedCount })];
      if (res.orbitsCreated > 0) {
        parts.push(t('settings.integrations.importedOrbits', { count: res.orbitsCreated }));
      }
      if (res.skippedCount > 0) {
        parts.push(t('settings.integrations.importedSkipped', { count: res.skippedCount }));
      }
      toast.success(res.importedCount > 0 ? parts.join(' · ') : emptyMsg);
      onVaultChanged?.();
      window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
    window.kapsula.getVideoCacheStats?.().then(setVideoCacheInfo).catch(() => {});
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('settings.integrations.importErr'), locale));
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={handleModalOpenChange}
      topAligned
      title={t('settings.title')}
      subtitle={t('settings.subtitle')}
      maxWidthClass="max-w-[860px]"
    >
      <div className="px-5 pt-3.5 pb-5 flex flex-col gap-4">
        <SegmentedControl<Exclude<SettingsTab, 'general'>>
          value={tab}
          onChange={setTab}
          size="sm"
          fullWidth
          options={[
            { value: 'appearance', label: t('settings.tab.appearance'), icon: <LiveIcon icon={PaletteIcon} size={14} active={tab === 'appearance'} /> },
            { value: 'sync', label: t('settings.tab.sync'), icon: <LiveIcon icon={CloudSyncIcon} size={14} active={tab === 'sync'} /> },
            { value: 'security', label: t('settings.tab.security'), icon: <LiveIcon icon={ShieldCheckIcon} size={14} active={tab === 'security'} /> },
            { value: 'ai', label: t('settings.tab.ai'), icon: <Cpu className="w-3.5 h-3.5" /> },
            { value: 'integrations', label: t('settings.tab.integrations'), icon: <PlugsConnected className="w-3.5 h-3.5" /> },
            { value: 'data', label: t('settings.tab.data'), icon: <Database className="w-3.5 h-3.5" /> },
            { value: 'shortcuts', label: t('settings.tab.shortcuts'), icon: <Keyboard className="w-3.5 h-3.5" /> },
          ]}
        />

        {/* Fixed-height tab body with crisp directional slide & zero modal height jump */}
        <div className="relative h-[460px] overflow-hidden">
          <AnimatePresence
            mode="popLayout"
            initial={false}
            custom={{ dir: tabDir, skip: Boolean(prefersReduced) }}
          >
            <motion.div
              key={tab}
              custom={{ dir: tabDir, skip: Boolean(prefersReduced) }}
              variants={SETTINGS_TAB_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={
                prefersReduced
                  ? { duration: 0 }
                  : { duration: 0.17, ease: [0.23, 1, 0.32, 1] }
              }
              className="absolute inset-0 overflow-y-auto k-scroll-stable pr-1 flex flex-col gap-3"
            >
          {/* 1. APPEARANCE */}
          {tab === 'appearance' ? (
            <>
              <div
                data-testid="settings-language-card"
                className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3"
              >
                <div>
                  <div className="text-[13.5px] font-medium">{t('lang.label')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('lang.hint')}
                  </div>
                </div>
                <div data-testid="settings-language-switcher">
                  <SegmentedControl<AppLocale>
                    value={locale}
                    onChange={(nextLocale) => {
                      if (nextLocale === locale) return;
                      onSettingsUpdated({ ...settings, locale: nextLocale });
                      void patch({ locale: nextLocale });
                    }}
                    options={[
                      { value: 'ru', label: t('lang.name.ru') },
                      { value: 'en', label: t('lang.name.en') },
                    ]}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.appearance.themeTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.appearance.themeDesc')}
                  </div>
                </div>
                <SegmentedControl<ThemeMode>
                  value={theme}
                  onChange={(nextTheme) => void handleThemeSwitch(nextTheme)}
                  options={[
                    { value: 'dark', label: t('onboarding.step2.dark'), icon: <Moon className="w-3.5 h-3.5" /> },
                    { value: 'light', label: t('onboarding.step2.light'), icon: <Sun className="w-3.5 h-3.5" /> },
                  ]}
                />
              </div>

              {/* Accent Color Card: Presets + Rainbow Hue Slider + #HEX + Live Contrast Preview */}
              <div
                data-testid="appearance-accent-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.appearance.accentTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.appearance.accentDesc')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0" data-testid="accent-preset-picker">
                    {accentPresets.map((preset) => {
                      const active =
                        appearance.accentMode === 'preset' && appearance.accentPreset === preset.id;
                      const swatch = theme === 'light' ? preset.swatchLight : preset.swatchDark;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          title={preset.label}
                          aria-label={preset.label}
                          data-testid={`accent-preset-${preset.id}`}
                          onClick={() => {
                            setHexDraft(swatch);
                            applyAppearanceChange(
                              {
                                ...appearance,
                                accentMode: 'preset',
                                accentPreset: preset.id,
                                accentHex: preset.swatchDark,
                              },
                              { immediate: true }
                            );
                          }}
                          className={`k-interactive w-[22px] h-[22px] rounded-full cursor-pointer transition-transform ${
                            active
                              ? 'ring-[1.5px] ring-[var(--k-ink-primary)] ring-offset-[1.5px] ring-offset-[var(--k-bg-surface-2)]'
                              : 'opacity-85 hover:opacity-100 hover:scale-105'
                          }`}
                          style={{ backgroundColor: swatch }}
                        />
                      );
                    })}
                  </div>
                </div>

                {/* Rainbow Hue Slider + Editable #HEX + Live Preview Chip */}
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-center gap-3 pt-1 border-t border-[var(--k-border-hairline)]">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                      <span>{t('settings.appearance.customAccent')}</span>
                      <span className="k-mono k-tabular text-[var(--k-ink-muted)]">{accentHue}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      data-testid="accent-hue-slider"
                      aria-label={t('settings.appearance.accentHueAria')}
                      value={accentHue}
                      onChange={(e) => {
                        const hue = Number(e.target.value);
                        const nextHex = hslToHex(hue, 78, theme === 'dark' ? 58 : 44);
                        setHexDraft(nextHex);
                        applyAppearanceChange({
                          ...appearance,
                          accentMode: 'custom',
                          accentHex: nextHex,
                        });
                      }}
                      className="k-color-slider k-color-slider--hue"
                    />
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] focus-within:border-[var(--k-border-focus)]">
                      <span
                        className="w-3.5 h-3.5 rounded-full shrink-0 border border-black/15"
                        style={{ backgroundColor: computedPreview.accentHex }}
                      />
                      <input
                        type="text"
                        data-testid="accent-hex-input"
                        value={hexDraft}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setHexDraft(raw);
                          const norm = normalizeHex(raw);
                          if (norm) {
                            applyAppearanceChange({
                              ...appearance,
                              accentMode: 'custom',
                              accentHex: norm,
                            });
                          }
                        }}
                        onBlur={() => {
                          const norm = normalizeHex(hexDraft);
                          if (!norm) setHexDraft(computedPreview.accentHex);
                          else setHexDraft(norm);
                        }}
                        aria-label={t('settings.appearance.hexAria')}
                        className="w-[74px] bg-transparent border-none outline-none k-mono text-[12px] text-[var(--k-ink-primary)]"
                      />
                    </div>

                    <div
                      data-testid="accent-live-preview"
                      style={{
                        backgroundColor: computedPreview.accentHex,
                        color: computedPreview.inkOnAccent,
                      }}
                      className="h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium shadow-xs select-none"
                      title={t('settings.appearance.contrastTitle', { ratio: accentContrast.toFixed(1) })}
                    >
                      <span>{t('settings.appearance.previewButton')}</span>
                      <span className="k-mono text-[10px] opacity-80">
                        {accentContrast.toFixed(1)}:1
                      </span>
                    </div>
                  </div>
                </div>

                {/* Independent Section & Board Accent Toggle */}
                <div className="flex items-center justify-between gap-4 pt-3 border-t border-[var(--k-border-hairline)]">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">
                      {t('settings.appearance.sectionAccentTitle')}
                    </div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.appearance.sectionAccentDesc')}
                    </div>
                  </div>
                  <SwitchToggle
                    checked={appearance.sectionAccentEnabled !== false}
                    data-testid="section-accent-toggle"
                    aria-label={t('settings.appearance.sectionAccentTitle')}
                    onCheckedChange={(checked) =>
                      applyAppearanceChange(
                        {
                          ...appearance,
                          sectionAccentEnabled: checked,
                        },
                        { immediate: true }
                      )
                    }
                  />
                </div>
              </div>

              {/* Background Color Presets + Custom Background Sliders */}
              <div
                data-testid="appearance-bg-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.appearance.bgTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.appearance.bgDesc')}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="appearance-reset-btn"
                    onClick={() => {
                      const reset = resetSavedAppearance(theme);
                      setAppearance(reset);
                      const p = accentPresets[0]!;
                      setHexDraft(theme === 'light' ? p.swatchLight : p.swatchDark);
                      toast.success(t('settings.appearance.resetToast'));
                    }}
                    className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer shrink-0"
                  >
                    <ArrowCounterClockwise className="w-3.5 h-3.5" />
                    <span>{t('settings.appearance.resetDefault')}</span>
                  </button>
                </div>

                {/* Preset Swatch Grid — expressive 2-tone mini-theme preview tiles */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="bg-preset-picker">
                  {bgPresets.map((preset) => {
                    const active = appearance.bgPreset === preset.id;
                    const displayLabel =
                      preset.id === 'paper' ? t('onboarding.step2.paperWarm') : preset.label;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        data-testid={`bg-preset-${preset.id}`}
                        onClick={() =>
                          applyAppearanceChange(
                            {
                              ...appearance,
                              bgPreset: preset.id,
                              bgHue: preset.bgHue,
                              bgTint: preset.bgTint,
                              bgLightness: preset.bgLightness,
                            },
                            { immediate: true }
                          )
                        }
                        className={`k-interactive flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl border text-left cursor-pointer ${
                          active
                            ? 'border-[var(--k-accent)] bg-[var(--k-accent-soft)] text-[var(--k-ink-primary)]'
                            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:border-[var(--k-border-strong)] hover:text-[var(--k-ink-primary)]'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span
                            aria-hidden="true"
                            className="relative w-[34px] h-[22px] rounded-[7px] shrink-0 overflow-hidden flex border"
                            style={{
                              backgroundColor: preset.previewCanvas,
                              borderColor:
                                theme === 'dark'
                                  ? 'rgba(255, 255, 255, 0.22)'
                                  : 'rgba(15, 23, 42, 0.20)',
                            }}
                          >
                            <span
                              className="w-[46%] h-full shrink-0"
                              style={{ backgroundColor: preset.previewCanvas }}
                            />
                            <span
                              className="flex-1 h-full border-l"
                              style={{
                                backgroundColor: preset.previewSurface,
                                borderColor:
                                  theme === 'dark'
                                    ? 'rgba(255, 255, 255, 0.14)'
                                    : 'rgba(15, 23, 42, 0.14)',
                              }}
                            />
                          </span>
                          <span className="text-[12px] font-medium truncate">{displayLabel}</span>
                        </span>
                        {active ? (
                          <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>

                {/* Custom Background Sliders */}
                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]/70 p-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-medium text-[var(--k-ink-primary)]">
                      {t('settings.appearance.customBgTitle')}
                    </span>
                    <span className="k-mono text-[11px] text-[var(--k-ink-muted)]">
                      {appearance.bgPreset === 'custom'
                        ? computedPreview.canvasHex
                        : t('settings.appearance.presetBadge')}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                        <span>{t('settings.appearance.hue')}</span>
                        <span className="k-mono k-tabular text-[var(--k-ink-muted)]">
                          {Math.round(appearance.bgHue)}°
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={360}
                        step={1}
                        data-testid="bg-hue-slider"
                        value={Math.round(appearance.bgHue)}
                        onChange={(e) =>
                          applyAppearanceChange({
                            ...appearance,
                            bgPreset: 'custom',
                            bgHue: Number(e.target.value),
                          })
                        }
                        className="k-color-slider k-color-slider--hue"
                      />
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                        <span>{t('settings.appearance.saturation')}</span>
                        <span className="k-mono k-tabular text-[var(--k-ink-muted)]">
                          {Math.round(appearance.bgTint)}%
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        data-testid="bg-tint-slider"
                        value={Math.round(appearance.bgTint)}
                        onChange={(e) =>
                          applyAppearanceChange({
                            ...appearance,
                            bgPreset: 'custom',
                            bgTint: Number(e.target.value),
                          })
                        }
                        style={{
                          background: `linear-gradient(90deg, ${hslToHex(appearance.bgHue, 0, theme === 'dark' ? 14 : 94)}, ${hslToHex(appearance.bgHue, theme === 'dark' ? 44 : 34, theme === 'dark' ? 22 : 86)})`,
                        }}
                        className="k-color-slider"
                      />
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                        <span>{t('settings.appearance.lightness')}</span>
                        <span className="k-mono k-tabular text-[var(--k-ink-muted)]">
                          {Math.round(appearance.bgLightness)}%
                        </span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        data-testid="bg-lightness-slider"
                        value={Math.round(appearance.bgLightness)}
                        onChange={(e) =>
                          applyAppearanceChange({
                            ...appearance,
                            bgPreset: 'custom',
                            bgLightness: Number(e.target.value),
                          })
                        }
                        style={{
                          background:
                            theme === 'dark'
                              ? 'linear-gradient(90deg, #000000, #272b33)'
                              : 'linear-gradient(90deg, #dcdce6, #ffffff)',
                        }}
                        className="k-color-slider"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.appearance.densityTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.appearance.densityDesc')}
                  </div>
                </div>
                <SegmentedControl<UiDensity>
                  value={appearance.density}
                  onChange={(density) =>
                    applyAppearanceChange({ ...appearance, density }, { immediate: true })
                  }
                  options={[
                    { value: 'comfortable', label: t('settings.appearance.comfortable') },
                    { value: 'compact', label: t('settings.appearance.compact') },
                  ]}
                />
              </div>

              <div
                data-testid="appearance-glass-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.appearance.glassTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.appearance.glassDesc')}
                    </div>
                  </div>
                  <SegmentedControl<GlassPreset>
                    value={appearance.glassPreset ?? 'off'}
                    onChange={(glassPreset) => {
                      const prevPreset = appearance.glassPreset ?? 'off';
                      const curNative = appearance.glassNativeMaterial ?? 'none';
                      // When turning glass ON from OFF while native material is still 'none',
                      // automatically engage OS translucency so the window immediately becomes truly translucent.
                      const nextNative: NativeWindowMaterial =
                        glassPreset === 'off'
                          ? curNative
                          : prevPreset === 'off' && curNative === 'none'
                            ? glassPreset === 'subtle'
                              ? 'mica'
                              : 'acrylic'
                            : curNative;
                      applyAppearanceChange(
                        { ...appearance, glassPreset, glassNativeMaterial: nextNative },
                        { immediate: true }
                      );
                    }}
                    options={[
                      { value: 'off', label: t('settings.appearance.glassOff') },
                      { value: 'subtle', label: t('settings.appearance.glassSubtle') },
                      { value: 'frosted', label: t('settings.appearance.glassFrosted') },
                      { value: 'liquid', label: t('settings.appearance.glassLiquid') },
                    ]}
                  />
                </div>

                {(appearance.glassPreset ?? 'off') !== 'off' ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-[var(--k-border-hairline)]">
                    <div>
                      <div className="text-[12.5px] font-medium">{t('settings.appearance.glassNativeTitle')}</div>
                      <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                        {isMac
                          ? t('settings.appearance.glassNativeDescMac')
                          : t('settings.appearance.glassNativeDesc')}
                      </div>
                    </div>
                    <SegmentedControl<NativeWindowMaterial>
                      value={appearance.glassNativeMaterial ?? 'none'}
                      onChange={(glassNativeMaterial) =>
                        applyAppearanceChange(
                          { ...appearance, glassNativeMaterial },
                          { immediate: true }
                        )
                      }
                      options={[
                        { value: 'none', label: t('settings.appearance.glassNativeNone') },
                        {
                          value: 'mica',
                          label: isMac
                            ? t('settings.appearance.glassNativeMacSoft')
                            : t('settings.appearance.glassNativeMica'),
                        },
                        {
                          value: 'acrylic',
                          label: isMac
                            ? t('settings.appearance.glassNativeMacDeep')
                            : t('settings.appearance.glassNativeAcrylic'),
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </div>

              <div
                data-testid="appearance-sidebar-sections-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3 flex flex-col gap-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('nav.customizeSidebar')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('nav.customizeSidebarDesc')}
                    </div>
                  </div>
                  {hiddenNavSections.length > 0 ? (
                    <button
                      type="button"
                      data-testid="settings-sidebar-show-all"
                      onClick={() => setHiddenNavSections(writeHiddenNavSections([]))}
                      className="text-[12px] font-medium text-[var(--k-accent)] hover:underline cursor-pointer shrink-0"
                    >
                      {t('nav.showAllSidebar')}
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {HIDEABLE_NAV_SECTIONS.map((sec) => {
                    const visible = !hiddenNavSections.includes(sec);
                    return (
                      <button
                        key={sec}
                        type="button"
                        data-testid={`settings-sidebar-toggle-${sec}`}
                        onClick={() => {
                          const next = hiddenNavSections.includes(sec)
                            ? hiddenNavSections.filter((s) => s !== sec)
                            : [...hiddenNavSections, sec];
                          setHiddenNavSections(writeHiddenNavSections(next));
                        }}
                        className={`k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] font-medium cursor-pointer ${
                          visible
                            ? 'border-[var(--k-accent)]/35 bg-[var(--k-accent-soft)] text-[var(--k-ink-primary)]'
                            : 'border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-secondary)]'
                        }`}
                      >
                        <Check
                          weight="bold"
                          className={`w-3.5 h-3.5 ${visible ? 'text-[var(--k-accent)] opacity-100' : 'opacity-25'}`}
                        />
                        <span>{t(HIDEABLE_SECTION_LABEL_KEYS[sec])}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}

          {/* 2. SYNC */}
          {tab === 'sync' ? (
            <Suspense fallback={null}>
              <SyncSettingsPanel
                onVaultChanged={onVaultChanged}
                onAuthChanged={refreshCloudQuota}
                freshRecoveryKey={freshRecoveryKey}
                onFreshRecoveryKeyChange={setFreshRecoveryKey}
              />
            </Suspense>
          ) : null}

          {/* 3. SECURITY */}
          {tab === 'security' ? (
            <>
              <form
                onSubmit={handleSetPin}
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.security.pinTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {settings.hasMasterPin
                        ? t('settings.security.pinEnabledDesc')
                        : t('settings.security.pinDisabledDesc')}
                    </div>
                  </div>
                  {settings.hasMasterPin ? (
                    <button
                      type="button"
                      disabled={pinSaving || !currentPinDraft.trim()}
                      onClick={async () => {
                        const cleanCurrent = currentPinDraft.trim();
                        if (!cleanCurrent) {
                          toast.info(t('settings.security.currentPinRequired'));
                          return;
                        }
                        setPinSaving(true);
                        try {
                          await window.kapsula.setMasterPin(null, cleanCurrent);
                          const next = await window.kapsula.getSettings();
                          onSettingsUpdated(next);
                          setCurrentPinDraft('');
                          setPinDraft('');
                          toast.success(t('settings.security.pinDisabledToast'));
                        } catch (err) {
                          toast.error(
                            friendlyErrorMessage(err, t('settings.security.wrongCurrentPin'), locale)
                          );
                        } finally {
                          setPinSaving(false);
                        }
                      }}
                      className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-danger)] cursor-pointer disabled:opacity-50 disabled:cursor-default"
                    >
                      {t('settings.security.pinRemoveBtn')}
                    </button>
                  ) : null}
                </div>

                {settings.hasMasterPin ? (
                  <input
                    type="password"
                    value={currentPinDraft}
                    onChange={(e) => setCurrentPinDraft(e.target.value)}
                    placeholder={t('settings.security.currentPinPlaceholder')}
                    className="h-9 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                ) : null}

                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={pinDraft}
                    onChange={(e) => setPinDraft(e.target.value)}
                    placeholder={
                      settings.hasMasterPin
                        ? t('settings.security.pinNewPlaceholder')
                        : t('settings.security.pinSetPlaceholder')
                    }
                    className="flex-1 h-9 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <button
                    type="submit"
                    disabled={pinSaving || pinDraft.trim().length < 4 || (Boolean(settings.hasMasterPin) && !currentPinDraft.trim())}
                    className="k-interactive h-9 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </form>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.security.autoLockTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.security.autoLockDesc')}
                  </div>
                </div>
                <SelectMenu
                  value={String(settings.vaultAutoLockMinutes ?? 5)}
                  onChange={(v) => void patch({ vaultAutoLockMinutes: Number(v) })}
                  options={[
                    { value: '1', label: t('settings.security.autoLock1') },
                    { value: '5', label: t('settings.security.autoLock5') },
                    { value: '15', label: t('settings.security.autoLock15') },
                    { value: '30', label: t('settings.security.autoLock30') },
                    { value: '0', label: t('settings.security.autoLock0') },
                  ]}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.security.lockMinimizeTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.security.lockMinimizeDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.lockVaultOnMinimize ?? true}
                  onCheckedChange={(lockVaultOnMinimize) => void patch({ lockVaultOnMinimize })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.security.lockHudTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.security.lockHudDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.lockVaultOnHudClose ?? false}
                  onCheckedChange={(lockVaultOnHudClose) => void patch({ lockVaultOnHudClose })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">
                    {t('settings.security.screenShieldTitle')}
                  </div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.security.screenShieldDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.enableScreenProtection ?? true}
                  onCheckedChange={async (enabled) => {
                    try {
                      await patch({ enableScreenProtection: enabled });
                    } catch (err) {
                      toast.error(friendlyErrorMessage(err, undefined, locale));
                    }
                  }}
                />
              </div>

              {settings.biometricUnlockAvailable ? (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <Fingerprint className="w-4.5 h-4.5 text-[var(--k-accent)] mt-0.5 shrink-0" />
                    <div>
                      <div className="text-[13.5px] font-medium">
                        {isMac ? t('settings.security.touchIdTitle') : t('settings.security.biometricTitle')}
                      </div>
                      <div className="text-[12px] text-[var(--k-ink-secondary)]">
                        {settings.hasMasterPin
                          ? t('settings.security.biometricEnabledDesc')
                          : t('settings.security.biometricDisabledDesc')}
                      </div>
                    </div>
                  </div>
                  <SwitchToggle
                    disabled={!settings.hasMasterPin}
                    checked={Boolean(settings.hasMasterPin && settings.biometricUnlockEnabled)}
                    onCheckedChange={async (biometricUnlockEnabled) => {
                      if (!settings.hasMasterPin) return;
                      try {
                        const next = await window.kapsula.updateSettings({ biometricUnlockEnabled });
                        onSettingsUpdated(next);
                      } catch (err) {
                        toast.error(friendlyErrorMessage(err, undefined, locale));
                      }
                    }}
                  />
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.security.clipWipeTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.security.clipWipeDesc')}
                  </div>
                </div>
                <SelectMenu
                  value={String(settings.clipboardAutoWipeSeconds)}
                  onChange={(v) => void patch({ clipboardAutoWipeSeconds: Number(v) })}
                  options={[
                    { value: '15', label: t('settings.security.wipe15') },
                    { value: '30', label: t('settings.security.wipe30') },
                    { value: '60', label: t('settings.security.wipe60') },
                    { value: '0', label: t('settings.security.wipe0') },
                  ]}
                />
              </div>
            </>
          ) : null}

          {/* 4. AI */}
          {tab === 'ai' ? (
            <>
              {/* Shared Built-In Kapsula AI Card */}
              <div
                data-testid="cloud-ai-quota-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-[var(--k-accent)]/12 text-[var(--k-accent)] flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkle weight="duotone" className="w-4.5 h-4.5" />
                    </div>
                    <div>
                      <div className="text-[13.5px] font-semibold">
                        {settings.hasGoogleAiKey || settings.hasOpenRouterKey || cloudQuota?.usingPersonalKey
                          ? t('settings.ai.customActiveTitle')
                          : t('settings.ai.builtInTitle')}
                      </div>
                      {settings.hasGoogleAiKey || settings.hasOpenRouterKey || cloudQuota?.usingPersonalKey ? (
                        <div className="text-[12px] text-[var(--k-emerald)] mt-0.5 font-medium">
                          {t('settings.ai.personalKeyNote')}
                        </div>
                      ) : cloudQuota?.signedIn ? (
                        <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                          {t('settings.ai.builtInSignedInDesc')}
                        </div>
                      ) : (
                        <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                          {t('settings.ai.builtInSignedOutDesc')}
                        </div>
                      )}
                    </div>
                  </div>
                  {!settings.hasGoogleAiKey && !settings.hasOpenRouterKey ? (
                    cloudQuota?.signedIn ? (
                      <button
                        type="button"
                        disabled={quotaLoading}
                        onClick={refreshCloudQuota}
                        title={t('settings.ai.refreshQuotaTitle')}
                        className="k-interactive w-8 h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center justify-center cursor-pointer shrink-0 disabled:opacity-50"
                      >
                        <ArrowsClockwise className={`w-3.5 h-3.5 ${quotaLoading ? 'animate-spin' : ''}`} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setTab('sync')}
                        className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0"
                      >
                        {t('settings.ai.signInBtn')}
                      </button>
                    )
                  ) : null}
                </div>

                {!settings.hasGoogleAiKey && !settings.hasOpenRouterKey && cloudQuota?.signedIn ? (
                  <div className="flex flex-col gap-1.5 pt-0.5">
                    <div className="h-2 rounded-full bg-[var(--k-bg-surface-3)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-[width,background-color] duration-300"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(
                              cloudQuota.spentUsd > 0 ? 3 : 0,
                              Math.round((cloudQuota.spentUsd / Math.max(0.01, cloudQuota.limitUsd)) * 100)
                            )
                          )}%`,
                          backgroundColor:
                            cloudQuota.blocked ||
                            cloudQuota.globalExhausted ||
                            cloudQuota.remainingUsd <= 0
                              ? 'var(--k-danger)'
                              : cloudQuota.remainingUsd <= cloudQuota.limitUsd * 0.15
                                ? 'var(--k-amber)'
                                : 'var(--k-accent)',
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--k-ink-secondary)] k-tabular">
                      <span>
                        {t('settings.ai.quotaSpent', {
                          spent: formatCurrencyUsd(cloudQuota.spentUsd),
                          limit: formatCurrencyUsd(cloudQuota.limitUsd),
                          remaining: formatCurrencyUsd(cloudQuota.remainingUsd),
                        })}
                      </span>
                      {cloudQuota.requestCount > 0 ? (
                        <span className="text-[11px] text-[var(--k-ink-muted)]">
                          {t('settings.ai.quotaRequests', { count: cloudQuota.requestCount })}
                        </span>
                      ) : null}
                    </div>
                    {cloudQuota.blocked || cloudQuota.globalExhausted || cloudQuota.remainingUsd <= 0 ? (
                      <div className="text-[11.5px] text-[var(--k-amber)]">
                        {cloudQuota.globalExhausted
                          ? t('settings.ai.quotaGlobalExhausted')
                          : t('settings.ai.quotaUserExhausted')}
                      </div>
                    ) : cloudQuota.error ? (
                      <div className="text-[11.5px] text-[var(--k-ink-muted)]">{cloudQuota.error}</div>
                    ) : null}
                  </div>
                ) : null}

                {cloudQuota?.signedIn &&
                settings.aiProvider === 'local' &&
                !settings.hasGoogleAiKey &&
                !settings.hasOpenRouterKey ? (
                  <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]/75 px-3 py-2.5">
                    <div className="text-[11.5px] leading-relaxed text-[var(--k-ink-secondary)] flex-1 min-w-[200px]">
                      {t('settings.ai.localSignedInBanner')}
                    </div>
                    <button
                      type="button"
                      data-testid="enable-builtin-ai-btn"
                      onClick={async () => {
                        const ok = await patch({ aiProvider: 'google_ai_studio' });
                        if (ok) toast.success(t('settings.ai.builtInEnabledToast'));
                      }}
                      className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0"
                    >
                      {t('settings.ai.enableBuiltInBtn')}
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.ai.modeTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.ai.modeDesc')}
                    </div>
                  </div>
                  <SelectMenu
                    value={settings.aiProvider}
                    onChange={(val) => void patch({ aiProvider: val as AiProvider })}
                    options={[
                      { value: 'local', label: t('settings.ai.modeLocal') },
                      { value: 'google_ai_studio', label: 'Google Gemini' },
                      { value: 'openrouter', label: 'OpenRouter' },
                    ]}
                  />
                </div>

                <div className="text-[11.5px] text-[var(--k-ink-muted)] leading-relaxed">
                  {settings.aiProvider === 'local'
                    ? t('settings.ai.localPrivacyHint')
                    : t('settings.ai.cloudPrivacyHint')}
                </div>

                <div className="flex flex-wrap items-center gap-4 text-[12px] text-[var(--k-ink-secondary)] pt-1">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle
                      weight="fill"
                      className={`w-3.5 h-3.5 ${settings.hasGoogleAiKey ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'}`}
                    />
                    {t('settings.ai.geminiStatus', {
                      status: settings.hasGoogleAiKey ? t('settings.ai.keyConnected') : t('settings.ai.keyUnset'),
                    })}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle
                      weight="fill"
                      className={`w-3.5 h-3.5 ${settings.hasOpenRouterKey ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'}`}
                    />
                    {t('settings.ai.openRouterStatus', {
                      status: settings.hasOpenRouterKey ? t('settings.ai.keyConnected') : t('settings.ai.keyUnset'),
                    })}
                  </span>
                </div>
              </div>

              <form
                onSubmit={handleSaveApiKey}
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
                    <Key className="w-4 h-4 text-[var(--k-accent)]" />
                    {t('settings.ai.customKeyTitle')}
                  </span>
                  <SegmentedControl<'google_ai_studio' | 'openrouter'>
                    value={keyProviderTarget}
                    onChange={setKeyProviderTarget}
                    options={[
                      { value: 'google_ai_studio', label: 'Google Gemini' },
                      { value: 'openrouter', label: 'OpenRouter' },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    placeholder={t('settings.ai.customKeyPlaceholder')}
                    className="flex-1 h-9 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <button
                    type="button"
                    disabled={testingKey}
                    onClick={() => void handleTestKey()}
                    className="k-interactive h-9 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] text-[12px] font-medium hover:border-[var(--k-ink-secondary)] cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:border-[var(--k-border-hairline)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
                  >
                    {testingKey ? t('settings.ai.testing') : t('settings.ai.testBtn')}
                  </button>
                  <button
                    type="submit"
                    disabled={!apiKeyDraft.trim()}
                    className="k-interactive h-9 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
                  >
                    {t('common.save')}
                  </button>
                  {(keyProviderTarget === 'google_ai_studio' && settings.hasGoogleAiKey) ||
                  (keyProviderTarget === 'openrouter' && settings.hasOpenRouterKey) ? (
                    <button
                      type="button"
                      title={t('settings.ai.deleteKeyTitle')}
                      onClick={async () => {
                        try {
                          const next = await window.kapsula.setApiKey(keyProviderTarget, '');
                          onSettingsUpdated(next);
                          toast.success(t('settings.ai.keyDeletedToast'));
                          refreshCloudQuota();
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, undefined, locale));
                        }
                      }}
                      className="k-interactive w-9 h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-danger)] inline-flex items-center justify-center cursor-pointer"
                    >
                      <Trash className="w-4 h-4" />
                    </button>
                  ) : null}
                </div>
              </form>

              {settings.hasGoogleAiKey || settings.hasOpenRouterKey ? (
                <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium">{t('settings.ai.capTitle')}</div>
                      <div className="text-[12px] text-[var(--k-ink-secondary)]">
                        {t('settings.ai.capDesc')}
                      </div>
                    </div>
                    <SelectMenu
                      size="sm"
                      value={String(settings.monthlyCapUsd)}
                      onChange={(v) => void patch({ monthlyCapUsd: Number(v) })}
                      options={[
                        { value: '0.5', label: t('settings.ai.capPerMonth', { amount: '0.50' }) },
                        { value: '1.5', label: t('settings.ai.capPerMonth', { amount: '1.50' }) },
                        { value: '3', label: t('settings.ai.capPerMonth', { amount: '3.00' }) },
                        { value: '5', label: t('settings.ai.capPerMonth', { amount: '5.00' }) },
                        { value: '10', label: t('settings.ai.capPerMonth', { amount: '10.00' }) },
                      ]}
                    />
                  </div>
                  {budget ? (
                    <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular">
                      {t('settings.ai.capSpentLine', {
                        spent: budget.spentUsd.toFixed(4),
                        cap: budget.capUsd.toFixed(2),
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {/* 5. INTEGRATIONS */}
          {tab === 'integrations' ? (
            <>
              {/* 1. Google Calendar + 1-click .ics import/export */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CalendarBlank weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">{t('settings.integrations.calTitle')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {calStatus?.lastSyncAt ? (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[11px] text-[var(--k-ink-muted)] k-tabular">
                        {t('settings.integrations.updatedAt', {
                          when: formatSyncTimestamp(calStatus.lastSyncAt, t, dateLocale),
                        })}
                      </span>
                    ) : null}
                    <span
                      className={`text-[11.5px] font-medium ${
                        calStatus?.connected ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'
                      }`}
                    >
                      {calStatus?.connected
                        ? calStatus.email || t('settings.integrations.connected')
                        : t('settings.integrations.notConnected')}
                    </span>
                  </div>
                </div>

                {!calStatus?.connected && !showGcalSetup ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {t('settings.integrations.calDesc')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      {calStatus?.builtInOAuthAvailable ? (
                        <>
                          <button
                            type="button"
                            disabled={calBusy}
                            data-testid="gcal-oneclick-btn"
                            onClick={async () => {
                              setCalBusy(true);
                              try {
                                const st = await window.kapsula.connectGoogleCalendar();
                                setCalStatus(st);
                                toast.success(t('settings.integrations.calConnectedToast'));
                                onVaultChanged?.();
                              } catch (err) {
                                toast.error(friendlyErrorMessage(err, undefined, locale));
                              } finally {
                                setCalBusy(false);
                              }
                            }}
                            className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                          >
                            {calBusy ? t('settings.integrations.calOpeningBrowser') : t('settings.integrations.calConnectBtn')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowGcalSetup(true)}
                            className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                          >
                            {t('settings.integrations.icsLinkBtn')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowGcalSetup(true)}
                          className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                        >
                          {t('settings.integrations.calConnectGoogleShort')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const r = await window.kapsula.importCalendarIcs();
                            if (r.imported > 0) {
                              toast.success(t('settings.integrations.eventsImported', { count: r.imported }));
                              onVaultChanged?.();
                            }
                          } catch (err) {
                            toast.error(friendlyErrorMessage(err, undefined, locale));
                          }
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] hover:border-[var(--k-border-strong)] cursor-pointer"
                      >
                        <UploadSimple className="w-3.5 h-3.5" />
                        <span>{t('settings.integrations.icsImport')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const r = await window.kapsula.exportCalendarIcs();
                            if (r.path) toast.success(t('settings.integrations.eventsExported', { count: r.exported }));
                          } catch (err) {
                            toast.error(friendlyErrorMessage(err, undefined, locale));
                          }
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] hover:border-[var(--k-border-strong)] cursor-pointer"
                      >
                        <DownloadSimple className="w-3.5 h-3.5" />
                        <span>{t('settings.integrations.icsExport')}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {calStatus?.connected && calStatus.authMode !== 'ical' ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[12px] text-[var(--k-ink-secondary)]">
                          {t('settings.integrations.calTwoWayActive')}
                          {calStatus.email ? ` (${calStatus.email})` : ''}.
                        </div>
                        <button
                          type="button"
                          disabled={calBusy}
                          onClick={async () => {
                            setCalBusy(true);
                            try {
                              const res = await window.kapsula.syncCalendarNow();
                              setCalStatus(res.status);
                              toast.success(
                                t('settings.integrations.syncedDelta', {
                                  imported: res.imported,
                                  pushed: res.pushed,
                                })
                              );
                              onVaultChanged?.();
                            } catch (err) {
                              toast.error(friendlyErrorMessage(err, undefined, locale));
                            } finally {
                              setCalBusy(false);
                            }
                          }}
                          className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                        >
                          <ArrowsClockwise className={`w-3.5 h-3.5 ${calBusy ? 'animate-spin' : ''}`} />
                          <span>{calBusy ? t('settings.integrations.syncingNow') : t('settings.integrations.syncNowBtn')}</span>
                        </button>
                      </div>
                    ) : (
                      <>
                        {calStatus?.builtInOAuthAvailable && !calStatus.connected ? (
                          <div className="flex items-center justify-between gap-2 pb-1">
                            <span className="text-[12px] text-[var(--k-ink-secondary)]">
                              {t('settings.integrations.calTwoWayHint')}
                            </span>
                            <button
                              type="button"
                              disabled={calBusy}
                              onClick={async () => {
                                setCalBusy(true);
                                try {
                                  const st = await window.kapsula.connectGoogleCalendar();
                                  setCalStatus(st);
                                  toast.success(t('settings.integrations.calConnectedToast'));
                                  onVaultChanged?.();
                                } catch (err) {
                                  toast.error(friendlyErrorMessage(err, undefined, locale));
                                } finally {
                                  setCalBusy(false);
                                }
                              }}
                              className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                            >
                              {calBusy ? t('settings.integrations.calOpeningBrowser') : t('settings.integrations.calConnectBtn')}
                            </button>
                          </div>
                        ) : null}

                        <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                          {t('settings.integrations.calIcalHint')}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            value={gcalIcalDraft}
                            onChange={(e) => setGcalIcalDraft(e.target.value)}
                            placeholder="https://calendar.google.com/calendar/ical/…"
                            className="flex-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] k-mono text-[11.5px] outline-none"
                          />
                          <button
                            type="button"
                            disabled={calBusy || !gcalIcalDraft.trim()}
                            onClick={async () => {
                              setCalBusy(true);
                              try {
                                await window.kapsula.saveCalendarConfig({ icalUrl: gcalIcalDraft });
                                const res = await window.kapsula.syncCalendarNow();
                                setCalStatus(res.status);
                                toast.success(t('settings.integrations.calLoadedCount', { count: res.imported }));
                              } catch (err) {
                                toast.error(friendlyErrorMessage(err, undefined, locale));
                              } finally {
                                setCalBusy(false);
                              }
                            }}
                            className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default"
                          >
                            {t('settings.integrations.syncBtn')}
                          </button>
                        </div>

                        <div className="pt-0.5">
                          <button
                            type="button"
                            onClick={() => setShowCustomGcalClient((v) => !v)}
                            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                          >
                            <CaretDown
                              className={`w-3 h-3 transition-transform duration-150 ${showCustomGcalClient ? 'rotate-180' : ''}`}
                            />
                            <span>{t('settings.integrations.calCustomClient')}</span>
                          </button>
                          {showCustomGcalClient ? (
                            <div className="flex items-center gap-2 mt-2">
                              <input
                                value={gcalClientIdDraft}
                                onChange={(e) => setGcalClientIdDraft(e.target.value)}
                                placeholder={t('settings.integrations.calClientIdPlaceholder')}
                                className="flex-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] k-mono text-[11.5px] outline-none"
                              />
                              <button
                                type="button"
                                disabled={calBusy || !gcalClientIdDraft.trim()}
                                onClick={async () => {
                                  setCalBusy(true);
                                  try {
                                    const st = await window.kapsula.connectGoogleCalendar(gcalClientIdDraft);
                                    setCalStatus(st);
                                    toast.success(t('settings.integrations.calConnectedToast'));
                                  } catch (err) {
                                    toast.error(friendlyErrorMessage(err, undefined, locale));
                                  } finally {
                                    setCalBusy(false);
                                  }
                                }}
                                className="k-interactive h-8 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] text-[12px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default shrink-0"
                              >
                                {t('settings.integrations.calSignInBrowser')}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[var(--k-border-hairline)]">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const r = await window.kapsula.importCalendarIcs();
                              if (r.imported > 0) {
                                toast.success(t('settings.integrations.eventsImported', { count: r.imported }));
                                onVaultChanged?.();
                              }
                            } catch (err) {
                              toast.error(friendlyErrorMessage(err, undefined, locale));
                            }
                          }}
                          className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] cursor-pointer"
                        >
                          <UploadSimple className="w-3.5 h-3.5" />
                          <span>{t('settings.integrations.icsImport')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const r = await window.kapsula.exportCalendarIcs();
                              if (r.path) toast.success(t('settings.integrations.eventsExported', { count: r.exported }));
                            } catch (err) {
                              toast.error(friendlyErrorMessage(err, undefined, locale));
                            }
                          }}
                          className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] cursor-pointer"
                        >
                          <DownloadSimple className="w-3.5 h-3.5" />
                          <span>{t('settings.integrations.icsExport')}</span>
                        </button>
                      </div>
                      {calStatus?.connected ? (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const st = await window.kapsula.disconnectGoogleCalendar();
                              setCalStatus(st);
                              setGcalIcalDraft('');
                              setShowGcalSetup(false);
                              toast.success(t('settings.integrations.calDisconnectedToast'));
                            } catch (err) {
                              toast.error(friendlyErrorMessage(err, undefined, locale));
                            }
                          }}
                          className="k-interactive h-7.5 px-2.5 rounded-lg text-[12px] text-[var(--k-danger)] cursor-pointer"
                        >
                          {t('settings.integrations.calDisconnect')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowGcalSetup(false)}
                          className="k-interactive h-7.5 px-2.5 rounded-lg text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          {t('common.collapse')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 2. Browser Extension + 3-step install + live port + pairing code */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Browser weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">{t('settings.integrations.extTitle')}</span>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 text-[11.5px] k-tabular ${
                      settings.clipperPort > 0
                        ? 'text-[var(--k-emerald)]'
                        : 'text-[var(--k-ink-muted)]'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        settings.clipperPort > 0 ? 'bg-[var(--k-emerald)]' : 'bg-[var(--k-ink-muted)]'
                      }`}
                    />
                    {settings.clipperPort > 0
                      ? t('settings.integrations.extActive', { port: settings.clipperPort })
                      : t('settings.integrations.extOff')}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11.5px] text-[var(--k-ink-secondary)]">
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">1.</strong> {t('settings.integrations.extStep1')}
                  </div>
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">2.</strong> {t('settings.integrations.extStep2')}
                  </div>
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">3.</strong> {t('settings.integrations.extStep3')}
                  </div>
                </div>

                {clipperPairingInfo?.pairingCode ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)]/80 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-medium text-[var(--k-ink-primary)]">
                        {t('settings.integrations.extPairLabel')}:{' '}
                        <code className="px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-2)] font-mono tracking-wider text-[12.5px]">
                          {clipperPairingInfo.pairingCode}
                        </code>
                        {clipperPairingInfo.pairedCount > 0 ? (
                          <span className="ml-2 text-[11px] text-[var(--k-ink-secondary)]">
                            · {t('settings.integrations.extPairedCount', { count: clipperPairingInfo.pairedCount })}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-[var(--k-ink-secondary)] mt-0.5">
                        {t('settings.integrations.extPairHint')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        data-testid="copy-clipper-pair-code-btn"
                        onClick={async () => {
                          await window.kapsula.copyText(clipperPairingInfo.pairingCode);
                          setCopiedPairCode(true);
                          toast.success(t('settings.integrations.extPairCodeCopied'));
                          window.setTimeout(() => setCopiedPairCode(false), 2000);
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[11px] font-medium text-[var(--k-ink-primary)] cursor-pointer"
                      >
                        {copiedPairCode ? (
                          <Check weight="bold" className="w-3 h-3 text-[var(--k-emerald)]" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>
                          {copiedPairCode ? t('common.copied') : t('settings.integrations.extCopyPairCode')}
                        </span>
                      </button>
                      {clipperPairingInfo.pairedCount > 0 ? (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const next = await window.kapsula.resetClipperPairing();
                              setClipperPairingInfo(next);
                              toast.success(t('settings.integrations.extResetPairToast'));
                            } catch {
                              toast.error(t('error.generic'));
                            }
                          }}
                          className="k-interactive h-7 px-2.5 rounded-md border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[11px] text-[var(--k-ink-secondary)] cursor-pointer"
                        >
                          {t('settings.integrations.extResetPairBtn')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void window.kapsula.openExtensionFolder()}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>{t('settings.integrations.extOpenFolder')}</span>
                    <ArrowSquareOut className="w-3 h-3 opacity-80" />
                  </button>
                </div>
              </div>

              {/* 3. Email -> Kapsula */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <EnvelopeSimple weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">{t('settings.integrations.emailTitle')}</span>
                  </div>
                  <button
                    type="button"
                    data-testid="import-eml-btn"
                    disabled={importBusy === 'eml'}
                    onClick={() =>
                      void runImport(
                        'eml',
                        () => window.kapsula.importEmlFiles(),
                        t('settings.integrations.noNewEmails')
                      )
                    }
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                  >
                    <UploadSimple className="w-3.5 h-3.5" />
                    <span>
                      {importBusy === 'eml'
                        ? t('settings.integrations.importing')
                        : t('settings.integrations.importEml')}
                    </span>
                  </button>
                </div>

                <div className="text-[12px] text-[var(--k-ink-secondary)]">
                  {t('settings.integrations.emlHint')}
                </div>
              </div>

              {/* 4. Import from other apps: Obsidian/Markdown, Notion (.zip), Chat/Notes Archives */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold">{t('settings.integrations.importTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.integrations.importDesc')}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    data-testid="import-obsidian-btn"
                    disabled={importBusy !== null}
                    onClick={() =>
                      void runImport(
                        'markdown',
                        () => window.kapsula.importMarkdownFolder(),
                        t('settings.integrations.noMdFound')
                      )
                    }
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <BookOpen weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'markdown' ? t('settings.integrations.importing') : 'Obsidian / Markdown'}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      {t('settings.integrations.mdDesc')}
                    </div>
                  </button>

                  <button
                    type="button"
                    data-testid="import-notion-btn"
                    disabled={importBusy !== null}
                    onClick={() =>
                      void runImport(
                        'notion',
                        () => window.kapsula.importNotionZip(),
                        t('settings.integrations.noNotionFound')
                      )
                    }
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <FileArchive weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'notion' ? t('settings.integrations.importing') : 'Notion (.zip)'}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      {t('settings.integrations.notionDesc')}
                    </div>
                  </button>

                  <button
                    type="button"
                    data-testid="import-archive-btn"
                    disabled={importBusy !== null}
                    onClick={async () => {
                      setImportBusy('archive');
                      try {
                        const r = await window.kapsula.pickAndImportArchive();
                        if (r.canceled) return;
                        toast.success(
                          `${t('settings.integrations.importedSummary', { imported: r.imported })} (${t('settings.integrations.importedSkipped', { count: r.skippedDuplicates })})`
                        );
                        onVaultChanged?.();
                      } catch (err) {
                        toast.error(friendlyErrorMessage(err, undefined, locale));
                      } finally {
                        setImportBusy(null);
                      }
                    }}
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <FileText weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'archive' ? t('settings.integrations.importing') : t('settings.integrations.archiveBtn')}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      {t('settings.integrations.archiveDesc')}
                    </div>
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {/* 6. DATA */}
          {tab === 'data' ? (
            <>
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.data.storageTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular mt-0.5">
                    {storageInfo
                      ? t('settings.data.storageSummary', {
                          items: storageInfo.itemCount,
                          media: storageInfo.mediaFilesCount,
                          size: formatFileSize(storageInfo.totalBytes, locale),
                        })
                      : t('settings.data.storageLoading')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void window.kapsula.openDataFolder()}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>{t('settings.data.openFolder')}</span>
                </button>
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.data.videoCacheTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular mt-0.5">
                    {t('settings.data.videoCacheSummary', {
                      count: videoCacheInfo?.fileCount ?? 0,
                      used: formatFileSize(videoCacheInfo?.bytesUsed ?? 0, locale) || t('settings.data.zeroBytes'),
                      limit: videoCacheInfo?.limitMb ?? settings?.videoCacheLimitMb ?? 500,
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <SelectMenu
                    size="sm"
                    data-testid="video-cache-limit-select"
                    value={String(videoCacheInfo?.limitMb ?? settings?.videoCacheLimitMb ?? 500)}
                    onChange={async (val) => {
                      const limitMb = Number(val);
                      if (!Number.isFinite(limitMb)) return;
                      await patch({ videoCacheLimitMb: limitMb });
                      window.kapsula.getVideoCacheStats?.().then(setVideoCacheInfo).catch(() => {});
                    }}
                    options={[
                      { value: '250', label: t('settings.data.cache250mb') },
                      { value: '500', label: t('settings.data.cache500mb') },
                      { value: '1024', label: t('settings.data.cache1gb') },
                      { value: '2048', label: t('settings.data.cache2gb') },
                    ]}
                  />
                  <button
                    type="button"
                    data-testid="clear-video-cache-btn"
                    disabled={clearingVideoCache || (videoCacheInfo?.fileCount ?? 0) === 0}
                    onClick={async () => {
                      setClearingVideoCache(true);
                      try {
                        const stats = await window.kapsula.clearVideoCache?.();
                        if (stats) setVideoCacheInfo(stats);
                        toast.success(t('settings.data.videoCacheCleared'));
                        window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
                      } finally {
                        setClearingVideoCache(false);
                      }
                    }}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-50"
                  >
                    <Trash className="w-3.5 h-3.5" />
                    <span>{t('settings.data.videoCacheClearBtn')}</span>
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.data.exportZipTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5">
                    {t('settings.data.exportZipDesc')}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="export-markdown-zip-btn"
                  disabled={exportingMdZip}
                  onClick={async () => {
                    setExportingMdZip(true);
                    try {
                      const res = await window.kapsula.exportMarkdownZip();
                      if (res.ok && res.filePath) {
                        toast.success(t('settings.data.exportZipToast', { count: res.count ?? 0 }));
                      } else if (res.error) {
                        toast.error(res.error);
                      }
                    } catch (err) {
                      toast.error(friendlyErrorMessage(err, t('settings.data.exportZipErr'), locale));
                    } finally {
                      setExportingMdZip(false);
                    }
                  }}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                >
                  <FileArchive className="w-3.5 h-3.5" />
                  <span>{exportingMdZip ? t('settings.data.exportZipBusy') : t('settings.data.exportZipBtn')}</span>
                </button>
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">{t('settings.data.backupTitle')}</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5">
                      {t('settings.data.backupDesc')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      data-testid="restore-json-backup-btn"
                      disabled={restoringBackup}
                      onClick={async () => {
                        setRestoringBackup(true);
                        try {
                          const res = await window.kapsula.importJsonBackup();
                          if (res.importedCount > 0 || res.skippedCount > 0) {
                            toast.success(
                              `${t('settings.data.restoredCount', { count: res.importedCount })}${
                                res.skippedCount > 0
                                  ? t('settings.data.restoredSkipped', { count: res.skippedCount })
                                  : ''
                              }`
                            );
                            onVaultChanged?.();
                            window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
    window.kapsula.getVideoCacheStats?.().then(setVideoCacheInfo).catch(() => {});
                          }
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, t('settings.data.restoreErr'), locale));
                        } finally {
                          setRestoringBackup(false);
                        }
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium hover:bg-[var(--k-bg-surface-3)] cursor-pointer disabled:opacity-60"
                    >
                      <UploadSimple className="w-3.5 h-3.5" />
                      <span>{restoringBackup ? t('settings.data.restoringBtn') : t('settings.data.restoreBtn')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={exportingBackup}
                      onClick={async () => {
                        setExportingBackup(true);
                        try {
                          const res = await window.kapsula.exportBackup();
                          if (!res.canceled) {
                            toast.success(
                              t('settings.data.backupSaved', {
                                count: res.itemCount,
                                word: pluralNoun(res.itemCount, 'item').replace(/^\d+\s+/, ''),
                              })
                            );
                          }
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, t('settings.data.backupErr'), locale));
                        } finally {
                          setExportingBackup(false);
                        }
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-60"
                    >
                      <DownloadSimple className="w-3.5 h-3.5" />
                      <span>{exportingBackup ? t('common.saving') : t('settings.data.saveCopyBtn')}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.data.unfurlTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.data.unfurlDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.enableUrlUnfurl}
                  onCheckedChange={(enableUrlUnfurl) => void patch({ enableUrlUnfurl })}
                />
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3.5 text-[12px] text-[var(--k-ink-secondary)] leading-relaxed">
                {t('settings.data.localBanner')}
              </div>
            </>
          ) : null}

          {/* 7. SHORTCUTS */}
          {tab === 'shortcuts' ? (
            <>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.shortcuts.hudTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.shortcuts.hudDesc')}
                  </div>
                </div>
                <ShortcutRecorder
                  value={settings.hudShortcut}
                  registered={settings.shortcutStatus?.hudRegistered ?? true}
                  onChange={(hudShortcut) => void patch({ hudShortcut })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.shortcuts.snatchTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.shortcuts.snatchDesc')}
                  </div>
                </div>
                <ShortcutRecorder
                  value={settings.snatchShortcut}
                  registered={settings.shortcutStatus?.snatchRegistered ?? true}
                  onChange={(snatchShortcut) => void patch({ snatchShortcut })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.shortcuts.autostartTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.shortcuts.autostartDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.launchAtLogin}
                  onCheckedChange={(launchAtLogin) => void patch({ launchAtLogin })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">{t('settings.shortcuts.soundsTitle')}</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    {t('settings.shortcuts.soundsDesc')}
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.soundTickEnabled}
                  onCheckedChange={(soundTickEnabled) => void patch({ soundTickEnabled })}
                />
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 space-y-2">
                <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                  {t('settings.shortcuts.inAppHeader')}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                  {[
                    [isMac ? '⌘ F' : 'Ctrl + F', t('settings.shortcuts.find')],
                    [isMac ? '⌘ N' : 'Ctrl + N', t('settings.shortcuts.newNote')],
                    [t('settings.shortcuts.space'), t('settings.shortcuts.quickLook')],
                    ['Esc', t('settings.shortcuts.escDesc')],
                  ].map(([keyCombo, desc]) => (
                    <div key={keyCombo} className="flex items-center justify-between gap-2 py-0.5">
                      <span className="text-[var(--k-ink-secondary)]">{desc}</span>
                      <kbd className="k-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)] shrink-0">
                        {keyCombo}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Always-accessible About, Cloud Updates & Safe Diagnostics bar */}
        <div
          data-testid="settings-about-footer"
          className="pt-3 border-t border-[var(--k-border-hairline)] flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
              <span className="text-[12.5px] font-semibold text-[var(--k-ink-primary)] k-tabular">
                Kapsula v{updaterState?.currentVersion ?? APP_VERSION}
              </span>
              {updaterState?.status === 'checking' ? (
                <span className="text-[11.5px] text-[var(--k-ink-muted)]">{t('settings.updates.checking')}</span>
              ) : updaterState?.status === 'available' && updaterState.latestVersion ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11px] font-medium k-tabular">
                  {t('workspace.sidebar.updateAvailable', { version: updaterState.latestVersion })}
                </span>
              ) : updaterState?.status === 'downloading' ? (
                <span className="text-[11.5px] text-[var(--k-accent)] font-medium k-tabular">
                  {t('settings.updates.downloading', { percent: updaterState.percent ?? 0 })}
                </span>
              ) : updaterState?.status === 'downloaded' ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] text-[11px] font-medium">
                  {t('settings.updates.ready')}
                </span>
              ) : updaterState?.status === 'up-to-date' ? (
                <span className="text-[11.5px] text-[var(--k-emerald)]">{t('settings.updates.upToDate')}</span>
              ) : updaterState?.status === 'error' && updaterState.error ? (
                <span className="text-[11.5px] text-[var(--k-amber)]">{updaterState.error}</span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {updaterState?.status === 'downloaded' ? (
                <button
                  type="button"
                  data-testid="settings-install-update-btn"
                  onClick={() => void handleDownloadOrInstallUpdate()}
                  className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-3 rounded-lg bg-[var(--k-emerald)] text-white text-[12px] font-medium cursor-pointer"
                >
                  <ArrowsClockwise className="w-3.5 h-3.5" />
                  <span>{t('settings.updates.restartBtn')}</span>
                </button>
              ) : updaterState?.status === 'available' ? (
                <button
                  type="button"
                  data-testid="settings-download-update-btn"
                  onClick={() => void handleDownloadOrInstallUpdate()}
                  className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  <DownloadSimple className="w-3.5 h-3.5" />
                  <span>{isMac ? t('settings.updates.downloadMac') : t('settings.updates.downloadWin')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="settings-check-updates-btn"
                  disabled={updaterState?.status === 'checking' || updaterState?.status === 'downloading'}
                  onClick={() => void handleCheckUpdates()}
                  className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-55"
                >
                  <ArrowsClockwise
                    className={`w-3.5 h-3.5 ${updaterState?.status === 'checking' ? 'animate-spin text-[var(--k-accent)]' : ''}`}
                  />
                  <span>{t('settings.updates.checkBtn')}</span>
                </button>
              )}

              <button
                type="button"
                data-testid="settings-copy-diagnostics-btn"
                disabled={diagCopying}
                onClick={() => void handleCopyDiagnostics()}
                className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-55"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{diagCopying ? t('settings.diag.collecting') : t('settings.diag.copyBtn')}</span>
              </button>
            </div>
          </div>

          {updaterState?.status === 'downloading' ? (
            <div className="h-1.5 rounded-full bg-[var(--k-bg-surface-3)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--k-accent)] transition-[width] duration-200"
                style={{ width: `${Math.max(4, Math.min(100, updaterState.percent ?? 0))}%` }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
};
