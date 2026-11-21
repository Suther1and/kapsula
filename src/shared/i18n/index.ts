import {
  DEFAULT_LOCALE,
  detectLocale,
  formatCurrencyUsd,
  formatRelativeTime,
  formatShortDateTime,
  interpolate,
  normalizeLocale,
  pluralize,
} from './core';
import { en } from './en';
import { ru } from './ru';
import type {
  AppLocale,
  I18nTranslator,
  PluralForms,
  PluralNounKey,
  TranslationDict,
  TranslationKey,
  TranslationParams,
} from './types';

export {
  DEFAULT_LOCALE,
  detectLocale,
  formatCurrencyUsd,
  formatRelativeTime,
  formatShortDateTime,
  interpolate,
  normalizeLocale,
  pluralize,
  ru,
  en,
};
export type {
  AppLocale,
  I18nTranslator,
  PluralForms,
  PluralNounKey,
  TranslationDict,
  TranslationKey,
  TranslationParams,
};

export const PLURAL_NOUNS: Record<PluralNounKey, PluralForms> = {
  item: { ru: ['запись', 'записи', 'записей'], en: ['item', 'items'] },
  task: { ru: ['задача', 'задачи', 'задач'], en: ['task', 'tasks'] },
  note: { ru: ['заметка', 'заметки', 'заметок'], en: ['note', 'notes'] },
  day: { ru: ['день', 'дня', 'дней'], en: ['day', 'days'] },
  event: { ru: ['событие', 'события', 'событий'], en: ['event', 'events'] },
  file: { ru: ['файл', 'файла', 'файлов'], en: ['file', 'files'] },
};

export function getDictionary(locale: AppLocale): TranslationDict {
  return locale === 'en' ? en : ru;
}

export function getDateLocale(locale: AppLocale): 'ru-RU' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'ru-RU';
}

export function translate(
  locale: AppLocale,
  key: TranslationKey,
  params?: TranslationParams
): string {
  const dict = getDictionary(locale);
  const template = dict[key] ?? ru[key] ?? key;
  return interpolate(template, params);
}

export function createTranslator(rawLocale?: string | null): I18nTranslator {
  const locale = normalizeLocale(rawLocale);
  const dateLocale = getDateLocale(locale);
  return {
    locale,
    dateLocale,
    t: (key, params) => translate(locale, key, params),
    plural: (count, forms) => pluralize(locale, count, forms),
    pluralNoun: (count, noun) => pluralize(locale, count, PLURAL_NOUNS[noun]),
    formatRelativeTime: (timestamp, now) => formatRelativeTime(locale, timestamp, now),
    formatShortDateTime: (timestamp) => formatShortDateTime(locale, timestamp),
    formatCurrencyUsd: (amount) => formatCurrencyUsd(locale, amount),
  };
}
