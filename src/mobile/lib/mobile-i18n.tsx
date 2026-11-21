import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  detectLocale,
  formatCurrencyUsd,
  formatRelativeTime,
  formatShortDateTime,
  interpolate,
  pluralize,
  type AppLocale,
} from '@shared/i18n/core';
import {
  MOBILE_ACCENT_LABELS,
  MOBILE_DARK_BG_LABELS,
  MOBILE_DEFAULT_COLUMN_LABELS,
  MOBILE_DEFAULT_COLUMN_RU_TO_ID,
  MOBILE_DICT,
  MOBILE_DNA_LABELS,
  MOBILE_LIGHT_BG_LABELS,
  MOBILE_LOCALE_OPTIONS,
  MOBILE_NOTE_TEMPLATES,
  MOBILE_ONBOARDING_PRESETS,
  MOBILE_PLURALS,
  MOBILE_WEEKDAYS,
  type MobileDictKey,
  type MobilePluralKey,
} from '@shared/i18n/mobile-dict';
import type { ContentDna, ItemSubKind, TaskBoardColumn } from '@shared/types';
import type { NoteTemplate, OnboardingOrbitPreset, OnboardingWelcomeNote } from '@shared/note-templates';

export const MOBILE_LOCALE_STORAGE_KEY = 'kapsula_mobile_locale';

let runtimeLocaleOverride: AppLocale | null = null;

export function getUrlLocaleOverride(search?: string): AppLocale | null {
  try {
    const rawSearch =
      typeof search === 'string'
        ? search
        : typeof window !== 'undefined' && window.location
          ? window.location.search
          : '';
    if (!rawSearch) return null;
    const raw = new URLSearchParams(rawSearch).get('lang')?.trim().toLowerCase();
    if (raw === 'ru') return 'ru';
    if (raw === 'en') return 'en';
    return null;
  } catch {
    return null;
  }
}

export function isMobileLocaleLockedByUrl(search?: string): boolean {
  return getUrlLocaleOverride(search) !== null;
}

export function readStoredMobileLocale(): AppLocale | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)?.trim().toLowerCase();
    if (raw === 'ru' || raw === 'en') return raw;
    return null;
  } catch {
    return null;
  }
}

export function writeStoredMobileLocale(locale: AppLocale): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, locale);
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Resolution order:
 * 1. ?lang=ru|en URL param override (deterministic Playwright QA)
 * 2. Persisted mobile_locale in mobile-store / localStorage
 * 3. navigator.language ('ru*' -> 'ru', else 'en'; fallback 'ru' in headless Node)
 */
export function resolveMobileLocale(opts?: {
  urlSearch?: string;
  persistedLocale?: string | null;
  navigatorLanguage?: string | null;
}): AppLocale {
  const urlOverride = getUrlLocaleOverride(opts?.urlSearch);
  if (urlOverride) return urlOverride;

  const persistedRaw = opts?.persistedLocale ?? readStoredMobileLocale();
  const browserLocale =
    opts?.navigatorLanguage !== undefined
      ? opts.navigatorLanguage
      : typeof window !== 'undefined' &&
          typeof document !== 'undefined' &&
          typeof navigator !== 'undefined'
        ? navigator.language
        : null;

  return detectLocale(persistedRaw, browserLocale);
}

export function setRuntimeMobileLocale(locale: AppLocale | null): void {
  runtimeLocaleOverride = locale;
}

export function getRuntimeMobileLocale(): AppLocale {
  if (runtimeLocaleOverride) return runtimeLocaleOverride;
  const urlOverride = getUrlLocaleOverride();
  if (urlOverride) return urlOverride;
  return resolveMobileLocale();
}

export function getMobileIntlLocale(locale: AppLocale = getRuntimeMobileLocale()): string {
  return locale === 'en' ? 'en-US' : 'ru-RU';
}

export function tm(
  key: MobileDictKey,
  params?: Record<string, string | number>,
  locale?: AppLocale
): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  const table = MOBILE_DICT[activeLocale] ?? MOBILE_DICT[DEFAULT_LOCALE];
  const raw = table[key] ?? MOBILE_DICT[DEFAULT_LOCALE][key] ?? key;
  return interpolate(raw, params);
}

export function tmPlural(
  key: MobilePluralKey,
  count: number,
  locale?: AppLocale
): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  const forms = MOBILE_PLURALS[key];
  return `${count} ${pluralize(activeLocale, count, forms)}`;
}

export function tmPluralWord(
  key: MobilePluralKey,
  count: number,
  locale?: AppLocale
): string {
  const activeLocale = locale ?? getRuntimeMobileLocale();
  return pluralize(activeLocale, count, MOBILE_PLURALS[key]);
}

export function formatMobileRelativeDate(
  ts: number,
  locale: AppLocale = getRuntimeMobileLocale(),
  now = Date.now()
): string {
  return formatRelativeTime(locale, ts, now);
}

export function formatMobileShortDateTime(
  ts: number,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  return formatShortDateTime(locale, ts);
}

