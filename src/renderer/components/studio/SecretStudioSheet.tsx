import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Check,
  CreditCard,
  Eye,
  EyeSlash,
  Key,
  Lock,
  LockOpen,
  PencilSimple,
  ShieldCheck,
  ShieldPlus,
  Trash,
  User,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { OrbitDef, SecretPayload, VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { formatCardExpiryDraft } from '@shared/russian-event-parser';
import { useSecondTicker } from '@shared/second-ticker';
import { generateTotp, isValidTotpInput, parseOtpAuthUri } from '@shared/totp';
import { formatCardPanGroups, friendlyErrorMessage } from '../../lib/format';
import { useTotpSnapshot } from '../../lib/totp-ticker';
import { CopySlotPill } from '../ui/CopySlotPill';
import { SelectMenu } from '../ui/SelectMenu';

interface SecretStudioSheetProps {
  item: VaultItem;
  orbits: OrbitDef[];
  vaultLocked: boolean;
  wipeSeconds: number;
  onUnlockRequest: () => void;
  onUpdated: (updated: VaultItem) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const CARD_BRAND_LABEL: Record<string, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  amex: 'AMEX',
  unionpay: 'UnionPay',
};

function formatTotpDisplay(code: string): string {
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

interface SheetTotpRingProps {
  remainingSec: number;
  period: number;
  size?: number;
}

const SheetTotpRing: React.FC<SheetTotpRingProps> = ({ remainingSec, period, size = 28 }) => {
  const stroke = 2.6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, remainingSec / Math.max(1, period)));
  const offset = c * (1 - ratio);
  const urgent = remainingSec <= 5;

  return (
    <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
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
      <span
        className={`absolute text-[9.5px] k-mono k-tabular font-semibold ${
          urgent ? 'text-[var(--k-amber)]' : 'text-[var(--k-ink-secondary)]'
        }`}
      >
        {remainingSec}
      </span>
    </div>
  );
};

