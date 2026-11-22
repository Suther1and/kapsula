import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  Clock,
  Copy,
  CreditCard,
  DotsThree,
  Eye,
  EyeSlash,
  Fingerprint,
  FolderSimple,
  Key,
  Lock,
  LockKey,
  LockOpen,
  MagnifyingGlass,
  Note,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
  User,
  X,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { formatCardExpiryDraft } from '@shared/russian-event-parser';
import { useSecondTicker } from '@shared/second-ticker';
import { generateTotp, isValidTotpInput, parseOtpAuthUri } from '@shared/totp';
import type {
  OrbitDef,
  SecretCopyField,
  SecretKind,
  SecretPayload,
  StructuredSecretInput,
  VaultItem,
} from '@shared/types';
import type { MobileDictKey } from '@shared/i18n/mobile-dict';
import { formatCardPanGroups } from '@renderer/lib/format';
import { filterItemsByQuery, getCardBrandLabel } from '../lib/mobile-helpers';
import { useMobileI18n } from '../lib/mobile-i18n';
import { pushBackHandler } from '../lib/back-stack';
import { mobileBridge } from '../native/bridge';
import { BottomSheet } from './BottomSheet';
import { ItemActionSheet, type ActionSheetEntry } from './ItemActionSheet';
import { MobilePickerSheet, PickerTriggerChip } from './MobilePickerSheet';
import { SwipeableRow } from './SwipeableRow';

const AUTO_REMASK_MS = 30_000;

function formatTotpCode(code: string): string {
  const clean = code.replace(/\s+/g, '');
  if (clean.length === 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return clean;
}

const TotpRing: React.FC<{ remainingSec: number; period: number; size?: number }> = ({
  remainingSec,
  period,
  size = 24,
}) => {
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, remainingSec / Math.max(1, period)));
  const offset = circ * (1 - ratio);
  const urgent = remainingSec <= 5;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--k-border-strong)"
        strokeWidth={2.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={urgent ? 'var(--k-amber)' : 'var(--k-accent)'}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.85s linear, stroke 0.2s ease' }}
      />
      <text
        x="50%"
        y="53%"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={urgent ? 'var(--k-amber)' : 'var(--k-ink-primary)'}
        fontSize={size <= 24 ? 8.5 : 9.5}
        fontWeight={600}
        className="k-mono"
      >
        {remainingSec}
      </text>
    </svg>
  );
};

const MobileRevealCountdown: React.FC<{
  untilMs: number;
  renderText: (sec: number) => string;
}> = ({ untilMs, renderText }) => {
  const nowSec = useSecondTicker(true);
  const remaskSec = Math.max(1, Math.ceil((untilMs - nowSec * 1000) / 1000));
  return <>{renderText(remaskSec)}</>;
};

const MobileTotpCardBlock: React.FC<{
  itemId: string;
  dec?: SecretPayload | null;
  copyBadge: CopyBadgeState | null;
  onCopy: (e: React.MouseEvent, itemId: string) => void;
}> = React.memo(({ itemId, dec, copyBadge, onCopy }) => {
  const { t } = useMobileI18n();
  const hasTotp = Boolean(dec?.totpSecret);
  const nowSec = useSecondTicker(hasTotp);
  if (!dec?.totpSecret) return null;
  let snap: ReturnType<typeof generateTotp> | null = null;
  try {
    snap = generateTotp({
      secret: dec.totpSecret,
      algorithm: dec.totpAlgorithm ?? 'SHA1',
      digits: dec.totpDigits ?? 6,
      period: dec.totpPeriod ?? 30,
      nowMs: nowSec * 1000,
    });
  } catch {
    snap = null;
  }
  if (!snap) return null;
  const isCopied = copyBadge?.key === `${itemId}:totp`;
  return (
    <div
      data-testid={`mobile-totp-row-${itemId}`}
      onClick={(e) => onCopy(e, itemId)}
      className="relative mb-2.5 flex items-center justify-between gap-2 rounded-xl bg-[var(--k-bg-surface-2)]/85 border border-[var(--k-border-hairline)] px-3 py-2 cursor-pointer"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <TotpRing remainingSec={snap.remainingSec} period={snap.period} size={26} />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-[var(--k-ink-muted)]">
            {t('vault.totpBadge')}
          </div>
          <div className="k-mono text-[16.5px] font-bold tracking-[0.14em] text-[var(--k-ink-primary)]">
            {formatTotpCode(snap.code)}
          </div>
        </div>
      </div>
      <span
        data-testid={`mobile-copy-totp-${itemId}`}
        className={`inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-medium border shrink-0 ${
          isCopied
            ? 'bg-[var(--k-emerald-soft)] border-[var(--k-emerald)]/55 text-[var(--k-emerald)]'
            : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]'
        }`}
      >
        {isCopied ? (
          <>
            <Check weight="bold" className="w-3 h-3" />
            <span className="k-mono">{t('common.secondsShort', { count: copyBadge.remainingSec })}</span>
          </>
        ) : (
          <>
            <Copy className="w-3 h-3" />
            <span>2FA</span>
          </>
        )}
      </span>
    </div>
  );
});

const MobileTotpDetailBlock: React.FC<{
  itemId: string;
  dec?: SecretPayload | null;
  onCopy: (e: React.MouseEvent, itemId: string) => void;
}> = React.memo(({ itemId, dec, onCopy }) => {
  const { t } = useMobileI18n();
  const hasTotp = Boolean(dec?.totpSecret);
  const nowSec = useSecondTicker(hasTotp);
  if (!dec?.totpSecret) return null;
  let totpSnap: ReturnType<typeof generateTotp> | null = null;
  try {
    totpSnap = generateTotp({
      secret: dec.totpSecret,
      algorithm: dec.totpAlgorithm ?? 'SHA1',
      digits: dec.totpDigits ?? 6,
      period: dec.totpPeriod ?? 30,
      nowMs: nowSec * 1000,
    });
  } catch {
    totpSnap = null;
  }
  if (!totpSnap) return null;
  return (
    <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-focus)] flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <TotpRing remainingSec={totpSnap.remainingSec} period={totpSnap.period} size={32} />
        <div className="min-w-0">
          <div className="text-[11px] text-[var(--k-ink-muted)]">{t('vault.totpBadge')}</div>
          <div className="k-mono text-[19px] font-bold tracking-[0.14em] text-[var(--k-ink-primary)]">
            {formatTotpCode(totpSnap.code)}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => onCopy(e, itemId)}
        className="k-tap inline-flex items-center gap-1 px-3 h-9 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12.5px] font-semibold shrink-0"
      >
        <Copy className="w-3.5 h-3.5" />
        {t('vault.copyWord')}
      </button>
    </div>
  );
});

const MobileTotpFormPreview: React.FC<{ uriOrSecret: string }> = ({ uriOrSecret }) => {
  const { t } = useMobileI18n();
  const raw = uriOrSecret.trim();
  const nowSec = useSecondTicker(Boolean(raw));
  if (!raw) return null;
  const parsed = parseOtpAuthUri(raw);
  if (!parsed) {
    return (
      <div className="text-[11.5px] text-[var(--k-danger)] px-1">{t('vault.formTotpInvalid')}</div>
    );
  }
  let snap: ReturnType<typeof generateTotp> | null = null;
  try {
    snap = generateTotp({ ...parsed, nowMs: nowSec * 1000 });
  } catch {
    snap = null;
  }
  if (!snap) {
    return (
      <div className="text-[11.5px] text-[var(--k-danger)] px-1">{t('vault.formTotpInvalid')}</div>
    );
  }
  return (
    <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-[var(--k-emerald-soft)] text-[12px] text-[var(--k-emerald)]">
      <span>{t('vault.formTotpNow')}</span>
      <span className="k-mono font-bold tracking-[0.12em]">
        {formatTotpCode(snap.code)} · {t('common.secondsShort', { count: snap.remainingSec })}
      </span>
    </div>
  );
};