export function formatMobileReminderStamp(
  ts: number,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startTarget - startToday) / 86_400_000);
  const intl = getMobileIntlLocale(locale);
  const timeStr = d.toLocaleTimeString(intl, { hour: '2-digit', minute: '2-digit', hour12: false });

  if (dayDiff === 0) return tm('date.todayAt', { time: timeStr }, locale);
  if (dayDiff === 1) return tm('date.tomorrowAt', { time: timeStr }, locale);
  if (dayDiff === -1) return tm('date.yesterdayAt', { time: timeStr }, locale);

  return d.toLocaleString(intl, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatMobileDateCompact(
  ts: number,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    getMobileIntlLocale(locale),
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  );
}

export function formatMobileFileSize(
  bytes?: number | null,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return `0 ${tm('size.b', undefined, locale)}`;
  }
  const units: MobileDictKey[] = ['size.b', 'size.kb', 'size.mb', 'size.gb'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  const numStr = i === 0 ? String(val) : val.toFixed(1);
  const formattedNum = locale === 'en' ? numStr : numStr.replace('.', ',');
  return `${formattedNum} ${tm(units[i]!, undefined, locale)}`;
}

export function formatMobileUsd(
  amount: number,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  return formatCurrencyUsd(locale, amount);
}

export function getMobileDnaLabel(
  dna: ContentDna,
  _subKind?: ItemSubKind | null,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  const map = MOBILE_DNA_LABELS[locale] ?? MOBILE_DNA_LABELS.ru;
  return map[dna] || map.note || 'Note';
}

export function getMobileColumnTitle(
  col: Pick<TaskBoardColumn, 'id' | 'title'>,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  const defaultMap = MOBILE_DEFAULT_COLUMN_LABELS[locale] ?? MOBILE_DEFAULT_COLUMN_LABELS.ru;
  const trimmed = col.title.trim();
  const mappedId = MOBILE_DEFAULT_COLUMN_RU_TO_ID[trimmed];
  const lowerTrimmed = trimmed.toLowerCase();
  const isDefaultText =
    trimmed === MOBILE_DEFAULT_COLUMN_LABELS.ru[col.id] ||
    trimmed === MOBILE_DEFAULT_COLUMN_LABELS.en[col.id] ||
    lowerTrimmed === (MOBILE_DEFAULT_COLUMN_LABELS.en[col.id] ?? '').toLowerCase() ||
    mappedId === col.id;
  if (defaultMap[col.id] && (isDefaultText || !trimmed)) {
    return defaultMap[col.id]!;
  }
  return trimmed || defaultMap.inbox || tm('store.defaultColumn', undefined, locale);
}

export function getMobileAccentLabel(
  id: string,
  fallback: string,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  return MOBILE_ACCENT_LABELS[locale]?.[id] ?? fallback;
}

export function getMobileBgLabel(
  theme: 'dark' | 'light',
  id: string,
  fallback: string,
  locale: AppLocale = getRuntimeMobileLocale()
): string {
  const map = theme === 'dark' ? MOBILE_DARK_BG_LABELS[locale] : MOBILE_LIGHT_BG_LABELS[locale];
  return map?.[id] ?? fallback;
}

export function getMobileNoteTemplates(locale: AppLocale = getRuntimeMobileLocale()): NoteTemplate[] {
  return MOBILE_NOTE_TEMPLATES[locale] ?? MOBILE_NOTE_TEMPLATES.ru;
}

export function getMobileOnboardingPresets(locale: AppLocale = getRuntimeMobileLocale()): {
  orbits: OnboardingOrbitPreset[];
  welcomeNote: OnboardingWelcomeNote;
} {
  return MOBILE_ONBOARDING_PRESETS[locale] ?? MOBILE_ONBOARDING_PRESETS.ru;
}

export function getMobileWeekdays(
  locale: AppLocale = getRuntimeMobileLocale()
): readonly [string, string, string, string, string, string, string] {
  return MOBILE_WEEKDAYS[locale] ?? MOBILE_WEEKDAYS.ru;
}

export interface MobileI18nContextValue {
  locale: AppLocale;
  intlLocale: string;
  localeOptions: typeof MOBILE_LOCALE_OPTIONS;
  setLocale: (next: AppLocale) => void;
  t: (key: MobileDictKey, params?: Record<string, string | number>) => string;
  plural: (key: MobilePluralKey, count: number) => string;
  pluralWord: (key: MobilePluralKey, count: number) => string;
  formatRelativeDate: (ts: number, now?: number) => string;
  formatShortDateTime: (ts: number) => string;
  formatReminderStamp: (ts: number) => string;
  formatDateCompact: (ts: number) => string;
  formatFileSize: (bytes?: number | null) => string;
  formatUsd: (amount: number) => string;
  getDnaLabel: (dna: ContentDna, subKind?: ItemSubKind | null) => string;
  getColumnTitle: (col: Pick<TaskBoardColumn, 'id' | 'title'>) => string;
  getAccentLabel: (id: string, fallback: string) => string;
  getBgLabel: (theme: 'dark' | 'light', id: string, fallback: string) => string;
  noteTemplates: NoteTemplate[];
  onboardingPresets: { orbits: OnboardingOrbitPreset[]; welcomeNote: OnboardingWelcomeNote };
  weekdays: readonly [string, string, string, string, string, string, string];
}

