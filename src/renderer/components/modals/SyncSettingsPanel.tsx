import React, { useEffect, useState } from 'react';
import {
  ArrowsClockwise,
  Check,
  CheckCircle,
  CloudCheck,
  CloudSlash,
  CloudWarning,
  Copy,
  Desktop,
  DeviceMobile,
  Key,
  Laptop,
  LockKey,
  ShieldCheck,
  SignOut,
  SlidersHorizontal,
  WarningCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { SyncPlatform, SyncStatus } from '@shared/sync-contract';
import { friendlyErrorMessage } from '../../lib/format';
import { SegmentedControl } from '../ui/SegmentedControl';

interface SyncSettingsPanelProps {
  onVaultChanged?: () => void;
  onAuthChanged?: () => void;
  freshRecoveryKey: string | null;
  onFreshRecoveryKeyChange: (key: string | null) => void;
}

const GoogleColorIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4 shrink-0' }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.08 3.56-5.15 3.56-8.65z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.07 7.93-2.9l-3.87-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.29 14.3a7.18 7.18 0 0 1 0-4.6V6.6H1.29a12 12 0 0 0 0 10.8l4-3.1z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.6l4 3.1c.94-2.84 3.59-4.95 6.71-4.95z"
    />
  </svg>
);

const MIN_NEW_PASSPHRASE_LENGTH = 10;

interface PassphraseStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  color: string;
}

function evaluatePassphraseStrength(raw: string): PassphraseStrength {
  const value = raw.trim();
  if (!value) {
    return { score: 0, label: `Минимум ${MIN_NEW_PASSPHRASE_LENGTH} символов`, color: 'var(--k-ink-muted)' };
  }
  if (value.length < MIN_NEW_PASSPHRASE_LENGTH) {
    return {
      score: 1,
      label: `Короткая — добавь ещё ${MIN_NEW_PASSPHRASE_LENGTH - value.length} симв.`,
      color: 'var(--k-danger)',
    };
  }
  let classes = 0;
  if (/[a-zа-яё]/.test(value)) classes += 1;
  if (/[A-ZА-ЯЁ]/.test(value)) classes += 1;
  if (/\d/.test(value)) classes += 1;
  if (/[^a-zA-Zа-яА-ЯёЁ0-9\s]/.test(value)) classes += 1;
  const wordCount = value.split(/\s+/).filter(Boolean).length;

  if (value.length >= 16 || (value.length >= 12 && classes >= 3) || wordCount >= 3) {
    return { score: 4, label: 'Надёжная секретная фраза', color: 'var(--k-emerald)' };
  }
  if (value.length >= 12 || classes >= 3) {
    return { score: 3, label: 'Хорошая фраза', color: 'var(--k-emerald)' };
  }
  return {
    score: 2,
    label: 'Нормальная — для усиления добавь цифры или слова',
    color: 'var(--k-amber)',
  };
}

const PassphraseStrengthMeter: React.FC<{ value: string }> = ({ value }) => {
  const { score, label, color } = evaluatePassphraseStrength(value);
  return (
    <div data-testid="passphrase-strength-meter" className="space-y-1">
      <div className="grid grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((step) => (
          <div
            key={step}
            className="h-1.5 rounded-full transition-colors duration-150"
            style={{
              backgroundColor: score >= step ? color : 'var(--k-bg-surface-3)',
            }}
          />
        ))}
      </div>
      <div className="text-[11px] flex items-center justify-between gap-2" style={{ color }}>
        <span>{label}</span>
        <span className="k-mono k-tabular text-[var(--k-ink-muted)]">
          {value.trim().length}/{MIN_NEW_PASSPHRASE_LENGTH}+
        </span>
      </div>
    </div>
  );
};

function formatSyncTime(ts: number | null | undefined): string {
  if (!ts) return 'ещё не выполнялась';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 15) return 'только что';
  if (diffSec < 60) return `${diffSec} с назад`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeenIso(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  return formatSyncTime(ts);
}

function platformLabel(platform: SyncPlatform): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Веб';
  }
}

function PlatformIcon({ platform }: { platform: SyncPlatform }) {
  if (platform === 'android' || platform === 'ios') {
    return <DeviceMobile className="w-4 h-4 text-[var(--k-ink-secondary)]" />;
  }
  if (platform === 'darwin') {
    return <Laptop className="w-4 h-4 text-[var(--k-ink-secondary)]" />;
  }
  return <Desktop className="w-4 h-4 text-[var(--k-ink-secondary)]" />;
}

