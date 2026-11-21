import { matchesBilingualHaystack } from '@shared/bilingual-search';
import type { AppLocale } from '@shared/i18n/core';
import type { CalendarEvent, VaultItem } from '@shared/types';
import { stripMarkdownPreview } from '@renderer/lib/format';
import { getMobileIntlLocale, getRuntimeMobileLocale, tm } from './mobile-i18n';

export type MobileTabId = 'feed' | 'notes' | 'tasks' | 'calendar' | 'vault';

/**
 * Strips inline note image tags (`![alt](kapsula-media://...)`), wiki-links (`[[Title|Label]]`),
 * and markdown links before passing to `stripMarkdownPreview`, so card snippets stay clean.
 */
export function stripMobileInlineMarkdown(raw: string): string {
  const cleaned = (raw || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return stripMarkdownPreview(cleaned);
}

export function filterItemsByQuery(items: VaultItem[], rawQuery: string): VaultItem[] {
  const q = rawQuery.trim();
  if (!q) return items;

  return items.filter((item) => {
    const hay = [
      item.title,
      item.body,
      item.summary,
      item.url,
      item.domain,
      item.platform,
      item.ocrText,
      item.secretMeta?.service,
      item.secretMeta?.loginHint,
      item.secretMeta?.last4,
      item.mediaMeta?.transcript,
      ...(item.tags ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return matchesBilingualHaystack(hay, q);
  });
}

export function isMediaItem(item: VaultItem): boolean {
  return (
    item.dna === 'shot' ||
    item.dna === 'voice' ||
    item.dna === 'doc' ||
    Boolean(item.imagePath || item.thumbPath || item.mediaPath || item.ogImageUrl)
  );
}

export function getCardBrandLabel(brand?: string | null, locale?: AppLocale): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  if (!brand) return tm('brand.fallback', undefined, activeLocale);
  const map: Record<string, string> = {
    visa: 'VISA',
    mastercard: 'Mastercard',
    mir: tm('brand.mir', undefined, activeLocale),
    amex: 'AMEX',
    unionpay: 'UnionPay',
  };
  return map[brand.toLowerCase()] || brand.toUpperCase();
}

export function extractFirstUrlFromText(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')]+/i.exec(text || '');
  return m ? m[0].replace(/[.,!?;:]+$/, '') : null;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} ${many}`;
  if (last === 1) return `${n} ${one}`;
  if (last >= 2 && last <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function makeSafeUploadName(prefix: string, originalName: string, mime: string): string {
  const lowerMime = (mime || '').toLowerCase();
  const extFromName = originalName.includes('.')
    ? originalName.slice(originalName.lastIndexOf('.')).toLowerCase().replace(/[^a-z0-9.]/g, '')
    : '';
  const extFromMime = lowerMime.includes('png')
    ? '.png'
    : lowerMime.includes('jpeg') || lowerMime.includes('jpg')
      ? '.jpg'
      : lowerMime.includes('webp')
        ? '.webp'
        : lowerMime.startsWith('video/mp4')
          ? '.mp4'
          : lowerMime.startsWith('video/webm')
            ? '.webm'
            : lowerMime.includes('mp4') || lowerMime.includes('m4a') || lowerMime.includes('aac')
              ? '.m4a'
              : lowerMime.includes('webm')
                ? '.webm'
                : lowerMime.includes('wav')
                  ? '.wav'
                  : lowerMime.includes('ogg')
                    ? '.ogg'
                    : lowerMime.includes('pdf')
                      ? '.pdf'
                      : '.bin';
  const ext = extFromName && extFromName.length <= 8 ? extFromName : extFromMime;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}${ext}`;
}

export function sameCalendarDay(aMs: number, bDate: Date): boolean {
  const a = new Date(aMs);
  return (
    a.getFullYear() === bDate.getFullYear() &&
    a.getMonth() === bDate.getMonth() &&
    a.getDate() === bDate.getDate()
  );
}

export function eventOccursOnDay(ev: CalendarEvent, day: Date): boolean {
  if (ev.deletedAt) return false;
  const startDay = new Date(ev.startAt);
  const targetStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
  const targetEnd = targetStart + 86_400_000;

  if (!ev.recurrence || ev.recurrence === 'none') {
    if (ev.endAt > ev.startAt) {
      return ev.startAt < targetEnd && ev.endAt > targetStart;
    }
    return sameCalendarDay(ev.startAt, day);
  }

  const originStart = new Date(
    startDay.getFullYear(),
    startDay.getMonth(),
    startDay.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  if (targetStart < originStart) return false;

  if (ev.recurrence === 'daily') return true;
  if (ev.recurrence === 'weekdays') {
    const dow = day.getDay();
    return dow >= 1 && dow <= 5;
  }
  if (ev.recurrence === 'weekly') {
    return day.getDay() === startDay.getDay();
  }
  if (ev.recurrence === 'monthly') {
    return day.getDate() === startDay.getDate();
  }
  return false;
}

export function formatSyncTimeLabel(ts: number | null, locale?: AppLocale): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  if (!ts) return tm('syncTime.never', undefined, activeLocale);
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 30) return tm('syncTime.justNow', undefined, activeLocale);
  if (diffSec < 60) return tm('syncTime.secAgo', { sec: diffSec }, activeLocale);
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return tm('syncTime.minAgo', { min: diffMin }, activeLocale);
  return new Date(ts).toLocaleTimeString(getMobileIntlLocale(activeLocale), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface VaultSecurityGuardState {
  hasMasterPin: boolean;
  biometricEnabled: boolean;
  vaultLocked: boolean;
}

export type BiometricToggleGuardResult =
  | { action: 'allow' }
  | { action: 'require_biometric' }
  | { action: 'reject'; message: string };

/**
 * Prevents bypassing Master-PIN-only Vault protection by toggling Biometrics ON while locked,
 * and requires biometric confirmation before disabling active biometric protection.
 */
export function evaluateBiometricToggleGuard(
  nextEnabled: boolean,
  state: VaultSecurityGuardState,
  locale?: AppLocale
): BiometricToggleGuardResult {
  if (nextEnabled && state.hasMasterPin && state.vaultLocked) {
    return {
      action: 'reject',
      message: tm('guard.unlockPinForBiometric', undefined, locale),
    };
  }
  if (!nextEnabled && state.biometricEnabled) {
    return { action: 'require_biometric' };
  }
  return { action: 'allow' };
}

/**
 * Prevents disabling Vault idle auto-lock (minutes === 0) while a protected Vault is locked.
 */
export function evaluateAutoLockChangeGuard(
  nextMinutes: number,
  state: VaultSecurityGuardState,
  locale?: AppLocale
): { allowed: true } | { allowed: false; message: string } {
  if (nextMinutes === 0 && (state.hasMasterPin || state.biometricEnabled) && state.vaultLocked) {
    return {
      allowed: false,
      message: tm('guard.unlockVaultFirst', undefined, locale),
    };
  }
  return { allowed: true };
}
