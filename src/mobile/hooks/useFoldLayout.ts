import { useEffect, useState } from 'react';
import { mobileBridge, type NativeFoldState } from '../native/bridge';

export const FOLD_EXPANDED_BREAKPOINT_PX = 600;

export interface FoldLayoutState {
  width: number;
  height: number;
  /** Compact outer screen (< 600dp) vs Expanded inner Fold screen (>= 600dp) */
  isExpanded: boolean;
  /** Very wide inner screen / landscape tablet (>= 840dp) */
  isWide: boolean;
  /** Half-opened horizontally (tabletop / flex mode) */
  isFlexTabletop: boolean;
  posture: NativeFoldState['posture'];
  isSeparating: boolean;
  hingeOrientation: NativeFoldState['hingeOrientation'];
  hingeBounds: NativeFoldState['hingeBounds'];
}

function readViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') {
    return { width: 390, height: 844 };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function useFoldLayout(): FoldLayoutState {
  const [viewport, setViewport] = useState(readViewport);
  const [nativeFold, setNativeFold] = useState<NativeFoldState>({
    posture: 'flat',
    isSeparating: false,
    hingeOrientation: 'none',
    hingeBounds: null,
  });

  useEffect(() => {
    const onResize = () => {
      setViewport(readViewport());
    };
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });

    let cancelled = false;
    void mobileBridge
      .getFoldState()
      .then((s) => {
        if (!cancelled && s) setNativeFold(s);
      })
      .catch(() => {});

    const offFold = mobileBridge.onFoldStateChanged((s) => {
      if (!cancelled && s) setNativeFold(s);
    });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      offFold();
    };
  }, []);

  const isExpanded = viewport.width >= FOLD_EXPANDED_BREAKPOINT_PX;
  const isWide = viewport.width >= 840;
  const isFlexTabletop =
    nativeFold.posture === 'half-opened' &&
    nativeFold.hingeOrientation === 'horizontal' &&
    Boolean(nativeFold.hingeBounds);

  return {
    width: viewport.width,
    height: viewport.height,
    isExpanded,
    isWide,
    isFlexTabletop,
    posture: nativeFold.posture,
    isSeparating: nativeFold.isSeparating,
    hingeOrientation: nativeFold.hingeOrientation,
    hingeBounds: nativeFold.hingeBounds,
  };
}
