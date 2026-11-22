import { useEffect, useState } from 'react';

type TickListener = (nowSec: number) => void;

const listeners = new Set<TickListener>();
let timerId: ReturnType<typeof setInterval> | null = null;
let alignTimeoutId: ReturnType<typeof setTimeout> | null = null;

function currentSec(): number {
  return Math.floor(Date.now() / 1000);
}

function broadcastTick(): void {
  const sec = currentSec();
  for (const listener of listeners) {
    try {
      listener(sec);
    } catch {
      // ignore isolated subscriber errors
    }
  }
}

function startTickerIfNeeded(): void {
  if (timerId !== null || alignTimeoutId !== null || listeners.size === 0) return;
  const msIntoSec = Date.now() % 1000;
  const delay = msIntoSec === 0 ? 1000 : 1000 - msIntoSec;
  alignTimeoutId = setTimeout(() => {
    alignTimeoutId = null;
    if (listeners.size === 0) return;
    broadcastTick();
    timerId = setInterval(broadcastTick, 1000);
  }, delay);
}

function stopTickerIfIdle(): void {
  if (listeners.size > 0) return;
  if (alignTimeoutId !== null) {
    clearTimeout(alignTimeoutId);
    alignTimeoutId = null;
  }
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

export function subscribeSecondTick(listener: TickListener): () => void {
  listeners.add(listener);
  startTickerIfNeeded();
  return () => {
    listeners.delete(listener);
    stopTickerIfIdle();
  };
}

/**
 * Shared singleton 1Hz epoch-seconds hook.
 * Spawns at most one aligned interval across the entire window while >= 1 subscriber is enabled.
 */
export function useSecondTicker(enabled = true): number {
  const [nowSec, setNowSec] = useState<number>(() => currentSec());

  useEffect(() => {
    if (!enabled) return;
    setNowSec(currentSec());
    return subscribeSecondTick(setNowSec);
  }, [enabled]);

  return nowSec;
}