interface VaultViewProps {
  items: VaultItem[];
  orbits: OrbitDef[];
  isExpanded: boolean;
  hingeRightOffsetPx?: number;
  searchQuery: string;
  vaultLocked: boolean;
  biometricEnabled?: boolean;
  hasMasterPin?: boolean;
  pinLockoutRemainingSec?: number;
  wipeSeconds: number;
  selectedSecretId: string | null;
  openCreateSignal?: number;
  onSelectSecret: (id: string | null) => void;
  onUnlockVault: () => Promise<{ ok: boolean; needsPinFallback?: boolean; error?: string } | boolean>;
  onUnlockWithPin?: (
    pin: string
  ) => Promise<{ ok: boolean; lockoutRemainingSec: number; error?: string }>;
  onOpenSecuritySettings?: () => void;
  onLockVault: () => void;
  onRevealSecret: (itemId: string) => Promise<SecretPayload | null>;
  onCopySecretField: (itemId: string, field: SecretCopyField) => Promise<number | null>;
  onUpsertSecret: (input: StructuredSecretInput) => Promise<VaultItem>;
  onDeleteSecret: (itemId: string) => Promise<void>;
  onCreateOrbit?: (name: string, color: string) => Promise<string>;
}

const SECRET_FILTERS: Array<{ id: 'all' | SecretKind; labelKey: MobileDictKey }> = [
  { id: 'all', labelKey: 'vault.filterAll' },
  { id: 'bank_card', labelKey: 'vault.filterCards' },
  { id: 'password', labelKey: 'vault.filterPasswords' },
  { id: 'api_key', labelKey: 'vault.filterKeys' },
  { id: 'seed', labelKey: 'vault.filterSeeds' },
  { id: 'note', labelKey: 'vault.filterNotes' },
];

interface CopyBadgeState {
  key: string;
  label: string;
  totalSec: number;
  remainingSec: number;
}

