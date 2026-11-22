import { createContext, useContext } from 'react';

export interface MobileMediaCacheValue {
  retainMediaUrl: (localName?: string | null) => void;
  releaseMediaUrl: (localName?: string | null) => void;
}

const NOOP = () => {};

export const MobileMediaCacheContext = createContext<MobileMediaCacheValue>({
  retainMediaUrl: NOOP,
  releaseMediaUrl: NOOP,
});

export function useMobileMediaCache(): MobileMediaCacheValue {
  return useContext(MobileMediaCacheContext);
}
