import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  Eye,
  EyeSlash,
  Key,
  Lock,
  LockOpen,
  ShieldCheck,
  Trash,
  User,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { SecretCopyField, SecretPayload, TotpCodeSnapshot, VaultItem } from '@shared/types';
import { formatCardPanGroups } from '../../lib/format';
import { CopySlotPill } from '../ui/CopySlotPill';
import { SecretMorphField } from '../ui/SecretMorphField';

interface VaultSecretCardProps {
  item: VaultItem;
  compactList?: boolean;
  vaultLocked: boolean;
  wipeSeconds: number;
  onOpen?: (item: VaultItem) => void;
  onDelete: (id: string) => void;
  onUnlockRequest: () => void;
}

const CARD_BRAND_LABEL: Record<string, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  mir: 'МИР',
  amex: 'AMEX',
  unionpay: 'UnionPay',
};

const AUTO_REMASK_SECONDS = 30;

function formatTotpDisplay(code: string): string {
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

interface TotpCountdownRingProps {
  remainingSec: number;
  period: number;
  size?: number;
}

const TotpCountdownRing: React.FC<TotpCountdownRingProps> = ({
  remainingSec,
  period,
  size = 20,
}) => {
  const stroke = 2.2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, remainingSec / Math.max(1, period)));
  const offset = c * (1 - ratio);
  const urgent = remainingSec <= 5;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--k-border-strong)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={urgent ? 'var(--k-amber)' : 'var(--k-accent)'}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.85s linear, stroke 180ms ease' }}
      />
    </svg>
  );
};

