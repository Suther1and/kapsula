import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Switch } from '@base-ui/react/switch';
import { motion, useReducedMotion } from 'motion/react';
import {
  Archive,
  ArrowCircleUp,
  ArrowCounterClockwise,
  ArrowsClockwise,
  Check,
  ClipboardText,
  CloudCheck,
  CloudSlash,
  Copy,
  Desktop,
  DeviceMobile,
  Fingerprint,
  FolderSimple,
  Key,
  Laptop,
  LockKey,
  Moon,
  Palette,
  PencilSimple,
  Plus,
  Rows,
  ShieldCheck,
  SignOut,
  Sparkle,
  Sun,
  Swatches,
  Timer,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import {
  ACCENT_PRESETS,
  DARK_BG_PRESETS,
  DEFAULT_APPEARANCE_CONFIG,
  hexToHsl,
  hslToHex,
  LIGHT_BG_PRESETS,
  normalizeHex,
} from '@shared/color-engine';
import { SECTION_COLOR_PALETTE } from '@shared/constants';
import type { SyncStatus } from '@shared/sync-contract';
import type {
  AiProvider,
  AppearanceConfig,
  FocusBoard,
  OrbitDef,
  ThemeMode,
  VaultItem,
} from '@shared/types';
import { formatRelativeDate, getDnaHumanLabel } from '@renderer/lib/format';
import {
  fetchMobileCloudAiQuota,
  formatUsdRu,
  type MobileCloudAiQuota,
} from '../lib/mobile-ai';
import { formatSyncTimeLabel, pluralRu } from '../lib/mobile-helpers';
import type { MobileUpdateCheckResult } from '../lib/mobile-updater';
import { mobileBridge, type NativeAppVersion } from '../native/bridge';
import type { MobileAiConfig } from '../storage/mobile-store';
import type { MobileSyncEngine } from '../sync/mobile-sync-engine';
import { BottomSheet } from './BottomSheet';

const GoogleBrandIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4 shrink-0' }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.27 14.29A7.12 7.12 0 0 1 4.9 12c0-.8.14-1.57.37-2.29V6.62H1.29A11.99 11.99 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
    />
  </svg>
);

interface SettingsCloudSheetProps {
  open: boolean;
  initialSection?: 'cloud' | 'appearance' | 'structure';
  isExpanded: boolean;
  keyboardOpen?: boolean;
  hingeRightOffsetPx?: number;
  theme: ThemeMode;
  appearance: AppearanceConfig;
  biometricEnabled: boolean;
  hasMasterPin: boolean;
  vaultLocked?: boolean;
  autoLockMinutes: number;
  wipeSeconds: number;
  aiConfig: MobileAiConfig;
  syncStatus: SyncStatus;
  syncEngine: MobileSyncEngine;
  appVersion: NativeAppVersion;
  updateInfo: MobileUpdateCheckResult | null;
  updateChecking: boolean;
  updateDownloadPercent: number | null;
  updateInstalling: boolean;
  orbits: OrbitDef[];
  boards: FocusBoard[];
  trashedItems: VaultItem[];
  archivedItems: VaultItem[];
  onClose: () => void;
  onChangeTheme: (theme: ThemeMode) => void;
  onChangeAppearance: (patch: Partial<AppearanceConfig>) => void;
  onChangeBiometric: (enabled: boolean) => void;
  onSetMasterPin: (pin: string, currentPin?: string) => Promise<void>;
  onRemoveMasterPin: (currentPin?: string) => Promise<void>;
  onChangeAutoLockMinutes: (minutes: number) => void;
  onChangeWipeSeconds: (sec: number) => void;
  onSaveAiConfig: (patch: {
    provider?: AiProvider;
    googleKey?: string | null;
    openrouterKey?: string | null;
  }) => Promise<void>;
  onCheckUpdates: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onCopyDiagnostics: () => Promise<void>;
  onCreateOrbit: (name: string, color: string) => Promise<void>;
  onUpdateOrbit: (id: string, patch: { name?: string; color?: string }) => Promise<void>;
  onDeleteOrbit: (id: string) => Promise<void>;
  onCreateBoard: (name: string, color: string) => Promise<void>;
  onUpdateBoard: (id: string, patch: { name?: string; color?: string }) => Promise<void>;
  onDeleteBoard: (id: string) => Promise<void>;
  onRestoreTrashedItem: (id: string) => Promise<void>;
  onPurgeTrashedItem: (id: string) => Promise<void>;
  onEmptyTrash: () => Promise<number>;
  onUnarchiveItem: (id: string) => Promise<void>;
  onSensitiveOverlayChange?: (visible: boolean) => void;
}

const AUTO_LOCK_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1 мин' },
  { value: 5, label: '5 мин' },
  { value: 15, label: '15 мин' },
  { value: 30, label: '30 мин' },
  { value: 0, label: 'Выкл' },
];

function evaluatePassphraseStrength(pass: string): {
  score: number;
  label: string;
  color: string;
} {
  const clean = pass.trim();
  if (!clean) return { score: 0, label: '', color: 'var(--k-ink-muted)' };
  let score = 0;
  if (clean.length >= 10) score += 1;
  if (clean.length >= 14) score += 1;
  if (/[A-ZА-Я]/.test(clean) && /[a-zа-я]/.test(clean)) score += 1;
  if (/\d/.test(clean) || /[^a-zA-Zа-яА-Я0-9\s]/.test(clean)) score += 1;
  if (clean.length < 10) {
    return {
      score: 1,
      label: `Ещё ${10 - clean.length} симв.`,
      color: 'var(--k-danger)',
    };
  }
  if (score <= 2) return { score: 2, label: 'Нормальная', color: 'var(--k-amber)' };
  if (score === 3) return { score: 3, label: 'Хорошая', color: 'var(--k-emerald)' };
  return { score: 4, label: 'Надёжная', color: 'var(--k-emerald)' };
}

