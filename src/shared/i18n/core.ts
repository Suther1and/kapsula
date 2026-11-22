import type { AppLocale } from '../types';

export type { AppLocale };

export const DEFAULT_LOCALE: AppLocale = 'ru';

export function normalizeLocale(raw?: string | null): AppLocale {
  if (!raw) return DEFAULT_LOCALE;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('ru')) return 'ru';
  if (trimmed.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

export function detectLocale(
  override?: string | null,
  browserOrOsLocale?: string | null
): AppLocale {
  if (override && override.trim()) {
    const trimmed = override.trim().toLowerCase();
    if (trimmed.startsWith('ru')) return 'ru';
    if (trimmed.startsWith('en')) return 'en';
  }
  if (browserOrOsLocale && browserOrOsLocale.trim()) {
    return browserOrOsLocale.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
  }
  return DEFAULT_LOCALE;
}

export function interpolate(
  template: string,
  params?: Record<string, string | number>
): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (match, doubleKey, singleKey) => {
    const key = doubleKey || singleKey;
    if (key && Object.prototype.hasOwnProperty.call(params, key)) {
      return String(params[key]);
    }
    return match;
  });
}

export function pluralize(
  locale: AppLocale,
  count: number,
  forms: { ru: [string, string, string]; en: [string, string] }
): string {
  const abs = Math.abs(Math.trunc(count));
  if (locale === 'en') {
    return abs === 1 ? forms.en[0] : forms.en[1];
  }
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms.ru[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms.ru[1];
  return forms.ru[2];
}

export function formatRelativeTime(
  locale: AppLocale,
  timestamp: number,
  now = Date.now()
): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const diffMs = now - timestamp;
  if (diffMs < -45_000) {
    const aheadMin = Math.round(-diffMs / 60_000);
    if (aheadMin < 60) {
      return locale === 'en' ? `in ${Math.max(1, aheadMin)}m` : `через ${Math.max(1, aheadMin)} мин`;
    }
    const aheadHours = Math.floor(aheadMin / 60);
    if (aheadHours < 24) {
      return locale === 'en' ? `in ${aheadHours}h` : `через ${aheadHours} ч`;
    }
    return new Date(timestamp).toLocaleDateString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: 'numeric',
      month: 'short',
    });
  }
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 45) {
    return locale === 'en' ? 'just now' : 'только что';
  }
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) {
    return locale === 'en' ? `${diffMin}m ago` : `${diffMin} мин назад`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return locale === 'en' ? `${diffHours}h ago` : `${diffHours} ч назад`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return locale === 'en' ? 'yesterday' : 'вчера';
  }
  if (diffDays < 7) {
    return locale === 'en'
      ? `${diffDays}d ago`
      : `${diffDays} ${pluralize('ru', diffDays, { ru: ['день', 'дня', 'дней'], en: ['day', 'days'] })} назад`;
  }
  return new Date(timestamp).toLocaleDateString(locale === 'en' ? 'en-US' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

export function formatShortDateTime(locale: AppLocale, timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatCurrencyUsd(locale: AppLocale, amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const fixed = safe.toFixed(2);
  return locale === 'en' ? `$${fixed}` : `$${fixed.replace('.', ',')}`;
}
