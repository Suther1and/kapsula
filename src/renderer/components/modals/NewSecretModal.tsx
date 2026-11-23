import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CaretDown,
  CreditCard,
  Eye,
  EyeSlash,
  Key,
  ShieldCheck,
  ShieldPlus,
  User,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { SecretKind, VaultItem } from '@shared/types';
import { useI18n } from '@shared/i18n/react';
import { formatCardExpiryDraft } from '@shared/russian-event-parser';
import { generateTotp, isValidTotpInput, parseOtpAuthUri } from '@shared/totp';
import { formatCardPanGroups, friendlyErrorMessage } from '../../lib/format';
import { Spotlight } from '../motion-primitives/spotlight';
import { Tilt } from '../motion-primitives/tilt';
import { ModalDialog } from '../ui/ModalDialog';
import { SegmentedControl } from '../ui/SegmentedControl';

interface NewSecretModalProps {
  open: boolean;
  initialKind?: 'bank_card' | 'password' | 'api_key' | 'note';
  onOpenChange: (open: boolean) => void;
  onCreated: (item: VaultItem) => void;
}

function formatTotpCode(code: string): string {
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  return code;
}

export const NewSecretModal: React.FC<NewSecretModalProps> = ({
  open,
  initialKind = 'bank_card',
  onOpenChange,
  onCreated,
}) => {
  const { t, locale } = useI18n();
  const prefersReduced = useReducedMotion();
  const [kind, setKind] = useState<'bank_card' | 'password' | 'api_key' | 'note'>(initialKind);
  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  const [title, setTitle] = useState('');
  const [pan, setPan] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [login, setLogin] = useState('');
  const [website, setWebsite] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [notes, setNotes] = useState('');
  const [totpOpen, setTotpOpen] = useState(false);
  const [totpInput, setTotpInput] = useState('');
  const [totpTick, setTotpTick] = useState(0);
  const [showCvv, setShowCvv] = useState(false);
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  const digits = pan.replace(/\D/g, '').slice(0, 19);
  const detectedBrand = useMemo(() => {
    if (digits.startsWith('220')) return t('vault.brand.mir');
    if (digits.startsWith('4')) return 'VISA';
    if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
    if (/^3[47]/.test(digits)) return 'AMEX';
    return t('vault.brand.cardFallback');
  }, [digits, t]);

  const trimmedTotp = totpInput.trim();
  const parsedTotp = useMemo(
    () => (trimmedTotp ? parseOtpAuthUri(trimmedTotp) : null),
    [trimmedTotp]
  );
  const totpValid = !trimmedTotp || isValidTotpInput(trimmedTotp);

  useEffect(() => {
    if (!open || !parsedTotp) return;
    const timer = window.setInterval(() => setTotpTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [open, parsedTotp]);

  const totpPreview = useMemo(() => {
    if (!parsedTotp) return null;
    try {
      return generateTotp({
        secret: parsedTotp.secret,
        algorithm: parsedTotp.algorithm,
        digits: parsedTotp.digits,
        period: parsedTotp.period,
      });
    } catch {
      return null;
    }
  }, [parsedTotp, totpTick]);

  const reset = () => {
    setTitle('');
    setPan('');
    setExpiry('');
    setCvv('');
    setLogin('');
    setWebsite('');
    setSecretValue('');
    setNotes('');
    setTotpOpen(false);
    setTotpInput('');
    setShowCvv(false);
    setShowValue(false);
  };

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === 'bank_card' && digits.length < 12) {
      toast.info(t('secret.modal.errCard'));
      return;
    }
    if (kind !== 'bank_card' && !secretValue.trim()) {
      toast.info(t('secret.modal.errSecret'));
      return;
    }
    if (trimmedTotp && !totpValid) {
      toast.info(t('secret.modal.errTotp'));
      return;
    }

    setSaving(true);
    try {
      const secretKind: SecretKind = kind;
      const serviceName =
        kind === 'password'
          ? website.trim() || title.trim() || t('vault.account')
          : title.trim() ||
            (kind === 'bank_card'
              ? detectedBrand
              : kind === 'note'
                ? t('vault.type.note')
                : t('dna.apiKey'));
      const item = await window.kapsula.saveStructuredSecret({
        kind: secretKind,
        service: serviceName,
        title:
          title.trim() ||
          (kind === 'bank_card'
            ? ''
            : kind === 'password'
              ? website.trim() || t('vault.account')
              : kind === 'note'
                ? t('vault.type.note')
                : t('vault.secretKey')),
        secretValue: kind === 'bank_card' ? digits : secretValue.trim(),
        ...(kind === 'bank_card'
          ? { expiry: expiry.trim() || undefined, cvv: cvv.trim() || undefined }
          : {}),
        ...(kind === 'password' ? { login: login.trim() || undefined } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(trimmedTotp && parsedTotp
          ? {
              totpUriOrSecret: trimmedTotp,
              totpAlgorithm: parsedTotp.algorithm,
              totpDigits: parsedTotp.digits,
              totpPeriod: parsedTotp.period,
            }
          : {}),
      });
      if (item) {
        onCreated(item);
        reset();
        onOpenChange(false);
        toast.success(t('secret.modal.saved'));
      }
    } catch (err) {
      toast.error(friendlyErrorMessage(err, t('secret.sheet.saveFailed'), locale));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      topAligned
      title={t('secret.modal.title')}
      subtitle={t('secret.modal.subtitle')}
      maxWidthClass="max-w-[540px]"
    >
      <form onSubmit={handleSubmit} data-testid="new-secret-form" className="p-5 flex flex-col gap-4">
        <SegmentedControl
          value={kind}
          onChange={setKind}
          size="md"
          fullWidth
          options={[
            { value: 'bank_card', label: t('secret.modal.tabCard'), icon: <CreditCard className="w-3.5 h-3.5" /> },
            { value: 'password', label: t('secret.modal.tabPassword'), icon: <User className="w-3.5 h-3.5" /> },
            { value: 'api_key', label: t('secret.modal.tabKey'), icon: <Key className="w-3.5 h-3.5" /> },
            { value: 'note', label: t('secret.modal.tabNote'), icon: <ShieldCheck className="w-3.5 h-3.5" /> },
          ]}
        />

        {/* Fixed-height body prevents any vertical modal jumping when switching tabs */}
        <motion.div
          key={kind}
          initial={prefersReduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          className="h-[388px] flex flex-col gap-3 overflow-y-auto pr-0.5"
        >
          {kind === 'bank_card' ? (
            <>
              <Tilt
                rotationFactor={prefersReduced ? 0 : 7}
                springOptions={{ stiffness: 260, damping: 24 }}
                className="shrink-0"
              >
                <div
                  style={{
                    background: 'linear-gradient(155deg, var(--k-bg-surface-1) 0%, var(--k-bg-surface-2) 100%)',
                  }}
                  className="relative overflow-hidden rounded-2xl border border-[var(--k-border-hairline)] p-4 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-card)] flex flex-col gap-3"
                >
                  <Spotlight
                    size={180}
                    className="from-[var(--k-accent)]/22 via-[var(--k-accent)]/8 to-transparent opacity-70"
                  />
                  <div className="relative flex items-center justify-between text-[12px]">
                    <span className="font-semibold truncate text-[var(--k-ink-primary)]">
                      {title.trim() || t('vault.type.bank_card')}
                    </span>
                    <span className="uppercase tracking-wider text-[11px] text-[var(--k-accent)] font-semibold">
                      {detectedBrand}
                    </span>
                  </div>
                  <div className="relative k-mono text-[16px] tracking-[0.08em] text-[var(--k-ink-primary)]">
                    {digits ? formatCardPanGroups(digits) : '••••  ••••  ••••  ••••'}
                  </div>
                  <div className="relative flex items-center gap-4 text-[12px] text-[var(--k-ink-secondary)] k-mono">
                    <span>{expiry.trim() || 'MM/YY'}</span>
                    <span>CVV {cvv ? (showCvv ? cvv : '•••') : '---'}</span>
                  </div>
                </div>
              </Tilt>

              <div className="flex flex-col gap-2.5">
                <input
                  type="text"
                  data-testid="secret-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('secret.modal.titlePlaceholderCard')}
                  className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  data-testid="secret-pan-input"
                  value={formatCardPanGroups(digits)}
                  onChange={(e) => setPan(e.target.value)}
                  placeholder={t('secret.modal.cardNumberPlaceholder')}
                  className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] k-mono outline-none focus:border-[var(--k-border-focus)]"
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={5}
                    data-testid="secret-expiry-input"
                    value={expiry}
                    onChange={(e) => setExpiry(formatCardExpiryDraft(e.target.value))}
                    placeholder={t('secret.modal.expiryPlaceholder')}
                    className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] k-mono outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <div className="flex items-center gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-9 focus-within:border-[var(--k-border-focus)]">
                    <input
                      type={showCvv ? 'text' : 'password'}
                      inputMode="numeric"
                      data-testid="secret-cvv-input"
                      value={cvv}
                      onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="CVV / CVC"
                      className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] k-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCvv((v) => !v)}
                      aria-label={showCvv ? t('secret.modal.hideCvv') : t('secret.modal.showCvv')}
                      className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
                    >
                      {showCvv ? <EyeSlash className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <textarea
                  rows={2}
                  data-testid="secret-card-notes-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('secret.modal.cardCommentPlaceholder')}
                  className="px-3 py-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] resize-none outline-none focus:border-[var(--k-border-focus)]"
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2.5">
              <input
                type="text"
                data-testid="secret-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  kind === 'password'
                    ? t('secret.modal.servicePassword')
                    : kind === 'note'
                      ? t('secret.modal.serviceNote')
                      : t('secret.modal.serviceKey')
                }
                className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
              />
              {kind === 'password' ? (
                <>
                  <input
                    type="text"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder={t('secret.modal.websitePlaceholder')}
                    className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                  <input
                    type="text"
                    data-testid="secret-login-input"
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    placeholder={t('secret.modal.loginPlaceholder')}
                    className="h-9 px-3 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] outline-none focus:border-[var(--k-border-focus)]"
                  />
                </>
              ) : null}

              {kind === 'note' ? (
                <textarea
                  rows={4}
                  data-testid="secret-value-input"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  placeholder={t('secret.modal.noteBodyPlaceholder')}
                  className="px-3 py-2.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] resize-none outline-none focus:border-[var(--k-border-focus)]"
                />
              ) : (
                <div className="flex items-center gap-1.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] px-3 h-9 focus-within:border-[var(--k-border-focus)]">
                  <input
                    type={showValue ? 'text' : 'password'}
                    data-testid="secret-value-input"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder={
                      kind === 'password' ? t('vault.passwordLabel') : t('secret.modal.keyBodyPlaceholder')
                    }
                    className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] k-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowValue((v) => !v)}
                    className="text-[var(--k-ink-muted)] hover:text-[var(--k-ink-primary)] cursor-pointer shrink-0"
                  >
                    {showValue ? <EyeSlash className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}

              {/* Collapsible 2FA TOTP code field */}
              <div className="rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)]/70 overflow-hidden">
                <button
                  type="button"
                  data-testid="secret-totp-toggle"
                  onClick={() => setTotpOpen((v) => !v)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)] cursor-pointer"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldPlus className="w-3.5 h-3.5 text-[var(--k-accent)]" />
                    <span>{t('secret.modal.totpToggle')}</span>
                    {totpPreview ? (
                      <span className="ml-1 px-1.5 py-0.5 rounded-md bg-[var(--k-emerald-soft)] text-[var(--k-emerald)] k-mono text-[11px]">
                        {formatTotpCode(totpPreview.code)}
                      </span>
                    ) : null}
                  </span>
                  <CaretDown
                    className={`w-3.5 h-3.5 transition-transform duration-150 ${totpOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {totpOpen ? (
                    <motion.div
                      key="totp-body"
                      initial={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      animate={prefersReduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                      exit={prefersReduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-3 pb-3 pt-2 space-y-2 border-t border-[var(--k-border-hairline)]">
                        <input
                          type="text"
                          data-testid="secret-totp-input"
                          value={totpInput}
                          onChange={(e) => setTotpInput(e.target.value)}
                          placeholder={t('secret.modal.totpPlaceholder')}
                          className="w-full h-8.5 px-2.5 rounded-lg border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-1)] text-[12px] k-mono outline-none focus:border-[var(--k-border-focus)]"
                        />
                        {trimmedTotp ? (
                          totpPreview ? (
                            <div
                              data-testid="secret-totp-preview"
                              className="flex items-center justify-between gap-2 rounded-lg bg-[var(--k-bg-surface-1)] border border-[var(--k-emerald)]/35 px-2.5 py-1.5"
                            >
                              <span className="text-[11.5px] text-[var(--k-ink-secondary)]">
                                {t('secret.modal.totpCurrent')}
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="k-mono text-[14px] font-semibold tracking-[0.1em] text-[var(--k-ink-primary)]">
                                  {formatTotpCode(totpPreview.code)}
                                </span>
                                <span className="k-mono text-[11px] text-[var(--k-ink-muted)]">
                                  {totpPreview.remainingSec} {t('common.secUnit')}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11.5px] text-[var(--k-danger)]">
                              {t('secret.modal.totpInvalid')}
                            </div>
                          )
                        ) : (
                          <div className="text-[11px] text-[var(--k-ink-muted)]">
                            {t('secret.modal.totpHint')}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('secret.modal.commentOptional')}
                className="px-3 py-2 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] resize-none outline-none focus:border-[var(--k-border-focus)]"
              />
            </div>
          )}
        </motion.div>

        <div className="flex justify-end gap-2 pt-1 border-t border-[var(--k-border-hairline)]">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="k-interactive h-9 px-3.5 rounded-xl border border-[var(--k-border-hairline)] bg-[var(--k-bg-surface-2)] text-[13px] cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            data-testid="secret-submit-btn"
            disabled={saving || (Boolean(trimmedTotp) && !totpValid)}
            className="k-interactive h-9 px-4 rounded-xl bg-[var(--k-accent)] hover:bg-[var(--k-accent-hover)] text-[var(--k-ink-on-accent)] text-[13px] font-medium cursor-pointer disabled:bg-[var(--k-bg-surface-3)] disabled:text-[var(--k-ink-muted)] disabled:opacity-100 disabled:cursor-default"
          >
            {t('secret.modal.submit')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
};