export const VaultSecretCard: React.FC<VaultSecretCardProps> = ({
  item,
  compactList = false,
  vaultLocked,
  wipeSeconds,
  onOpen,
  onDelete,
  onUnlockRequest,
}) => {
  const [revealed, setRevealed] = useState(false);
  const [revealSecLeft, setRevealSecLeft] = useState(0);
  const [payload, setPayload] = useState<SecretPayload | null>(null);
  const [loadingReveal, setLoadingReveal] = useState(false);
  const [totpSnap, setTotpSnap] = useState<TotpCodeSnapshot | null>(null);
  const [totpCopied, setTotpCopied] = useState(false);

  const meta = item.secretMeta;
  const kind = meta?.kind ?? 'note';
  const hasTotp = Boolean(meta?.hasTotp);
  const isTrashed = Boolean(item.deletedAt);

  useEffect(() => {
    if (vaultLocked || isTrashed) {
      setRevealed(false);
      setRevealSecLeft(0);
      setPayload(null);
      setTotpSnap(null);
    }
  }, [vaultLocked, isTrashed]);

  useEffect(() => {
    setRevealed(false);
    setRevealSecLeft(0);
    setPayload(null);
  }, [item.id, item.updatedAt, item.contentUpdatedAt]);

  const effectiveRevealed = revealed && !vaultLocked && !isTrashed;

  // 30-second auto-re-mask countdown when revealed
  useEffect(() => {
    if (!effectiveRevealed) {
      setRevealSecLeft(0);
      return;
    }
    setRevealSecLeft(AUTO_REMASK_SECONDS);
    const timer = window.setInterval(() => {
      setRevealSecLeft((prev) => {
        if (prev <= 1) {
          setRevealed(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [effectiveRevealed]);

  // Live 1s polling for 2FA TOTP code when secret has TOTP and vault is unlocked (never in Trash)
  useEffect(() => {
    if (!hasTotp || vaultLocked || isTrashed) {
      setTotpSnap(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      window.kapsula
        .getTotpCode(item.id)
        .then((snap) => {
          if (!cancelled) setTotpSnap(snap);
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [item.id, hasTotp, vaultLocked, isTrashed, item.updatedAt]);

  const handleToggleReveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTrashed) return;
    if (effectiveRevealed) {
      setRevealed(false);
      return;
    }
    if (vaultLocked) {
      onUnlockRequest();
      return;
    }
    if (payload) {
      setRevealed(true);
      return;
    }
    setLoadingReveal(true);
    try {
      const dec = await window.kapsula.revealSecret(item.id);
      if (!dec) {
        onUnlockRequest();
        return;
      }
      setPayload(dec);
      setRevealed(true);
    } catch {
      toast.error('Сначала разблокируй Сейф мастер-кодом');
      onUnlockRequest();
    } finally {
      setLoadingReveal(false);
    }
  };

  const handleCopyField = async (field: SecretCopyField): Promise<number | boolean> => {
    if (vaultLocked) {
      onUnlockRequest();
      return false;
    }
    try {
      const res = await window.kapsula.copySecretField(item.id, field);
      if (!res.ok) {
        if (res.locked) onUnlockRequest();
        else toast.error('Не удалось скопировать данные');
        return false;
      }
      if (field === 'expiry' || field === 'login') {
        if (field === 'expiry') toast.success('Срок карты скопирован');
        return true;
      }
      if (field === 'totp') {
        setTotpCopied(true);
        window.setTimeout(() => setTotpCopied(false), 1600);
        toast.success('2FA-код скопирован');
        return true;
      }
      const effectiveWipe = res.wipeSeconds ?? wipeSeconds ?? 30;
      return effectiveWipe > 0 ? effectiveWipe : true;
    } catch {
      toast.error('Не удалось скопировать данные');
      return false;
    }
  };

  const handleCopyDefault = async (): Promise<number | boolean> => {
    if (vaultLocked) {
      onUnlockRequest();
      return false;
    }
    try {
      const res = await window.kapsula.copySecret(item.id);
      if (!res.ok) {
        if (res.locked) onUnlockRequest();
        else toast.error('Не удалось скопировать секрет');
        return false;
      }
      const effectiveWipe = res.wipeSeconds ?? wipeSeconds ?? 30;
      return effectiveWipe > 0 ? effectiveWipe : true;
    } catch {
      toast.error('Не удалось скопировать секрет');
      return false;
    }
  };

  const renderTotpStrip = () => {
    if (!hasTotp || isTrashed) return null;
    if (vaultLocked) {
      return (
        <div className="mb-2.5 flex items-center justify-between gap-2 rounded-xl bg-[var(--k-bg-surface-2)]/85 border border-[var(--k-border-hairline)] px-2.5 py-1.5 text-[11.5px] text-[var(--k-ink-secondary)]">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--k-amber)]" />
            <span>2FA-код под мастер-кодом</span>
          </span>
          <span className="k-mono tracking-wider text-[var(--k-ink-muted)]">••• •••</span>
        </div>
      );
    }
    if (!totpSnap) return null;
    const urgent = totpSnap.remainingSec <= 5;
    return (
      <div
        data-testid={`secret-totp-row-${item.id}`}
        onClick={(e) => {
          e.stopPropagation();
          void handleCopyField('totp');
        }}
        title="Нажми, чтобы скопировать 2FA-код"
        className="k-interactive mb-2.5 flex items-center justify-between gap-2 rounded-xl bg-[var(--k-bg-surface-2)]/85 hover:bg-[var(--k-bg-surface-3)]/75 border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] px-2.5 py-1.5 cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <TotpCountdownRing remainingSec={totpSnap.remainingSec} period={totpSnap.period} size={20} />
          <span className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-muted)] font-semibold">
            2FA
          </span>
          <span
            data-testid={`secret-totp-code-${item.id}`}
            className={`k-mono text-[14.5px] font-semibold tracking-[0.12em] ${
              urgent ? 'text-[var(--k-amber)]' : 'text-[var(--k-ink-primary)]'
            }`}
          >
            {formatTotpDisplay(totpSnap.code)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`k-mono text-[11px] k-tabular ${
              urgent ? 'text-[var(--k-amber)] font-semibold' : 'text-[var(--k-ink-secondary)]'
            }`}
          >
            {totpSnap.remainingSec} с
          </span>
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]">
            {totpCopied ? (
              <Check weight="bold" className="w-3 h-3 text-[var(--k-emerald)]" />
            ) : (
              <Copy className="w-3 h-3 opacity-80" />
            )}
          </span>
        </div>
      </div>
    );
  };

  if (kind === 'bank_card') {
    const brandName =
      (meta?.cardBrand && (CARD_BRAND_LABEL[meta.cardBrand.toLowerCase()] || meta.cardBrand)) ||
      'КАРТА';
    const last4 = meta?.last4 || '••••';
    const maskedPan = `••••  ••••  ••••  ${last4}`;
    const revealedPan = effectiveRevealed && payload?.secretValue ? formatCardPanGroups(payload.secretValue) : null;
    const expiryText = meta?.expiry || (effectiveRevealed ? payload?.expiry : undefined);
    const hasCvv = Boolean(meta?.hasCvv || payload?.cvv);

    if (compactList) {
      return (
        <div
          data-testid={`secret-card-${item.id}`}
          onClick={() => {
            if (!isTrashed) onOpen?.(item);
          }}
          style={{
            background: 'linear-gradient(155deg, var(--k-bg-surface-1) 0%, var(--k-bg-surface-2) 100%)',
          }}
          className="k-card-lift rounded-2xl border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] px-4 py-2.5 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-card)] flex items-center justify-between gap-3 cursor-pointer"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent-soft)] border border-[var(--k-accent)]/20 shrink-0">
              <CreditCard weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
            </span>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold truncate text-[var(--k-ink-primary)]">
                {item.title || 'Банковская карта'}
              </div>
              <div className="k-mono text-[11.5px] text-[var(--k-ink-secondary)] truncate">
                {brandName} · •••• {last4}{expiryText ? ` · ${expiryText}` : ''}
              </div>
            </div>
          </div>

          {!isTrashed ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <CopySlotPill
                data-testid={`secret-copy-pan-${item.id}`}
                label="Номер"
                copiedLabel="Готово"
                widthPx={100}
                heightPx={28}
                tone="default"
                className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                wipeSeconds={wipeSeconds ?? 30}
                onCopy={() => handleCopyField('secretValue')}
              />
              {expiryText ? (
                <CopySlotPill
                  data-testid={`secret-copy-expiry-${item.id}`}
                  label={expiryText}
                  copiedLabel="Готово"
                  widthPx={84}
                  heightPx={28}
                  tone="default"
                  className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                  onCopy={() => handleCopyField('expiry')}
                />
              ) : null}
              {hasCvv ? (
                <CopySlotPill
                  data-testid={`secret-copy-cvv-${item.id}`}
                  label="CVV"
                  copiedLabel="Готово"
                  widthPx={98}
                  heightPx={28}
                  tone="default"
                  className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                  wipeSeconds={wipeSeconds ?? 30}
                  onCopy={() => handleCopyField('cvv')}
                />
              ) : null}
            </div>
          ) : (
            <span className="text-[11px] text-[var(--k-ink-muted)] shrink-0">Скрыто в корзине</span>
          )}
        </div>
      );
    }

    return (
      <div
        data-testid={`secret-card-${item.id}`}
        onClick={() => {
          if (!isTrashed) onOpen?.(item);
        }}
        style={{
          background: 'linear-gradient(155deg, var(--k-bg-surface-1) 0%, var(--k-bg-surface-2) 100%)',
        }}
        className="group relative k-card-lift rounded-2xl border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] p-4 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-card)] hover:shadow-[var(--k-shadow-card-hover)] overflow-clip cursor-pointer"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-10 w-36 h-36 rounded-full blur-2xl opacity-75"
          style={{ background: 'var(--k-accent-soft)' }}
        />

        {/* Header Row */}
        <div className="relative flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent-soft)] border border-[var(--k-accent)]/20 shrink-0">
              <CreditCard weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
            </span>
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold leading-tight truncate text-[var(--k-ink-primary)]">
                {item.title || 'Банковская карта'}
              </div>
              <div className="text-[10.5px] tracking-wider uppercase text-[var(--k-ink-muted)] font-medium">
                {brandName}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {effectiveRevealed && revealSecLeft > 0 ? (
              <span
                title="Данные автоматически скроются"
                className="k-mono k-tabular text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]"
              >
                {revealSecLeft} с
              </span>
            ) : null}
            {!isTrashed ? (
              <button
                type="button"
                data-testid={`secret-reveal-${item.id}`}
                disabled={loadingReveal}
                onClick={(e) => void handleToggleReveal(e)}
                aria-label={effectiveRevealed ? 'Скрыть данные карты' : 'Показать данные карты'}
                className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--k-bg-surface-1)]/85 border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer shrink-0"
              >
                {vaultLocked ? (
                  <Lock className="w-3.5 h-3.5 text-[var(--k-amber)]" />
                ) : effectiveRevealed ? (
                  <EyeSlash className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            ) : null}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(item.id);
              }}
              aria-label="Удалить карту"
              className="k-interactive inline-flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity duration-140 items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer shrink-0"
            >
              <Trash className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* PAN Line */}
        <div className="relative h-7 flex items-center mb-2.5 overflow-clip">
          <SecretMorphField
            revealed={effectiveRevealed}
            maskedText={maskedPan}
            revealedText={revealedPan}
            className="text-[15px] tracking-[0.06em] font-medium text-[var(--k-ink-primary)] w-full"
          />
        </div>

        {/* Persistent Card Metadata Line */}
        <div className="relative flex items-center justify-between gap-3 text-[12px] text-[var(--k-ink-secondary)] mb-2.5">
          <span className="k-mono whitespace-nowrap">
            {expiryText ? (
              <>
                <span className="text-[10.5px] text-[var(--k-ink-muted)] mr-1.5">СРОК</span>
                <span className="text-[var(--k-ink-primary)]">{expiryText}</span>
              </>
            ) : (
              <span className="text-[11px] text-[var(--k-ink-muted)]">Срок не указан</span>
            )}
          </span>
          {hasCvv ? (
            <span
              data-testid={`secret-cvv-display-${item.id}`}
              className="k-mono whitespace-nowrap inline-flex items-center gap-1 shrink-0"
            >
              <span className="text-[10.5px] text-[var(--k-ink-muted)]">CVV</span>
              <SecretMorphField
                revealed={effectiveRevealed}
                maskedText="•••"
                revealedText={effectiveRevealed ? payload?.cvv || '•••' : '•••'}
                className="text-[var(--k-ink-primary)]"
              />
            </span>
          ) : null}
        </div>

        {renderTotpStrip()}

        {/* Revealed Comment Preview */}
        {effectiveRevealed && payload?.notes?.trim() ? (
          <div className="relative mb-2.5 rounded-lg bg-[var(--k-bg-surface-1)]/75 border border-[var(--k-border-hairline)] px-2.5 py-1.5 text-[11.5px] leading-snug text-[var(--k-ink-secondary)] line-clamp-2 whitespace-pre-wrap">
            {payload.notes.trim()}
          </div>
        ) : null}

        {/* Copy Pills Row */}
        <div className="relative flex items-center gap-1.5 pt-2.5 border-t border-[var(--k-border-hairline)]">
          {isTrashed ? (
            <span className="text-[11.5px] text-[var(--k-ink-muted)]">
              Скрыто в корзине · восстанови, чтобы открыть в Сейфе
            </span>
          ) : (
            <>
              <CopySlotPill
                data-testid={`secret-copy-pan-${item.id}`}
                label="Номер"
                copiedLabel="Готово"
                widthPx={100}
                heightPx={28}
                tone="default"
                className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                wipeSeconds={wipeSeconds ?? 30}
                onCopy={() => handleCopyField('secretValue')}
              />
              {expiryText ? (
                <CopySlotPill
                  data-testid={`secret-copy-expiry-${item.id}`}
                  label={expiryText}
                  copiedLabel="Готово"
                  widthPx={82}
                  heightPx={28}
                  tone="default"
                  className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                  onCopy={() => handleCopyField('expiry')}
                />
              ) : null}
              {hasCvv ? (
                <CopySlotPill
                  data-testid={`secret-copy-cvv-${item.id}`}
                  label="CVV"
                  copiedLabel="Готово"
                  widthPx={98}
                  heightPx={28}
                  tone="default"
                  className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                  wipeSeconds={wipeSeconds ?? 30}
                  onCopy={() => handleCopyField('cvv')}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  // Password / API Key / Seed / Secret Note
  const Icon = kind === 'password' ? User : Key;
  const kindDefaultTitle =
    kind === 'password'
      ? 'Аккаунт'
      : kind === 'api_key'
        ? 'Секретный ключ'
        : kind === 'seed'
          ? 'Фраза восстановления'
          : kind === 'note'
            ? 'Секретная заметка'
            : 'Секрет';
  const kindLabel =
    kind === 'password'
      ? 'Пароль'
      : kind === 'api_key'
        ? 'Ключ доступа'
        : kind === 'seed'
          ? 'Фраза восстановления'
          : kind === 'note'
            ? 'Секретная заметка'
            : 'Секрет';
  const copyValueLabel =
    kind === 'password'
      ? 'Пароль'
      : kind === 'api_key'
        ? 'Ключ'
        : kind === 'seed'
          ? 'Фраза'
          : kind === 'note'
            ? 'Заметка'
            : 'Секрет';
  const hasLoginField = meta?.hasLogin ?? Boolean(meta?.loginHint && kind === 'password');
  const maskedBody =
    meta?.loginHint
      ? `${meta.loginHint} · ••••••••`
      : kind === 'api_key'
        ? `${meta?.service || 'Ключ'} · ••••••••••••`
        : '••••••••••••';

  const displayTitle = (item.title || kindDefaultTitle).trim();
  const normalizedTitle = displayTitle.toLowerCase();
  const normalizedService = (meta?.service || '').trim().toLowerCase();
  const subtitleText =
    meta?.service && normalizedService && normalizedService !== normalizedTitle
      ? meta.service.trim()
      : !meta?.service && kindLabel.toLowerCase() !== normalizedTitle
        ? kindLabel
        : null;

  return (
    <div
      data-testid={`secret-card-${item.id}`}
      onClick={() => {
        if (!isTrashed) onOpen?.(item);
      }}
      style={{
        background: 'linear-gradient(155deg, var(--k-bg-surface-1) 0%, var(--k-bg-surface-2) 100%)',
      }}
      className="group relative k-card-lift rounded-2xl border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] p-4 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-card)] hover:shadow-[var(--k-shadow-card-hover)] overflow-clip cursor-pointer"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 w-32 h-32 rounded-full blur-2xl opacity-60"
        style={{ background: 'var(--k-accent-soft)' }}
      />

      <div className="relative flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--k-accent-soft)] border border-[var(--k-accent)]/20 shrink-0">
            <Icon weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate text-[var(--k-ink-primary)]">
              {displayTitle}
            </div>
            {subtitleText ? (
              <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                {subtitleText}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {effectiveRevealed && revealSecLeft > 0 ? (
            <span
              title="Данные автоматически скроются"
              className="k-mono k-tabular text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]"
            >
              {revealSecLeft} с
            </span>
          ) : null}
          {!isTrashed ? (
            <button
              type="button"
              data-testid={`secret-reveal-${item.id}`}
              disabled={loadingReveal}
              onClick={(e) => void handleToggleReveal(e)}
              aria-label={effectiveRevealed ? 'Скрыть' : 'Показать'}
              className="k-interactive k-focus-ring inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--k-bg-surface-1)]/85 border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
            >
              {vaultLocked ? (
                <Lock className="w-3.5 h-3.5 text-[var(--k-amber)]" />
              ) : effectiveRevealed ? (
                <EyeSlash className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
            </button>
          ) : null}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item.id);
            }}
            aria-label="Удалить"
            className="k-interactive inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--k-ink-muted)] hover:text-[var(--k-danger)] hover:bg-[var(--k-danger-soft)] cursor-pointer opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
          >
            <Trash className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="relative rounded-xl bg-[var(--k-bg-surface-2)]/80 border border-[var(--k-border-hairline)] px-3 py-2 mb-2.5">
        {effectiveRevealed && payload?.login ? (
          <div className="text-[11.5px] text-[var(--k-ink-secondary)] truncate mb-0.5 k-selectable">
            {payload.login}
          </div>
        ) : null}
        <SecretMorphField
          revealed={effectiveRevealed}
          maskedText={maskedBody}
          revealedText={effectiveRevealed ? payload?.secretValue || '' : ''}
          className="text-[13px] text-[var(--k-ink-primary)] w-full truncate"
        />
      </div>

      {renderTotpStrip()}

      <div className="relative flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--k-ink-muted)]">
          {isTrashed ? (
            <>
              <Lock className="w-3 h-3 text-[var(--k-ink-muted)]" />
              <span>Скрыто в корзине</span>
            </>
          ) : vaultLocked ? (
            <>
              <Lock className="w-3 h-3 text-[var(--k-amber)]" />
              <span>Под кодом</span>
            </>
          ) : (
            <>
              <LockOpen className="w-3 h-3 text-[var(--k-emerald)]" />
              <span>Защищено</span>
            </>
          )}
        </span>

        {!isTrashed ? (
          <div className="flex items-center gap-1.5 shrink-0">
            {hasLoginField ? (
              <CopySlotPill
                data-testid={`secret-copy-login-${item.id}`}
                label="Логин"
                copiedLabel="Готово"
                widthPx={86}
                heightPx={28}
                tone="default"
                className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
                onCopy={() => handleCopyField('login')}
              />
            ) : null}
            <CopySlotPill
              data-testid={`secret-copy-value-${item.id}`}
              label={copyValueLabel}
              copiedLabel="Готово"
              widthPx={104}
              heightPx={28}
              tone="default"
              className="!bg-[var(--k-bg-surface-1)]/90 hover:!bg-[var(--k-bg-surface-2)]"
              wipeSeconds={wipeSeconds ?? 30}
              onCopy={handleCopyDefault}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
