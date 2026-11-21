import type { AppLocale } from '../types';
import type { ru } from './ru';

export type { AppLocale };

export type TranslationKey = keyof typeof ru;
export type TranslationDict = Record<TranslationKey, string>;
export type TranslationParams = Record<string, string | number>;

export interface PluralForms {
  ru: [string, string, string];
  en: [string, string];
}

export type PluralNounKey = 'item' | 'task' | 'note' | 'day' | 'event' | 'file';

export interface I18nTranslator {
  locale: AppLocale;
  dateLocale: 'ru-RU' | 'en-US';
  t: (key: TranslationKey, params?: TranslationParams) => string;
  plural: (count: number, forms: PluralForms) => string;
  pluralNoun: (count: number, noun: PluralNounKey) => string;
  formatRelativeTime: (timestamp: number, now?: number) => string;
  formatShortDateTime: (timestamp: number) => string;
  formatCurrencyUsd: (amount: number) => string;
}