const MobileI18nContext = createContext<MobileI18nContextValue | null>(null);

export const MobileI18nProvider: React.FC<{
  locale?: AppLocale;
  onLocaleChange?: (next: AppLocale) => void;
  children: React.ReactNode;
}> = ({ locale: controlledLocale, onLocaleChange, children }) => {
  const [internalLocale, setInternalLocale] = useState<AppLocale>(() =>
    controlledLocale ?? resolveMobileLocale()
  );

  const activeLocale = controlledLocale ?? internalLocale;

  useEffect(() => {
    setRuntimeMobileLocale(activeLocale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = activeLocale;
      document.title = tm('app.title', undefined, activeLocale);
    }
  }, [activeLocale]);

  const handleSetLocale = useCallback(
    (next: AppLocale) => {
      writeStoredMobileLocale(next);
      setRuntimeMobileLocale(next);
      if (controlledLocale === undefined) {
        setInternalLocale(next);
      }
      onLocaleChange?.(next);
    },
    [controlledLocale, onLocaleChange]
  );

  const value = useMemo<MobileI18nContextValue>(() => {
    const t = (key: MobileDictKey, params?: Record<string, string | number>) =>
      tm(key, params, activeLocale);
    return {
      locale: activeLocale,
      intlLocale: getMobileIntlLocale(activeLocale),
      localeOptions: MOBILE_LOCALE_OPTIONS,
      setLocale: handleSetLocale,
      t,
      plural: (key, count) => tmPlural(key, count, activeLocale),
      pluralWord: (key, count) => tmPluralWord(key, count, activeLocale),
      formatRelativeDate: (ts, now) => formatMobileRelativeDate(ts, activeLocale, now),
      formatShortDateTime: (ts) => formatMobileShortDateTime(ts, activeLocale),
      formatReminderStamp: (ts) => formatMobileReminderStamp(ts, activeLocale),
      formatDateCompact: (ts) => formatMobileDateCompact(ts, activeLocale),
      formatFileSize: (bytes) => formatMobileFileSize(bytes, activeLocale),
      formatUsd: (amount) => formatMobileUsd(amount, activeLocale),
      getDnaLabel: (dna, subKind) => getMobileDnaLabel(dna, subKind, activeLocale),
      getColumnTitle: (col) => getMobileColumnTitle(col, activeLocale),
      getAccentLabel: (id, fallback) => getMobileAccentLabel(id, fallback, activeLocale),
      getBgLabel: (theme, id, fallback) => getMobileBgLabel(theme, id, fallback, activeLocale),
      noteTemplates: getMobileNoteTemplates(activeLocale),
      onboardingPresets: getMobileOnboardingPresets(activeLocale),
      weekdays: getMobileWeekdays(activeLocale),
    };
  }, [activeLocale, handleSetLocale]);

  return <MobileI18nContext.Provider value={value}>{children}</MobileI18nContext.Provider>;
};

export function useMobileI18n(): MobileI18nContextValue {
  const ctx = useContext(MobileI18nContext);
  if (ctx) return ctx;

  // Fallback for isolated component tests rendered without MobileI18nProvider
  const fallbackLocale = getRuntimeMobileLocale();
  return {
    locale: fallbackLocale,
    intlLocale: getMobileIntlLocale(fallbackLocale),
    localeOptions: MOBILE_LOCALE_OPTIONS,
    setLocale: (next) => {
      writeStoredMobileLocale(next);
      setRuntimeMobileLocale(next);
    },
    t: (key, params) => tm(key, params, fallbackLocale),
    plural: (key, count) => tmPlural(key, count, fallbackLocale),
    pluralWord: (key, count) => tmPluralWord(key, count, fallbackLocale),
    formatRelativeDate: (ts, now) => formatMobileRelativeDate(ts, fallbackLocale, now),
    formatShortDateTime: (ts) => formatMobileShortDateTime(ts, fallbackLocale),
    formatReminderStamp: (ts) => formatMobileReminderStamp(ts, fallbackLocale),
    formatDateCompact: (ts) => formatMobileDateCompact(ts, fallbackLocale),
    formatFileSize: (bytes) => formatMobileFileSize(bytes, fallbackLocale),
    formatUsd: (amount) => formatMobileUsd(amount, fallbackLocale),
    getDnaLabel: (dna, subKind) => getMobileDnaLabel(dna, subKind, fallbackLocale),
    getColumnTitle: (col) => getMobileColumnTitle(col, fallbackLocale),
    getAccentLabel: (id, fallback) => getMobileAccentLabel(id, fallback, fallbackLocale),
    getBgLabel: (theme, id, fallback) => getMobileBgLabel(theme, id, fallback, fallbackLocale),
    noteTemplates: getMobileNoteTemplates(fallbackLocale),
    onboardingPresets: getMobileOnboardingPresets(fallbackLocale),
    weekdays: getMobileWeekdays(fallbackLocale),
  };
}