export const SyncSettingsPanel: React.FC<SyncSettingsPanelProps> = ({
  onVaultChanged,
  onAuthChanged,
  freshRecoveryKey,
  onFreshRecoveryKeyChange,
}) => {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  // Passphrase setup / unlock / recovery
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [unlockMode, setUnlockMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoveryNewPass, setRecoveryNewPass] = useState('');
  const [recoveryNewPassConfirm, setRecoveryNewPassConfirm] = useState('');
  const [cryptoBusy, setCryptoBusy] = useState(false);

  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  // Change passphrase collapsible
  const [showChangePass, setShowChangePass] = useState(false);
  const [curPassDraft, setCurPassDraft] = useState('');
  const [newPassDraft, setNewPassDraft] = useState('');
  const [newPassConfirmDraft, setNewPassConfirmDraft] = useState('');
  const [changePassBusy, setChangePassBusy] = useState(false);

  // Sync now, reconcile, sign out & custom server collapsible
  const [syncBusy, setSyncBusy] = useState(false);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [showCustomServer, setShowCustomServer] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [savingServer, setSavingServer] = useState(false);
  const [, setTimeTick] = useState(0);

  useEffect(() => {
    window.kapsula
      .getSyncStatus()
      .then((st) => {
        setStatus(st);
        if (st.email) setEmail(st.email);
        if (st.state === 'awaiting_email_confirm') setAuthMode('signin');
        if (st.hasCustomServer) setCustomUrl(st.supabaseUrl);
      })
      .catch(() => {});
    return window.kapsula.onSyncStatusUpdated((next) => {
      setStatus(next);
      if (next.state === 'awaiting_email_confirm') {
        setAuthMode('signin');
      }
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTimeTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!status) {
    return (
      <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 text-[12.5px] text-[var(--k-ink-secondary)]">
        Загружаю состояние синхронизации…
      </div>
    );
  }

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      toast.info('Введи почту и пароль');
      return;
    }
    setAuthBusy(true);
    try {
      const res =
        authMode === 'signup'
          ? await window.kapsula.syncSignUp({ email: cleanEmail, password })
          : await window.kapsula.syncSignIn({ email: cleanEmail, password });
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось войти');
        return;
      }
      setPassword('');
      if (res.needsEmailConfirmation) {
        toast.success('Отправили письмо для подтверждения почты');
        setAuthMode('signin');
      } else if (res.needsPassphraseSetup) {
        toast.success('Аккаунт создан — теперь задай секретную фразу шифрования');
        onAuthChanged?.();
      } else if (res.needsPassphraseUnlock) {
        toast.info('Введи секретную фразу шифрования с твоего первого устройства');
        onAuthChanged?.();
      } else {
        toast.success('Синхронизация подключена');
        onAuthChanged?.();
        onVaultChanged?.();
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Ошибка подключения к облаку'));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleBusy(true);
    try {
      const res = await window.kapsula.syncSignInGoogle();
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось войти через Google');
        return;
      }
      onAuthChanged?.();
      if (res.needsPassphraseSetup) {
        toast.success('Вход через Google выполнен — задай секретную фразу шифрования');
      } else if (res.needsPassphraseUnlock) {
        toast.info('Вход через Google выполнен — введи секретную фразу шифрования');
      } else {
        toast.success('Синхронизация через Google подключена');
        onVaultChanged?.();
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось выполнить вход через Google'));
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleSetupPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passphrase.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
      toast.info(`Придумай фразу минимум из ${MIN_NEW_PASSPHRASE_LENGTH} символов`);
      return;
    }
    if (passphrase !== passphraseConfirm) {
      toast.error('Фразы не совпадают');
      return;
    }
    setCryptoBusy(true);
    try {
      const res = await window.kapsula.syncSetupPassphrase(passphrase);
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось настроить шифрование');
        return;
      }
      setPassphrase('');
      setPassphraseConfirm('');
      if (res.recoveryKey) {
        onFreshRecoveryKeyChange(res.recoveryKey);
        setCopiedRecovery(false);
      }
      if (res.initialSyncOk === false) {
        toast.warning('Ключ создан, но первичная отправка не завершена — повтори синхронизацию');
      } else {
        toast.success('Сквозное шифрование включено — данные синхронизированы');
      }
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось настроить шифрование'));
    } finally {
      setCryptoBusy(false);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (unlockMode === 'recovery' && recoveryNewPass.trim()) {
      if (recoveryNewPass.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
        toast.info(`Новая фраза должна быть не короче ${MIN_NEW_PASSPHRASE_LENGTH} символов`);
        return;
      }
      if (recoveryNewPass !== recoveryNewPassConfirm) {
        toast.error('Новые фразы не совпадают');
        return;
      }
    }
    setCryptoBusy(true);
    try {
      const res =
        unlockMode === 'passphrase'
          ? await window.kapsula.syncUnlockPassphrase(passphrase)
          : await window.kapsula.syncUnlockRecovery({
              recoveryKey: recoveryInput,
              newPassphrase: recoveryNewPass.trim() || undefined,
            });
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось расшифровать хранилище');
        return;
      }
      setPassphrase('');
      setRecoveryInput('');
      setRecoveryNewPass('');
      setRecoveryNewPassConfirm('');
      toast.success('Хранилище расшифровано и синхронизировано');
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Ошибка расшифровки'));
    } finally {
      setCryptoBusy(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncBusy(true);
    try {
      const res = await window.kapsula.syncNow();
      setStatus(res.status);
      if (res.ok) {
        const parts: string[] = [];
        if (res.pushed) parts.push(`отправлено: ${res.pushed}`);
        if (res.pulled) parts.push(`получено: ${res.pulled}`);
        toast.success(parts.length ? `Синхронизировано (${parts.join(', ')})` : 'Всё актуально');
        if (res.pulled) onVaultChanged?.();
      } else {
        toast.error(res.error || 'Не удалось синхронизировать');
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Ошибка синхронизации'));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleReconcileFull = async () => {
    setReconcileBusy(true);
    try {
      const next = await window.kapsula.reconcileFullSync();
      setStatus(next);
      toast.success('Сверка синхронизации завершена');
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось выполнить сверку'));
    } finally {
      setReconcileBusy(false);
    }
  };

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassDraft.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
      toast.info(`Новая фраза должна быть не короче ${MIN_NEW_PASSPHRASE_LENGTH} символов`);
      return;
    }
    if (newPassDraft !== newPassConfirmDraft) {
      toast.error('Новые фразы не совпадают');
      return;
    }
    setChangePassBusy(true);
    try {
      const res = await window.kapsula.syncChangePassphrase({
        currentPassphrase: curPassDraft,
        newPassphrase: newPassDraft,
      });
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || 'Не удалось сменить фразу');
        return;
      }
      setCurPassDraft('');
      setNewPassDraft('');
      setNewPassConfirmDraft('');
      setShowChangePass(false);
      toast.success('Секретная фраза обновлена (резервный ключ остался прежним)');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Ошибка смены фразы'));
    } finally {
      setChangePassBusy(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    setRegenBusy(true);
    try {
      const res = await window.kapsula.syncRegenerateRecoveryKey();
      setStatus(res.status);
      if (!res.ok || !res.recoveryKey) {
        toast.error(res.error || 'Не удалось перевыпустить резервный ключ');
        return;
      }
      onFreshRecoveryKeyChange(res.recoveryKey);
      setCopiedRecovery(false);
      toast.success('Создан новый резервный ключ — старый больше не действует');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось перевыпустить резервный ключ'));
    } finally {
      setRegenBusy(false);
    }
  };

  const handleSignOut = async () => {
    setSignOutBusy(true);
    try {
      const next = await window.kapsula.syncSignOut();
      setStatus(next);
      onFreshRecoveryKeyChange(null);
      onAuthChanged?.();
      toast('Синхронизация отключена · локальные записи сохранены');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось отключить синхронизацию'));
    } finally {
      setSignOutBusy(false);
    }
  };

  const handleSaveCustomServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingServer(true);
    try {
      const next = await window.kapsula.syncSetServerConfig(
        customUrl.trim() && customKey.trim()
          ? { supabaseUrl: customUrl.trim(), supabasePublishableKey: customKey.trim() }
          : null
      );
      setStatus(next);
      setCustomKey('');
      setShowCustomServer(false);
      toast.success(
        next.hasCustomServer
          ? 'Подключён свой сервер синхронизации'
          : 'Возвращён стандартный облачный сервер Kapsula'
      );
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Проверь адрес и ключ сервера'));
    } finally {
      setSavingServer(false);
    }
  };

  const handleResetServer = async () => {
    setSavingServer(true);
    try {
      const next = await window.kapsula.syncSetServerConfig(null);
      setStatus(next);
      setCustomUrl('');
      setCustomKey('');
      setShowCustomServer(false);
      toast.success('Возвращён стандартный сервер синхронизации');
    } catch (err) {
      toast.error(friendlyErrorMessage(err, 'Не удалось сбросить сервер'));
    } finally {
      setSavingServer(false);
    }
  };

  const isSignedOut = status.state === 'signed_out' || status.state === 'awaiting_email_confirm';
  const isActive =
    status.state === 'synced' ||
    status.state === 'syncing' ||
    status.state === 'offline' ||
    status.state === 'error';
  const failedCount = status.failedDirtyCount ?? 0;

  return (
    <div className="flex flex-col gap-3" data-testid="sync-settings-panel">
      {/* One-time Recovery Key banner (persisted in parent modal until acknowledged) */}
      {freshRecoveryKey ? (
        <div
          data-testid="sync-recovery-key-banner"
          className="rounded-xl border border-[var(--k-accent)]/40 bg-[var(--k-accent)]/10 p-4 flex flex-col gap-2.5"
        >
          <div>
            <div className="text-[13.5px] font-semibold text-[var(--k-ink-primary)] flex items-center gap-1.5">
              <Key className="w-4 h-4 text-[var(--k-accent)]" />
              <span>Сохрани резервный ключ восстановления</span>
            </div>
            <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
              Он показывается один раз. Если забудешь секретную фразу, только этот ключ вернёт доступ к заметкам и Сейфу на новом устройстве.
            </div>
          </div>
          <div className="rounded-lg bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] px-3 py-2.5 font-mono text-[12px] text-[var(--k-ink-primary)] select-all break-all">
            {freshRecoveryKey}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="sync-copy-recovery-btn"
              onClick={async () => {
                const res = await window.kapsula.syncCopyRecoveryKey(freshRecoveryKey);
                setCopiedRecovery(true);
                toast.success(
                  res.wipeSeconds > 0
                    ? `Резервный ключ скопирован (буфер очистится через ${res.wipeSeconds} с)`
                    : 'Резервный ключ скопирован'
                );
              }}
              className={`k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium cursor-pointer ${
                copiedRecovery
                  ? 'bg-[var(--k-emerald)] text-white'
                  : 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
              }`}
            >
              {copiedRecovery ? <Check weight="bold" className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedRecovery ? 'Ключ скопирован' : 'Скопировать ключ'}</span>
            </button>
            <button
              type="button"
              onClick={() => onFreshRecoveryKeyChange(null)}
              className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <span>Готово, я сохранил</span>
            </button>
            {copiedRecovery ? (
              <span className="text-[11.5px] text-[var(--k-emerald)] inline-flex items-center gap-1">
                <CheckCircle weight="fill" className="w-3.5 h-3.5" />
                Сохрани ключ в надёжном месте
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Signed out / Email confirmation */}
      {isSignedOut ? (
        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[var(--k-accent)]/12 text-[var(--k-accent)] flex items-center justify-center shrink-0">
              <CloudCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[13.5px] font-medium">
                Синхронизация (Windows · Mac · Android)
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                Заметки, задачи, календарь, файлы и Сейф шифруются твоим ключом прямо на устройстве до отправки в облако. Без ключа прочитать данные невозможно.
              </div>
            </div>
          </div>

          {status.state === 'awaiting_email_confirm' ? (
            <div className="rounded-lg border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] px-3 py-2.5 text-[12px] text-[var(--k-ink-primary)]">
              Отправили письмо на <strong>{status.email}</strong>. Перейди по ссылке подтверждения из письма, затем войди ниже.
            </div>
          ) : null}

          <button
            type="button"
            disabled={googleBusy || authBusy}
            data-testid="sync-google-btn"
            onClick={() => void handleGoogleSignIn()}
            className="k-interactive h-9.5 px-3.5 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] text-[13px] font-medium inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <GoogleColorIcon className="w-4 h-4 shrink-0" />
            <span>{googleBusy ? 'Ожидаю вход в браузере…' : 'Войти через Google'}</span>
          </button>

          <div className="flex items-center gap-2.5 text-[11px] text-[var(--k-ink-muted)]">
            <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
            <span>или по почте и паролю</span>
            <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
          </div>

          <SegmentedControl<'signup' | 'signin'>
            value={authMode}
            onChange={setAuthMode}
            size="sm"
            fullWidth
            options={[
              { value: 'signup', label: 'Создать аккаунт' },
              { value: 'signin', label: 'Войти в существующий' },
            ]}
          />

          <form onSubmit={handleAuthSubmit} className="flex flex-col gap-2.5">
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Почта (например, name@example.com)"
              data-testid="sync-email-input"
              className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <input
              type="password"
              required
              minLength={6}
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Пароль аккаунта (от 6 символов)"
              data-testid="sync-password-input"
              className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <button
              type="submit"
              disabled={authBusy || googleBusy}
              data-testid="sync-auth-submit"
              className="k-interactive h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:opacity-60"
            >
              {authBusy
                ? 'Подключаюсь…'
                : authMode === 'signup'
                  ? 'Создать аккаунт синхронизации'
                  : 'Войти'}
            </button>
            {authMode === 'signup' ? (
              <div className="text-[11.5px] text-[var(--k-ink-muted)] text-center">
                Подтверждение почты не требуется — аккаунт заработает сразу после создания.
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {/* Step 2a: First-time passphrase setup */}
      {status.state === 'needs_passphrase_setup' ? (
        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[13.5px] font-medium flex items-center gap-1.5">
                <LockKey className="w-4 h-4 text-[var(--k-accent)]" />
                <span>Задай секретную фразу шифрования</span>
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                Аккаунт <strong>{status.email}</strong> подключён. Придумай надёжную фразу от {MIN_NEW_PASSPHRASE_LENGTH} символов — ею будут шифроваться все твои записи и Сейф. На этом устройстве её нужно ввести один раз.
              </div>
            </div>
            <button
              type="button"
              disabled={signOutBusy}
              onClick={() => void handleSignOut()}
              className="text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0 disabled:opacity-50"
            >
              Выйти
            </button>
          </div>

          <form onSubmit={handleSetupPassphrase} className="flex flex-col gap-2.5">
            <input
              type="password"
              required
              minLength={MIN_NEW_PASSPHRASE_LENGTH}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`Секретная фраза (от ${MIN_NEW_PASSPHRASE_LENGTH} символов)`}
              data-testid="sync-setup-passphrase-input"
              className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <PassphraseStrengthMeter value={passphrase} />
            <input
              type="password"
              required
              minLength={MIN_NEW_PASSPHRASE_LENGTH}
              value={passphraseConfirm}
              onChange={(e) => setPassphraseConfirm(e.target.value)}
              placeholder="Повтори секретную фразу"
              data-testid="sync-setup-passphrase-confirm"
              className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <button
              type="submit"
              disabled={cryptoBusy || passphrase.trim().length < MIN_NEW_PASSPHRASE_LENGTH}
              data-testid="sync-setup-passphrase-submit"
              className="k-interactive h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default"
            >
              {cryptoBusy ? 'Создаю ключ и шифрую…' : 'Включить сквозную синхронизацию'}
            </button>
          </form>
        </div>
      ) : null}

      {/* Step 2b: Unlock existing encrypted vault on a new device */}
      {status.state === 'needs_passphrase_unlock' ? (
        <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[13.5px] font-medium flex items-center gap-1.5">
                <LockKey className="w-4 h-4 text-[var(--k-accent)]" />
                <span>Расшифруй облачное хранилище</span>
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                Для аккаунта <strong>{status.email}</strong> уже есть зашифрованные данные. Введи свою секретную фразу или резервный ключ, чтобы подключить это устройство.
              </div>
            </div>
            <button
              type="button"
              disabled={signOutBusy}
              onClick={() => void handleSignOut()}
              className="text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0 disabled:opacity-50"
            >
              Выйти
            </button>
          </div>

          <SegmentedControl<'passphrase' | 'recovery'>
            value={unlockMode}
            onChange={setUnlockMode}
            size="sm"
            fullWidth
            options={[
              { value: 'passphrase', label: 'Секретная фраза' },
              { value: 'recovery', label: 'Резервный ключ' },
            ]}
          />

          <form onSubmit={handleUnlockSubmit} className="flex flex-col gap-2.5">
            {unlockMode === 'passphrase' ? (
              <input
                type="password"
                required
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Твоя секретная фраза шифрования"
                data-testid="sync-unlock-passphrase-input"
                className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
              />
            ) : (
              <>
                <input
                  type="text"
                  required
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  placeholder="KAPS-XXXX-XXXX-XXXX-…"
                  data-testid="sync-unlock-recovery-input"
                  className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 font-mono text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="password"
                    value={recoveryNewPass}
                    onChange={(e) => setRecoveryNewPass(e.target.value)}
                    placeholder="Новая фраза (необязательно)"
                    className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                  <input
                    type="password"
                    value={recoveryNewPassConfirm}
                    onChange={(e) => setRecoveryNewPassConfirm(e.target.value)}
                    placeholder="Повтори новую фразу"
                    className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                </div>
                {recoveryNewPass.trim() ? <PassphraseStrengthMeter value={recoveryNewPass} /> : null}
              </>
            )}
            <button
              type="submit"
              disabled={cryptoBusy}
              data-testid="sync-unlock-submit"
              className="k-interactive h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:opacity-60"
            >
              {cryptoBusy ? 'Проверяю ключ и загружаю…' : 'Подключить это устройство'}
            </button>
          </form>
        </div>
      ) : null}

      {/* Active synced / offline / error dashboard */}
      {isActive ? (
        <>
          <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    status.state === 'error'
                      ? 'bg-[var(--k-danger-soft)] text-[var(--k-danger)]'
                      : status.state === 'offline'
                        ? 'bg-[var(--k-amber-soft)] text-[var(--k-amber)]'
                        : 'bg-[var(--k-emerald-soft)] text-[var(--k-emerald)]'
                  }`}
                >
                  {status.state === 'offline' ? (
                    <CloudSlash className="w-5 h-5" />
                  ) : status.state === 'error' ? (
                    <CloudWarning className="w-5 h-5" />
                  ) : (
                    <CloudCheck className="w-5 h-5" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span>
                      {status.state === 'syncing'
                        ? 'Синхронизация…'
                        : status.state === 'offline'
                          ? 'Офлайн · ждём сеть'
                          : status.state === 'error'
                            ? 'Нужна повторная синхронизация'
                            : 'Синхронизация активна'}
                    </span>
                    {status.realtimeConnected ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] text-[10.5px] font-medium whitespace-nowrap shrink-0">
                        в реальном времени
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular truncate mt-0.5">
                    {status.email} · обновлено: {formatSyncTime(status.lastSyncAt)}
                    {status.pendingCount > 0 ? ` · в очереди: ${status.pendingCount}` : ''}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={reconcileBusy || syncBusy || status.state === 'syncing'}
                  onClick={() => void handleReconcileFull()}
                  data-testid="sync-reconcile-btn"
                  title="Сверить все записи и удаления с облаком заново"
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                >
                  <ShieldCheck className={`w-3.5 h-3.5 text-[var(--k-accent)] ${reconcileBusy ? 'animate-pulse' : ''}`} />
                  <span>{reconcileBusy ? 'Сверяю…' : 'Сверка синхронизации'}</span>
                </button>
                <button
                  type="button"
                  disabled={syncBusy || reconcileBusy || status.state === 'syncing'}
                  onClick={() => void handleSyncNow()}
                  data-testid="sync-now-btn"
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                >
                  <ArrowsClockwise
                    className={`w-3.5 h-3.5 ${syncBusy || status.state === 'syncing' ? 'animate-spin' : ''}`}
                  />
                  <span>Синхронизировать</span>
                </button>
              </div>
            </div>

            {failedCount > 0 ? (
              <div
                data-testid="sync-failed-dirty-warning"
                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] px-3 py-2 text-[12px] text-[var(--k-amber)]"
              >
                <span className="inline-flex items-center gap-1.5">
                  <WarningCircle weight="fill" className="w-4 h-4 shrink-0" />
                  <span>
                    Не удалось отправить изменений: <strong>{failedCount}</strong>. Запусти полную сверку, чтобы повторить отправку.
                  </span>
                </span>
              </div>
            ) : null}

            {status.error ? (
              <div className="rounded-lg border border-[var(--k-danger)]/35 bg-[var(--k-danger-soft)] px-3 py-2 text-[12px] text-[var(--k-danger)]">
                {status.error}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-secondary)]">
              <span className="inline-flex items-center gap-1.5 k-tabular">
                <CheckCircle className="w-3.5 h-3.5 text-[var(--k-emerald)]" />
                <span>
                  Зашифровано на устройстве · записей: {status.syncedRecordsCount}
                  {status.lastReconcileAt ? ` · сверка: ${formatSyncTime(status.lastReconcileAt)}` : ''}
                </span>
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={regenBusy}
                  onClick={() => void handleRegenerateRecovery()}
                  className="text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-50"
                >
                  {regenBusy ? 'Создаю ключ…' : 'Новый резервный ключ'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowChangePass((v) => !v)}
                  className="text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  Сменить фразу
                </button>
                <button
                  type="button"
                  disabled={signOutBusy}
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] cursor-pointer disabled:opacity-50"
                >
                  <SignOut className="w-3.5 h-3.5" />
                  <span>Выйти</span>
                </button>
              </div>
            </div>

            {showChangePass ? (
              <form
                onSubmit={handleChangePassphrase}
                className="pt-2 border-t border-[var(--k-border-hairline)] flex flex-col gap-2"
              >
                <div className="text-[12px] text-[var(--k-ink-secondary)]">
                  Смена секретной фразы обновит защиту ключа без перезагрузки всей базы. Резервный ключ останется действительным.
                </div>
                <input
                  type="password"
                  required
                  value={curPassDraft}
                  onChange={(e) => setCurPassDraft(e.target.value)}
                  placeholder="Текущая фраза"
                  className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSPHRASE_LENGTH}
                    value={newPassDraft}
                    onChange={(e) => setNewPassDraft(e.target.value)}
                    placeholder={`Новая фраза (от ${MIN_NEW_PASSPHRASE_LENGTH} симв.)`}
                    className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSPHRASE_LENGTH}
                    value={newPassConfirmDraft}
                    onChange={(e) => setNewPassConfirmDraft(e.target.value)}
                    placeholder="Повтори новую фразу"
                    className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                </div>
                <PassphraseStrengthMeter value={newPassDraft} />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={changePassBusy || newPassDraft.trim().length < MIN_NEW_PASSPHRASE_LENGTH}
                    className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
                  >
                    {changePassBusy ? 'Обновляю…' : 'Сохранить новую фразу'}
                  </button>
                </div>
              </form>
            ) : null}
          </div>

          {/* Connected devices roster */}
          {status.devices.length > 0 ? (
            <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                Подключённые устройства ({status.devices.length})
              </div>
              <div className="flex flex-col gap-1.5">
                {status.devices.map((dev) => (
                  <div
                    key={dev.deviceId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-[var(--k-bg-surface-1)]/70 border border-[var(--k-border-hairline)] px-3 py-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <PlatformIcon platform={dev.platform} />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)] truncate flex items-center gap-1.5">
                          <span className="truncate">{dev.deviceName}</span>
                          {dev.isCurrent ? (
                            <span className="px-1.5 py-0.5 rounded bg-[var(--k-accent)]/15 text-[var(--k-accent)] text-[10px] font-medium shrink-0">
                              это устройство
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-[var(--k-ink-muted)]">
                          {platformLabel(dev.platform)} · активность: {formatLastSeenIso(dev.lastSeenAt)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Progressive disclosure: Optional custom sync server (zero technical brand jargon) */}
      <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-4 py-3">
        <button
          type="button"
          onClick={() => setShowCustomServer((v) => !v)}
          className="w-full flex items-center justify-between text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>
              {status.hasCustomServer
                ? `Свой сервер синхронизации: ${status.supabaseUrl}`
                : 'Свой сервер синхронизации (сейчас используется облако Kapsula)'}
            </span>
          </span>
          <span className="text-[11px] text-[var(--k-ink-muted)]">
            {showCustomServer ? 'Скрыть' : 'Изменить'}
          </span>
        </button>

        {showCustomServer ? (
          <form onSubmit={handleSaveCustomServer} className="mt-3 flex flex-col gap-2">
            <input
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="Адрес сервера синхронизации (https://…)"
              className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <input
              type="password"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              placeholder="Публичный ключ доступа (оставь пустым для сброса)"
              className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <div className="flex justify-end gap-2">
              {status.hasCustomServer ? (
                <button
                  type="button"
                  disabled={savingServer}
                  onClick={() => void handleResetServer()}
                  className="h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-50"
                >
                  Сбросить
                </button>
              ) : null}
              <button
                type="submit"
                disabled={savingServer}
                className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
              >
                {savingServer ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
};
