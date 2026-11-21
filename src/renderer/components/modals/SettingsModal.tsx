import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  AppUpdaterState,
  BudgetSummary,
  CalendarSyncStatus,
  CloudAiQuotaStatus,
  SettingsState,
  ThemeMode,
} from '@shared/types';
import { isMacPlatform } from '@shared/shortcuts';
import { friendlyErrorMessage, pluralRu } from '../../lib/format';
import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  LIGHT_BG_PRESETS,
  computeThemeTokens,
  contrastRatio,
  getSavedAppearance,
  hexToHsl,
  hslToHex,
  hydrateAppearanceFromSettings,
  normalizeHex,
  resetSavedAppearance,
  setSavedAppearance,
  type UiDensity,
} from '../../lib/appearance';
import { ModalDialog } from '../ui/ModalDialog';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectMenu } from '../ui/SelectMenu';
import { ShortcutRecorder } from '../ui/ShortcutRecorder';
import { SwitchToggle } from '../ui/SwitchToggle';
import { SyncSettingsPanel } from './SyncSettingsPanel';

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

function formatSyncTimestamp(ts: number | null | undefined): string {
  if (!ts) return '';
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин. назад`;
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatUsdRu(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return `$${safe.toFixed(2).replace('.', ',')}`;
}

function buildBookmarkletCode(port: number, token: string): string {
  const safePort = port > 0 ? port : 41731;
  const safeToken = (token || '').replace(/['"\\]/g, '');
  return `javascript:(function(){var t=(window.getSelection&&window.getSelection().toString())||'';fetch('http://127.0.0.1:${safePort}/clip',{method:'POST',headers:{'Content-Type':'application/json','X-Kapsula-Token':'${safeToken}'},body:JSON.stringify({url:location.href,title:document.title,text:t||document.title})}).then(function(){alert('Сохранено в Kapsula');}).catch(function(){alert('Открой Kapsula на компьютере');});})();`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onOpenChange,
  initialTab = 'appearance',
  settings,
  onSettingsUpdated,
  onVaultChanged,
  onRecoveryKeyVisibleChange,
}) => {
  const isMac = isMacPlatform(window.kapsula?.platform ?? 'win32');
  const [tab, setTab] = useState<Exclude<SettingsTab, 'general'>>(() => normalizeTab(initialTab));
  const [appearance, setAppearance] = useState<AppearanceConfig>(() => getSavedAppearance());
  const [hexDraft, setHexDraft] = useState<string>(() => getSavedAppearance().accentHex);

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
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);
  const [importBusy, setImportBusy] = useState<string | null>(null);

  // Cloud Updates & Diagnostics
  const [updaterState, setUpdaterState] = useState<AppUpdaterState | null>(null);
  const [diagCopying, setDiagCopying] = useState(false);

  // Security PIN & Cloud Sync one-time Recovery Key
  const [pinDraft, setPinDraft] = useState('');
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
    window.kapsula.getUpdaterState().then(setUpdaterState).catch(() => {});
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

  const theme: ThemeMode = settings?.theme ?? 'dark';

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

  const patch = async (delta: Record<string, unknown>) => {
    try {
      const next = await window.kapsula.updateSettings(delta);
      onSettingsUpdated(next);
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось сохранить настройку.'));
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
      const p = ACCENT_PRESETS.find((x) => x.id === applied.accentPreset);
      if (p) setHexDraft(theme === 'light' ? p.swatchLight : p.swatchDark);
    }
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = apiKeyDraft.trim();
    if (!cleaned) return;
    const next = await window.kapsula.setApiKey(keyProviderTarget, cleaned);
    onSettingsUpdated(next);
    setApiKeyDraft('');
    toast.success('Ключ сохранён и зашифрован на устройстве');
    window.kapsula.getBudget().then(setBudget).catch(() => {});
    refreshCloudQuota();
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
      toast.error(friendlyErrorMessage(err, 'Ошибка проверки ключа.'));
    } finally {
      setTestingKey(false);
    }
  };

  const handleSetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pinDraft.trim();
    if (clean.length < 4) {
      toast.info('Придумай мастер-код минимум из 4 символов');
      return;
    }
    setPinSaving(true);
    try {
      await window.kapsula.setMasterPin(clean);
      const next = await window.kapsula.getSettings();
      onSettingsUpdated(next);
      setPinDraft('');
      toast.success('Мастер-код для Сейфа установлен');
    } finally {
      setPinSaving(false);
    }
  };

  const handleModalOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && freshRecoveryKey) {
      setTab('sync');
      toast.info('Сначала скопируй резервный ключ и нажми «Готово, я сохранил»');
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

  const bgPresets = theme === 'dark' ? DARK_BG_PRESETS : LIGHT_BG_PRESETS;

  const handleCopyDiagnostics = async () => {
    setDiagCopying(true);
    try {
      const report = await window.kapsula.getDiagnosticsReport();
      await window.kapsula.copyText(report);
      toast.success('Диагностика скопирована — можно отправить разработчику');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось собрать диагностику.'));
    } finally {
      setDiagCopying(false);
    }
  };

  const handleCheckUpdates = async () => {
    try {
      const next = await window.kapsula.checkForUpdates();
      setUpdaterState(next);
      if (next.status === 'available' && next.latestVersion) {
        toast.success(`Доступна новая версия v${next.latestVersion}`);
      } else if (next.status === 'up-to-date') {
        toast.success('У тебя установлена последняя версия Kapsula');
      } else if (next.status === 'error' && next.error) {
        toast.error(next.error);
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось проверить обновления.'));
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
        toast.success(isMac ? 'Открываю загрузку образа для Mac в браузере' : 'Открываю загрузку обновления в браузере');
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось загрузить обновление.'));
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
      const parts = [`Импортировано: ${res.importedCount}`];
      if (res.orbitsCreated > 0) parts.push(`разделов: ${res.orbitsCreated}`);
      if (res.skippedCount > 0) parts.push(`пропущено дублей: ${res.skippedCount}`);
      toast.success(res.importedCount > 0 ? parts.join(' · ') : emptyMsg);
      onVaultChanged?.();
      window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось выполнить импорт.'));
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={handleModalOpenChange}
      topAligned
      title="Настройки Kapsula"
      subtitle="Внешний вид, облачная синхронизация, защита Сейфа, ИИ и интеграции"
      maxWidthClass="max-w-[860px]"
    >
      <div className="px-5 pt-3.5 pb-5 flex flex-col gap-4">
        <SegmentedControl<Exclude<SettingsTab, 'general'>>
          value={tab}
          onChange={setTab}
          size="sm"
          fullWidth
          options={[
            { value: 'appearance', label: 'Внешний вид', icon: <Palette className="w-3.5 h-3.5" /> },
            { value: 'sync', label: 'Синхронизация', icon: <CloudCheck className="w-3.5 h-3.5" /> },
            { value: 'security', label: 'Безопасность', icon: <ShieldCheck className="w-3.5 h-3.5" /> },
            { value: 'ai', label: 'ИИ', icon: <Cpu className="w-3.5 h-3.5" /> },
            { value: 'integrations', label: 'Интеграции', icon: <PlugsConnected className="w-3.5 h-3.5" /> },
            { value: 'data', label: 'Данные', icon: <Database className="w-3.5 h-3.5" /> },
            { value: 'shortcuts', label: 'Клавиши', icon: <Keyboard className="w-3.5 h-3.5" /> },
          ]}
        />

        {/* Fixed-height tab body prevents modal jumping when switching sections */}
        <div className="h-[460px] overflow-y-auto k-scroll-stable pr-1 flex flex-col gap-3">
          {/* 1. ВНЕШНИЙ ВИД */}
          {tab === 'appearance' ? (
            <>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Тема оформления</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Переключай тёмную и светлую палитру в один клик
                  </div>
                </div>
                <SegmentedControl<ThemeMode>
                  value={theme}
                  onChange={(nextTheme) => void handleThemeSwitch(nextTheme)}
                  options={[
                    { value: 'dark', label: 'Тёмная', icon: <Moon className="w-3.5 h-3.5" /> },
                    { value: 'light', label: 'Светлая', icon: <Sun className="w-3.5 h-3.5" /> },
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
                    <div className="text-[13.5px] font-medium">Акцентный цвет</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      Цвет кнопок, выделений и активных вкладок с автоподбором контраста
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0" data-testid="accent-preset-picker">
                    {ACCENT_PRESETS.map((preset) => {
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
                          className={`k-interactive w-6 h-6 rounded-full cursor-pointer transition-transform ${
                            active
                              ? 'scale-110 ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)]'
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
                      <span>Свой оттенок акцента</span>
                      <span className="k-mono k-tabular text-[var(--k-ink-muted)]">{accentHue}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={1}
                      data-testid="accent-hue-slider"
                      aria-label="Оттенок акцента"
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
                        aria-label="Код цвета HEX"
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
                      title={`Контраст текста: ${accentContrast.toFixed(1)}:1`}
                    >
                      <span>Кнопка</span>
                      <span className="k-mono text-[10px] opacity-80">
                        {accentContrast.toFixed(1)}:1
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Background Color Presets + Custom Background Sliders */}
              <div
                data-testid="appearance-bg-card"
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[13.5px] font-medium">Цвет фона и поверхностей</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      Выбери готовую палитру или настрой тон, насыщенность и глубину вручную
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="appearance-reset-btn"
                    onClick={() => {
                      const reset = resetSavedAppearance(theme);
                      setAppearance(reset);
                      const p = ACCENT_PRESETS[0]!;
                      setHexDraft(theme === 'light' ? p.swatchLight : p.swatchDark);
                      toast.success('Оформление сброшено по умолчанию');
                    }}
                    className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer shrink-0"
                  >
                    <ArrowCounterClockwise className="w-3.5 h-3.5" />
                    <span>Сбросить по умолчанию</span>
                  </button>
                </div>

                {/* Preset Swatch Grid — expressive 2-tone mini-theme preview tiles */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="bg-preset-picker">
                  {bgPresets.map((preset) => {
                    const active = appearance.bgPreset === preset.id;
                    const displayLabel = preset.id === 'paper' ? 'Тёплая бумага' : preset.label;
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
                      Свой цвет фона
                    </span>
                    <span className="k-mono text-[11px] text-[var(--k-ink-muted)]">
                      {appearance.bgPreset === 'custom' ? computedPreview.canvasHex : 'Пресет'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                        <span>Оттенок</span>
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
                        <span>Насыщенность тона</span>
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
                        <span>Глубина / яркость</span>
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
                  <div className="text-[13.5px] font-medium">Плотность интерфейса</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Воздушные карточки или больше записей на одном экране
                  </div>
                </div>
                <SegmentedControl<UiDensity>
                  value={appearance.density}
                  onChange={(density) =>
                    applyAppearanceChange({ ...appearance, density }, { immediate: true })
                  }
                  options={[
                    { value: 'comfortable', label: 'Просторно' },
                    { value: 'compact', label: 'Компактно' },
                  ]}
                />
              </div>
            </>
          ) : null}

          {/* 2. СИНХРОНИЗАЦИЯ */}
          {tab === 'sync' ? (
            <SyncSettingsPanel
              onVaultChanged={onVaultChanged}
              onAuthChanged={refreshCloudQuota}
              freshRecoveryKey={freshRecoveryKey}
              onFreshRecoveryKeyChange={setFreshRecoveryKey}
            />
          ) : null}

          {/* 3. БЕЗОПАСНОСТЬ */}
          {tab === 'security' ? (
            <>
              <form
                onSubmit={handleSetPin}
                className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[13.5px] font-medium">Мастер-код для Сейфа</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      {settings.hasMasterPin
                        ? 'Защита включена — без кода карты, пароли, ключи и 2FA скрыты'
                        : 'Дополнительная блокировка карт, паролей, ключей и 2FA-кодов'}
                    </div>
                  </div>
                  {settings.hasMasterPin ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await window.kapsula.setMasterPin(null);
                        const next = await window.kapsula.getSettings();
                        onSettingsUpdated(next);
                        toast.success('Мастер-код отключён');
                      }}
                      className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-danger)] cursor-pointer"
                    >
                      Снять код
                    </button>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={pinDraft}
                    onChange={(e) => setPinDraft(e.target.value)}
                    placeholder={
                      settings.hasMasterPin
                        ? 'Новый код (от 4 символов)'
                        : 'Задать код (от 4 символов)'
                    }
                    className="flex-1 h-9 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <button
                    type="submit"
                    disabled={pinSaving || pinDraft.trim().length < 4}
                    className="k-interactive h-9 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                  >
                    Сохранить
                  </button>
                </div>
              </form>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Автоблокировка Сейфа</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Через сколько минут бездействия автоматически закрывать Сейф
                  </div>
                </div>
                <SelectMenu
                  value={String(settings.vaultAutoLockMinutes ?? 5)}
                  onChange={(v) => void patch({ vaultAutoLockMinutes: Number(v) })}
                  options={[
                    { value: '1', label: '1 мин' },
                    { value: '5', label: '5 мин' },
                    { value: '15', label: '15 мин' },
                    { value: '30', label: '30 мин' },
                    { value: '0', label: 'Выкл' },
                  ]}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Блокировать Сейф при сворачивании окна</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Сразу скрывает расшифрованные данные, когда ты сворачиваешь Kapsula
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.lockVaultOnMinimize ?? true}
                  onCheckedChange={(lockVaultOnMinimize) => void patch({ lockVaultOnMinimize })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Блокировать после закрытия быстрой панели</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Закрывает доступ к Сейфу сразу после скрытия быстрого поиска
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
                    Защита Сейфа от записи экрана и скриншотов
                  </div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Скрывает окно на скриншотах только когда открыт Сейф или ключ восстановления
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.enableScreenProtection ?? true}
                  onCheckedChange={async (enabled) => {
                    try {
                      await patch({ enableScreenProtection: enabled });
                    } catch (err) {
                      toast.error(friendlyErrorMessage(err));
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
                        {isMac ? 'Touch ID для входа в Сейф' : 'Биометрия для входа в Сейф'}
                      </div>
                      <div className="text-[12px] text-[var(--k-ink-secondary)]">
                        {settings.hasMasterPin
                          ? 'Открывать Сейф отпечатком пальца или системной проверкой вместо ввода кода'
                          : 'Сначала задай мастер-код выше, чтобы включить вход по отпечатку'}
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
                        toast.error(friendlyErrorMessage(err));
                      }
                    }}
                  />
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Автоочистка буфера обмена</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Через сколько секунд стирать скопированный пароль, карту или CVV
                  </div>
                </div>
                <SelectMenu
                  value={String(settings.clipboardAutoWipeSeconds)}
                  onChange={(v) => void patch({ clipboardAutoWipeSeconds: Number(v) })}
                  options={[
                    { value: '15', label: '15 секунд' },
                    { value: '30', label: '30 секунд' },
                    { value: '60', label: '60 секунд' },
                    { value: '0', label: 'Не очищать' },
                  ]}
                />
              </div>
            </>
          ) : null}

          {/* 4. ИИ */}
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
                      <div className="text-[13.5px] font-semibold">Встроенный ИИ Kapsula</div>
                      {settings.hasGoogleAiKey || settings.hasOpenRouterKey || cloudQuota?.usingPersonalKey ? (
                        <div className="text-[12px] text-[var(--k-emerald)] mt-0.5 font-medium">
                          Работает через твой личный ключ (без лимита Kapsula)
                        </div>
                      ) : cloudQuota?.signedIn ? (
                        <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                          Разбор картинок, расшифровка голоса, ассистент и сортировка работают сразу без настройки ключей.
                        </div>
                      ) : (
                        <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                          Войди в аккаунт во вкладке «Синхронизация», чтобы бесплатно пользоваться встроенным ИИ (лимит $1/мес)
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
                        title="Обновить остаток лимита"
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
                        Войти в аккаунт
                      </button>
                    )
                  ) : null}
                </div>

                {!settings.hasGoogleAiKey && !settings.hasOpenRouterKey && cloudQuota?.signedIn ? (
                  <div className="flex flex-col gap-1.5 pt-0.5">
                    <div className="h-2 rounded-full bg-[var(--k-bg-surface-3)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
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
                        Потрачено {formatUsdRu(cloudQuota.spentUsd)} из {formatUsdRu(cloudQuota.limitUsd)} в этом месяце · осталось{' '}
                        <strong className="text-[var(--k-ink-primary)]">
                          {formatUsdRu(cloudQuota.remainingUsd)}
                        </strong>
                      </span>
                      {cloudQuota.requestCount > 0 ? (
                        <span className="text-[11px] text-[var(--k-ink-muted)]">
                          Запросов: {cloudQuota.requestCount}
                        </span>
                      ) : null}
                    </div>
                    {cloudQuota.blocked || cloudQuota.globalExhausted || cloudQuota.remainingUsd <= 0 ? (
                      <div className="text-[11.5px] text-[var(--k-amber)]">
                        {cloudQuota.globalExhausted
                          ? 'Общий месячный лимит встроенного ИИ исчерпан — добавь свой ключ ниже или дождись 1-го числа.'
                          : 'Месячный лимит встроенного ИИ исчерпан — добавь свой ключ ниже или дождись 1-го числа.'}
                      </div>
                    ) : cloudQuota.error ? (
                      <div className="text-[11.5px] text-[var(--k-ink-muted)]">{cloudQuota.error}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">Режим умной обработки</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      Для разбора картинок, расшифровки голоса, «Разобрать» и «Свести в заметку»
                    </div>
                  </div>
                  <SelectMenu
                    value={settings.aiProvider}
                    onChange={(val) => void patch({ aiProvider: val as AiProvider })}
                    options={[
                      { value: 'local', label: 'Только на устройстве' },
                      { value: 'google_ai_studio', label: 'Google Gemini' },
                      { value: 'openrouter', label: 'OpenRouter' },
                    ]}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4 text-[12px] text-[var(--k-ink-secondary)] pt-1">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle
                      weight="fill"
                      className={`w-3.5 h-3.5 ${settings.hasGoogleAiKey ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'}`}
                    />
                    Свой ключ Gemini: {settings.hasGoogleAiKey ? 'подключён' : 'не задан'}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle
                      weight="fill"
                      className={`w-3.5 h-3.5 ${settings.hasOpenRouterKey ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'}`}
                    />
                    Свой ключ OpenRouter: {settings.hasOpenRouterKey ? 'подключён' : 'не задан'}
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
                    Свой ключ (необязательно — для работы без лимита)
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
                    placeholder="Вставь свой ключ Gemini или OpenRouter…"
                    className="flex-1 h-9 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <button
                    type="button"
                    disabled={testingKey}
                    onClick={() => void handleTestKey()}
                    className="k-interactive h-9 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] text-[12px] font-medium hover:border-[var(--k-ink-secondary)] cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:border-[var(--k-border-hairline)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
                  >
                    {testingKey ? 'Проверка…' : 'Проверить'}
                  </button>
                  <button
                    type="submit"
                    disabled={!apiKeyDraft.trim()}
                    className="k-interactive h-9 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
                  >
                    Сохранить
                  </button>
                  {(keyProviderTarget === 'google_ai_studio' && settings.hasGoogleAiKey) ||
                  (keyProviderTarget === 'openrouter' && settings.hasOpenRouterKey) ? (
                    <button
                      type="button"
                      title="Удалить сохранённый ключ"
                      onClick={async () => {
                        const next = await window.kapsula.setApiKey(keyProviderTarget, '');
                        onSettingsUpdated(next);
                        toast.success('Ключ удалён');
                        refreshCloudQuota();
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
                      <div className="text-[13px] font-medium">Месячный лимит для своего ключа</div>
                      <div className="text-[12px] text-[var(--k-ink-secondary)]">
                        Защита от лишних трат по личному ключу — после лимита обработка переходит в локальный режим
                      </div>
                    </div>
                    <SelectMenu
                      size="sm"
                      value={String(settings.monthlyCapUsd)}
                      onChange={(v) => void patch({ monthlyCapUsd: Number(v) })}
                      options={[
                        { value: '0.5', label: '$0.50 / мес' },
                        { value: '1.5', label: '$1.50 / мес' },
                        { value: '3', label: '$3.00 / мес' },
                        { value: '5', label: '$5.00 / мес' },
                        { value: '10', label: '$10.00 / мес' },
                      ]}
                    />
                  </div>
                  {budget ? (
                    <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular">
                      Потрачено по своему ключу в этом месяце: ${budget.spentUsd.toFixed(4)} из ${budget.capUsd.toFixed(2)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {/* 5. ИНТЕГРАЦИИ (Google Calendar, Browser Extension, Email -> Kapsula, Importers — ZERO legacy Telegram MTProto) */}
          {tab === 'integrations' ? (
            <>
              {/* 1. Google Calendar + 1-click .ics import/export */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CalendarBlank weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">Google Календарь и файлы .ics</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {calStatus?.lastSyncAt ? (
                      <span className="px-2 py-0.5 rounded-full bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[11px] text-[var(--k-ink-muted)] k-tabular">
                        Обновлено: {formatSyncTimestamp(calStatus.lastSyncAt)}
                      </span>
                    ) : null}
                    <span
                      className={`text-[11.5px] font-medium ${
                        calStatus?.connected ? 'text-[var(--k-emerald)]' : 'text-[var(--k-ink-muted)]'
                      }`}
                    >
                      {calStatus?.connected ? calStatus.email || 'Подключён' : 'Не подключён'}
                    </span>
                  </div>
                </div>

                {!calStatus?.connected && !showGcalSetup ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[12px] text-[var(--k-ink-secondary)]">
                      Синхронизируй встречи с Google Календарём в один клик или переноси расписание через файлы .ics
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
                                toast.success('Google Календарь подключён');
                                onVaultChanged?.();
                              } catch (err) {
                                toast.error(friendlyErrorMessage(err));
                              } finally {
                                setCalBusy(false);
                              }
                            }}
                            className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                          >
                            {calBusy ? 'Открываю браузер…' : 'Подключить Google Календарь'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowGcalSetup(true)}
                            className="k-interactive h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer"
                          >
                            Ссылка .ics
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowGcalSetup(true)}
                          className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                        >
                          Подключить Google
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const r = await window.kapsula.importCalendarIcs();
                            if (r.imported > 0) {
                              toast.success(`Импортировано событий: ${r.imported}`);
                              onVaultChanged?.();
                            }
                          } catch (err) {
                            toast.error(friendlyErrorMessage(err));
                          }
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] hover:border-[var(--k-border-strong)] cursor-pointer"
                      >
                        <UploadSimple className="w-3.5 h-3.5" />
                        <span>Импорт .ics</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const r = await window.kapsula.exportCalendarIcs();
                            if (r.path) toast.success(`Экспортировано событий: ${r.exported}`);
                          } catch (err) {
                            toast.error(friendlyErrorMessage(err));
                          }
                        }}
                        className="k-interactive inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] hover:border-[var(--k-border-strong)] cursor-pointer"
                      >
                        <DownloadSimple className="w-3.5 h-3.5" />
                        <span>Экспорт .ics</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {calStatus?.connected && calStatus.authMode !== 'ical' ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[12px] text-[var(--k-ink-secondary)]">
                          Двусторонняя синхронизация активна{calStatus.email ? ` (${calStatus.email})` : ''}.
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
                                `Синхронизировано: получено ${res.imported}, отправлено ${res.pushed}`
                              );
                              onVaultChanged?.();
                            } catch (err) {
                              toast.error(friendlyErrorMessage(err));
                            } finally {
                              setCalBusy(false);
                            }
                          }}
                          className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                        >
                          <ArrowsClockwise className={`w-3.5 h-3.5 ${calBusy ? 'animate-spin' : ''}`} />
                          <span>{calBusy ? 'Синхронизирую…' : 'Синхронизировать сейчас'}</span>
                        </button>
                      </div>
                    ) : (
                      <>
                        {calStatus?.builtInOAuthAvailable && !calStatus.connected ? (
                          <div className="flex items-center justify-between gap-2 pb-1">
                            <span className="text-[12px] text-[var(--k-ink-secondary)]">
                              Двусторонняя синхронизация встреч в один клик:
                            </span>
                            <button
                              type="button"
                              disabled={calBusy}
                              onClick={async () => {
                                setCalBusy(true);
                                try {
                                  const st = await window.kapsula.connectGoogleCalendar();
                                  setCalStatus(st);
                                  toast.success('Google Календарь подключён');
                                  onVaultChanged?.();
                                } catch (err) {
                                  toast.error(friendlyErrorMessage(err));
                                } finally {
                                  setCalBusy(false);
                                }
                              }}
                              className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                            >
                              {calBusy ? 'Открываю браузер…' : 'Подключить Google Календарь'}
                            </button>
                          </div>
                        ) : null}

                        <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                          Подключение по <strong>секретной ссылке календаря (.ics)</strong> из настроек Google Календаря:
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
                                toast.success(`Загружено событий: ${res.imported}`);
                              } catch (err) {
                                toast.error(friendlyErrorMessage(err));
                              } finally {
                                setCalBusy(false);
                              }
                            }}
                            className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default"
                          >
                            Синхронизировать
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
                            <span>Свой идентификатор клиента (необязательно)</span>
                          </button>
                          {showCustomGcalClient ? (
                            <div className="flex items-center gap-2 mt-2">
                              <input
                                value={gcalClientIdDraft}
                                onChange={(e) => setGcalClientIdDraft(e.target.value)}
                                placeholder="Свой идентификатор приложения Google…"
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
                                    toast.success('Google Календарь подключён');
                                  } catch (err) {
                                    toast.error(friendlyErrorMessage(err));
                                  } finally {
                                    setCalBusy(false);
                                  }
                                }}
                                className="k-interactive h-8 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] text-[12px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default shrink-0"
                              >
                                Войти через браузер
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
                            const r = await window.kapsula.importCalendarIcs();
                            if (r.imported > 0) {
                              toast.success(`Импортировано событий: ${r.imported}`);
                              onVaultChanged?.();
                            }
                          }}
                          className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] cursor-pointer"
                        >
                          <UploadSimple className="w-3.5 h-3.5" />
                          <span>Импорт .ics</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const r = await window.kapsula.exportCalendarIcs();
                            if (r.path) toast.success(`Экспортировано событий: ${r.exported}`);
                          }}
                          className="k-interactive inline-flex items-center gap-1 h-7.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[11.5px] cursor-pointer"
                        >
                          <DownloadSimple className="w-3.5 h-3.5" />
                          <span>Экспорт .ics</span>
                        </button>
                      </div>
                      {calStatus?.connected ? (
                        <button
                          type="button"
                          onClick={async () => {
                            const st = await window.kapsula.disconnectGoogleCalendar();
                            setCalStatus(st);
                            setGcalIcalDraft('');
                            setShowGcalSetup(false);
                            toast.success('Календарь отключён');
                          }}
                          className="k-interactive h-7.5 px-2.5 rounded-lg text-[12px] text-[var(--k-danger)] cursor-pointer"
                        >
                          Отключить
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowGcalSetup(false)}
                          className="k-interactive h-7.5 px-2.5 rounded-lg text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          Свернуть
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 2. Browser Extension + 3-step install + live port + 1-click Bookmarklet */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Browser weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">Расширение для браузера</span>
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
                      ? `Локальный приёмник активен (порт ${settings.clipperPort})`
                      : 'Локальный приёмник выключен'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11.5px] text-[var(--k-ink-secondary)]">
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">1.</strong> Открой папку расширения кнопкой ниже
                  </div>
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">2.</strong> В Chrome / Edge открой «Расширения» → «Режим разработчика»
                  </div>
                  <div className="rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-2.5 py-2">
                    <strong className="text-[var(--k-ink-primary)]">3.</strong> Нажми «Загрузить распакованное» и выбери эту папку
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void window.kapsula.openExtensionFolder()}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Открыть папку расширения</span>
                    <ArrowSquareOut className="w-3 h-3 opacity-80" />
                  </button>
                  <button
                    type="button"
                    data-testid="copy-bookmarklet-btn"
                    onClick={async () => {
                      const code = buildBookmarkletCode(settings.clipperPort, settings.clipperToken);
                      await window.kapsula.copyText(code);
                      setCopiedBookmarklet(true);
                      toast.success('Букмарклет скопирован — вставь его в закладки браузера');
                      window.setTimeout(() => setCopiedBookmarklet(false), 2000);
                    }}
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] text-[12px] font-medium cursor-pointer"
                  >
                    {copiedBookmarklet ? (
                      <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-emerald)]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedBookmarklet ? 'Скопировано' : 'Скопировать букмарклет'}</span>
                  </button>
                </div>
              </div>

              {/* 3. Email -> Kapsula (local .eml import — unlaunched inbound forwarding hidden cleanly) */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <EnvelopeSimple weight="duotone" className="w-4.5 h-4.5 text-[var(--k-accent)]" />
                    <span className="text-[13.5px] font-semibold">Почта → Kapsula</span>
                  </div>
                  <button
                    type="button"
                    data-testid="import-eml-btn"
                    disabled={importBusy === 'eml'}
                    onClick={() =>
                      void runImport(
                        'eml',
                        () => window.kapsula.importEmlFiles(),
                        'Новых писем для импорта не найдено'
                      )
                    }
                    className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                  >
                    <UploadSimple className="w-3.5 h-3.5" />
                    <span>{importBusy === 'eml' ? 'Импортирую…' : 'Импортировать письма (.eml)'}</span>
                  </button>
                </div>

                <div className="text-[12px] text-[var(--k-ink-secondary)]">
                  Файлы писем <span className="k-mono text-[11.5px]">.eml</span> можно также просто перетащить прямо в поле быстрого ввода — тема, текст и вложения сохранятся аккуратной заметкой.
                </div>
              </div>

              {/* 4. Import from other apps: Obsidian/Markdown, Notion (.zip), Chat/Notes Archives */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold">Импорт из других приложений</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Перенеси существующие базы заметок с сохранением структуры разделов и тегов
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
                        'В выбранной папке не найдено новых Markdown-заметок'
                      )
                    }
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <BookOpen weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'markdown' ? 'Импортирую…' : 'Obsidian / Markdown'}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      Папка с .md файлами, тегами и картинками
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
                        'В архиве Notion не найдено новых страниц'
                      )
                    }
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <FileArchive weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'notion' ? 'Импортирую…' : 'Notion (.zip)'}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      Экспорт пространства Notion в формате Markdown & CSV
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
                          `Импортировано: ${r.imported} (пропущено дублей: ${r.skippedDuplicates})`
                        );
                        onVaultChanged?.();
                      } catch (err) {
                        toast.error(friendlyErrorMessage(err));
                      } finally {
                        setImportBusy(null);
                      }
                    }}
                    className="k-interactive flex flex-col items-start gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] hover:border-[var(--k-border-strong)] p-3 text-left cursor-pointer disabled:opacity-55"
                  >
                    <FileText weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                    <div className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                      {importBusy === 'archive' ? 'Импортирую…' : 'Архивы чатов и заметок'}
                    </div>
                    <div className="text-[11px] text-[var(--k-ink-muted)] leading-snug">
                      Выгрузки сохранённых записей в HTML или JSON
                    </div>
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {/* 6. ДАННЫЕ */}
          {tab === 'data' ? (
            <>
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-medium">Локальное хранилище</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular mt-0.5">
                    {storageInfo
                      ? `Записей: ${storageInfo.itemCount} · Вложений: ${storageInfo.mediaFilesCount} · Занято: ${
                          storageInfo.totalBytes < 1024 * 1024
                            ? `${Math.max(1, Math.round(storageInfo.totalBytes / 1024))} КБ`
                            : `${(storageInfo.totalBytes / (1024 * 1024)).toFixed(1)} МБ`
                        }`
                      : 'Загружаю статистику хранилища…'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void window.kapsula.openDataFolder()}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] cursor-pointer shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Открыть папку</span>
                </button>
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-medium">Экспорт в Markdown + медиа (.zip)</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5">
                    Выгрузить все заметки в чистые файлы .md с картинками и вложениями — открывается в любом редакторе
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
                        toast.success(`Экспортировано заметок: ${res.count ?? 0}`);
                      } else if (res.error) {
                        toast.error(res.error);
                      }
                    } catch (err) {
                      toast.error(friendlyErrorMessage(err, 'Не удалось экспортировать архив.'));
                    } finally {
                      setExportingMdZip(false);
                    }
                  }}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                >
                  <FileArchive className="w-3.5 h-3.5" />
                  <span>{exportingMdZip ? 'Собираю архив…' : 'Экспорт Markdown (.zip)'}</span>
                </button>
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13.5px] font-medium">Резервная копия (JSON)</div>
                    <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5">
                      Сохранить или восстановить заметки, разделы, холсты и календарь. Записи из Сейфа остаются зашифрованными.
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
                              `Восстановлено записей: ${res.importedCount}${
                                res.skippedCount > 0 ? ` · пропущено: ${res.skippedCount}` : ''
                              }`
                            );
                            onVaultChanged?.();
                            window.kapsula.getStorageSummary().then(setStorageInfo).catch(() => {});
                          }
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, 'Не удалось восстановить копию.'));
                        } finally {
                          setRestoringBackup(false);
                        }
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium hover:bg-[var(--k-bg-surface-3)] cursor-pointer disabled:opacity-60"
                    >
                      <UploadSimple className="w-3.5 h-3.5" />
                      <span>{restoringBackup ? 'Восстанавливаю…' : 'Восстановить из копии'}</span>
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
                              `Резервная копия сохранена (${pluralRu(res.itemCount, 'запись', 'записи', 'записей')})`
                            );
                          }
                        } catch (err) {
                          toast.error(friendlyErrorMessage(err, 'Не удалось сохранить резервную копию.'));
                        } finally {
                          setExportingBackup(false);
                        }
                      }}
                      className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] font-medium hover:border-[var(--k-border-strong)] cursor-pointer disabled:opacity-60"
                    >
                      <DownloadSimple className="w-3.5 h-3.5" />
                      <span>{exportingBackup ? 'Сохраняю…' : 'Сохранить копию'}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Автопревью ссылок</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Автоматически загружать заголовки, описания и обложки для сохранённых веб-страниц
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.enableUrlUnfurl}
                  onCheckedChange={(enableUrlUnfurl) => void patch({ enableUrlUnfurl })}
                />
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3.5 text-[12px] text-[var(--k-ink-secondary)] leading-relaxed">
                Все заметки, картинки, голосовые записи и зашифрованные данные Сейфа хранятся локально на этом компьютере — приложение работает даже без интернета.
              </div>
            </>
          ) : null}

          {/* 7. КЛАВИШИ */}
          {tab === 'shortcuts' ? (
            <>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Быстрая панель поверх всех окон</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Поиск, быстрые заметки, Сейф и задачи из любого приложения
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
                  <div className="text-[13.5px] font-medium">Мгновенно сохранить из буфера</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Быстрый перехват текста, ссылки или картинки из буфера обмена
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
                  <div className="text-[13.5px] font-medium">Запускать при старте системы</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Чтобы горячие клавиши и напоминания работали сразу после входа
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.launchAtLogin}
                  onCheckedChange={(launchAtLogin) => void patch({ launchAtLogin })}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
                <div>
                  <div className="text-[13.5px] font-medium">Тихие тактильные звуки</div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)]">
                    Мягкий отклик при сохранении и копировании
                  </div>
                </div>
                <SwitchToggle
                  checked={settings.soundTickEnabled}
                  onCheckedChange={(soundTickEnabled) => void patch({ soundTickEnabled })}
                />
              </div>

              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 space-y-2">
                <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                  Основные сочетания внутри окна
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                  {[
                    [isMac ? '⌘ F' : 'Ctrl + F', 'Поиск по всем записям'],
                    [isMac ? '⌘ N' : 'Ctrl + N', 'Новая заметка'],
                    ['Пробел', 'Быстрый просмотр карточки'],
                    ['Esc', 'Закрыть панель или снять выбор'],
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
        </div>

        {/* Always-accessible About, Cloud Updates & Safe Diagnostics bar */}
        <div
          data-testid="settings-about-footer"
          className="pt-3 border-t border-[var(--k-border-hairline)] flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
              <span className="text-[12.5px] font-semibold text-[var(--k-ink-primary)] k-tabular">
                Kapsula v{updaterState?.currentVersion ?? '1.0.1'}
              </span>
              {updaterState?.status === 'checking' ? (
                <span className="text-[11.5px] text-[var(--k-ink-muted)]">Проверяю обновления…</span>
              ) : updaterState?.status === 'available' && updaterState.latestVersion ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11px] font-medium k-tabular">
                  Доступна v{updaterState.latestVersion}
                </span>
              ) : updaterState?.status === 'downloading' ? (
                <span className="text-[11.5px] text-[var(--k-accent)] font-medium k-tabular">
                  Загружаю обновление… {updaterState.percent ?? 0}%
                </span>
              ) : updaterState?.status === 'downloaded' ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] text-[11px] font-medium">
                  Обновление готово к установке
                </span>
              ) : updaterState?.status === 'up-to-date' ? (
                <span className="text-[11.5px] text-[var(--k-emerald)]">Актуальная версия</span>
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
                  <span>Перезапустить и обновить</span>
                </button>
              ) : updaterState?.status === 'available' ? (
                <button
                  type="button"
                  data-testid="settings-download-update-btn"
                  onClick={() => void handleDownloadOrInstallUpdate()}
                  className="k-interactive inline-flex items-center gap-1.5 h-7.5 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer"
                >
                  <DownloadSimple className="w-3.5 h-3.5" />
                  <span>{isMac ? 'Скачать образ для Mac' : 'Скачать обновление'}</span>
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
                  <span>Проверить обновления</span>
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
                <span>{diagCopying ? 'Собираю…' : 'Скопировать диагностику'}</span>
              </button>
            </div>
          </div>

          {updaterState?.status === 'downloading' ? (
            <div className="h-1.5 rounded-full bg-[var(--k-bg-surface-3)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--k-accent)] transition-all duration-200"
                style={{ width: `${Math.max(4, Math.min(100, updaterState.percent ?? 0))}%` }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
};
