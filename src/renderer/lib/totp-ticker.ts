import { useEffect, useMemo, useRef, useState } from 'react';
import type { TotpCodeSnapshot } from '@shared/types';
import { useSecondTicker } from '@shared/second-ticker';

/**
 * Shared 1Hz TOTP snapshot hook.
 * Calls `getTotpCode` IPC only on mount, version change, or when the TOTP period bucket advances
 * (default 30s), while computing `remainingSec` locally from the shared 1Hz ticker.
 */
export function useTotpSnapshot(
  itemId: string,
  enabled: boolean,
  versionKey?: unknown
): TotpCodeSnapshot | null {
  const nowSec = useSecondTicker(enabled);
  const [rawSnap, setRawSnap] = useState<TotpCodeSnapshot | null>(null);
  const periodRef = useRef<number>(30);
  const period = rawSnap?.period && rawSnap.period > 0 ? rawSnap.period : periodRef.current;
  const bucket = enabled ? Math.floor(nowSec / period) : -1;

  useEffect(() => {
    if (!enabled || !itemId) {
      setRawSnap(null);
      return;
    }
    let cancelled = false;
    window.kapsula
      .getTotpCode(itemId)
      .then((snap) => {
        if (cancelled) return;
        if (snap && snap.period > 0) {
          periodRef.current = snap.period;
        }
        setRawSnap(snap);
      })
      .catch(() => {
        if (!cancelled) setRawSnap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, enabled, bucket, versionKey]);

  return useMemo(() => {
    if (!enabled || !rawSnap) return null;
    const effectivePeriod = rawSnap.period > 0 ? rawSnap.period : 30;
    const remainingSec = Math.max(1, effectivePeriod - (nowSec % effectivePeriod));
    return {
      ...rawSnap,
      remainingSec,
    };
  }, [enabled, rawSnap, nowSec]);
}
