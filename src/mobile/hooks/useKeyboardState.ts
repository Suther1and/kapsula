import { useEffect, useState } from 'react';
import { mobileBridge, type NativeKeyboardState } from '../native/bridge';

export interface KeyboardState {
  keyboardOpen: boolean;
  keyboardHeightDp: number;
}

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return (
      !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
        type
      ) && !(el as HTMLInputElement).readOnly
    );
  }
  return false;
}

/**
 * Tracks soft keyboard visibility across native Android (via MainActivity WindowInsets IME),
 * browser visualViewport resize, and Playwright test overrides — while locking root window
 * scroll to (0, 0) so WebView focus-reveal NEVER pushes fixed headers off the top edge.
 */
export function useKeyboardState(): KeyboardState {
  const [nativeState, setNativeState] = useState<NativeKeyboardState>({
    visible: false,
    heightDp: 0,
  });
  const [fallbackOpen, setFallbackOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void mobileBridge
      .getKeyboardState()
      .then((st) => {
        if (!cancelled && st) setNativeState(st);
      })
      .catch(() => {});

    const offNative = mobileBridge.onKeyboardStateChanged((st) => {
      if (!cancelled && st) setNativeState(st);
    });

    // Pin root document scroll to (0,0) so Chromium WebView never pans fixed headers off-screen
    const lockRootScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      if (document.documentElement.scrollTop !== 0) {
        document.documentElement.scrollTop = 0;
      }
      if (document.body.scrollTop !== 0) {
        document.body.scrollTop = 0;
      }
    };

    const syncFallback = () => {
      lockRootScroll();
      if (mobileBridge.isNativeAndroid()) return;
      const vv = window.visualViewport;
      const vvShrink = vv ? window.innerHeight - vv.height > 120 : false;
      const compactFocusedShortViewport =
        window.innerWidth < 600 &&
        window.innerHeight <= 540 &&
        isEditableElement(document.activeElement);
      setFallbackOpen(vvShrink || compactFocusedShortViewport);
    };

    const onFocusChange = () => {
      lockRootScroll();
      requestAnimationFrame(lockRootScroll);
      syncFallback();
    };

    window.addEventListener('scroll', lockRootScroll, { passive: true });
    window.addEventListener('resize', syncFallback, { passive: true });
    window.visualViewport?.addEventListener('resize', syncFallback, { passive: true });
    window.visualViewport?.addEventListener('scroll', lockRootScroll, { passive: true });
    document.addEventListener('focusin', onFocusChange, true);
    document.addEventListener('focusout', onFocusChange, true);

    return () => {
      cancelled = true;
      offNative();
      window.removeEventListener('scroll', lockRootScroll);
      window.removeEventListener('resize', syncFallback);
      window.visualViewport?.removeEventListener('resize', syncFallback);
      window.visualViewport?.removeEventListener('scroll', lockRootScroll);
      document.removeEventListener('focusin', onFocusChange, true);
      document.removeEventListener('focusout', onFocusChange, true);
    };
  }, []);

  const keyboardOpen = nativeState.visible || fallbackOpen;
  return {
    keyboardOpen,
    keyboardHeightDp: nativeState.heightDp,
  };
}
