import React, { createContext, useContext } from 'react';

export const ScopedAccentContext = createContext<React.CSSProperties | undefined>(undefined);

export function useScopedAccentStyle(): React.CSSProperties | undefined {
  return useContext(ScopedAccentContext);
}