export const SecretStudioSheet: React.FC<SecretStudioSheetProps> = ({
  item,
  orbits,
  vaultLocked,
  wipeSeconds,
  onUnlockRequest,
  onUpdated,
  onDelete,
  onClose,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [payload, setPayload] = useState<SecretPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState(item.title || '');
  const [service, setService] = useState(item.secretMeta?.service || '');
  const [login, setLogin] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [expiry, setExpiry] = useState(item.secretMeta?.expiry || '');
  const [cvv, setCvv] = useState('');
  const [notes, setNotes] = useState('');
  const [totpInput, setTotpInput] = useState('');
  const [showTotpSeed, setShowTotpSeed] = useState(false);
  const [orbit, setOrbit] = useState(item.orbit || '');

  const [showSecret, setShowSecret] = useState(false);
  const [showCvv, setShowCvv] = useState(false);

  const notesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusNotesOnEditRef = useRef(false);

  useEffect(() => {
    if (mode === 'edit' && focusNotesOnEditRef.current) {
      focusNotesOnEditRef.current = false;
      requestAnimationFrame(() => notesInputRef.current?.focus());
    }
  }, [mode]);

  const kind = item.secretMeta?.kind ?? 'password';
  const isCard = kind === 'bank_card';
  const hasTotp = Boolean(item.secretMeta?.hasTotp || payload?.totpSecret);
  const orbitObj = orbits.find((o) => o.id === (item.orbit || orbit));

  useEffect(() => {
    setMode('view');
    setTitle(item.title || '');
    setService(item.secretMeta?.service || '');
    setExpiry(item.secretMeta?.expiry || '');
    setOrbit(item.orbit || '');
    setShowSecret(false);
    setShowCvv(false);
    setShowTotpSeed(false);
    setPayload(null);
    setRevealFailed(false);
    setLogin('');
    setSecretValue('');
    setCvv('');
    setNotes('');
    setTotpInput('');

    if (vaultLocked) return;
    let cancelled = false;
    setLoading(true);
    window.kapsula
      .revealSecret(item.id)
      .then((dec) => {
        if (cancelled) return;
        if (!dec) {
          setRevealFailed(true);
          return;
        }
        setRevealFailed(false);
        setPayload(dec);
        setService(dec.service || item.secretMeta?.service || '');
        setLogin(dec.login || '');
        setSecretValue(dec.secretValue || '');
        setExpiry(dec.expiry || item.secretMeta?.expiry || '');
        setCvv(dec.cvv || '');
        setNotes(dec.notes || '');
        setTotpInput(dec.totpSecret || '');
      })
      .catch(() => {
        if (!cancelled) setRevealFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, vaultLocked]);

  // Shared 1Hz TOTP snapshot (IPC only on mount/update/period rollover)
  const totpSnap = useTotpSnapshot(
    item.id,
    hasTotp && !vaultLocked && mode === 'view',
    item.updatedAt
  );

  // Edit mode TOTP live validation & preview
  const trimmedTotp = totpInput.trim();
  const parsedEditTotp = useMemo(
    () => (trimmedTotp ? parseOtpAuthUri(trimmedTotp) : null),
    [trimmedTotp]
  );
  const editTotpValid = !trimmedTotp || isValidTotpInput(trimmedTotp);
  const editTickSec = useSecondTicker(mode === 'edit' && Boolean(parsedEditTotp));

  const editTotpPreview = useMemo(() => {
    if (!parsedEditTotp) return null;
    try {
      return generateTotp({
        secret: parsedEditTotp.secret,
        algorithm: parsedEditTotp.algorithm,
        digits: parsedEditTotp.digits,
        period: parsedEditTotp.period,
        nowMs: editTickSec * 1000,
      });
    } catch {
      return null;
    }
  }, [parsedEditTotp, editTickSec]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (vaultLocked) {
      onUnlockRequest();
      return;
    }
    if (loading || !payload || revealFailed) {
      toast.error(t('secret.sheet.revealFailed'));
      return;
    }
    const cleanCardDigits = secretValue.replace(/\D/g, '');
    if (isCard && cleanCardDigits.length < 12) {
      toast.info(t('secret.modal.errCard'));
      return;
    }
    if (!isCard && !secretValue.trim()) {
      toast.info(t('secret.modal.errSecret'));
      return;
    }
    if (trimmedTotp && !editTotpValid) {
      toast.info(t('secret.modal.errTotpShort'));
      return;
    }
    setSaving(true);
    try {
      const updated = await window.kapsula.saveStructuredSecret({
        id: item.id,
        kind,
        title: title.trim() || item.title,
        service: service.trim() || title.trim() || t('nav.vault'),
        login: login.trim() || undefined,
        secretValue: isCard ? secretValue.replace(/\D/g, '') : secretValue,
        expiry: isCard ? expiry.trim() || undefined : undefined,
        cvv: isCard ? cvv.trim() || undefined : undefined,
        notes: notes.trim() || undefined,
        totpUriOrSecret: trimmedTotp || '',
        ...(parsedEditTotp
          ? {
              totpAlgorithm: parsedEditTotp.algorithm,
              totpDigits: parsedEditTotp.digits,
              totpPeriod: parsedEditTotp.period,
            }
          : {}),
        orbit,
      });
      if (updated) {
        onUpdated(updated);
        setShowSecret(false);
        setShowCvv(false);
        setShowTotpSeed(false);
        setMode('view');
        toast.success(t('secret.sheet.updated'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('secret.sheet.saveFailed'), locale));
    } finally {
      setSaving(false);
    }
  };

  const Icon = isCard ? CreditCard : kind === 'password' ? User : kind === 'api_key' ? Key : ShieldCheck;
  const rawBrand = item.secretMeta?.cardBrand?.toLowerCase();
  const brandName =
    rawBrand === 'mir'
      ? t('vault.brand.mir')
      : (item.secretMeta?.cardBrand &&
          ((rawBrand && CARD_BRAND_LABEL[rawBrand]) || item.secretMeta.cardBrand)) ||
        t('vault.brand.cardFallback');
  const last4 = item.secretMeta?.last4 || (secretValue ? secretValue.replace(/\D/g, '').slice(-4) : '••••');
  const maskedPan = `••••  ••••  ••••  ${last4}`;
  const revealedPan = secretValue ? formatCardPanGroups(secretValue) : maskedPan;

  return (
    <div
      data-testid="secret-studio-sheet"
      className="flex flex-col h-full min-h-0 bg-[var(--k-bg-surface-1)] text-[var(--k-ink-primary)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--k-border-hairline)] shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-accent-soft)] text-[var(--k-accent)] shrink-0">
            <Icon weight="duotone" className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[14.5px] font-semibold truncate">{title || item.title}</div>
            <div className="text-[11.5px] text-[var(--k-ink-muted)] inline-flex items-center gap-1">
              {vaultLocked ? (
                <>
                  <Lock className="w-3 h-3 text-[var(--k-amber)]" />
                  <span>{t('vault.underMasterCodeLong')}</span>
                </>
              ) : (
                <>
                  <LockOpen className="w-3 h-3 text-[var(--k-emerald)]" />
                  <span>{t('vault.encryptedLocallyLong')}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!vaultLocked ? (
            mode === 'view' ? (
              <button
                type="button"
                data-testid="secret-edit-mode-btn"
                disabled={loading || !payload || revealFailed}
                onClick={() => setMode('edit')}
                className="k-interactive h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] hover:border-[var(--k-border-strong)] text-[12px] font-medium text-[var(--k-ink-primary)] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-default"
              >
                <PencilSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                <span>{t('common.edit')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMode('view')}
                className="k-interactive h-8 px-3 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
              >
                {t('secret.sheet.view')}
              </button>
            )
          ) : null}

          <button
            type="button"
            onClick={() => onDelete(item.id)}
            aria-label={t('secret.sheet.deleteAria')}
            className="k-interactive w-8 h-8 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-secondary)] hover:bg-[var(--k-danger-soft)] hover:text-[var(--k-danger)] cursor-pointer"
          >
            <Trash className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('secret.sheet.closeAria')}
            className="k-interactive w-8 h-8 rounded-lg inline-flex items-center justify-center text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] hover:text-[var(--k-ink-primary)] cursor-pointer"
          >
            <X weight="bold" className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {vaultLocked ? (
          <div className="rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-surface-2)] p-6 text-center flex flex-col items-center gap-3">
            <Lock className="w-8 h-8 text-[var(--k-amber)]" />
            <div className="text-[14px] font-semibold">{t('vault.lockedTitle')}</div>
            <div className="text-[12.5px] text-[var(--k-ink-secondary)]">
              {t('vault.lockedHint')}
            </div>
            <button
              type="button"
              onClick={onUnlockRequest}
              className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer"
            >
              {t('secret.sheet.enterPin')}
            </button>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'view' ? (
              <motion.div
                key="secret-view"
                data-testid="secret-view-mode"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, -4px, 0)' }}
                transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col gap-4"
              >
                {isCard ? (
                  /* Interactive Visual Bank Card Preview — theme-aware porcelain on Light, obsidian on Dark */
                  <div
                    style={{
                      background: 'linear-gradient(155deg, var(--k-bg-surface-1) 0%, var(--k-bg-surface-2) 100%)',
                    }}
                    className="relative rounded-2xl border border-[var(--k-border-hairline)] p-5 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-card)] overflow-hidden space-y-5"
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute -right-12 -top-12 w-44 h-44 rounded-full blur-2xl opacity-75"
                      style={{ background: 'var(--k-accent-soft)' }}
                    />

                    <div className="relative flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--k-ink-muted)] font-semibold">
                          {brandName}
                        </div>
                        <div className="text-[16px] font-semibold text-[var(--k-ink-primary)] mt-0.5">
                          {title || item.title || t('vault.type.bank_card')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const next = !showSecret;
                            setShowSecret(next);
                            setShowCvv(next);
                          }}
                          className="k-interactive h-8 px-2.5 rounded-lg bg-[var(--k-bg-surface-1)]/85 border border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] hover:bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-primary)] inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          {showSecret ? <EyeSlash className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          <span>{showSecret ? t('common.hide') : t('common.show')}</span>
                        </button>
                      </div>
                    </div>

                    <div className="relative k-mono text-[20px] tracking-[0.09em] font-medium text-[var(--k-ink-primary)] k-selectable">
                      {loading ? t('vault.decrypting') : showSecret ? revealedPan : maskedPan}
                    </div>

                    <div className="relative flex items-end justify-between gap-4 pt-1">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-[var(--k-ink-muted)]">{t('vault.cardExpiryShort')}</div>
                        <div className="k-mono text-[14px] text-[var(--k-ink-primary)] mt-0.5 k-selectable">
                          {expiry || item.secretMeta?.expiry || '—'}
                        </div>
                      </div>
                      {item.secretMeta?.hasCvv || cvv ? (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-[var(--k-ink-muted)]">CVV</div>
                          <div className="k-mono text-[14px] text-[var(--k-ink-primary)] mt-0.5 k-selectable">
                            {showCvv && cvv ? cvv : '•••'}
                          </div>
                        </div>
                      ) : null}
                      <div className="text-[11px] text-[var(--k-ink-muted)] text-right">
                        {wipeSeconds > 0 ? t('vault.wipePillHud', { seconds: wipeSeconds }) : t('vault.wipeLocalPillShort')}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Clean Read-Only Access Card */
                  <div className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/65 divide-y divide-[var(--k-border-hairline)] overflow-hidden">
                    {service ? (
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] text-[var(--k-ink-muted)]">{t('secret.sheet.serviceLabel')}</div>
                          <div className="text-[14px] font-medium text-[var(--k-ink-primary)] truncate k-selectable mt-0.5">
                            {service}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {login || item.secretMeta?.hasLogin ? (
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] text-[var(--k-ink-muted)]">{t('vault.login')}</div>
                          <div className="text-[14px] font-medium text-[var(--k-ink-primary)] truncate k-selectable mt-0.5">
                            {loading ? '…' : login || item.secretMeta?.loginHint || '—'}
                          </div>
                        </div>
                        <CopySlotPill
                          label={t('vault.login')}
                          copiedLabel={t('common.done')}
                          widthPx={92}
                          heightPx={30}
                          onCopy={async () => {
                            const r = await window.kapsula.copySecretField(item.id, 'login');
                            return r.ok;
                          }}
                        />
                      </div>
                    ) : null}

                    <div className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] text-[var(--k-ink-muted)]">
                          <span>
                            {kind === 'api_key'
                              ? t('vault.secretKey')
                              : kind === 'seed'
                                ? t('dna.seed')
                                : kind === 'note'
                                  ? t('secret.sheet.secretTextLabel')
                                  : t('vault.passwordLabel')}
                          </span>
                        </div>
                        <div className="k-mono text-[13.5px] text-[var(--k-ink-primary)] break-all k-selectable mt-0.5">
                          {loading
                            ? t('vault.decrypting')
                            : showSecret
                              ? secretValue || '—'
                              : '••••••••••••••••'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowSecret((v) => !v)}
                        aria-label={showSecret ? t('common.hide') : t('common.show')}
                        className="k-interactive w-8 h-8 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] inline-flex items-center justify-center cursor-pointer shrink-0"
                      >
                        {showSecret ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                {/* Live 2FA TOTP Card */}
                {hasTotp && totpSnap ? (
                  <div
                    data-testid="secret-sheet-totp-card"
                    className="rounded-2xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/80 px-4 py-3 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <SheetTotpRing remainingSec={totpSnap.remainingSec} period={totpSnap.period} size={32} />
                      <div className="min-w-0">
                        <div className="text-[11px] text-[var(--k-ink-muted)]">
                          {t('secret.modal.totpToggle')}
                        </div>
                        <div
                          data-testid="secret-sheet-totp-code"
                          className={`k-mono text-[20px] font-semibold tracking-[0.14em] leading-tight mt-0.5 k-selectable ${
                            totpSnap.remainingSec <= 5
                              ? 'text-[var(--k-amber)]'
                              : 'text-[var(--k-ink-primary)]'
                          }`}
                        >
                          {formatTotpDisplay(totpSnap.code)}
                        </div>
                      </div>
                    </div>
                    <CopySlotPill
                      data-testid="secret-sheet-copy-totp"
                      label={t('common.copy')}
                      copiedLabel={t('common.done')}
                      widthPx={126}
                      heightPx={32}
                      tone="accent"
                      onCopy={async () => {
                        const r = await window.kapsula.copySecretField(item.id, 'totp');
                        if (r.ok) toast.success(t('vault.totpCopied'));
                        return r.ok;
                      }}
                    />
                  </div>
                ) : null}

                {/* 1-Click Quick Copy Strip */}
                <div className="flex flex-wrap items-center gap-2">
                  <CopySlotPill
                    label={
                      isCard
                        ? t('vault.copyNumber')
                        : kind === 'api_key'
                          ? t('vault.copyKey')
                          : kind === 'note'
                            ? t('vault.copyText')
                            : t('vault.copyPassword')
                    }
                    copiedLabel={t('common.copied')}
                    widthPx={172}
                    heightPx={34}
                    wipeSeconds={wipeSeconds ?? 30}
                    tone="default"
                    onCopy={async () => {
                      const r = await window.kapsula.copySecretField(item.id, 'secretValue');
                      const w = r.wipeSeconds ?? wipeSeconds ?? 30;
                      return r.ok ? (w > 0 ? w : true) : false;
                    }}
                  />
                  {isCard && (item.secretMeta?.expiry || expiry) ? (
                    <CopySlotPill
                      label={t('secret.sheet.expiryField', { value: item.secretMeta?.expiry || expiry })}
                      copiedLabel={t('common.done')}
                      widthPx={116}
                      heightPx={34}
                      onCopy={async () => {
                        const r = await window.kapsula.copySecretField(item.id, 'expiry');
                        if (r.ok) toast.success(t('vault.cardExpiryCopied'));
                        return r.ok;
                      }}
                    />
                  ) : null}
                  {isCard && (item.secretMeta?.hasCvv || cvv) ? (
                    <CopySlotPill
                      label="CVV"
                      copiedLabel={t('common.done')}
                      widthPx={94}
                      heightPx={34}
                      wipeSeconds={wipeSeconds ?? 30}
                      onCopy={async () => {
                        const r = await window.kapsula.copySecretField(item.id, 'cvv');
                        const w = r.wipeSeconds ?? wipeSeconds ?? 30;
                        return r.ok ? (w > 0 ? w : true) : false;
                      }}
                    />
                  ) : null}
                </div>

                {/* Comment & Orbit meta in clean View presentation */}
                {notes ? (
                  <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/50 p-3.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--k-ink-muted)]">
                        {t('secret.sheet.commentLabel')}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          focusNotesOnEditRef.current = true;
                          setMode('edit');
                        }}
                        className="text-[11px] text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                      >
                        {t('common.edit')}
                      </button>
                    </div>
                    <div className="text-[13px] leading-relaxed text-[var(--k-ink-primary)] whitespace-pre-wrap k-selectable">
                      {notes}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="secret-add-comment-btn"
                    onClick={() => {
                      focusNotesOnEditRef.current = true;
                      setMode('edit');
                    }}
                    className="k-interactive self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-dashed border-[var(--k-border-hairline)] hover:border-[var(--k-border-strong)] text-[12px] text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                  >
                    <PencilSimple className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                    <span>{t('secret.sheet.addComment')}</span>
                  </button>
                )}

                {orbitObj ? (
                  <div className="inline-flex items-center gap-1.5 self-start px-2.5 py-1 rounded-full bg-[var(--k-bg-surface-2)] text-[12px] text-[var(--k-ink-secondary)]">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: orbitObj.color }}
                    />
                    <span>{orbitObj.name}</span>
                  </div>
                ) : null}
              </motion.div>
            ) : (
              <motion.form
                key="secret-edit"
                data-testid="secret-edit-mode"
                initial={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, 6px, 0)' }}
                animate={prefersReduced ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0, 0, 0)' }}
                exit={prefersReduced ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0, -4px, 0)' }}
                transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
                onSubmit={handleSave}
                className="flex flex-col gap-4"
              >
                {loading ? (
                  <div className="text-[12.5px] text-[var(--k-ink-muted)]">{t('vault.decryptingFields')}</div>
                ) : revealFailed || !payload ? (
                  <div className="rounded-xl border border-[var(--k-danger)]/35 bg-[var(--k-danger-soft)] p-3.5 text-[12.5px] text-[var(--k-danger)]">
                    {t('secret.sheet.revealFailed')}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                        {t('secret.sheet.entryTitle')}
                      </label>
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                      />
                    </div>

                    {!isCard ? (
                      <>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                            {t('secret.sheet.serviceLabel')}
                          </label>
                          <input
                            value={service}
                            onChange={(e) => setService(e.target.value)}
                            className="h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                            {t('secret.modal.loginPlaceholder')}
                          </label>
                          <input
                            value={login}
                            onChange={(e) => setLogin(e.target.value)}
                            className="h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 text-[13px] k-selectable outline-none focus:border-[var(--k-border-focus)]"
                          />
                        </div>
                      </>
                    ) : null}

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                        {isCard
                          ? t('secret.sheet.cardNumberLabel')
                          : kind === 'api_key'
                            ? t('secret.sheet.apiKeyLabel')
                            : kind === 'seed'
                              ? t('dna.seed')
                              : kind === 'note'
                                ? t('secret.sheet.secretTextLabel')
                                : t('vault.passwordLabel')}
                      </label>
                      <div className="flex items-center gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-9 focus-within:border-[var(--k-border-focus)]">
                        <input
                          type={showSecret ? 'text' : 'password'}
                          value={
                            isCard
                              ? showSecret
                                ? formatCardPanGroups(secretValue)
                                : secretValue.replace(/\s+/g, '')
                              : secretValue
                          }
                          onChange={(e) => {
                            const rawVal = e.target.value;
                            if (!isCard || !showSecret) {
                              setSecretValue(isCard ? rawVal.replace(/\s+/g, '') : rawVal);
                              return;
                            }
                            const inputEl = e.currentTarget;
                            const caret = inputEl.selectionStart ?? rawVal.length;
                            const nonSpaceBeforeCaret = rawVal.slice(0, caret).replace(/\s+/g, '').length;
                            const compact = rawVal.replace(/\s+/g, '');
                            setSecretValue(compact);
                            requestAnimationFrame(() => {
                              if (document.activeElement !== inputEl) return;
                              const formatted = formatCardPanGroups(compact);
                              let seen = 0;
                              let nextPos = formatted.length;
                              for (let i = 0; i < formatted.length; i += 1) {
                                if (seen >= nonSpaceBeforeCaret) {
                                  nextPos = i;
                                  break;
                                }
                                if (formatted[i] !== ' ') seen += 1;
                              }
                              inputEl.setSelectionRange(nextPos, nextPos);
                            });
                          }}
                          className="flex-1 bg-transparent border-none outline-none k-mono text-[13px] k-selectable"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSecret((v) => !v)}
                          className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          {showSecret ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {isCard ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                            {t('secret.sheet.expiryFullLabel')}
                          </label>
                          <input
                            value={expiry}
                            inputMode="numeric"
                            maxLength={5}
                            placeholder="MM/YY"
                            onChange={(e) => setExpiry(formatCardExpiryDraft(e.target.value))}
                            className="h-9 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 k-mono text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                            CVV / CVC
                          </label>
                          <div className="flex items-center gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-9 focus-within:border-[var(--k-border-focus)]">
                            <input
                              type={showCvv ? 'text' : 'password'}
                              value={cvv}
                              onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              className="flex-1 bg-transparent border-none outline-none k-mono text-[13px]"
                            />
                            <button
                              type="button"
                              onClick={() => setShowCvv((v) => !v)}
                              className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                            >
                              {showCvv ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* 2FA TOTP Edit Field */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)] inline-flex items-center gap-1.5">
                        <ShieldPlus className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                        <span>{t('secret.modal.totpToggle')}</span>
                      </label>
                      <div className="flex items-center gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-9 focus-within:border-[var(--k-border-focus)]">
                        <input
                          type={showTotpSeed ? 'text' : 'password'}
                          data-testid="secret-edit-totp-input"
                          value={totpInput}
                          onChange={(e) => setTotpInput(e.target.value)}
                          placeholder={t('secret.modal.totpPlaceholder')}
                          className="flex-1 bg-transparent border-none outline-none k-mono text-[12.5px] k-selectable"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTotpSeed((v) => !v)}
                          aria-label={showTotpSeed ? t('secret.sheet.hideTotp') : t('secret.sheet.showTotp')}
                          className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                        >
                          {showTotpSeed ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {trimmedTotp ? (
                        editTotpPreview ? (
                          <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--k-bg-surface-2)]/70 border border-[var(--k-emerald)]/35 px-3 py-1.5 text-[12px]">
                            <span className="text-[var(--k-ink-secondary)]">{t('secret.sheet.codePreview')}</span>
                            <span className="k-mono font-semibold text-[var(--k-ink-primary)] tracking-[0.1em]">
                              {formatTotpDisplay(editTotpPreview.code)}{' '}
                              <span className="font-normal text-[var(--k-ink-muted)]">
                                ({editTotpPreview.remainingSec} {t('common.secUnit')})
                              </span>
                            </span>
                          </div>
                        ) : (
                          <div className="text-[11.5px] text-[var(--k-danger)]">
                            {t('secret.modal.totpInvalid')}
                          </div>
                        )
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                        {t('nav.sectionFallback')}
                      </label>
                      <SelectMenu
                        value={orbit}
                        onChange={setOrbit}
                        options={[
                          { value: '', label: t('nav.noSection') },
                          ...orbits.map((o) => ({ value: o.id, label: o.name, dotColor: o.color })),
                        ]}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11.5px] font-medium text-[var(--k-ink-secondary)]">
                        {t('secret.sheet.commentEncrypted')}
                      </label>
                      <textarea
                        ref={notesInputRef}
                        rows={3}
                        data-testid="secret-edit-notes-input"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder={
                          isCard
                            ? t('secret.sheet.commentCardPh')
                            : t('secret.sheet.commentOtherPh')
                        }
                        className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] p-3 text-[13px] resize-none outline-none focus:border-[var(--k-border-focus)] k-selectable"
                      />
                    </div>

                    <div className="pt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setMode('view')}
                        className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] text-[13px] text-[var(--k-ink-secondary)] hover:bg-[var(--k-bg-surface-2)] cursor-pointer"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="submit"
                        disabled={
                          saving ||
                          loading ||
                          !payload ||
                          revealFailed ||
                          (Boolean(trimmedTotp) && !editTotpValid)
                        }
                        className="k-interactive inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:hover:bg-[var(--k-bg-surface-3)] disabled:opacity-100 disabled:cursor-default"
                      >
                        <Check weight="bold" className="w-4 h-4" />
                        <span>{saving ? t('common.saving') : t('common.save')}</span>
                      </button>
                    </div>
                  </>
                )}
              </motion.form>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
};
