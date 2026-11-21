import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Fingerprint, Lock, Timer } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { isMacPlatform } from '@shared/shortcuts';
import { friendlyErrorMessage } from '../../lib/format';
import { ModalDialog } from '../ui/ModalDialog';

interface UnlockPinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnlocked: () => void;
  biometricAvailable?: boolean;
  biometricEnabled?: boolean;
  initialLockoutSec?: number;
}

export const UnlockPinDialog: React.FC<UnlockPinDialogProps> = ({
  open,
  onOpenChange,
  onUnlocked,
  biometricAvailable,
  biometricEnabled,
  initialLockoutSec = 0,
}) => {
  const prefersReduced = useReducedMotion();
  const isMac = isMacPlatform(window.kapsula?.platform ?? 'win32');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [bioCanUse, setBioCanUse] = useState(Boolean(biometricAvailable && biometricEnabled));
  const [lockoutSec, setLockoutSec] = useState<number>(Math.max(0, Math.ceil(initialLockoutSec)));

  useEffect(() => {
    if (!open) {
      setPin('');
      setError(null);
      return;
    }
    setBioCanUse(Boolean(biometricAvailable && biometricEnabled));
    setLockoutSec(Math.max(0, Math.ceil(initialLockoutSec)));

    let cancelled = false;
    window.kapsula
      .getSettings()
      .then((st) => {
        if (cancelled) return;
        setBioCanUse(Boolean(st.biometricUnlockAvailable && st.biometricUnlockEnabled));
        if (typeof st.pinLockoutRemainingSec === 'number' && st.pinLockoutRemainingSec > 0) {
          setLockoutSec(Math.ceil(st.pinLockoutRemainingSec));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, biometricAvailable, biometricEnabled, initialLockoutSec]);

  useEffect(() => {
    if (!open || lockoutSec <= 0) return;
    const timer = window.setInterval(() => {
      setLockoutSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, lockoutSec > 0]);

  const refreshLockoutFromSettings = async () => {
    try {
      const st = await window.kapsula.getSettings();
      if (typeof st.pinLockoutRemainingSec === 'number' && st.pinLockoutRemainingSec > 0) {
        setLockoutSec(Math.ceil(st.pinLockoutRemainingSec));
      }
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim() || checking || lockoutSec > 0) return;
    setChecking(true);
    setError(null);
    try {
      const ok = await window.kapsula.unlockVaultPin(pin.trim());
      if (ok) {
        setPin('');
        setLockoutSec(0);
        onOpenChange(false);
        onUnlocked();
        toast.success('Сейф открыт');
      } else {
        setError('Неверный мастер-код');
        setShakeKey((k) => k + 1);
        await refreshLockoutFromSettings();
      }
    } catch (err) {
      setError(friendlyErrorMessage(err, 'Слишком много неверных попыток — подожди немного'));
      setShakeKey((k) => k + 1);
      await refreshLockoutFromSettings();
    } finally {
      setChecking(false);
    }
  };

  const handleBiometricUnlock = async () => {
    if (biometricBusy || checking) return;
    setBiometricBusy(true);
    setError(null);
    try {
      const res = await window.kapsula.promptBiometricUnlock();
      if (res.ok) {
        setPin('');
        setLockoutSec(0);
        onOpenChange(false);
        onUnlocked();
        toast.success('Сейф открыт');
      } else if (res.error) {
        setError(res.error);
      }
    } catch (err) {
      setError(friendlyErrorMessage(err, 'Не удалось выполнить биометрическую проверку'));
    } finally {
      setBiometricBusy(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Открыть Сейф"
      subtitle="Введи мастер-код, чтобы просматривать и копировать данные"
      maxWidthClass="max-w-[390px]"
    >
      <motion.form
        key={shakeKey}
        initial={shakeKey > 0 && !prefersReduced ? { transform: 'translate3d(0px, 0, 0)' } : false}
        animate={
          shakeKey > 0 && !prefersReduced
            ? {
                transform: [
                  'translate3d(0px, 0, 0)',
                  'translate3d(-8px, 0, 0)',
                  'translate3d(8px, 0, 0)',
                  'translate3d(-5px, 0, 0)',
                  'translate3d(5px, 0, 0)',
                  'translate3d(0px, 0, 0)',
                ],
              }
            : { transform: 'translate3d(0px, 0, 0)' }
        }
        transition={{ duration: prefersReduced ? 0 : 0.24, ease: [0.23, 1, 0.32, 1] }}
        onSubmit={handleSubmit}
        className="p-5 flex flex-col gap-3"
      >
        <div className="flex items-center gap-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-10 focus-within:border-[var(--k-border-focus)]">
          <Lock className="w-4 h-4 text-[var(--k-accent)] shrink-0" />
          <input
            autoFocus
            type="password"
            disabled={lockoutSec > 0}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="Мастер-код"
            data-testid="unlock-pin-input"
            className="flex-1 bg-transparent border-none outline-none text-[14px] k-mono disabled:opacity-50"
          />
        </div>

        {lockoutSec > 0 ? (
          <div
            data-testid="unlock-pin-lockout"
            className="flex items-center gap-2 rounded-xl border border-[var(--k-amber)]/35 bg-[var(--k-amber-soft)] px-3 py-2 text-[12px] text-[var(--k-amber)] k-tabular"
          >
            <Timer weight="bold" className="w-4 h-4 shrink-0" />
            <span>Слишком много попыток — повтори через {lockoutSec} с</span>
          </div>
        ) : error ? (
          <div className="text-[12px] text-[var(--k-danger)]">{error}</div>
        ) : null}

        <button
          type="submit"
          data-testid="unlock-pin-submit"
          disabled={checking || lockoutSec > 0 || !pin.trim()}
          className="k-interactive h-9 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
        >
          {lockoutSec > 0
            ? `Подожди ${lockoutSec} с`
            : checking
              ? 'Проверяю…'
              : 'Разблокировать'}
        </button>

        {bioCanUse ? (
          <button
            type="button"
            data-testid="unlock-biometric-btn"
            disabled={biometricBusy || checking}
            onClick={() => void handleBiometricUnlock()}
            className="k-interactive h-9 rounded-xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] hover:bg-[var(--k-bg-surface-3)] text-[var(--k-ink-primary)] text-[13px] font-medium inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Fingerprint className="w-4 h-4 text-[var(--k-accent)]" />
            <span>
              {biometricBusy
                ? 'Подтверди личность…'
                : isMac
                  ? 'Открыть через Touch ID'
                  : 'Войти по биометрии'}
            </span>
          </button>
        ) : null}
      </motion.form>
    </ModalDialog>
  );
};