export const VaultView: React.FC<VaultViewProps> = ({
  items,
  orbits,
  isExpanded,
  hingeRightOffsetPx = 0,
  searchQuery,
  vaultLocked,
  biometricEnabled = true,
  hasMasterPin = false,
  pinLockoutRemainingSec = 0,
  wipeSeconds,
  selectedSecretId,
  openCreateSignal = 0,
  onSelectSecret,
  onUnlockVault,
  onUnlockWithPin,
  onOpenSecuritySettings,
  onLockVault,
  onRevealSecret,
  onCopySecretField,
  onUpsertSecret,
  onDeleteSecret,
  onCreateOrbit,
}) => {
  const { locale, t, plural } = useMobileI18n();
  const [kindFilter, setKindFilter] = useState<'all' | SecretKind>('all');
  const [localSearch, setLocalSearch] = useState('');
  const [revealUntilById, setRevealUntilById] = useState<Record<string, number>>({});
  const [payloadCache, setPayloadCache] = useState<
    Record<string, { rev: number; data: SecretPayload }>
  >({});
  const [copyBadge, setCopyBadge] = useState<CopyBadgeState | null>(null);
  const [editorMode, setEditorMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [actionSecret, setActionSecret] = useState<VaultItem | null>(null);
  const [orbitPickerOpen, setOrbitPickerOpen] = useState(false);

  // Master PIN lock screen state
  const [showPinInput, setShowPinInput] = useState(false);
  const [pinDraft, setPinDraft] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [liveLockoutSec, setLiveLockoutSec] = useState(pinLockoutRemainingSec);
  const [noBiometricNotice, setNoBiometricNotice] = useState(false);

  useEffect(() => {
    setLiveLockoutSec(pinLockoutRemainingSec);
  }, [pinLockoutRemainingSec]);

  useEffect(() => {
    if (liveLockoutSec <= 0) return;
    const t = setInterval(() => {
      setLiveLockoutSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [liveLockoutSec > 0]);

  useEffect(() => {
    if (!isExpanded || editorMode === 'closed') return;
    return pushBackHandler(() => setEditorMode('closed'));
  }, [isExpanded, editorMode]);

  // Editor form fields
  const [editId, setEditId] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<SecretKind>('bank_card');
  const [title, setTitle] = useState('');
  const [login, setLogin] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [totpUriOrSecret, setTotpUriOrSecret] = useState('');
  const [notes, setNotes] = useState('');
  const [orbit, setOrbit] = useState('');
  const [saving, setSaving] = useState(false);

  const wipeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const payloadCacheRef = useRef(payloadCache);
  payloadCacheRef.current = payloadCache;

  const orbitMap = useMemo(() => new Map(orbits.map((o) => [o.id, o])), [orbits]);
  const selectedFormOrbit = orbit ? orbitMap.get(orbit) ?? null : null;
  const allSecrets = useMemo(() => items.filter((it) => it.dna === 'secret'), [items]);

  const effectiveQuery = (localSearch.trim() || searchQuery.trim()).trim();

  const secrets = useMemo(() => {
    let list = allSecrets;
    if (kindFilter !== 'all') {
      list = list.filter((it) => (it.secretMeta?.kind ?? 'note') === kindFilter);
    }
    if (!effectiveQuery) return list;
    // Also match decrypted bank card comments / logins when unlocked
    const matchedBase = new Set(filterItemsByQuery(list, effectiveQuery).map((i) => i.id));
    const qLower = effectiveQuery.toLowerCase();
    return list.filter((it) => {
      if (matchedBase.has(it.id)) return true;
      const dec = payloadCache[it.id]?.data;
      if (!dec) return false;
      return (
        (dec.notes && dec.notes.toLowerCase().includes(qLower)) ||
        (dec.login && dec.login.toLowerCase().includes(qLower)) ||
        (dec.cardHolder && dec.cardHolder.toLowerCase().includes(qLower))
      );
    });
  }, [allSecrets, kindFilter, effectiveQuery, payloadCache]);

  const pendingCreateSignalRef = useRef(openCreateSignal);
  const wantCreateAfterUnlockRef = useRef(false);

  // Targeted single timeout for 30s auto-re-mask on revealed secrets (no 1Hz VaultView re-renders)
  useEffect(() => {
    if (vaultLocked) return;
    const entries = Object.entries(revealUntilById);
    if (entries.length === 0) return;
    const now = Date.now();
    const minUntil = Math.min(...entries.map(([, until]) => until));
    const delayMs = Math.max(20, minUntil - now + 15);
    const id = setTimeout(() => {
      const ts = Date.now();
      setRevealUntilById((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [k, until] of Object.entries(prev)) {
          if (until > ts) next[k] = until;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, delayMs);
    return () => clearTimeout(id);
  }, [vaultLocked, revealUntilById]);

  const isRevealed = (itemId: string): boolean => {
    const until = revealUntilById[itemId];
    return typeof until === 'number' && until > Date.now();
  };

  const runUnlockVault = async (): Promise<boolean> => {
    const raw = await onUnlockVault();
    if (typeof raw === 'boolean') return raw;
    if (raw.ok) {
      setNoBiometricNotice(false);
      setShowPinInput(false);
      setPinError(null);
      return true;
    }
    if (raw.needsPinFallback) {
      if (hasMasterPin) {
        setShowPinInput(true);
        setNoBiometricNotice(false);
      } else {
        setNoBiometricNotice(true);
      }
    }
    return false;
  };

  const handlePinUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUnlockWithPin || pinBusy || liveLockoutSec > 0) return;
    const pin = pinDraft.trim();
    if (pin.length < 4) {
      setPinError(t('vault.pinPromptMin4'));
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      const res = await onUnlockWithPin(pin);
      if (res.ok) {
        setPinDraft('');
        setPinError(null);
        setShowPinInput(false);
        mobileBridge.haptic('success');
      } else {
        setPinDraft('');
        if (res.lockoutRemainingSec > 0) {
          setLiveLockoutSec(res.lockoutRemainingSec);
        }
        setPinError(res.error || t('vault.pinWrong'));
        mobileBridge.haptic('error');
      }
    } finally {
      setPinBusy(false);
    }
  };

  useEffect(() => {
    if (vaultLocked) {
      // Clear decrypted secrets from memory on lock, but keep unsaved editor form intact across
      // brief background switches (e.g. copying 2FA/card details from a banking app).
      setRevealUntilById({});
      setPayloadCache({});
      setLocalSearch('');
      setPinDraft('');
      setPinError(null);
      if (!biometricEnabled && hasMasterPin) {
        setShowPinInput(true);
      }
    } else if (wantCreateAfterUnlockRef.current) {
      wantCreateAfterUnlockRef.current = false;
      openCreateForm('bank_card');
    }
  }, [vaultLocked, biometricEnabled, hasMasterPin]);

  useEffect(() => {
    if (openCreateSignal > pendingCreateSignalRef.current) {
      pendingCreateSignalRef.current = openCreateSignal;
      if (vaultLocked) {
        wantCreateAfterUnlockRef.current = true;
      } else {
        openCreateForm('bank_card');
      }
    }
  }, [openCreateSignal, vaultLocked]);

  useEffect(() => {
    if (vaultLocked) return;
    let cancelled = false;
    const loadMissing = async () => {
      const additions: Record<string, { rev: number; data: SecretPayload }> = {};
      for (const item of allSecrets) {
        const cached = payloadCacheRef.current[item.id];
        if (cached && cached.rev === item.updatedAt) continue;
        try {
          const dec = await onRevealSecret(item.id);
          if (dec) additions[item.id] = { rev: item.updatedAt, data: dec };
        } catch {
          // ignore unreadable item
        }
      }
      if (!cancelled && Object.keys(additions).length > 0) {
        setPayloadCache((prev) => ({ ...prev, ...additions }));
      }
    };
    void loadMissing();
    return () => {
      cancelled = true;
    };
  }, [vaultLocked, allSecrets, onRevealSecret]);

  useEffect(() => {
    return () => {
      if (wipeIntervalRef.current) clearInterval(wipeIntervalRef.current);
    };
  }, []);

  const triggerCopyBadge = (key: string, label: string, sec: number) => {
    if (wipeIntervalRef.current) clearInterval(wipeIntervalRef.current);
    if (sec <= 0) {
      setCopyBadge({ key, label, totalSec: 0, remainingSec: 0 });
      wipeIntervalRef.current = setTimeout(() => setCopyBadge(null), 1800) as unknown as ReturnType<
        typeof setInterval
      >;
      return;
    }
    setCopyBadge({ key, label, totalSec: sec, remainingSec: sec });
    wipeIntervalRef.current = setInterval(() => {
      setCopyBadge((prev) => {
        if (!prev || prev.key !== key) return null;
        if (prev.remainingSec <= 1) {
          if (wipeIntervalRef.current) clearInterval(wipeIntervalRef.current);
          return null;
        }
        return { ...prev, remainingSec: prev.remainingSec - 1 };
      });
    }, 1000);
  };

  const handleCopy = async (
    e: React.MouseEvent | null,
    itemId: string,
    field: SecretCopyField,
    label: string
  ) => {
    e?.stopPropagation();
    if (vaultLocked) {
      const ok = await runUnlockVault();
      if (!ok) return;
    }
    const wipe = await onCopySecretField(itemId, field);
    if (wipe === null) {
      toast.error(t('vault.copyFailed'));
      return;
    }
    mobileBridge.haptic('success');
    const isCountdownField = field !== 'expiry' && field !== 'login' && wipe > 0;
    triggerCopyBadge(`${itemId}:${field}`, label, isCountdownField ? wipe : 0);
    // For sensitive countdown fields, the live top progress banner + green button badge already
    // confirm copy without spawning a bottom toast that covers adjacent 08/29 & CVV buttons!
    if (!isCountdownField) {
      toast.success(t('vault.copiedBadge', { label }), { duration: 1800 });
    }
  };

  const handleToggleReveal = async (e: React.MouseEvent | null, itemId: string) => {
    e?.stopPropagation();
    if (vaultLocked) {
      const ok = await runUnlockVault();
      if (!ok) return;
    }
    if (!payloadCache[itemId]) {
      const dec = await onRevealSecret(itemId);
      const it = allSecrets.find((s) => s.id === itemId);
      if (dec && it) {
        setPayloadCache((prev) => ({ ...prev, [itemId]: { rev: it.updatedAt, data: dec } }));
      }
    }
    mobileBridge.haptic('light');
    const now = Date.now();
    setRevealUntilById((prev) => {
      if (prev[itemId] && prev[itemId]! > now) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: now + AUTO_REMASK_MS };
    });
  };

  const openCreateForm = (initialKind: SecretKind = 'bank_card') => {
    setEditId(undefined);
    setKind(initialKind);
    setTitle('');
    setLogin('');
    setSecretValue('');
    setExpiry('');
    setCvv('');
    setTotpUriOrSecret('');
    setNotes('');
    setOrbit('');
    setEditorMode('create');
  };

  const openEditForm = async (item: VaultItem) => {
    if (vaultLocked) {
      const ok = await runUnlockVault();
      if (!ok) return;
    }
    const dec = payloadCache[item.id]?.data ?? (await onRevealSecret(item.id));
    if (dec) {
      setPayloadCache((prev) => ({ ...prev, [item.id]: { rev: item.updatedAt, data: dec } }));
    }
    setEditId(item.id);
    setKind(item.secretMeta?.kind ?? 'password');
    setTitle(item.title || dec?.service || item.secretMeta?.service || '');
    setLogin(dec?.login || dec?.cardHolder || item.secretMeta?.loginHint || '');
    setSecretValue(dec?.secretValue || '');
    setExpiry(dec?.expiry || item.secretMeta?.expiry || '');
    setCvv(dec?.cvv || '');
    setTotpUriOrSecret(dec?.totpSecret || '');
    setNotes(dec?.notes || '');
    setOrbit(item.orbit || '');
    onSelectSecret(item.id);
    setEditorMode('edit');
  };

  const handleSubmitSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secretValue.trim() && kind !== 'note') {
      toast.error(kind === 'bank_card' ? t('vault.enterCardNumber') : t('vault.enterSecretValue'));
      return;
    }
    const cleanTotp = totpUriOrSecret.trim();
    if (cleanTotp && !isValidTotpInput(cleanTotp)) {
      toast.error(t('vault.totpParseError'));
      return;
    }
    setSaving(true);
    try {
      const cleanName = title.trim() || t('vault.secretFallback');
      const saved = await onUpsertSecret({
        id: editId,
        kind,
        title: cleanName,
        service: cleanName,
        login: login.trim(),
        secretValue: secretValue.trim() || notes.trim(),
        cardHolder: kind === 'bank_card' ? login.trim() : undefined,
        expiry: kind === 'bank_card' ? expiry.trim() : undefined,
        cvv: kind === 'bank_card' ? cvv.trim() : undefined,
        totpUriOrSecret: cleanTotp || undefined,
        notes: notes.trim(),
        orbit,
      });
      const freshDec = await onRevealSecret(saved.id);
      if (freshDec) {
        setPayloadCache((prev) => ({
          ...prev,
          [saved.id]: { rev: saved.updatedAt, data: freshDec },
        }));
      }
      onSelectSecret(saved.id);
      setEditorMode('closed');
      mobileBridge.haptic('success');
      toast.success(editId ? t('vault.secretUpdated') : t('vault.secretSaved'));
    } finally {
      setSaving(false);
    }
  };

  const selectedSecret = useMemo(
    () => (selectedSecretId ? secrets.find((s) => s.id === selectedSecretId) ?? null : null),
    [secrets, selectedSecretId]
  );

  // NOTE: every hook MUST stay above the `if (vaultLocked) return` early exit below —
  // otherwise locking/unlocking the Vault changes hook order and React throws #300/#310.
  const buildSecretActions = (item: VaultItem): ActionSheetEntry[] => {
    const isCard = item.secretMeta?.kind === 'bank_card';
    const revealed = isRevealed(item.id);
    const hasTotp = Boolean(item.secretMeta?.hasTotp || payloadCache[item.id]?.data.totpSecret);
    return [
      {
        id: 'copy-main',
        label: isCard ? t('vault.copyCardPan') : t('vault.copyValue'),
        icon: <Copy className="w-5 h-5" />,
        accent: true,
        onSelect: () =>
          void handleCopy(
            null,
            item.id,
            'secretValue',
            isCard ? t('vault.cardPanLabel') : t('vault.valueLabel')
          ),
      },
      ...(hasTotp
        ? [
            {
              id: 'copy-totp',
              label: t('vault.copyTotp'),
              icon: <Clock className="w-5 h-5" />,
              onSelect: () => void handleCopy(null, item.id, 'totp', t('vault.totpLabel')),
            },
          ]
        : []),
      {
        id: 'reveal',
        label: revealed ? t('vault.hideData') : t('vault.reveal30s'),
        icon: revealed ? <EyeSlash className="w-5 h-5" /> : <Eye className="w-5 h-5" />,
        onSelect: () => void handleToggleReveal(null, item.id),
      },
      {
        id: 'edit',
        label: t('vault.editSecret'),
        icon: <PencilSimple className="w-5 h-5" />,
        onSelect: () => void openEditForm(item),
      },
      {
        id: 'delete',
        label: t('vault.deleteSecret'),
        icon: <Trash className="w-5 h-5" />,
        danger: true,
        onSelect: () => {
          if (selectedSecretId === item.id) onSelectSecret(null);
          void onDeleteSecret(item.id);
        },
      },
    ];
  };

  if (vaultLocked) {
    const pinModeActive = showPinInput || (!biometricEnabled && hasMasterPin);
    return (
      <div
        data-testid="mobile-vault-locked"
        className="h-full flex flex-col items-center justify-center p-6 pb-24 text-center bg-[var(--k-bg-canvas)]"
      >
        <div className="w-full max-w-sm rounded-3xl p-6 bg-[var(--k-bg-surface-1)] border border-[var(--k-border-strong)] shadow-[var(--k-shadow-card)] space-y-5">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-[var(--k-accent-soft)] border border-[var(--k-border-focus)] flex items-center justify-center">
            {pinModeActive ? (
              <LockKey weight="duotone" className="w-9 h-9 text-[var(--k-accent)]" />
            ) : (
              <Fingerprint weight="duotone" className="w-9 h-9 text-[var(--k-accent)]" />
            )}
          </div>

          <div className="space-y-1.5">
            <h2 className="text-[19px] font-bold text-[var(--k-ink-primary)]">{t('vault.lockedTitle')}</h2>
            <p className="text-[13.5px] leading-relaxed text-[var(--k-ink-secondary)]">
              {pinModeActive
                ? t('vault.lockedHintPin')
                : t('vault.lockedHintBio')}
            </p>
          </div>

          {pinModeActive && hasMasterPin && onUnlockWithPin ? (
            <form onSubmit={(e) => void handlePinUnlockSubmit(e)} className="space-y-3 text-left">
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                data-testid="vault-pin-input"
                value={pinDraft}
                onChange={(e) => {
                  setPinDraft(e.target.value);
                  if (pinError) setPinError(null);
                }}
                disabled={pinBusy || liveLockoutSec > 0}
                placeholder={t('vault.masterPinPlaceholder')}
                className="w-full h-12 px-4 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-center k-mono text-[16px] tracking-[0.22em] placeholder:tracking-normal text-[var(--k-ink-primary)] disabled:opacity-50"
              />
              {liveLockoutSec > 0 ? (
                <div className="rounded-xl px-3 py-2 bg-[var(--k-danger-soft)] text-[12px] text-[var(--k-danger)] text-center">
                  {t('vault.tooManyAttemptsWait', { sec: liveLockoutSec })}
                </div>
              ) : pinError ? (
                <div className="text-[12.5px] text-[var(--k-danger)] text-center">{pinError}</div>
              ) : null}
              <button
                type="submit"
                data-testid="vault-pin-unlock-btn"
                disabled={pinBusy || liveLockoutSec > 0 || pinDraft.trim().length < 4}
                className="k-tap w-full h-12 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14.5px] font-semibold inline-flex items-center justify-center gap-2 shadow-sm disabled:opacity-45"
              >
                <LockOpen weight="bold" className="w-4 h-4" />
                {pinBusy ? t('vault.unlocking') : t('vault.unlockVault')}
              </button>
              {biometricEnabled ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowPinInput(false);
                    void runUnlockVault();
                  }}
                  className="k-tap w-full h-10 rounded-xl bg-[var(--k-bg-surface-2)] text-[13px] font-medium text-[var(--k-ink-secondary)] inline-flex items-center justify-center gap-1.5"
                >
                  <Fingerprint className="w-4 h-4 text-[var(--k-accent)]" />
                  {t('vault.unlockBiometric')}
                </button>
              ) : null}
            </form>
          ) : (
            <div className="space-y-2.5">
              <button
                type="button"
                data-testid="vault-biometric-unlock-btn"
                onClick={() => void runUnlockVault()}
                className="k-tap w-full h-12 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14.5px] font-semibold inline-flex items-center justify-center gap-2 shadow-sm"
              >
                <LockOpen weight="bold" className="w-4 h-4" />
                {t('vault.unlockAction')}
              </button>

              {hasMasterPin && onUnlockWithPin ? (
                <button
                  type="button"
                  data-testid="vault-switch-to-pin-btn"
                  onClick={() => setShowPinInput(true)}
                  className="k-tap w-full h-10 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[13px] font-medium text-[var(--k-ink-primary)] inline-flex items-center justify-center gap-1.5"
                >
                  <LockKey className="w-4 h-4 text-[var(--k-accent)]" />
                  {t('vault.enterMasterPin')}
                </button>
              ) : null}

              {noBiometricNotice ? (
                <div className="rounded-2xl p-3 bg-[var(--k-amber-soft)] border border-[var(--k-amber)]/30 text-left space-y-2">
                  <p className="text-[12px] leading-relaxed text-[var(--k-amber)]">
                    {t('vault.noDeviceLockHint')}
                  </p>
                  {onOpenSecuritySettings ? (
                    <button
                      type="button"
                      onClick={onOpenSecuritySettings}
                      className="k-tap w-full h-9 rounded-xl bg-[var(--k-bg-surface-1)] text-[12.5px] font-semibold text-[var(--k-ink-primary)]"
                    >
                      {t('vault.setupMasterPinBtn')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          <p className="text-[11.5px] text-[var(--k-ink-muted)]">
            {t('vault.inVaultPrefix')}{' '}
            {plural('secretEntry', allSecrets.length)}{' '}
            · {t('vault.wipeSuffix', { sec: wipeSeconds })}
          </p>
        </div>
      </div>
    );
  }

  const renderCopyBtn = (
    itemId: string,
    field: SecretCopyField,
    label: string,
    testId: string
  ) => {
    const key = `${itemId}:${field}`;
    const isActive = copyBadge?.key === key;
    return (
      <button
        key={field}
        type="button"
        data-testid={testId}
        onClick={(e) => void handleCopy(e, itemId, field, label)}
        className={`k-tap inline-flex items-center justify-center gap-1 px-2.5 h-8 rounded-xl text-[12px] font-medium border transition-colors ${
          isActive
            ? 'bg-[var(--k-emerald-soft)] border-[var(--k-emerald)]/55 text-[var(--k-emerald)]'
            : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-primary)] hover:border-[var(--k-border-strong)]'
        }`}
      >
        {isActive ? (
          <>
            <Check weight="bold" className="w-3.5 h-3.5 shrink-0" />
            <span className="k-mono text-[11.5px]">
              {copyBadge.remainingSec > 0
                ? t('common.secondsShort', { count: copyBadge.remainingSec })
                : t('vault.clipboardReady')}
            </span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5 shrink-0 opacity-80" />
            <span>{label}</span>
          </>
        )}
      </button>
    );
  };

  const renderSecretCard = (item: VaultItem) => {
    const meta = item.secretMeta;
    const itemKind = meta?.kind ?? 'note';
    const dec = payloadCache[item.id]?.data;
    const revealed = isRevealed(item.id);
    const revealUntil = revealUntilById[item.id] ?? 0;
    const isSelected = selectedSecretId === item.id;

    if (itemKind === 'bank_card') {
      const brand = getCardBrandLabel(meta?.cardBrand, locale);
      const last4 = meta?.last4 || '••••';
      const panDisplay =
        revealed && dec?.secretValue
          ? formatCardPanGroups(dec.secretValue)
          : `••••  ••••  ••••  ${last4}`;
      const expiryDisplay = dec?.expiry || meta?.expiry;
      const hasCvv = Boolean(meta?.hasCvv || dec?.cvv);
      const comment = dec?.notes?.trim();

      return (
        <SwipeableRow
          key={item.id}
          onLongPress={() => setActionSecret(item)}
          leftAction={{
            label: t('vault.panShort'),
            icon: <Copy weight="bold" className="w-4 h-4" />,
            bgClass: 'bg-[var(--k-emerald)]',
            onTrigger: () => void handleCopy(null, item.id, 'secretValue', t('vault.cardPanLabel')),
          }}
          rightAction={{
            label: t('common.delete'),
            icon: <Trash weight="fill" className="w-4 h-4" />,
            bgClass: 'bg-[var(--k-danger)]',
            onTrigger: () => {
              if (selectedSecretId === item.id) onSelectSecret(null);
              void onDeleteSecret(item.id);
            },
          }}
        >
          <article
            data-testid={`mobile-secret-card-${item.id}`}
            onClick={() => onSelectSecret(item.id)}
            style={{ background: 'var(--k-secret-bg)' }}
            className={`relative rounded-2xl p-4 text-[var(--k-ink-primary)] border overflow-hidden cursor-pointer shadow-[var(--k-shadow-card)] transition-colors ${
              isSelected && isExpanded ? 'border-[var(--k-accent)]' : 'border-[var(--k-border-strong)]'
            }`}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-10 -top-10 w-36 h-36 rounded-full blur-2xl"
              style={{ background: 'var(--k-secret-sheen)' }}
            />

            <div className="relative flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] shrink-0">
                  <CreditCard weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
                </span>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold leading-tight truncate text-[var(--k-ink-primary)]">
                    {item.title || meta?.service || t('vault.kindBankCard')}
                  </div>
                  <div className="text-[10.5px] uppercase tracking-wider text-[var(--k-ink-secondary)] truncate">
                    {brand}
                    {dec?.cardHolder || meta?.loginHint
                      ? ` · ${dec?.cardHolder || meta?.loginHint}`
                      : ''}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {revealed && revealUntil > 0 ? (
                  <span className="k-mono text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]">
                    <MobileRevealCountdown
                      untilMs={revealUntil}
                      renderText={(sec) => t('common.secondsShort', { count: sec })}
                    />
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={`mobile-secret-reveal-${item.id}`}
                  onClick={(e) => void handleToggleReveal(e, item.id)}
                  aria-label={revealed ? t('vault.hideCardAria') : t('vault.showCardAria')}
                  className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]"
                >
                  {revealed ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    mobileBridge.haptic('light');
                    setActionSecret(item);
                  }}
                  aria-label={t('vault.cardActionsAria')}
                  className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)]/70 text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
                >
                  <DotsThree weight="bold" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="relative k-mono text-[15.5px] tracking-[0.06em] font-medium text-[var(--k-ink-primary)] mb-2.5">
              {panDisplay}
            </div>

            <div className="relative flex items-center justify-between gap-2 text-[12px] text-[var(--k-ink-secondary)] mb-2.5">
              <span className="k-mono">
                <span className="text-[10px] text-[var(--k-ink-muted)] mr-1">{t('vault.cardExpiryHeader')}</span>
                {expiryDisplay || '—'}
              </span>
              {hasCvv ? (
                <span className="k-mono">
                  <span className="text-[10px] text-[var(--k-ink-muted)] mr-1">CVV</span>
                  {revealed && dec?.cvv ? dec.cvv : '•••'}
                </span>
              ) : null}
            </div>

            <MobileTotpCardBlock
              itemId={item.id}
              dec={dec}
              copyBadge={copyBadge}
              onCopy={(e, id) => void handleCopy(e, id, 'totp', t('vault.totpLabel'))}
            />

            {comment ? (
              <div
                data-testid={`mobile-card-notes-${item.id}`}
                className="relative mb-3 rounded-xl bg-[var(--k-bg-surface-2)]/75 border border-[var(--k-border-hairline)] px-2.5 py-2 text-[12px] leading-snug text-[var(--k-ink-secondary)] line-clamp-2"
              >
                {comment}
              </div>
            ) : null}

            <div className="relative flex items-center gap-1.5 flex-wrap pt-2.5 border-t border-[var(--k-border-hairline)]">
              {renderCopyBtn(item.id, 'secretValue', t('vault.panShort'), `mobile-copy-pan-${item.id}`)}
              {expiryDisplay
                ? renderCopyBtn(item.id, 'expiry', expiryDisplay, `mobile-copy-expiry-${item.id}`)
                : null}
              {hasCvv ? renderCopyBtn(item.id, 'cvv', 'CVV', `mobile-copy-cvv-${item.id}`) : null}
            </div>
          </article>
        </SwipeableRow>
      );
    }

    const KindIcon = itemKind === 'password' ? User : itemKind === 'note' ? Note : Key;
    const kindLabel =
      itemKind === 'password'
        ? t('vault.kindPassword')
        : itemKind === 'api_key'
          ? t('vault.kindApiKey')
          : itemKind === 'seed'
            ? t('vault.kindSeed')
            : t('vault.kindNote');
    const comment = dec?.notes?.trim();

    return (
      <SwipeableRow
        key={item.id}
        onLongPress={() => setActionSecret(item)}
        leftAction={{
          label: itemKind === 'password' ? t('vault.kindPassword') : t('vault.copyWord'),
          icon: <Copy weight="bold" className="w-4 h-4" />,
          bgClass: 'bg-[var(--k-emerald)]',
          onTrigger: () =>
            void handleCopy(
              null,
              item.id,
              'secretValue',
              itemKind === 'password' ? t('vault.kindPassword') : t('vault.valueLabel')
            ),
        }}
        rightAction={{
          label: t('common.delete'),
          icon: <Trash weight="fill" className="w-4 h-4" />,
          bgClass: 'bg-[var(--k-danger)]',
          onTrigger: () => {
            if (selectedSecretId === item.id) onSelectSecret(null);
            void onDeleteSecret(item.id);
          },
        }}
      >
        <article
          data-testid={`mobile-secret-card-${item.id}`}
          onClick={() => onSelectSecret(item.id)}
          style={{ background: 'var(--k-secret-bg)' }}
          className={`relative rounded-2xl p-4 text-[var(--k-ink-primary)] border overflow-hidden cursor-pointer shadow-[var(--k-shadow-card)] transition-colors ${
            isSelected && isExpanded ? 'border-[var(--k-accent)]' : 'border-[var(--k-border-strong)]'
          }`}
        >
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] shrink-0">
                <KindIcon weight="duotone" className="w-4 h-4 text-[var(--k-accent)]" />
              </span>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold truncate text-[var(--k-ink-primary)]">
                  {item.title || meta?.service || kindLabel}
                </div>
                <div className="text-[11px] text-[var(--k-ink-muted)] truncate">
                  {dec?.login || meta?.loginHint || kindLabel}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {revealed && revealUntil > 0 ? (
                <span className="k-mono text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]">
                  <MobileRevealCountdown
                    untilMs={revealUntil}
                    renderText={(sec) => t('common.secondsShort', { count: sec })}
                  />
                </span>
              ) : null}
              <button
                type="button"
                data-testid={`mobile-secret-reveal-${item.id}`}
                onClick={(e) => void handleToggleReveal(e, item.id)}
                aria-label={revealed ? t('vault.hideWord') : t('vault.showWord')}
                className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[var(--k-ink-primary)]"
              >
                {revealed ? <EyeSlash className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  mobileBridge.haptic('light');
                  setActionSecret(item);
                }}
                aria-label={t('vault.actionsWord')}
                className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)]/70 text-[var(--k-ink-secondary)] hover:text-[var(--k-ink-primary)]"
              >
                <DotsThree weight="bold" className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="k-mono text-[13px] text-[var(--k-ink-primary)] bg-[var(--k-bg-surface-2)]/85 border border-[var(--k-border-hairline)] rounded-xl px-3 py-2 mb-2.5 truncate">
            {revealed && dec?.secretValue ? dec.secretValue : '••••••••••••••••'}
          </div>

          <MobileTotpCardBlock
            itemId={item.id}
            dec={dec}
            copyBadge={copyBadge}
            onCopy={(e, id) => void handleCopy(e, id, 'totp', t('vault.totpLabel'))}
          />

          {comment ? (
            <div className="mb-2.5 text-[12px] text-[var(--k-ink-secondary)] line-clamp-2">{comment}</div>
          ) : null}

          <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-[var(--k-border-hairline)]">
            {dec?.login || meta?.loginHint
              ? renderCopyBtn(item.id, 'login', t('vault.loginLabel'), `mobile-copy-login-${item.id}`)
              : null}
            {renderCopyBtn(
              item.id,
              'secretValue',
              itemKind === 'password' ? t('vault.kindPassword') : t('vault.copyVerb'),
              `mobile-copy-val-${item.id}`
            )}
          </div>
        </article>
      </SwipeableRow>
    );
  };

  const renderSecretForm = () => (
    <form onSubmit={(e) => void handleSubmitSecret(e)} className="p-4 space-y-3.5">
      <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar">
        {(
          [
            { id: 'bank_card', labelKey: 'vault.formTabCard' },
            { id: 'password', labelKey: 'vault.formTabPassword' },
            { id: 'api_key', labelKey: 'vault.formTabKey' },
            { id: 'seed', labelKey: 'vault.formTabSeed' },
            { id: 'note', labelKey: 'vault.formTabNote' },
          ] as const
        ).map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            className={`k-tap px-3 py-1.5 rounded-xl text-[12.5px] font-medium shrink-0 border ${
              kind === k.id
                ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                : 'bg-[var(--k-bg-surface-2)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
            }`}
          >
            {t(k.labelKey)}
          </button>
        ))}
      </div>

      <input
        type="text"
        required
        data-testid="vault-secret-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={
          kind === 'bank_card' ? t('vault.formCardTitlePlaceholder') : t('vault.formServicePlaceholder')
        }
        className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[14px] text-[var(--k-ink-primary)]"
      />

      {kind === 'bank_card' ? (
        <>
          <input
            type="text"
            inputMode="numeric"
            required
            value={secretValue}
            onChange={(e) => setSecretValue(formatCardPanGroups(e.target.value))}
            placeholder={t('vault.formPanPlaceholder')}
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[14.5px] text-[var(--k-ink-primary)]"
          />

          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={expiry}
              onChange={(e) => setExpiry(formatCardExpiryDraft(e.target.value))}
              placeholder={t('vault.formExpiryPlaceholder')}
              className="h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none k-mono text-[14px] text-[var(--k-ink-primary)]"
            />
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={cvv}
              onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="CVV / CVC"
              className="h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none k-mono text-[14px] text-[var(--k-ink-primary)]"
            />
          </div>

          <input
            type="text"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder={t('vault.formHolderPlaceholder')}
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
          />
        </>
      ) : (
        <>
          {kind !== 'note' ? (
            <input
              type="text"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder={
                kind === 'password' ? t('vault.formLoginPlaceholder') : t('vault.formAccountPlaceholder')
              }
              className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] outline-none text-[14px] text-[var(--k-ink-primary)]"
            />
          ) : null}

          <textarea
            rows={kind === 'seed' || kind === 'note' ? 4 : 2}
            required
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            placeholder={
              kind === 'password'
                ? t('vault.kindPassword')
                : kind === 'api_key'
                  ? t('vault.formApiKeyPlaceholder')
                  : kind === 'seed'
                    ? t('vault.formSeedPlaceholder')
                    : t('vault.formNotePlaceholder')
            }
            className="w-full p-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[13.5px] text-[var(--k-ink-primary)] resize-none"
          />
        </>
      )}

      {kind !== 'note' ? (
        <div className="space-y-1.5">
          <input
            type="text"
            data-testid="vault-secret-totp-input"
            value={totpUriOrSecret}
            onChange={(e) => setTotpUriOrSecret(e.target.value)}
            placeholder={t('vault.formTotpPlaceholder')}
            className="w-full h-11 px-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none k-mono text-[13px] text-[var(--k-ink-primary)]"
          />
          <MobileTotpFormPreview uriOrSecret={totpUriOrSecret} />
        </div>
      ) : null}

      <textarea
        rows={3}
        data-testid="vault-secret-notes-input"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={
          kind === 'bank_card'
            ? t('vault.formCardNotesPlaceholder')
            : t('vault.formNotesPlaceholder')
        }
        className="w-full p-3.5 rounded-2xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13.5px] text-[var(--k-ink-primary)] resize-none"
      />

      {orbits.length > 0 ? (
        <PickerTriggerChip
          colorDot={selectedFormOrbit?.color}
          icon={
            <FolderSimple
              className="w-4 h-4 shrink-0"
              style={{ color: selectedFormOrbit?.color || 'var(--k-accent)' }}
            />
          }
          label={selectedFormOrbit?.name || t('common.noOrbit')}
          placeholder={!selectedFormOrbit}
          onClick={() => setOrbitPickerOpen(true)}
          className="w-full"
        />
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="k-tap flex-1 h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[14px] font-semibold disabled:opacity-50"
        >
          {editId ? t('common.saveChanges') : t('vault.saveToVaultBtn')}
        </button>
        {editId ? (
          <button
            type="button"
            onClick={async () => {
              await onDeleteSecret(editId);
              setEditorMode('closed');
              onSelectSecret(null);
            }}
            aria-label={t('common.delete')}
            className="k-tap inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-[var(--k-bg-surface-2)] text-[var(--k-danger)]"
          >
            <Trash className="w-4 h-4" />
          </button>
        ) : null}
      </div>
    </form>
  );

  const renderDetailPane = (item: VaultItem) => {
    const dec = payloadCache[item.id]?.data;
    const meta = item.secretMeta;
    const isCard = meta?.kind === 'bank_card';
    const revealed = isRevealed(item.id);
    const revealUntil = revealUntilById[item.id] ?? 0;

    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wider text-[var(--k-accent)] font-semibold">
                {isCard ? getCardBrandLabel(meta?.cardBrand, locale) : t('nav.vault')}
              </div>
              <h3 className="text-[17px] font-bold leading-snug text-[var(--k-ink-primary)] break-words">
                {item.title}
              </h3>
            </div>
            {isExpanded ? (
              <button
                type="button"
                onClick={() => onSelectSecret(null)}
                aria-label={t('common.closePanel')}
                className="k-tap inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)] shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => void handleToggleReveal(e, item.id)}
              className="k-tap inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)]"
            >
              {revealed ? <EyeSlash className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>
                {revealed && revealUntil > 0 ? (
                  <MobileRevealCountdown
                    untilMs={revealUntil}
                    renderText={(sec) => t('vault.revealRemaskBtn', { sec })}
                  />
                ) : (
                  t('vault.showWord')
                )}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void openEditForm(item)}
              className="k-tap inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] text-[12.5px] font-medium text-[var(--k-ink-primary)]"
            >
              <PencilSimple className="w-3.5 h-3.5" />
              {t('common.edit')}
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          <MobileTotpDetailBlock
            itemId={item.id}
            dec={dec}
            onCopy={(e, id) => void handleCopy(e, id, 'totp', t('vault.totpLabel'))}
          />

          <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] text-[var(--k-ink-muted)]">
                {isCard ? t('vault.cardPanLabel') : t('vault.valueLabel')}
              </span>
              {revealed && revealUntil > 0 ? (
                <span className="text-[10.5px] text-[var(--k-ink-muted)] k-mono">
                  <MobileRevealCountdown
                    untilMs={revealUntil}
                    renderText={(sec) => t('vault.willHideIn', { sec })}
                  />
                </span>
              ) : null}
            </div>
            <div className="k-mono text-[14.5px] text-[var(--k-ink-primary)] break-all k-selectable">
              {revealed && dec?.secretValue
                ? isCard
                  ? formatCardPanGroups(dec.secretValue)
                  : dec.secretValue
                : isCard
                  ? `••••  ••••  ••••  ${meta?.last4 || '••••'}`
                  : '••••••••••••••••'}
            </div>
          </div>

          {isCard ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
                <div className="text-[11px] text-[var(--k-ink-muted)] mb-0.5">{t('vault.expiryLabel')}</div>
                <div className="k-mono text-[14px] text-[var(--k-ink-primary)]">
                  {dec?.expiry || meta?.expiry || '—'}
                </div>
              </div>
              <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] text-[var(--k-ink-muted)] mb-0.5">CVV</div>
                  <div className="k-mono text-[14px] text-[var(--k-ink-primary)]">
                    {revealed && dec?.cvv ? dec.cvv : dec?.cvv || meta?.hasCvv ? '•••' : '—'}
                  </div>
                </div>
                {dec?.cvv || meta?.hasCvv ? (
                  <button
                    type="button"
                    onClick={(e) => void handleCopy(e, item.id, 'cvv', 'CVV')}
                    aria-label={t('vault.copyCvvAria')}
                    className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)]"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {dec?.login || dec?.cardHolder ? (
            <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--k-ink-muted)] mb-0.5">
                  {isCard ? t('vault.holderLabel') : t('vault.loginLabel')}
                </div>
                <div className="text-[14px] text-[var(--k-ink-primary)] truncate k-selectable">
                  {dec?.cardHolder || dec?.login}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) =>
                  void handleCopy(
                    e,
                    item.id,
                    'login',
                    isCard ? t('vault.holderLabel') : t('vault.loginLabel')
                  )
                }
                aria-label={t('vault.copyLoginAria')}
                className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-1)] text-[var(--k-ink-secondary)] shrink-0"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          <div className="rounded-2xl p-3 bg-[var(--k-bg-surface-2)] border border-[var(--k-border-hairline)]">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] text-[var(--k-ink-muted)]">
                {t('vault.encryptedNotesLabel')}
              </span>
              {dec?.notes?.trim() ? (
                <button
                  type="button"
                  onClick={(e) => void handleCopy(e, item.id, 'notes', t('vault.commentLabel'))}
                  className="k-tap inline-flex items-center gap-1 px-2 h-6 rounded-lg bg-[var(--k-bg-surface-1)] text-[11px] font-medium text-[var(--k-ink-secondary)]"
                >
                  <Copy className="w-3 h-3" />
                  {t('vault.copyWord')}
                </button>
              ) : null}
            </div>
            <div className="text-[13.5px] leading-relaxed text-[var(--k-ink-primary)] whitespace-pre-wrap k-selectable">
              {dec?.notes?.trim() || t('vault.noComment')}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={(e) =>
            void handleCopy(
              e,
              item.id,
              'secretValue',
              isCard ? t('vault.cardPanLabel') : t('vault.valueLabel')
            )
          }
          className="k-tap w-full h-11 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13.5px] font-semibold inline-flex items-center justify-center gap-2"
        >
          <Copy className="w-4 h-4" />
          {isCard ? t('vault.copyPanFullBtn') : t('vault.copyValueFullBtn')}
        </button>
      </div>
    );
  };

  return (
    <div data-testid="mobile-vault-view" className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col h-full min-h-0">
        {/* Vault Header, Local Search & Filters */}
        <div className="px-4 pt-2.5 pb-2 space-y-2 border-b border-[var(--k-border-hairline)] shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--k-emerald)] font-medium whitespace-nowrap truncate">
              <ShieldCheck weight="duotone" className="w-4 h-4 shrink-0" />
              <span>
                {isExpanded
                  ? t('vault.headerUnlockedFull', { sec: wipeSeconds })
                  : t('vault.headerUnlockedCompact', { sec: wipeSeconds })}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                data-testid="vault-add-btn"
                onClick={() => openCreateForm('bank_card')}
                className="k-tap inline-flex items-center gap-1 px-2.5 h-8 rounded-xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[12px] font-semibold"
              >
                <Plus weight="bold" className="w-3.5 h-3.5" />
                {t('common.add')}
              </button>
              <button
                type="button"
                data-testid="vault-lock-btn"
                onClick={onLockVault}
                aria-label={t('vault.lockVaultAria')}
                className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
              >
                <Lock className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Isolated Vault Search */}
          <div className="relative">
            <MagnifyingGlass className="w-3.5 h-3.5 text-[var(--k-ink-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              data-testid="vault-local-search"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder={t('vault.searchPlaceholder')}
              className="w-full h-9 pl-8 pr-8 rounded-xl bg-[var(--k-bg-surface-1)] border border-[var(--k-border-hairline)] focus:border-[var(--k-border-focus)] outline-none text-[13px] text-[var(--k-ink-primary)] placeholder:text-[var(--k-ink-muted)]"
            />
            {localSearch ? (
              <button
                type="button"
                onClick={() => setLocalSearch('')}
                aria-label={t('vault.clearSearchAria')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--k-ink-muted)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto k-no-scrollbar k-scroll-fade-r pr-6 pb-0.5">
            {SECRET_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setKindFilter(f.id)}
                className={`k-tap px-2.5 py-1 rounded-xl text-[12px] font-medium shrink-0 border ${
                  kindFilter === f.id
                    ? 'bg-[var(--k-accent-soft)] border-[var(--k-border-focus)] text-[var(--k-accent)]'
                    : 'bg-[var(--k-bg-surface-1)] border-[var(--k-border-hairline)] text-[var(--k-ink-secondary)]'
                }`}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>

          {/* Live Clipboard Wipe Countdown Bar */}
          <AnimatePresence>
            {copyBadge && copyBadge.totalSec > 0 && copyBadge.remainingSec > 0 ? (
              <motion.div
                initial={{ opacity: 0, gridTemplateRows: '0fr' }}
                animate={{ opacity: 1, gridTemplateRows: '1fr' }}
                exit={{ opacity: 0, gridTemplateRows: '0fr' }}
                transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                className="grid overflow-hidden"
              >
                <div className="min-h-0 overflow-hidden">
                <div className="rounded-xl px-3 py-2 bg-[var(--k-emerald-soft)] border border-[var(--k-emerald)]/30 space-y-1.5">
                  <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--k-emerald)]">
                    <span>{t('vault.inClipboard', { label: copyBadge.label })}</span>
                    <span className="k-mono">{t('vault.clipboardWipe', { sec: copyBadge.remainingSec })}</span>
                  </div>
                  <div className="w-full h-1 rounded-full bg-[var(--k-emerald)]/20 overflow-hidden">
                    <div
                      style={{
                        width: `${Math.round((copyBadge.remainingSec / copyBadge.totalSec) * 100)}%`,
                        transition: 'width 900ms linear',
                      }}
                      className="h-full rounded-full bg-[var(--k-emerald)]"
                    />
                  </div>
                </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* 1-col Compact / 2-col Expanded Fold Grid */}
        <div className="flex-1 min-h-0 k-scroll p-3.5 pb-28">
          {secrets.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-14 px-6">
              <ShieldCheck weight="duotone" className="w-10 h-10 text-[var(--k-ink-muted)] mb-2.5" />
              <div className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
                {effectiveQuery ? t('vault.emptySearchTitle') : t('vault.emptyTitle')}
              </div>
              <p className="text-[13px] text-[var(--k-ink-muted)] mt-1 max-w-xs">
                {effectiveQuery
                  ? t('vault.emptySearchHint')
                  : t('vault.emptyHint')}
              </p>
              {!effectiveQuery ? (
                <button
                  type="button"
                  onClick={() => openCreateForm('bank_card')}
                  className="k-tap mt-4 inline-flex items-center gap-1.5 px-4 h-10 rounded-2xl bg-[var(--k-accent)] text-[var(--k-ink-on-accent)] text-[13px] font-semibold"
                >
                  <Plus weight="bold" className="w-4 h-4" />
                  {t('vault.emptyAddBtn')}
                </button>
              ) : null}
            </div>
          ) : (
            <div
              data-testid="vault-grid"
              className={`grid gap-3 ${
                isExpanded
                  ? editorMode !== 'closed' || Boolean(selectedSecret)
                    ? 'grid-cols-1 min-[1080px]:grid-cols-2'
                    : 'grid-cols-2'
                  : 'grid-cols-1'
              }`}
            >
              {secrets.map(renderSecretCard)}
            </div>
          )}
        </div>
      </div>

      {/* Expanded Right Side Inspector / Editor */}
      {isExpanded && (editorMode !== 'closed' || selectedSecret) ? (
        <aside
          data-testid="vault-detail-pane"
          className="w-[335px] lg:w-[375px] shrink-0 border-l border-[var(--k-border-hairline)] bg-[var(--k-bg-rail)] h-full min-h-0 k-scroll"
        >
          {editorMode !== 'closed' ? (
            <div>
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--k-border-hairline)]">
                <h3 className="text-[15px] font-semibold text-[var(--k-ink-primary)]">
                  {editorMode === 'edit' ? t('vault.editSheetTitle') : t('vault.newSheetTitle')}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditorMode('closed')}
                  className="k-tap inline-flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--k-bg-surface-2)] text-[var(--k-ink-secondary)]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {renderSecretForm()}
            </div>
          ) : selectedSecret ? (
            renderDetailPane(selectedSecret)
          ) : null}
        </aside>
      ) : null}

      {/* Compact Mode Bottom Sheets */}
      {!isExpanded ? (
        <>
          <BottomSheet
            open={!vaultLocked && editorMode !== 'closed'}
            title={editorMode === 'edit' ? t('vault.editSheetTitle') : t('vault.newSheetTitle')}
            isExpanded={false}
            onClose={() => setEditorMode('closed')}
          >
            {renderSecretForm()}
          </BottomSheet>

          <BottomSheet
            open={editorMode === 'closed' && Boolean(selectedSecret)}
            title={selectedSecret?.title || t('nav.vault')}
            isExpanded={false}
            onClose={() => onSelectSecret(null)}
          >
            {selectedSecret ? renderDetailPane(selectedSecret) : null}
          </BottomSheet>
        </>
      ) : null}

      <ItemActionSheet
        open={Boolean(actionSecret)}
        title={actionSecret?.title || t('nav.vault')}
        actions={actionSecret ? buildSecretActions(actionSecret) : []}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        onClose={() => setActionSecret(null)}
      />

      <MobilePickerSheet
        open={orbitPickerOpen}
        title={t('vault.orbitTitle')}
        value={orbit}
        isExpanded={isExpanded}
        hingeRightOffsetPx={hingeRightOffsetPx}
        allowCreate={Boolean(onCreateOrbit)}
        createPlaceholder={t('common.orbitNamePlaceholder')}
        onCreateNew={onCreateOrbit}
        options={[
          { value: '', label: t('common.noOrbit') },
          ...orbits.map((o) => ({
            value: o.id,
            label: o.name,
            color: o.color,
            count: o.itemCount,
          })),
        ]}
        onSelect={setOrbit}
        onClose={() => setOrbitPickerOpen(false)}
      />
    </div>
  );
};
