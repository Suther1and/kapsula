import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { createTranslator, DEFAULT_LOCALE, normalizeLocale } from './index';
import type { AppLocale, I18nTranslator } from './types';

const I18nContext = createContext<I18nTranslator>(createTranslator(DEFAULT_LOCALE));

export interface I18nProviderProps {
  locale?: AppLocale | string | null;
  children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({ locale, children }) => {
  const normalized = normalizeLocale(locale);

  useEffect(() => {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = normalized;
    }
  }, [normalized]);

  const value = useMemo(() => createTranslator(normalized), [normalized]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nTranslator {
  return useContext(I18nContext);
}
