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
import { useI18n } from '@shared/i18n/react';
import type { I18nTranslator } from '@shared/i18n/types';
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

function evaluatePassphraseStrength(
  raw: string,
  t: I18nTranslator['t']
): PassphraseStrength {
  const value = raw.trim();
  if (!value) {
    return {
      score: 0,
      label: t('sync.pass.minLen', { min: MIN_NEW_PASSPHRASE_LENGTH }),
      color: 'var(--k-ink-muted)',
    };
  }
  if (value.length < MIN_NEW_PASSPHRASE_LENGTH) {
    return {
      score: 1,
      label: t('sync.pass.short', { left: MIN_NEW_PASSPHRASE_LENGTH - value.length }),
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
    return { score: 4, label: t('sync.pass.strong'), color: 'var(--k-emerald)' };
  }
  if (value.length >= 12 || classes >= 3) {
    return { score: 3, label: t('sync.pass.good'), color: 'var(--k-emerald)' };
  }
  return {
    score: 2,
    label: t('sync.pass.medium'),
    color: 'var(--k-amber)',
  };
}

const PassphraseStrengthMeter: React.FC<{ value: string }> = ({ value }) => {
  const { t } = useI18n();
  const { score, label, color } = evaluatePassphraseStrength(value, t);
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

function formatSyncTime(
  ts: number | null | undefined,
  t: I18nTranslator['t'],
  dateLocale: string
): string {
  if (!ts) return t('sync.time.never');
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 15) return t('date.justNow');
  if (diffSec < 60) return t('date.secondsAgo', { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('date.minutesAgo', { count: diffMin });
  return new Date(ts).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeenIso(
  iso: string,
  t: I18nTranslator['t'],
  dateLocale: string
): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  return formatSyncTime(ts, t, dateLocale);
}

function platformLabel(platform: SyncPlatform, t: I18nTranslator['t']): string {
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
      return t('sync.platform.web');
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
  const { t, locale, dateLocale } = useI18n();
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
        {t('sync.loading')}
      </div>
    );
  }

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      toast.info(t('sync.enterEmailPass'));
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
        toast.error(res.error || t('sync.signInErr'));
        return;
      }
      setPassword('');
      if (res.needsEmailConfirmation) {
        toast.success(t('sync.confirmEmailSent'));
        setAuthMode('signin');
      } else if (res.needsPassphraseSetup) {
        toast.success(t('sync.accountCreatedSetPass'));
        onAuthChanged?.();
      } else if (res.needsPassphraseUnlock) {
        toast.info(t('sync.enterFirstDevicePass'));
        onAuthChanged?.();
      } else {
        toast.success(t('sync.connectedToast'));
        onAuthChanged?.();
        onVaultChanged?.();
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.cloudConnectErr'), locale));
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
        toast.error(res.error || t('sync.googleErr'));
        return;
      }
      onAuthChanged?.();
      if (res.needsPassphraseSetup) {
        toast.success(t('sync.googleSetPass'));
      } else if (res.needsPassphraseUnlock) {
        toast.info(t('sync.googleEnterPass'));
      } else {
        toast.success(t('sync.googleConnected'));
        onVaultChanged?.();
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.googleStartErr'), locale));
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleSetupPassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passphrase.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
      toast.info(t('sync.passMinHint', { min: MIN_NEW_PASSPHRASE_LENGTH }));
      return;
    }
    if (passphrase !== passphraseConfirm) {
      toast.error(t('sync.passMismatch'));
      return;
    }
    setCryptoBusy(true);
    try {
      const res = await window.kapsula.syncSetupPassphrase(passphrase);
      setStatus(res.status);
      if (!res.ok) {
        toast.error(res.error || t('sync.cryptoSetupErr'));
        return;
      }
      setPassphrase('');
      setPassphraseConfirm('');
      if (res.recoveryKey) {
        onFreshRecoveryKeyChange(res.recoveryKey);
        setCopiedRecovery(false);
      }
      if (res.initialSyncOk === false) {
        toast.warning(t('sync.keyCreatedPushPending'));
      } else {
        toast.success(t('sync.e2eEnabledToast'));
      }
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.cryptoSetupErr'), locale));
    } finally {
      setCryptoBusy(false);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (unlockMode === 'recovery' && recoveryNewPass.trim()) {
      if (recoveryNewPass.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
        toast.info(t('sync.newPassMinHint', { min: MIN_NEW_PASSPHRASE_LENGTH }));
        return;
      }
      if (recoveryNewPass !== recoveryNewPassConfirm) {
        toast.error(t('sync.newPassMismatch'));
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
        toast.error(res.error || t('sync.unlockErr'));
        return;
      }
      setPassphrase('');
      setRecoveryInput('');
      setRecoveryNewPass('');
      setRecoveryNewPassConfirm('');
      toast.success(t('sync.unlockToast'));
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.unlockGenericErr'), locale));
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
        if (res.pushed) parts.push(t('sync.pushedPart', { count: res.pushed }));
        if (res.pulled) parts.push(t('sync.pulledPart', { count: res.pulled }));
        toast.success(parts.length ? t('sync.syncedSummary', { parts: parts.join(', ') }) : t('sync.allUpToDate'));
        if (res.pulled) onVaultChanged?.();
      } else {
        toast.error(res.error || t('sync.syncFailed'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.syncErr'), locale));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleReconcileFull = async () => {
    setReconcileBusy(true);
    try {
      const next = await window.kapsula.reconcileFullSync();
      setStatus(next);
      toast.success(t('sync.reconcileDone'));
      onVaultChanged?.();
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.reconcileErr'), locale));
    } finally {
      setReconcileBusy(false);
    }
  };

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassDraft.trim().length < MIN_NEW_PASSPHRASE_LENGTH) {
      toast.info(t('sync.newPassMinHint', { min: MIN_NEW_PASSPHRASE_LENGTH }));
      return;
    }
    if (newPassDraft !== newPassConfirmDraft) {
      toast.error(t('sync.newPassMismatch'));
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
        toast.error(res.error || t('sync.changePassErr'));
        return;
      }
      setCurPassDraft('');
      setNewPassDraft('');
      setNewPassConfirmDraft('');
      setShowChangePass(false);
      toast.success(t('sync.changePassDone'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.changePassFail'), locale));
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
        toast.error(res.error || t('sync.regenErr'));
        return;
      }
      onFreshRecoveryKeyChange(res.recoveryKey);
      setCopiedRecovery(false);
      toast.success(t('sync.regenDone'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.regenErr'), locale));
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
      toast(t('sync.signedOutToast'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.signOutErr'), locale));
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
          ? t('sync.customServerConnected')
          : t('sync.defaultServerRestored')
      );
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.customServerErr'), locale));
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
      toast.success(t('sync.resetServerDone'));
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('sync.resetServerErr'), locale));
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
              <span>{t('sync.recovery.title')}</span>
            </div>
            <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
              {t('sync.recovery.desc')}
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
                    ? t('sync.recovery.copiedWipe', { seconds: res.wipeSeconds })
                    : t('sync.recovery.copied')
                );
              }}
              className={`k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium cursor-pointer ${
                copiedRecovery
                  ? 'bg-[var(--k-emerald)] text-white'
                  : 'bg-[var(--k-accent)] text-[var(--k-ink-on-accent)]'
              }`}
            >
              {copiedRecovery ? <Check weight="bold" className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedRecovery ? t('sync.recovery.keyCopiedBtn') : t('sync.recovery.copyKeyBtn')}</span>
            </button>
            <button
              type="button"
              onClick={() => onFreshRecoveryKeyChange(null)}
              className="k-interactive inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
            >
              <span>{t('sync.recovery.doneBtn')}</span>
            </button>
            {copiedRecovery ? (
              <span className="text-[11.5px] text-[var(--k-emerald)] inline-flex items-center gap-1">
                <CheckCircle weight="fill" className="w-3.5 h-3.5" />
                {t('sync.recovery.safeHint')}
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
                {t('sync.header.title')}
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                {t('sync.header.desc')}
              </div>
            </div>
          </div>

          {status.state === 'awaiting_email_confirm' ? (
            <div className="rounded-lg border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] px-3 py-2.5 text-[12px] text-[var(--k-ink-primary)]">
              {t('sync.confirmEmailBanner', { email: status.email || '' })}
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
            <span>{googleBusy ? t('sync.googleWait') : t('sync.googleBtn')}</span>
          </button>

          <div className="flex items-center gap-2.5 text-[11px] text-[var(--k-ink-muted)]">
            <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
            <span>{t('sync.orEmailPass')}</span>
            <span className="h-px flex-1 bg-[var(--k-border-hairline)]" />
          </div>

          <SegmentedControl<'signup' | 'signin'>
            value={authMode}
            onChange={setAuthMode}
            size="sm"
            fullWidth
            options={[
              { value: 'signup', label: t('sync.tab.signup') },
              { value: 'signin', label: t('sync.tab.signin') },
            ]}
          />

          <form onSubmit={handleAuthSubmit} className="flex flex-col gap-2.5">
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('sync.emailPlaceholder')}
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
              placeholder={t('sync.passwordPlaceholder')}
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
                ? t('common.connecting')
                : authMode === 'signup'
                  ? t('sync.createAccountBtn')
                  : t('sync.signInBtn')}
            </button>
            {authMode === 'signup' ? (
              <div className="text-[11.5px] text-[var(--k-ink-muted)] text-center">
                {t('sync.noVerifyNeeded')}
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
                <span>{t('sync.setPassTitle')}</span>
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                {t('sync.setPassDesc', { email: status.email || '', min: MIN_NEW_PASSPHRASE_LENGTH })}
              </div>
            </div>
            <button
              type="button"
              disabled={signOutBusy}
              onClick={() => void handleSignOut()}
              className="text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0 disabled:opacity-50"
            >
              {t('sync.signOutBtn')}
            </button>
          </div>

          <form onSubmit={handleSetupPassphrase} className="flex flex-col gap-2.5">
            <input
              type="password"
              required
              minLength={MIN_NEW_PASSPHRASE_LENGTH}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t('sync.passPlaceholder', { min: MIN_NEW_PASSPHRASE_LENGTH })}
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
              placeholder={t('sync.repeatPassPlaceholder')}
              data-testid="sync-setup-passphrase-confirm"
              className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[13px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <button
              type="submit"
              disabled={cryptoBusy || passphrase.trim().length < MIN_NEW_PASSPHRASE_LENGTH}
              data-testid="sync-setup-passphrase-submit"
              className="k-interactive h-9 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:cursor-default"
            >
              {cryptoBusy ? t('sync.cryptoCreating') : t('sync.enableE2eBtn')}
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
                <span>{t('sync.unlockTitle')}</span>
              </div>
              <div className="text-[12px] text-[var(--k-ink-secondary)] mt-0.5 leading-relaxed">
                {t('sync.unlockDesc', { email: status.email || '' })}
              </div>
            </div>
            <button
              type="button"
              disabled={signOutBusy}
              onClick={() => void handleSignOut()}
              className="text-[11.5px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0 disabled:opacity-50"
            >
              {t('sync.signOutBtn')}
            </button>
          </div>

          <SegmentedControl<'passphrase' | 'recovery'>
            value={unlockMode}
            onChange={setUnlockMode}
            size="sm"
            fullWidth
            options={[
              { value: 'passphrase', label: t('sync.mode.passphrase') },
              { value: 'recovery', label: t('sync.mode.recovery') },
            ]}
          />

          <form onSubmit={handleUnlockSubmit} className="flex flex-col gap-2.5">
            {unlockMode === 'passphrase' ? (
              <input
                type="password"
                required
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('sync.yourPassPlaceholder')}
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
                    placeholder={t('sync.newPassOptional')}
                    className="h-9 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-3 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                  <input
                    type="password"
                    value={recoveryNewPassConfirm}
                    onChange={(e) => setRecoveryNewPassConfirm(e.target.value)}
                    placeholder={t('sync.repeatNewPass')}
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
              {cryptoBusy ? t('sync.verifyingAndLoading') : t('sync.connectDeviceBtn')}
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
                        ? t('sync.state.syncing')
                        : status.state === 'offline'
                          ? t('sync.state.offline')
                          : status.state === 'error'
                            ? t('sync.state.retry')
                            : t('sync.state.active')}
                    </span>
                    {status.realtimeConnected ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] text-[10.5px] font-medium whitespace-nowrap shrink-0">
                        {t('sync.realtimeBadge')}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-[var(--k-ink-secondary)] k-tabular truncate mt-0.5">
                    {t('sync.statusUpdated', {
                      email: status.email || '',
                      when: formatSyncTime(status.lastSyncAt, t, dateLocale),
                    })}
                    {status.pendingCount > 0
                      ? t('sync.statusPending', { count: status.pendingCount })
                      : ''}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={reconcileBusy || syncBusy || status.state === 'syncing'}
                  onClick={() => void handleReconcileFull()}
                  data-testid="sync-reconcile-btn"
                  title={t('sync.reconcileTitle')}
                  className="k-interactive inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)] hover:bg-[var(--k-bg-surface-3)] text-[12px] font-medium cursor-pointer shrink-0 disabled:opacity-60"
                >
                  <ShieldCheck className={`w-3.5 h-3.5 text-[var(--k-accent)] ${reconcileBusy ? 'animate-pulse' : ''}`} />
                  <span>{reconcileBusy ? t('sync.reconcileBusy') : t('sync.reconcileBtn')}</span>
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
                  <span>{t('sync.syncNowBtn')}</span>
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
                  <span>{t('sync.failedBanner', { count: failedCount })}</span>
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
                  {t('sync.statsLine', { count: status.syncedRecordsCount })}
                  {status.lastReconcileAt
                    ? t('sync.reconcileAt', { when: formatSyncTime(status.lastReconcileAt, t, dateLocale) })
                    : ''}
                </span>
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={regenBusy}
                  onClick={() => void handleRegenerateRecovery()}
                  className="text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer disabled:opacity-50"
                >
                  {regenBusy ? t('sync.regenBusy') : t('sync.regenBtn')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowChangePass((v) => !v)}
                  className="text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  {t('sync.changePassBtn')}
                </button>
                <button
                  type="button"
                  disabled={signOutBusy}
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] cursor-pointer disabled:opacity-50"
                >
                  <SignOut className="w-3.5 h-3.5" />
                  <span>{t('sync.signOutBtn')}</span>
                </button>
              </div>
            </div>

            {showChangePass ? (
              <form
                onSubmit={handleChangePassphrase}
                className="pt-2 border-t border-[var(--k-border-hairline)] flex flex-col gap-2"
              >
                <div className="text-[12px] text-[var(--k-ink-secondary)]">
                  {t('sync.changePassNote')}
                </div>
                <input
                  type="password"
                  required
                  value={curPassDraft}
                  onChange={(e) => setCurPassDraft(e.target.value)}
                  placeholder={t('sync.currentPassPh')}
                  className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSPHRASE_LENGTH}
                    value={newPassDraft}
                    onChange={(e) => setNewPassDraft(e.target.value)}
                    placeholder={t('sync.newPassMinPh', { min: MIN_NEW_PASSPHRASE_LENGTH })}
                    className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12.5px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
                  />
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSPHRASE_LENGTH}
                    value={newPassConfirmDraft}
                    onChange={(e) => setNewPassConfirmDraft(e.target.value)}
                    placeholder={t('sync.repeatNewPass')}
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
                    {changePassBusy ? t('common.updating') : t('sync.saveNewPassBtn')}
                  </button>
                </div>
              </form>
            ) : null}
          </div>

          {/* Connected devices roster */}
          {status.devices.length > 0 ? (
            <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-4 flex flex-col gap-2">
              <div className="text-[12.5px] font-medium text-[var(--k-ink-primary)]">
                {t('sync.devicesHeading', { count: status.devices.length })}
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
                              {t('sync.thisDevice')}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-[var(--k-ink-muted)]">
                          {t('sync.deviceActivity', {
                            platform: platformLabel(dev.platform, t),
                            when: formatLastSeenIso(dev.lastSeenAt, t, dateLocale),
                          })}
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
                ? t('sync.customServerActive', { url: status.supabaseUrl })
                : t('sync.customServerDefault')}
            </span>
          </span>
          <span className="text-[11px] text-[var(--k-ink-muted)]">
            {showCustomServer ? t('common.hide') : t('common.edit')}
          </span>
        </button>

        {showCustomServer ? (
          <form onSubmit={handleSaveCustomServer} className="mt-3 flex flex-col gap-2">
            <input
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder={t('sync.serverUrlPlaceholder')}
              className="h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] px-2.5 text-[12px] text-[var(--k-ink-primary)] outline-none focus:border-[var(--k-accent)]"
            />
            <input
              type="password"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              placeholder={t('sync.serverKeyPlaceholder')}
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
                  {t('common.reset')}
                </button>
              ) : null}
              <button
                type="submit"
                disabled={savingServer}
                className="k-interactive h-8 px-3 rounded-lg bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-medium cursor-pointer disabled:opacity-60"
              >
                {savingServer ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
};