export const SettingsCloudSheet: React.FC<SettingsCloudSheetProps> = ({
  open,
  initialSection = 'cloud',
  isExpanded,
  keyboardOpen = false,
  hingeRightOffsetPx = 0,
  theme,
  appearance,
  biometricEnabled,
  hasMasterPin,
  vaultLocked = false,
  autoLockMinutes,
  wipeSeconds,
  aiConfig,
  syncStatus,
  syncEngine,
  appVersion,
  updateInfo,
  updateChecking,
  updateDownloadPercent,
  updateInstalling,
  orbits,
  boards,
  trashedItems,
  archivedItems,
  onClose,
  onChangeTheme,
  onChangeAppearance,
  onChangeBiometric,
  onSetMasterPin,
  onRemoveMasterPin,
  onChangeAutoLockMinutes,
  onChangeWipeSeconds,
  onSaveAiConfig,
  onCheckUpdates,
  onInstallUpdate,
  onCopyDiagnostics,
  onCreateOrbit,
  onUpdateOrbit,
  onDeleteOrbit,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onRestoreTrashedItem,
  onPurgeTrashedItem,
  onEmptyTrash,
  onUnarchiveItem,
  onSensitiveOverlayChange,
}) => {
  const prefersReduced = useReducedMotion();
  const [section, setSection] = useState<'cloud' | 'appearance' | 'structure'>(initialSection);

  useEffect(() => {
    if (open && initialSection) {
      setSection(initialSection);
    }
  }, [open, initialSection]);

  // Auth / E2EE forms
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState(syncStatus.email || '');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [unlockMode, setUnlockMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [newPassAfterRecovery, setNewPassAfterRecovery] = useState('');
  const [shownRecoveryKey, setShownRecoveryKey] = useState<string | null>(null);
  const [showChangePass, setShowChangePass] = useState(false);
  const [curPassphrase, setCurPassphrase] = useState('');
  const [nextPassphrase, setNextPassphrase] = useState('');
  const [showCustomServer, setShowCustomServer] = useState(false);
  const [customUrl, setCustomUrl] = useState(
    syncStatus.hasCustomServer ? syncStatus.supabaseUrl : ''
  );
  const [customKey, setCustomKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [cloudAiQuota, setCloudAiQuota] = useState<MobileCloudAiQuota | null>(null);
  const [cloudAiQuotaLoading, setCloudAiQuotaLoading] = useState(false);

  // Custom color editor state
  const [hexDraft, setHexDraft] = useState(appearance.accentHex || '#E86A33');
  const [showBgSliders, setShowBgSliders] = useState(appearance.bgPreset === 'custom');

  useEffect(() => {
    if (appearance.accentHex) {
      setHexDraft(appearance.accentHex.toUpperCase());
    }
  }, [appearance.accentHex]);

  // Master PIN form state
  const [pinEditorOpen, setPinEditorOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinSaving, setPinSaving] = useState(false);

  // AI provider setup state
  const [aiProviderDraft, setAiProviderDraft] = useState<AiProvider>(aiConfig.provider);
  const [aiKeyDraft, setAiKeyDraft] = useState('');
  const [aiSaving, setAiSaving] = useState(false);

  useEffect(() => {
    setAiProviderDraft(aiConfig.provider);
  }, [aiConfig.provider]);

  const isCloudAccountSignedIn =
    syncStatus.state !== 'signed_out' && syncStatus.state !== 'awaiting_email_confirm';

  useEffect(() => {
    if (!open || section !== 'appearance' || !isCloudAccountSignedIn) return;
    let cancelled = false;
    setCloudAiQuotaLoading(true);
    void fetchMobileCloudAiQuota(syncEngine)
      .then((quota) => {
        if (!cancelled) setCloudAiQuota(quota);
      })
      .finally(() => {
        if (!cancelled) setCloudAiQuotaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, section, isCloudAccountSignedIn, syncEngine]);

  // Clear sensitive transient fields whenever settings sheet closes
  useEffect(() => {
    if (!open) {
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setPinEditorOpen(false);
      setShownRecoveryKey(null);
    }
  }, [open]);

  // Trash & Archive state
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  const [trashBusyId, setTrashBusyId] = useState<string | null>(null);
  const [archiveBusyId, setArchiveBusyId] = useState<string | null>(null);

  const emailTouchedRef = useRef(false);

  useEffect(() => {
    if (syncStatus.email && !emailTouchedRef.current) {
      setEmail(syncStatus.email);
    }
  }, [syncStatus.email]);

  useEffect(() => {
    onSensitiveOverlayChange?.(open && Boolean(shownRecoveryKey));
    return () => {
      onSensitiveOverlayChange?.(false);
    };
  }, [open, shownRecoveryKey, onSensitiveOverlayChange]);

  // Orbits / Boards forms & inline editing
  const [newOrbitName, setNewOrbitName] = useState('');
  const [newOrbitColor, setNewOrbitColor] = useState(SECTION_COLOR_PALETTE[0]!);
  const [editingOrbitId, setEditingOrbitId] = useState<string | null>(null);
  const [editOrbitName, setEditOrbitName] = useState('');
  const [editOrbitColor, setEditOrbitColor] = useState(SECTION_COLOR_PALETTE[0]!);

  const [newBoardName, setNewBoardName] = useState('');
  const [newBoardColor, setNewBoardColor] = useState(SECTION_COLOR_PALETTE[4]!);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [editBoardName, setEditBoardName] = useState('');
  const [editBoardColor, setEditBoardColor] = useState(SECTION_COLOR_PALETTE[4]!);

  const setupStrength = useMemo(() => evaluatePassphraseStrength(passphrase), [passphrase]);
  const changeStrength = useMemo(() => evaluatePassphraseStrength(nextPassphrase), [nextPassphrase]);

  const currentAccentHue = useMemo(() => {
    if (appearance.accentMode === 'custom') {
      return Math.round(hexToHsl(appearance.accentHex || '#E86A33').h);
    }
    const preset = ACCENT_PRESETS.find((p) => p.id === appearance.accentPreset);
    return Math.round(hexToHsl(preset?.swatchDark || '#E86A33').h);
  }, [appearance.accentMode, appearance.accentHex, appearance.accentPreset]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res =
        authMode === 'signin'
          ? await syncEngine.signIn(email, password)
          : await syncEngine.signUp(email, password);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось войти');
      } else if (res.needsEmailConfirmation) {
        toast.info('Проверь почту и подтверди аккаунт, затем войди снова');
      } else {
        setPassword('');
        toast.success('Вход выполнен');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    mobileBridge.haptic('light');
    setGoogleBusy(true);
    try {
      const res = await syncEngine.signInWithGoogle();
      if (!res.ok) {
        toast.error(res.error || 'Не удалось войти через Google');
      } else {
        toast.info('Выбери аккаунт Google в открывшемся окне');
      }
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleSetupPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passphrase.trim().length < 10) {
      toast.error('Секретная фраза должна содержать не менее 10 символов');
      return;
    }
    if (passphrase !== passphraseConfirm) {
      toast.error('Секретные фразы не совпадают');
      return;
    }
    setBusy(true);
    try {
      const res = await syncEngine.setupPassphrase(passphrase);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось настроить шифрование');
      } else {
        setPassphrase('');
        setPassphraseConfirm('');
        if (res.recoveryKey) {
          setShownRecoveryKey(res.recoveryKey);
        }
        toast.success('Сквозное шифрование настроено');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      unlockMode === 'recovery' &&
      newPassAfterRecovery.trim().length > 0 &&
      newPassAfterRecovery.trim().length < 10
    ) {
      toast.error('Новая секретная фраза должна быть не короче 10 символов');
      return;
    }
    setBusy(true);
    try {
      const res =
        unlockMode === 'passphrase'
          ? await syncEngine.unlockWithPassphrase(passphrase)
          : await syncEngine.unlockWithRecoveryKey(
              recoveryInput,
              newPassAfterRecovery.trim() || undefined
            );
      if (!res.ok) {
        toast.error(res.error || 'Не удалось расшифровать хранилище');
      } else {
        setPassphrase('');
        setRecoveryInput('');
        setNewPassAfterRecovery('');
        toast.success('Облако подключено и синхронизировано');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleManualSync = async () => {
    setBusy(true);
    try {
      const res = await syncEngine.syncNow();
      if (res.ok) {
        toast.success(
          `Синхронизировано (получено ${res.pulled ?? 0}, отправлено ${res.pushed ?? 0})`
        );
      } else if (res.error) {
        toast.error(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFullReconcile = async () => {
    setReconciling(true);
    try {
      const res = await syncEngine.reconcileFull();
      if (res.ok) {
        mobileBridge.haptic('success');
        toast.success(
          `Сверка завершена (получено ${res.pulled ?? 0}, отправлено ${res.pushed ?? 0})`
        );
      } else if (res.error) {
        toast.error(res.error);
      }
    } finally {
      setReconciling(false);
    }
  };

  const handleCopyRecovery = async () => {
    if (!shownRecoveryKey) return;
    await mobileBridge.copySensitive(shownRecoveryKey, 60, true);
    toast.success('Резервный ключ скопирован · буфер очистится через 60 с');
  };

  const handleSaveMasterPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasMasterPin && !currentPin.trim()) {
      mobileBridge.haptic('error');
      toast.error('Введи текущий мастер-ПИН');
      return;
    }
    const clean = newPin.trim();
    if (clean.length < 4) {
      toast.error('Мастер-ПИН должен быть не короче 4 символов');
      return;
    }
    if (clean !== confirmPin.trim()) {
      toast.error('ПИНы не совпадают');
      return;
    }
    setPinSaving(true);
    try {
      await onSetMasterPin(clean, hasMasterPin ? currentPin.trim() : undefined);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setPinEditorOpen(false);
      mobileBridge.haptic('success');
      toast.success(hasMasterPin ? 'Мастер-ПИН обновлён' : 'Мастер-ПИН установлен');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось сохранить мастер-ПИН');
    } finally {
      setPinSaving(false);
    }
  };

  const handleRemoveMasterPinClick = async () => {
    if (hasMasterPin && !currentPin.trim()) {
      mobileBridge.haptic('error');
      toast.error('Введи текущий мастер-ПИН, чтобы убрать защиту');
      return;
    }
    setPinSaving(true);
    try {
      await onRemoveMasterPin(hasMasterPin ? currentPin.trim() : undefined);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setPinEditorOpen(false);
      mobileBridge.haptic('success');
      toast('Мастер-ПИН удалён');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось убрать мастер-ПИН');
    } finally {
      setPinSaving(false);
    }
  };

  const handleSaveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setAiSaving(true);
    try {
      const cleanKey = aiKeyDraft.trim();
      await onSaveAiConfig({
        provider: aiProviderDraft,
        ...(aiProviderDraft === 'google_ai_studio' && cleanKey ? { googleKey: cleanKey } : {}),
        ...(aiProviderDraft === 'openrouter' && cleanKey ? { openrouterKey: cleanKey } : {}),
      });
      setAiKeyDraft('');
      mobileBridge.haptic('success');
      toast.success(
        aiProviderDraft === 'local'
          ? isCloudAccountSignedIn
            ? 'Включён встроенный ИИ Kapsula'
            : 'Настройки ИИ сохранены'
          : 'Настройки ИИ сохранены'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось сохранить настройки ИИ');
    } finally {
      setAiSaving(false);
    }
  };

  const deviceIcon = (platform: string) => {
    if (platform === 'android' || platform === 'ios') return DeviceMobile;
    if (platform === 'darwin') return Laptop;
    return Desktop;
  };

  const paletteSwatches = SECTION_COLOR_PALETTE.slice(0, 16);
  const bgPresets = theme === 'dark' ? DARK_BG_PRESETS : LIGHT_BG_PRESETS;
  const activeBgPreset = appearance.bgPreset;
  const activeBgHue = appearance.bgHue;
  const activeBgTint = appearance.bgTint;
  const activeBgLightness = appearance.bgLightness;
  const currentProviderHasKey =
    aiProviderDraft === 'google_ai_studio'
      ? aiConfig.hasGoogleKey
      : aiProviderDraft === 'openrouter'
        ? aiConfig.hasOpenRouterKey
        : false;
  const anyAiKeySaved = aiConfig.hasGoogleKey || aiConfig.hasOpenRouterKey;

  const cloudFooter =
    section === 'cloud' &&
    (syncStatus.state === 'signed_out' || syncStatus.state === 'awaiting_email_confirm') ? (
      <div className="px-4 py-2.5">
        <button
          type="submit"
          form="k-cloud-auth-form"
          data-testid="cloud-auth-submit"
          disabled={busy}
          className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold disabled:opacity-50"
        >
          {busy
            ? 'Подключаю…'
            : authMode === 'signin'
              ? 'Войти в облако'
              : 'Создать аккаунт'}
        </button>
      </div>
    ) : section === 'cloud' && syncStatus.state === 'needs_passphrase_setup' ? (
      <div className="px-4 py-2.5">
        <button
          type="submit"
          form="k-cloud-setup-form"
          data-testid="cloud-setup-submit"
          disabled={busy}
          className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold disabled:opacity-50"
        >
          {busy ? 'Создаю ключ…' : 'Включить сквозное шифрование'}
        </button>
      </div>
    ) : section === 'cloud' && syncStatus.state === 'needs_passphrase_unlock' ? (
      <div className="px-4 py-2.5">
        <button
          type="submit"
          form="k-cloud-unlock-form"
          data-testid="cloud-unlock-submit"
          disabled={busy}
          className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold disabled:opacity-50"
        >
          {busy ? 'Проверяю ключ…' : 'Расшифровать и синхронизировать'}
        </button>
      </div>
    ) : undefined;

  return (
    <BottomSheet
      open={open}
      title="Облако и настройки"
      subtitle={
        syncStatus.email
          ? `${syncStatus.email} · ${syncStatus.deviceName}`
          : syncStatus.deviceName
      }
      isExpanded={isExpanded}
      hingeRightOffsetPx={hingeRightOffsetPx}
      maxWidthClass="max-w-xl"
      onClose={onClose}
      footer={cloudFooter}
    >
      <div
        data-testid="settings-cloud-sheet"
        className={keyboardOpen ? 'p-3 space-y-2.5' : 'p-4 space-y-4'}
      >
        {/* Animated Segmented Tabs */}
        <div className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
          {(
            [
              { id: 'cloud', label: 'Облако' },
              { id: 'appearance', label: 'Вид и Сейф' },
              {
                id: 'structure',
                label: trashedItems.length > 0 ? `Разделы · ${trashedItems.length}` : 'Разделы',
              },
            ] as const
          ).map((t) => {
            const active = section === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`settings-tab-${t.id}`}
                onClick={() => {
                  mobileBridge.haptic('light');
                  setSection(t.id);
                }}
                className={`relative ${keyboardOpen ? 'py-1.5' : 'py-2'} rounded-xl text-[12.5px] font-semibold transition-colors ${
                  active ? 'text-[var(--k-ink-primary)]' : 'text-[var(--k-ink-muted)]'
                }`}
              >
                {active ? (
                  <motion.span
                    layoutId="k-settings-section-pill"
                    transition={
                      prefersReduced
                        ? { duration: 0.01 }
                        : { type: 'spring', stiffness: 480, damping: 35 }
                    }
                    className="absolute inset-0 rounded-xl bg-[var(--k-bg-surface-1)] shadow-xs"
                  />
                ) : null}
                <span className="relative z-10">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* ==================== CLOUD SYNC TAB ==================== */}
        {section === 'cloud' ? (
          <div className={keyboardOpen ? 'space-y-2.5' : 'space-y-4'}>
            {shownRecoveryKey ? (
              <div className="rounded-2xl p-4 bg-[var(--k-accent-soft)] border border-[var(--k-border-focus)] space-y-3">
                <div className="flex items-center gap-2 text-[14px] font-bold text-[var(--k-ink-primary)]">
                  <Key weight="duotone" className="w-5 h-5 text-[var(--k-accent)]" />
                  Сохрани резервный ключ восстановления
                </div>
                <p className="text-[12.5px] leading-relaxed text-[var(--k-ink-secondary)]">
                  Этот ключ показывается один раз. Если забудешь секретную фразу, только он сможет
                  расшифровать твоё хранилище.
                </p>
                <div className="k-mono text-[13px] p-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] break-all text-[var(--k-ink-primary)] k-selectable">
                  {shownRecoveryKey}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyRecovery()}
                    className="k-tap flex-1 h-10 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold inline-flex items-center justify-center gap-1.5"
                  >
                    <Copy className="w-4 h-4" />
                    Скопировать ключ
                  </button>
                  <button
                    type="button"
                    onClick={() => setShownRecoveryKey(null)}
                    className="k-tap px-4 h-10 rounded-xl bg-[var(--k-bg-surface-2)] text-[13px] font-medium text-[var(--k-ink-primary)]"
                  >
                    Сохранил
                  </button>
                </div>
              </div>
            ) : null}

            {syncStatus.state === 'signed_out' ||
            syncStatus.state === 'awaiting_email_confirm' ? (
              <form
                id="k-cloud-auth-form"
                onSubmit={(e) => void handleAuthSubmit(e)}
                className={`rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] ${
                  keyboardOpen ? 'p-3 space-y-2.5' : 'p-4 space-y-3'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                    Облако Kapsula
                  </div>
                  <div className="inline-flex p-0.5 rounded-lg bg-[var(--k-bg-surface-1)] text-[11.5px] shrink-0">
                    <button
                      type="button"
                      onClick={() => setAuthMode('signin')}
                      className={`px-2.5 py-1 rounded-md font-medium ${
                        authMode === 'signin'
                          ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                          : 'text-[var(--k-ink-muted)]'
                      }`}
                    >
                      Войти
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthMode('signup')}
                      className={`px-2.5 py-1 rounded-md font-medium ${
                        authMode === 'signup'
                          ? 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
                          : 'text-[var(--k-ink-muted)]'
                      }`}
                    >
                      Создать
                    </button>
                  </div>
                </div>

                {!keyboardOpen ? (
                  <p className="text-[12.5px] leading-relaxed text-[var(--k-ink-secondary)]">
                    Войди тем же аккаунтом, что на Windows или Mac — заметки, карты Сейфа, задачи,
                    календарь и медиа синхронизируются со сквозным шифрованием.
                  </p>
                ) : null}

                {syncStatus.state === 'awaiting_email_confirm' ? (
                  <div className="rounded-xl p-2.5 bg-[var(--k-amber-soft)] text-[12px] text-[var(--k-amber)]">
                    Подтверди почту по ссылке из письма, затем нажми «Войти».
                  </div>
                ) : null}

                <button
                  type="button"
                  data-testid="cloud-google-signin-btn"
                  disabled={busy || googleBusy}
                  onClick={() => void handleGoogleSignIn()}
                  className="k-tap w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] text-[13.5px] font-semibold text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-2.5 disabled:opacity-50"
                >
                  <GoogleBrandIcon className="w-4 h-4 shrink-0" />
                  <span>{googleBusy ? 'Открываю Google…' : 'Войти через Google'}</span>
                </button>

                <div className="flex items-center gap-2.5 text-[11px] text-[var(--k-ink-muted)]">
                  <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
                  <span>или по почте</span>
                  <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
                </div>

                <input
                  type="email"
                  required
                  data-testid="cloud-email-input"
                  value={email}
                  onChange={(e) => {
                    emailTouchedRef.current = true;
                    setEmail(e.target.value);
                  }}
                  placeholder="Электронная почта"
                  className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                />
                <input
                  type="password"
                  required
                  data-testid="cloud-password-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Пароль аккаунта"
                  className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                />

                {syncStatus.error ? (
                  <div className="text-[12.5px] text-[var(--k-danger)]">{syncStatus.error}</div>
                ) : null}
              </form>
            ) : null}

            {syncStatus.state === 'needs_passphrase_setup' ? (
              <form
                id="k-cloud-setup-form"
                onSubmit={(e) => void handleSetupPassphrase(e)}
                className={`rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-focus)] ${
                  keyboardOpen ? 'p-3 space-y-2.5' : 'p-4 space-y-3'
                }`}
              >
                <div className="text-[14px] font-semibold text-[var(--k-ink-primary)]">
                  Секретная фраза шифрования
                </div>
                {!keyboardOpen ? (
                  <p className="text-[12.5px] leading-relaxed text-[var(--k-ink-secondary)]">
                    Защищает все записи и Сейф до отправки в облако. Сервер никогда не видит
                    открытый текст.
                  </p>
                ) : null}
                <input
                  type="password"
                  required
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Секретная фраза (от 10 символов)"
                  className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                />
                {passphrase.trim().length > 0 ? (
                  <div className="space-y-1">
                    <div className="grid grid-cols-4 gap-1">
                      {[1, 2, 3, 4].map((step) => (
                        <span
                          key={step}
                          className="h-1 rounded-full transition-colors"
                          style={{
                            background:
                              setupStrength.score >= step
                                ? setupStrength.color
                                : 'var(--k-border-hairline)',
                          }}
                        />
                      ))}
                    </div>
                    <div
                      className="text-[11px] font-medium text-right"
                      style={{ color: setupStrength.color }}
                    >
                      {setupStrength.label}
                    </div>
                  </div>
                ) : null}
                <input
                  type="password"
                  required
                  value={passphraseConfirm}
                  onChange={(e) => setPassphraseConfirm(e.target.value)}
                  placeholder="Повтори секретную фразу"
                  className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                />
              </form>
            ) : null}

            {syncStatus.state === 'needs_passphrase_unlock' ? (
              <form
                id="k-cloud-unlock-form"
                onSubmit={(e) => void handleUnlock(e)}
                className={`rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-focus)] ${
                  keyboardOpen ? 'p-3 space-y-2.5' : 'p-4 space-y-3'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                    Расшифровать хранилище
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setUnlockMode(unlockMode === 'passphrase' ? 'recovery' : 'passphrase')
                    }
                    className="text-[12px] text-[var(--k-accent)] font-medium shrink-0"
                  >
                    {unlockMode === 'passphrase' ? 'По ключу' : 'По фразе'}
                  </button>
                </div>

                {unlockMode === 'passphrase' ? (
                  <input
                    type="password"
                    required
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Секретная фраза с компьютера"
                    className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                  />
                ) : (
                  <>
                    <input
                      type="text"
                      required
                      value={recoveryInput}
                      onChange={(e) => setRecoveryInput(e.target.value)}
                      placeholder="KAPS-XXXX-XXXX-…"
                      className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none k-mono text-[13px] text-[var(--k-ink-primary)]"
                    />
                    <input
                      type="password"
                      value={newPassAfterRecovery}
                      onChange={(e) => setNewPassAfterRecovery(e.target.value)}
                      placeholder="Новая фраза от 10 символов (необязательно)"
                      className="w-full h-10 px-3.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
                    />
                  </>
                )}

                {syncStatus.error ? (
                  <div className="text-[12.5px] text-[var(--k-danger)]">{syncStatus.error}</div>
                ) : null}
              </form>
            ) : null}

            {syncStatus.state === 'synced' ||
            syncStatus.state === 'syncing' ||
            syncStatus.state === 'offline' ||
            syncStatus.state === 'error' ? (
              <div className="space-y-3">
                <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {syncStatus.state === 'offline' || syncStatus.state === 'error' ? (
                        <CloudSlash
                          weight="duotone"
                          className="w-6 h-6 text-[var(--k-amber)] shrink-0"
                        />
                      ) : (
                        <CloudCheck
                          weight="duotone"
                          className="w-6 h-6 text-[var(--k-emerald)] shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold text-[var(--k-ink-primary)] truncate">
                          {syncStatus.state === 'syncing'
                            ? 'Идёт синхронизация…'
                            : syncStatus.state === 'offline'
                              ? 'Работаем офлайн'
                              : syncStatus.state === 'error'
                                ? 'Ошибка синхронизации'
                                : 'Синхронизация активна'}
                        </div>
                        <div className="text-[12px] text-[var(--k-ink-muted)] truncate">
                          {formatSyncTimeLabel(syncStatus.lastSyncAt)} · в очереди{' '}
                          {syncStatus.pendingCount}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={busy || reconciling || syncStatus.state === 'syncing'}
                      onClick={() => void handleManualSync()}
                      className="k-tap inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold disabled:opacity-50 shrink-0"
                    >
                      <ArrowsClockwise
                        className={`w-4 h-4 ${syncStatus.state === 'syncing' ? 'animate-spin' : ''}`}
                      />
                      Обновить
                    </button>
                  </div>

                  {syncStatus.lastReconcileAt ? (
                    <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                      Сверка: {formatSyncTimeLabel(syncStatus.lastReconcileAt)}
                    </div>
                  ) : null}

                  {(syncStatus.failedDirtyCount ?? 0) > 0 ? (
                    <div className="flex items-center gap-2 rounded-xl p-2.5 bg-[var(--k-amber-soft)] text-[12px] text-[var(--k-amber)]">
                      <WarningCircle className="w-4 h-4 shrink-0" />
                      <span>
                        Отложенных записей: {syncStatus.failedDirtyCount}. Запусти сверку для
                        повторной отправки.
                      </span>
                    </div>
                  ) : null}

                  {syncStatus.error ? (
                    <div className="rounded-xl p-2.5 bg-[var(--k-danger-soft)] text-[12px] text-[var(--k-danger)]">
                      {syncStatus.error}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    data-testid="cloud-reconcile-full-btn"
                    disabled={busy || reconciling || syncStatus.state === 'syncing'}
                    onClick={() => void handleFullReconcile()}
                    className="k-tap w-full h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] text-[12.5px] font-medium text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <ArrowsClockwise
                      className={`w-3.5 h-3.5 text-[var(--k-accent)] ${reconciling ? 'animate-spin' : ''}`}
                    />
                    {reconciling ? 'Выполняю сверку…' : 'Сверка синхронизации'}
                  </button>

                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const res = await syncEngine.regenerateRecoveryKey();
                          if (res.ok && res.recoveryKey) {
                            setShownRecoveryKey(res.recoveryKey);
                          } else if (res.error) {
                            toast.error(res.error);
                          }
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="k-tap flex-1 min-w-[120px] h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)]"
                    >
                      Новый ключ
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowChangePass((v) => !v)}
                      className="k-tap px-3 h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)]"
                    >
                      Сменить фразу
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        await syncEngine.signOut();
                        toast('Вышел из облачного аккаунта');
                      }}
                      className="k-tap inline-flex items-center gap-1 px-3 h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-danger)]"
                    >
                      <SignOut className="w-3.5 h-3.5" />
                      Выйти
                    </button>
                  </div>

                  {showChangePass ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (nextPassphrase.trim().length < 10) {
                          toast.error('Новая секретная фраза должна быть не короче 10 символов');
                          return;
                        }
                        setBusy(true);
                        try {
                          const res = await syncEngine.changePassphrase(
                            curPassphrase,
                            nextPassphrase
                          );
                          if (res.ok) {
                            setCurPassphrase('');
                            setNextPassphrase('');
                            setShowChangePass(false);
                            toast.success('Секретная фраза обновлена');
                          } else {
                            toast.error(res.error || 'Не удалось сменить фразу');
                          }
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="pt-2.5 border-t border-[var(--k-border-hairline)] space-y-2"
                    >
                      <input
                        type="password"
                        required
                        value={curPassphrase}
                        onChange={(e) => setCurPassphrase(e.target.value)}
                        placeholder="Текущая секретная фраза"
                        className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[13px] text-[var(--k-ink-primary)]"
                      />
                      <input
                        type="password"
                        required
                        value={nextPassphrase}
                        onChange={(e) => setNextPassphrase(e.target.value)}
                        placeholder="Новая секретная фраза (от 10 символов)"
                        className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[13px] text-[var(--k-ink-primary)]"
                      />
                      {nextPassphrase.trim().length > 0 ? (
                        <div
                          className="text-[11px] font-medium text-right"
                          style={{ color: changeStrength.color }}
                        >
                          {changeStrength.label}
                        </div>
                      ) : null}
                      <button
                        type="submit"
                        disabled={busy}
                        className="k-tap w-full h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold disabled:opacity-50"
                      >
                        Сохранить новую фразу
                      </button>
                    </form>
                  ) : null}
                </div>

                {syncStatus.devices.length > 0 ? (
                  <div className="rounded-2xl p-3.5 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-2">
                    <div className="text-[12px] font-semibold text-[var(--k-ink-secondary)]">
                      Подключённые устройства ({syncStatus.devices.length})
                    </div>
                    {syncStatus.devices.map((dev) => {
                      const DevIcon = deviceIcon(dev.platform);
                      return (
                        <div
                          key={dev.deviceId}
                          className="flex items-center justify-between gap-2 py-1.5 text-[13px]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <DevIcon className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
                            <span className="text-[var(--k-ink-primary)] truncate">
                              {dev.deviceName}
                            </span>
                            {dev.isCurrent ? (
                              <span className="px-1.5 py-0.5 rounded-md bg-[var(--k-accent-soft)] text-[10.5px] font-medium text-[var(--k-accent)] shrink-0">
                                это устройство
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-2xl p-3.5 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
              <button
                type="button"
                onClick={() => setShowCustomServer((v) => !v)}
                className="w-full flex items-center justify-between gap-2 text-left text-[12.5px] font-medium text-[var(--k-ink-secondary)]"
              >
                <span className="truncate">Свой сервер облака</span>
                <span className="text-[11.5px] text-[var(--k-ink-muted)] whitespace-nowrap shrink-0">
                  {syncStatus.hasCustomServer ? 'Свой' : 'По умолчанию'}
                </span>
              </button>

              {showCustomServer ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                      await syncEngine.configureServer({
                        supabaseUrl: customUrl,
                        supabasePublishableKey: customKey,
                      });
                      setCustomKey('');
                      toast.success(
                        customUrl.trim()
                          ? 'Подключён свой облачный сервер'
                          : 'Возвращён стандартный сервер Kapsula'
                      );
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : 'Некорректные параметры сервера'
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="mt-3 space-y-2"
                >
                  <input
                    type="url"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    placeholder="Адрес облачного сервера (пусто — стандартный)"
                    className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[12.5px] text-[var(--k-ink-primary)]"
                  />
                  <input
                    type="password"
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="Публичный ключ доступа сервера"
                    className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] outline-none text-[12.5px] text-[var(--k-ink-primary)]"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="k-tap w-full h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] text-[12.5px] font-medium text-[var(--k-ink-primary)]"
                  >
                    Применить адрес сервера
                  </button>
                </form>
              ) : null}
            </div>

            {!(keyboardOpen && !isCloudAccountSignedIn) ? (
              <>
                {/* App Updates Card */}
                <div
                  data-testid="settings-updates-card"
                  className="rounded-2xl p-3.5 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ArrowCircleUp
                        weight="duotone"
                        className="w-4 h-4 text-[var(--k-accent)] shrink-0"
                      />
                      <span className="text-[13px] font-semibold text-[var(--k-ink-primary)] truncate">
                        Обновление приложения
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded-md bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[11px] font-medium text-[var(--k-ink-muted)] k-mono shrink-0">
                      v{appVersion.versionName}
                    </span>
                  </div>

                  <div className="text-[12px] leading-relaxed text-[var(--k-ink-secondary)]">
                    {updateInfo?.status === 'update_available' && updateInfo.latestVersion ? (
                      <span className="text-[var(--k-accent)] font-medium">
                        Доступна новая версия v{updateInfo.latestVersion}
                      </span>
                    ) : updateInfo?.status === 'up_to_date' ? (
                      <span>Установлена актуальная версия Kapsula</span>
                    ) : updateInfo?.status === 'error' && updateInfo.error ? (
                      <span className="text-[var(--k-amber)]">{updateInfo.error}</span>
                    ) : (
                      <span>Проверяй и устанавливай новые версии Kapsula прямо из приложения</span>
                    )}
                  </div>

                  {updateInstalling && updateDownloadPercent !== null ? (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full rounded-full bg-[var(--k-bg-surface-1)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--k-accent)] transition-[width] duration-150"
                          style={{ width: `${Math.max(4, Math.min(100, updateDownloadPercent))}%` }}
                        />
                      </div>
                      <div className="text-[11px] text-[var(--k-ink-muted)] text-right k-tabular">
                        Загрузка: {updateDownloadPercent}%
                      </div>
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2">
                    {updateInfo?.status === 'update_available' && updateInfo.apkUrl ? (
                      <>
                        <button
                          type="button"
                          data-testid="settings-install-update-btn"
                          disabled={updateInstalling}
                          onClick={() => void onInstallUpdate()}
                          className="k-tap flex-1 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold disabled:opacity-50"
                        >
                          {updateInstalling ? 'Загружаю…' : 'Обновить приложение'}
                        </button>
                        <button
                          type="button"
                          data-testid="settings-check-updates-btn"
                          disabled={updateChecking || updateInstalling}
                          onClick={() => void onCheckUpdates()}
                          aria-label="Проверить обновления"
                          className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] disabled:opacity-50 shrink-0"
                        >
                          <ArrowsClockwise
                            className={`w-4 h-4 ${updateChecking ? 'animate-spin' : ''}`}
                          />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        data-testid="settings-check-updates-btn"
                        disabled={updateChecking || updateInstalling}
                        onClick={() => void onCheckUpdates()}
                        className="k-tap w-full h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] text-[12.5px] font-medium text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <ArrowsClockwise
                          className={`w-3.5 h-3.5 text-[var(--k-accent)] ${updateChecking ? 'animate-spin' : ''}`}
                        />
                        {updateChecking ? 'Проверяю…' : 'Проверить обновления'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Safe Redacted Diagnostics */}
                <div className="rounded-2xl p-3.5 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-2">
                  <button
                    type="button"
                    data-testid="settings-copy-diagnostics-btn"
                    onClick={() => void onCopyDiagnostics()}
                    className="k-tap w-full h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-2"
                  >
                    <ClipboardText className="w-4 h-4 text-[var(--k-accent)]" />
                    Скопировать диагностику
                  </button>
                  <p className="text-[11px] leading-relaxed text-[var(--k-ink-muted)]">
                    Техническая сводка без заметок, паролей, ключей и почты — удобно для
                    обращения в поддержку.
                  </p>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {/* ==================== APPEARANCE, VAULT & AI TAB ==================== */}
        {section === 'appearance' ? (
          <div className="space-y-4">
            {/* Theme */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                Тема оформления
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="theme-dark-btn"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    onChangeTheme('dark');
                  }}
                  className={`k-tap flex items-center justify-center gap-1.5 h-11 px-2.5 rounded-xl border text-[12.5px] font-medium transition-colors ${
                    theme === 'dark'
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  <Moon weight="duotone" className="w-4 h-4 shrink-0" />
                  <span>Тёмная</span>
                </button>
                <button
                  type="button"
                  data-testid="theme-light-btn"
                  onClick={() => {
                    mobileBridge.haptic('light');
                    onChangeTheme('light');
                  }}
                  className={`k-tap flex items-center justify-center gap-1.5 h-11 px-2.5 rounded-xl border text-[12.5px] font-medium transition-colors ${
                    theme === 'light'
                      ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                      : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                  }`}
                >
                  <Sun weight="duotone" className="w-4 h-4 shrink-0" />
                  <span>Светлая</span>
                </button>
              </div>
            </div>

            {/* Accent Color: 6 Presets + Custom Hue Slider + HEX Input */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                  <Palette weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                  Акцентный цвет
                </div>
                {appearance.accentMode === 'custom' ? (
                  <button
                    type="button"
                    onClick={() =>
                      onChangeAppearance({
                        accentMode: 'preset',
                        accentPreset: DEFAULT_APPEARANCE_CONFIG.accentPreset,
                        accentHex: DEFAULT_APPEARANCE_CONFIG.accentHex,
                      })
                    }
                    className="text-[11.5px] text-[var(--k-accent)] font-medium"
                  >
                    Сбросить
                  </button>
                ) : null}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ACCENT_PRESETS.map((preset) => {
                  const active =
                    appearance.accentMode === 'preset' && appearance.accentPreset === preset.id;
                  const swatch = theme === 'light' ? preset.swatchLight : preset.swatchDark;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`accent-preset-${preset.id}`}
                      onClick={() => {
                        mobileBridge.haptic('light');
                        onChangeAppearance({
                          accentMode: 'preset',
                          accentPreset: preset.id,
                        });
                      }}
                      className={`k-tap flex items-center gap-2.5 px-3 h-10 rounded-xl border text-left transition-colors ${
                        active
                          ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                          : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                      }`}
                    >
                      <span
                        className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center shadow-xs"
                        style={{ background: swatch }}
                      >
                        {active ? <Check weight="bold" className="w-2.5 h-2.5 text-white" /> : null}
                      </span>
                      <span className="text-[12.5px] font-medium whitespace-nowrap">
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Custom Accent Hue + HEX */}
              <div className="pt-2 border-t border-[var(--k-border-hairline)] space-y-2">
                <div className="flex items-center justify-between text-[11.5px] text-[var(--k-ink-secondary)]">
                  <span>Свой оттенок</span>
                  <span className="k-mono text-[var(--k-ink-muted)]">{currentAccentHue}°</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={currentAccentHue}
                  aria-label="Оттенок акцента"
                  onChange={(e) => {
                    const hue = Number(e.target.value);
                    const hex = hslToHex(hue, 76, theme === 'dark' ? 58 : 48);
                    setHexDraft(hex.toUpperCase());
                    onChangeAppearance({ accentMode: 'custom', accentHex: hex });
                  }}
                  className="k-hue-slider w-full block"
                />
                <div className="flex items-center gap-2">
                  <span
                    className="w-7 h-7 rounded-lg border border-[var(--k-border-strong)] shrink-0"
                    style={{ background: 'var(--k-accent)' }}
                  />
                  <input
                    type="text"
                    value={hexDraft}
                    maxLength={7}
                    aria-label="HEX-код акцента"
                    onChange={(e) => {
                      const v = e.target.value;
                      setHexDraft(v);
                      const norm = normalizeHex(v);
                      if (norm) {
                        onChangeAppearance({ accentMode: 'custom', accentHex: norm });
                      }
                    }}
                    placeholder="#E86A33"
                    className="flex-1 h-8 px-2.5 rounded-lg bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[12.5px] text-[var(--k-ink-primary)]"
                  />
                </div>
              </div>
            </div>

            {/* Background Surface Presets & Custom Hue/Tint/Lightness */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="flex items-center justify-between gap-1.5 min-w-0">
                <div className="text-[13px] font-semibold text-[var(--k-ink-primary)] whitespace-nowrap shrink-0">
                  Фон и поверхности
                </div>
                <div className="flex items-center gap-0.5 shrink-0 -mr-1.5">
                  <button
                    type="button"
                    data-testid="bg-fine-tune-toggle"
                    onClick={() => setShowBgSliders((v) => !v)}
                    className="k-tap min-h-[34px] px-1.5 rounded-lg inline-flex items-center whitespace-nowrap text-[11.5px] text-[var(--k-accent)] font-medium"
                  >
                    {showBgSliders ? 'Свернуть' : 'Тонкая настройка'}
                  </button>
                  {activeBgPreset !== (theme === 'dark' ? 'obsidian' : 'porcelain') ? (
                    <button
                      type="button"
                      data-testid="bg-preset-reset-btn"
                      onClick={() => {
                        const def = bgPresets[0]!;
                        onChangeAppearance({
                          bgPreset: def.id,
                          bgHue: def.bgHue,
                          bgTint: def.bgTint,
                          bgLightness: def.bgLightness,
                        });
                      }}
                      className="k-tap min-h-[34px] px-1.5 rounded-lg inline-flex items-center whitespace-nowrap text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]"
                    >
                      Сброс
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {bgPresets.map((preset) => {
                  const active = activeBgPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`bg-preset-${preset.id}`}
                      onClick={() => {
                        mobileBridge.haptic('light');
                        onChangeAppearance({
                          bgPreset: preset.id,
                          bgHue: preset.bgHue,
                          bgTint: preset.bgTint,
                          bgLightness: preset.bgLightness,
                        });
                      }}
                      className={`k-tap flex items-center justify-between gap-2 px-2.5 h-11 min-w-0 rounded-xl border text-left transition-colors ${
                        active
                          ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-ink-primary)]'
                          : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <span
                          aria-hidden="true"
                          className="relative w-[32px] h-[22px] rounded-[7px] shrink-0 overflow-hidden flex"
                          style={{
                            backgroundColor: preset.previewCanvas,
                            boxShadow:
                              theme === 'dark'
                                ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)'
                                : 'inset 0 0 0 1px rgba(15, 23, 42, 0.18)',
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
                                  : 'rgba(15, 23, 42, 0.10)',
                            }}
                          />
                        </span>
                        <span className="text-[12px] font-medium truncate">{preset.label}</span>
                      </span>
                      {active ? (
                        <Check weight="bold" className="w-3.5 h-3.5 text-[var(--k-accent)] shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {showBgSliders ? (
                <div className="pt-2 border-t border-[var(--k-border-hairline)] space-y-2.5">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-[var(--k-ink-secondary)]">
                      <span>Оттенок фона</span>
                      <span className="k-mono text-[var(--k-ink-muted)]">{Math.round(activeBgHue)}°</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      value={activeBgHue}
                      onChange={(e) => {
                        onChangeAppearance({ bgPreset: 'custom', bgHue: Number(e.target.value) });
                      }}
                      className="k-hue-slider w-full block"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-[var(--k-ink-secondary)]">
                      <span>Насыщенность тона</span>
                      <span className="k-mono text-[var(--k-ink-muted)]">{Math.round(activeBgTint)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={activeBgTint}
                      onChange={(e) => {
                        onChangeAppearance({ bgPreset: 'custom', bgTint: Number(e.target.value) });
                      }}
                      className="k-range-slider w-full block"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-[var(--k-ink-secondary)]">
                      <span>Яркость фона</span>
                      <span className="k-mono text-[var(--k-ink-muted)]">
                        {Math.round(activeBgLightness)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={activeBgLightness}
                      onChange={(e) => {
                        onChangeAppearance({
                          bgPreset: 'custom',
                          bgLightness: Number(e.target.value),
                        });
                      }}
                      className="k-range-slider w-full block"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* UI Density */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                <Rows weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                Плотность списков
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: 'comfortable', label: 'Комфортная' },
                    { id: 'compact', label: 'Компактная' },
                  ] as const
                ).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    data-testid={`density-${d.id}-btn`}
                    onClick={() => {
                      mobileBridge.haptic('light');
                      onChangeAppearance({ density: d.id });
                    }}
                    className={`k-tap h-10 rounded-xl border text-[13px] font-medium transition-colors ${
                      appearance.density === d.id
                        ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                        : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Vault Security: Biometric + Master PIN + Idle Auto-Lock + Clipboard Wipe */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3.5">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                <ShieldCheck weight="duotone" className="w-5 h-5 text-[var(--k-emerald)]" />
                Защита Сейфа
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Fingerprint className="w-5 h-5 text-[var(--k-accent)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-[var(--k-ink-primary)]">
                      Вход по отпечатку или лицу
                    </div>
                    <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                      {!biometricEnabled && hasMasterPin && vaultLocked
                        ? 'Разблокируй Сейф мастер-ПИНом, чтобы включить биометрию'
                        : 'Блокировать Сейф автоматически при сворачивании'}
                    </div>
                  </div>
                </div>
                <Switch.Root
                  data-testid="settings-biometric-switch"
                  checked={biometricEnabled}
                  onCheckedChange={(checked) => {
                    if (!(checked && hasMasterPin && vaultLocked)) {
                      mobileBridge.haptic('light');
                    }
                    onChangeBiometric(checked);
                  }}
                  aria-label="Вход по отпечатку или лицу"
                  className={`k-switch-root${!biometricEnabled && hasMasterPin && vaultLocked ? ' opacity-60' : ''}`}
                >
                  <Switch.Thumb className="k-switch-thumb" />
                </Switch.Root>
              </div>

              {/* Master PIN Setup */}
              <div className="pt-2.5 border-t border-[var(--k-border-hairline)] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <LockKey className="w-5 h-5 text-[var(--k-accent)] shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-medium text-[var(--k-ink-primary)]">
                        Мастер-ПИН Сейфа
                      </div>
                      <div className="text-[11.5px] text-[var(--k-ink-muted)]">
                        {hasMasterPin
                          ? 'Активен · резервный вход без биометрии'
                          : 'Запасной вход, если биометрия недоступна'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="settings-master-pin-toggle"
                    onClick={() => setPinEditorOpen((v) => !v)}
                    className="k-tap px-3 h-8 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12px] font-medium text-[var(--k-ink-primary)] shrink-0"
                  >
                    {hasMasterPin ? 'Изменить' : 'Задать'}
                  </button>
                </div>

                {pinEditorOpen ? (
                  <form
                    onSubmit={(e) => void handleSaveMasterPin(e)}
                    className="p-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] space-y-2"
                  >
                    {hasMasterPin ? (
                      <input
                        type="password"
                        inputMode="numeric"
                        data-testid="settings-current-pin-input"
                        value={currentPin}
                        onChange={(e) => setCurrentPin(e.target.value)}
                        placeholder="Текущий мастер-ПИН"
                        className="w-full h-9 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[13.5px] text-[var(--k-ink-primary)] placeholder:tracking-normal"
                      />
                    ) : null}
                    <input
                      type="password"
                      inputMode="numeric"
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value)}
                      placeholder="Новый мастер-ПИН (от 4 символов)"
                      className="w-full h-9 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none k-mono text-[13.5px] text-[var(--k-ink-primary)] placeholder:tracking-normal"
                    />
                    <input
                      type="password"
                      inputMode="numeric"
                      value={confirmPin}
                      onChange={(e) => setConfirmPin(e.target.value)}
                      placeholder="Повтори мастер-ПИН"
                      className="w-full h-9 px-3 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none k-mono text-[13.5px] text-[var(--k-ink-primary)] placeholder:tracking-normal"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={pinSaving}
                        className="k-tap flex-1 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold disabled:opacity-50"
                      >
                        Сохранить ПИН
                      </button>
                      {hasMasterPin ? (
                        <button
                          type="button"
                          data-testid="settings-remove-pin-btn"
                          disabled={pinSaving}
                          onClick={() => void handleRemoveMasterPinClick()}
                          className="k-tap px-3 h-9 rounded-xl bg-[var(--k-danger-soft)] text-[var(--k-danger)] text-[12px] font-medium disabled:opacity-50"
                        >
                          Убрать
                        </button>
                      ) : null}
                    </div>
                  </form>
                ) : null}
              </div>

              {/* Idle Auto-Lock Timeout */}
              <div className="space-y-1.5 pt-2.5 border-t border-[var(--k-border-hairline)]">
                <div className="flex items-center gap-1.5 text-[12.5px] text-[var(--k-ink-secondary)]">
                  <Timer className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                  Автоблокировка Сейфа при бездействии
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {AUTO_LOCK_OPTIONS.map((opt) => {
                    const lockedOffBlocked =
                      opt.value === 0 && (hasMasterPin || biometricEnabled) && vaultLocked;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        data-testid={`settings-autolock-${opt.value}`}
                        onClick={() => {
                          if (!lockedOffBlocked) {
                            mobileBridge.haptic('light');
                          }
                          onChangeAutoLockMinutes(opt.value);
                        }}
                        className={`k-tap h-9 rounded-xl border text-[12px] font-medium ${
                          autoLockMinutes === opt.value
                            ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                            : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                        }${lockedOffBlocked ? ' opacity-60' : ''}`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Clipboard Auto-Wipe */}
              <div className="space-y-1.5 pt-2.5 border-t border-[var(--k-border-hairline)]">
                <div className="text-[12.5px] text-[var(--k-ink-secondary)]">
                  Автоочистка буфера после копирования пароля, 2FA или карты
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[15, 30, 60].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => {
                        mobileBridge.haptic('light');
                        onChangeWipeSeconds(sec);
                      }}
                      className={`k-tap h-9 rounded-xl border text-[13px] font-medium ${
                        wipeSeconds === sec
                          ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                          : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                      }`}
                    >
                      {sec} с
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* AI Provider & Key for Mobile Voice Transcription */}
            <form
              onSubmit={(e) => void handleSaveAi(e)}
              className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                  <Sparkle weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                  ИИ для голоса и заметок
                </div>
                {currentProviderHasKey && aiProviderDraft !== 'local' ? (
                  <span className="px-2 py-0.5 rounded-md bg-[var(--k-emerald-soft)] text-[10.5px] font-medium text-[var(--k-emerald)] shrink-0">
                    Ключ сохранён
                  </span>
                ) : null}
              </div>

              {/* Built-in Kapsula Cloud AI Status & Quota Bar */}
              <div
                data-testid="settings-cloud-ai-status"
                className="rounded-xl p-3 bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--k-ink-primary)]">
                    Встроенный ИИ Kapsula
                  </span>
                  {anyAiKeySaved ? (
                    <span className="px-2 py-0.5 rounded-md bg-[var(--k-accent-soft)] text-[10.5px] font-medium text-[var(--k-accent)] shrink-0">
                      Личный ключ
                    </span>
                  ) : isCloudAccountSignedIn ? (
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10.5px] font-medium shrink-0 ${
                        cloudAiQuota &&
                        (cloudAiQuota.blocked ||
                          cloudAiQuota.globalExhausted ||
                          cloudAiQuota.remainingUsd <= 0)
                          ? 'bg-[var(--k-danger-soft)] text-[var(--k-danger)]'
                          : 'bg-[var(--k-emerald-soft)] text-[var(--k-emerald)]'
                      }`}
                    >
                      {cloudAiQuota &&
                      (cloudAiQuota.blocked ||
                        cloudAiQuota.globalExhausted ||
                        cloudAiQuota.remainingUsd <= 0)
                        ? 'Лимит исчерпан'
                        : 'Активен'}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] text-[10.5px] font-medium text-[var(--k-ink-muted)] shrink-0">
                      Нужен вход
                    </span>
                  )}
                </div>

                {anyAiKeySaved ? (
                  <p className="text-[11.5px] leading-relaxed text-[var(--k-ink-muted)]">
                    Работает через твой личный ключ без месячного лимита. Удали ключ ниже, чтобы
                    вернуться ко встроенному ИИ.
                  </p>
                ) : isCloudAccountSignedIn ? (
                  <>
                    {(() => {
                      const spent = cloudAiQuota?.spentUsd ?? 0;
                      const limit = cloudAiQuota?.limitUsd ?? 1;
                      const pct = Math.max(0, Math.min(100, limit > 0 ? (spent / limit) * 100 : 0));
                      const barColor =
                        pct >= 100 || cloudAiQuota?.blocked || cloudAiQuota?.globalExhausted
                          ? 'var(--k-danger)'
                          : pct >= 80
                            ? 'var(--k-amber)'
                            : 'var(--k-accent)';
                      return (
                        <div className="space-y-1.5">
                          <div className="h-1.5 w-full rounded-full bg-[var(--k-bg-surface-2)] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-[width] duration-200"
                              style={{ width: `${pct}%`, background: barColor }}
                            />
                          </div>
                          <div className="text-[11.5px] text-[var(--k-ink-secondary)]">
                            {cloudAiQuotaLoading && !cloudAiQuota
                              ? 'Загружаю статус квоты…'
                              : `Потрачено ${formatUsdRu(spent)} из ${formatUsdRu(limit)} в этом месяце`}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-[var(--k-ink-muted)]">
                    Войди в Облако Kapsula, чтобы расшифровывать голос и выделять задачи без
                    настройки ключей (до $1,00 в месяц), или добавь свой ключ ниже.
                  </p>
                )}
              </div>

              <p className="text-[12px] leading-relaxed text-[var(--k-ink-muted)]">
                Свой ключ необязателен — он снимает месячный лимит и хранится только на твоём
                устройстве.
              </p>

              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'local', label: 'Встроенный' },
                    { id: 'google_ai_studio', label: 'Gemini' },
                    { id: 'openrouter', label: 'OpenRouter' },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setAiProviderDraft(p.id)}
                    className={`k-tap h-9 rounded-xl border text-[12px] font-medium ${
                      aiProviderDraft === p.id
                        ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                        : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {aiProviderDraft !== 'local' ? (
                <input
                  type="password"
                  data-testid="settings-ai-key-input"
                  value={aiKeyDraft}
                  onChange={(e) => setAiKeyDraft(e.target.value)}
                  placeholder={
                    currentProviderHasKey
                      ? 'Ключ уже задан (введи новый для замены)'
                      : aiProviderDraft === 'google_ai_studio'
                        ? 'API-ключ Google AI (AIza…)'
                        : 'API-ключ OpenRouter (sk-or-…)'
                  }
                  className="w-full h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[12.5px] text-[var(--k-ink-primary)]"
                />
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={aiSaving}
                  className="k-tap flex-1 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold disabled:opacity-50"
                >
                  {aiSaving ? 'Сохраняю…' : 'Сохранить настройки ИИ'}
                </button>
                {anyAiKeySaved ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await onSaveAiConfig({
                        provider: 'local',
                        googleKey: null,
                        openrouterKey: null,
                      });
                      setAiProviderDraft('local');
                      setAiKeyDraft('');
                      toast('Ключ ИИ удалён');
                    }}
                    className="k-tap px-3 h-9 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[12px] text-[var(--k-danger)]"
                  >
                    Сбросить
                  </button>
                ) : null}
              </div>
            </form>
          </div>
        ) : null}

        {/* ==================== ORBITS, BOARDS & TRASH TAB ==================== */}
        {section === 'structure' ? (
          <div className="space-y-4">
            {/* Sections */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                <FolderSimple className="w-4 h-4 text-[var(--k-accent)]" />
                Разделы ({orbits.length})
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newOrbitName.trim()) return;
                  await onCreateOrbit(newOrbitName.trim(), newOrbitColor);
                  setNewOrbitName('');
                  mobileBridge.haptic('success');
                  toast.success('Раздел создан');
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  data-testid="settings-new-orbit-input"
                  value={newOrbitName}
                  onChange={(e) => setNewOrbitName(e.target.value)}
                  placeholder="Новый раздел…"
                  className="flex-1 h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                />
                <button
                  type="submit"
                  disabled={!newOrbitName.trim()}
                  aria-label="Создать раздел"
                  className="k-tap inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] disabled:opacity-40"
                >
                  <Plus weight="bold" className="w-4 h-4" />
                </button>
              </form>

              <div className="grid grid-cols-8 gap-2 justify-items-center">
                {paletteSwatches.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewOrbitColor(c)}
                    style={{ background: c }}
                    className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                      newOrbitColor === c
                        ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                        : 'opacity-80'
                    }`}
                  >
                    {newOrbitColor === c ? (
                      <Check weight="bold" className="w-3 h-3 text-white" />
                    ) : null}
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                {orbits.map((o) => {
                  const isEditing = editingOrbitId === o.id;
                  if (isEditing) {
                    return (
                      <form
                        key={o.id}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!editOrbitName.trim()) return;
                          await onUpdateOrbit(o.id, {
                            name: editOrbitName.trim(),
                            color: editOrbitColor,
                          });
                          setEditingOrbitId(null);
                          toast.success('Раздел обновлён');
                        }}
                        className="p-2.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] space-y-2"
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            autoFocus
                            value={editOrbitName}
                            onChange={(e) => setEditOrbitName(e.target.value)}
                            className="flex-1 h-9 px-2.5 rounded-lg bg-[var(--k-bg-surface-2)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                          />
                          <button
                            type="submit"
                            className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]"
                            aria-label="Сохранить"
                          >
                            <Check weight="bold" className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingOrbitId(null)}
                            className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
                            aria-label="Отмена"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-8 gap-1.5 justify-items-center">
                          {paletteSwatches.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setEditOrbitColor(c)}
                              style={{ background: c }}
                              className={`w-5 h-5 rounded-full flex items-center justify-center ${
                                editOrbitColor === c
                                  ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                                  : 'opacity-80'
                              }`}
                            >
                              {editOrbitColor === c ? (
                                <Check weight="bold" className="w-2.5 h-2.5 text-white" />
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </form>
                    );
                  }

                  return (
                    <div
                      key={o.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: o.color }}
                        />
                        <span className="text-[13.5px] text-[var(--k-ink-primary)] truncate">
                          {o.name}
                        </span>
                        <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular shrink-0">
                          {o.itemCount ?? 0}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingOrbitId(o.id);
                            setEditOrbitName(o.name);
                            setEditOrbitColor(o.color);
                          }}
                          aria-label="Редактировать раздел"
                          className="k-tap p-1.5 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]"
                        >
                          <PencilSimple className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onDeleteOrbit(o.id);
                            toast('Раздел удалён');
                          }}
                          aria-label="Удалить раздел"
                          className="k-tap p-1.5 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-danger)]"
                        >
                          <Trash className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Canvases (Холсты) */}
            <div className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                <Swatches className="w-4 h-4 text-[var(--k-emerald)]" />
                Холсты ({boards.length})
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newBoardName.trim()) return;
                  await onCreateBoard(newBoardName.trim(), newBoardColor);
                  setNewBoardName('');
                  mobileBridge.haptic('success');
                  toast.success('Холст создан');
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={newBoardName}
                  onChange={(e) => setNewBoardName(e.target.value)}
                  placeholder="Новый холст…"
                  className="flex-1 h-10 px-3 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                />
                <button
                  type="submit"
                  disabled={!newBoardName.trim()}
                  aria-label="Создать холст"
                  className="k-tap inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] disabled:opacity-40"
                >
                  <Plus weight="bold" className="w-4 h-4" />
                </button>
              </form>

              <div className="grid grid-cols-8 gap-2 justify-items-center">
                {paletteSwatches.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewBoardColor(c)}
                    style={{ background: c }}
                    className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                      newBoardColor === c
                        ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                        : 'opacity-80'
                    }`}
                  >
                    {newBoardColor === c ? (
                      <Check weight="bold" className="w-3 h-3 text-white" />
                    ) : null}
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                {boards.map((b) => {
                  const isEditing = editingBoardId === b.id;
                  if (isEditing) {
                    return (
                      <form
                        key={b.id}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!editBoardName.trim()) return;
                          await onUpdateBoard(b.id, {
                            name: editBoardName.trim(),
                            color: editBoardColor,
                          });
                          setEditingBoardId(null);
                          toast.success('Холст обновлён');
                        }}
                        className="p-2.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-focus)] space-y-2"
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            autoFocus
                            value={editBoardName}
                            onChange={(e) => setEditBoardName(e.target.value)}
                            className="flex-1 h-9 px-2.5 rounded-lg bg-[var(--k-bg-surface-2)] outline-none text-[13.5px] text-[var(--k-ink-primary)]"
                          />
                          <button
                            type="submit"
                            className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]"
                            aria-label="Сохранить"
                          >
                            <Check weight="bold" className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingBoardId(null)}
                            className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
                            aria-label="Отмена"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="grid grid-cols-8 gap-1.5 justify-items-center">
                          {paletteSwatches.map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setEditBoardColor(c)}
                              style={{ background: c }}
                              className={`w-5 h-5 rounded-full flex items-center justify-center ${
                                editBoardColor === c
                                  ? 'ring-2 ring-[var(--k-ink-primary)] ring-offset-2 ring-offset-[var(--k-bg-surface-2)] scale-110'
                                  : 'opacity-80'
                              }`}
                            >
                              {editBoardColor === c ? (
                                <Check weight="bold" className="w-2.5 h-2.5 text-white" />
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </form>
                    );
                  }

                  return (
                    <div
                      key={b.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Swatches
                          weight="duotone"
                          className="w-4 h-4 shrink-0"
                          style={{ color: b.color }}
                        />
                        <span className="text-[13.5px] text-[var(--k-ink-primary)] truncate">
                          {b.name}
                        </span>
                        <span className="text-[11.5px] text-[var(--k-ink-muted)] k-tabular shrink-0">
                          {b.itemCount ?? 0}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBoardId(b.id);
                            setEditBoardName(b.name);
                            setEditBoardColor(b.color);
                          }}
                          aria-label="Редактировать холст"
                          className="k-tap p-2 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)]"
                        >
                          <PencilSimple className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void onDeleteBoard(b.id);
                            toast('Холст удалён');
                          }}
                          aria-label="Удалить холст"
                          className="k-tap p-2 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-danger)]"
                        >
                          <Trash className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Archive (Архив) — View & Unarchive items archived on Desktop/Mac */}
            <div
              data-testid="settings-archive-section"
              className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3"
            >
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                <Archive className="w-4 h-4 text-[var(--k-accent)]" />
                Архив ({archivedItems.length})
              </div>

              {archivedItems.length === 0 ? (
                <p className="text-[12.5px] text-[var(--k-ink-muted)]">
                  Архив пуст. Записи, убранные в архив на ПК или Mac, появятся здесь — их можно
                  вернуть в ленту в любой момент.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {archivedItems.map((it) => {
                    const busyRow = archiveBusyId === it.id;
                    return (
                      <div
                        key={it.id}
                        data-testid={`archive-item-${it.id}`}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                            {it.title || 'Без названия'}
                          </div>
                          <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                            {getDnaHumanLabel(it)}
                            {it.updatedAt ? ` · ${formatRelativeDate(it.updatedAt)}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busyRow}
                          onClick={async () => {
                            setArchiveBusyId(it.id);
                            try {
                              await onUnarchiveItem(it.id);
                              mobileBridge.haptic('success');
                              toast.success('Возвращено из архива');
                            } finally {
                              setArchiveBusyId(null);
                            }
                          }}
                          aria-label="Вернуть из архива"
                          className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-medium shrink-0"
                        >
                          <ArrowCounterClockwise className="w-3.5 h-3.5" />
                          Вернуть
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Trash (Корзина) — Restore / Purge Permanently / Empty Trash */}
            <div
              data-testid="settings-trash-section"
              className="rounded-2xl p-4 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--k-ink-primary)]">
                  <Trash className="w-4 h-4 text-[var(--k-danger)]" />
                  Корзина ({trashedItems.length})
                </div>
                {trashedItems.length > 0 ? (
                  confirmEmptyTrash ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="trash-empty-confirm-btn"
                        onClick={async () => {
                          const count = await onEmptyTrash();
                          setConfirmEmptyTrash(false);
                          mobileBridge.haptic('medium');
                          toast.success(
                            `Корзина очищена (${pluralRu(count, 'запись', 'записи', 'записей')})`
                          );
                        }}
                        className="k-tap px-2.5 h-7 rounded-lg bg-[var(--k-danger)] text-white text-[11.5px] font-semibold"
                      >
                        Очистить навсегда
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmEmptyTrash(false)}
                        className="k-tap px-2 h-7 rounded-lg bg-[var(--k-bg-surface-1)] text-[11.5px] text-[var(--k-ink-secondary)]"
                      >
                        Отмена
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="trash-empty-btn"
                      onClick={() => setConfirmEmptyTrash(true)}
                      className="k-tap px-2.5 h-7 rounded-lg bg-[var(--k-danger-soft)] text-[var(--k-danger)] text-[11.5px] font-medium"
                    >
                      Очистить корзину
                    </button>
                  )
                ) : null}
              </div>

              {trashedItems.length === 0 ? (
                <p className="text-[12.5px] text-[var(--k-ink-muted)]">
                  Корзина пуста. Удалённые записи и секреты попадают сюда и могут быть восстановлены
                  или стёрты навсегда на всех устройствах.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {trashedItems.map((it) => {
                    const busyRow = trashBusyId === it.id;
                    return (
                      <div
                        key={it.id}
                        data-testid={`trash-item-${it.id}`}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-[var(--k-ink-primary)] truncate">
                            {it.title || 'Без названия'}
                          </div>
                          <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                            {getDnaHumanLabel(it)}
                            {it.deletedAt ? ` · удалено ${formatRelativeDate(it.deletedAt)}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            disabled={busyRow}
                            onClick={async () => {
                              setTrashBusyId(it.id);
                              try {
                                await onRestoreTrashedItem(it.id);
                                mobileBridge.haptic('success');
                                toast.success('Восстановлено из корзины');
                              } finally {
                                setTrashBusyId(null);
                              }
                            }}
                            aria-label="Восстановить"
                            className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-lg bg-[var(--k-accent-soft)] text-[var(--k-accent)] text-[11.5px] font-medium"
                          >
                            <ArrowCounterClockwise className="w-3.5 h-3.5" />
                            Вернуть
                          </button>
                          <button
                            type="button"
                            disabled={busyRow}
                            onClick={async () => {
                              setTrashBusyId(it.id);
                              try {
                                await onPurgeTrashedItem(it.id);
                                mobileBridge.haptic('medium');
                                toast('Удалено навсегда');
                              } finally {
                                setTrashBusyId(null);
                              }
                            }}
                            aria-label="Удалить навсегда"
                            className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--k-danger-soft)] text-[var(--k-danger)]"
                          >
                            <Trash className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
};
