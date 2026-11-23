import React, { useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';

interface SecretMorphFieldProps {
  revealed: boolean;
  maskedText: string;
  revealedText?: string | null;
  instantHide?: boolean;
  className?: string;
}

const NUMERIC_GLYPHS = '0123456789•#*';
const CRYPTO_GLYPHS = '0123456789ABCDEF•#*';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export const SecretMorphField: React.FC<SecretMorphFieldProps> = ({
  revealed,
  maskedText,
  revealedText,
  instantHide = false,
  className = '',
}) => {
  const prefersReduced = useReducedMotion();
  const showReal = revealed && Boolean(revealedText);
  const targetText = showReal ? revealedText || maskedText : maskedText;

  const [displayText, setDisplayText] = useState(targetText);
  const displayRef = useRef(targetText);
  const prevShowRealRef = useRef(showReal);
  const prevTargetRef = useRef(targetText);

  useLayoutEffect(() => {
    const prevShowReal = prevShowRealRef.current;
    const prevTarget = prevTargetRef.current;
    prevShowRealRef.current = showReal;
    prevTargetRef.current = targetText;

    // Initial mount or plain content edit without toggling reveal/hide: settle immediately
    if (prevShowReal === showReal) {
      if (prevTarget !== targetText || displayRef.current !== targetText) {
        displayRef.current = targetText;
        setDisplayText(targetText);
      }
      return;
    }

    // Security lock or reduced motion: hide plaintext instantaneously with zero linger
    if (prefersReduced || (instantHide && !showReal)) {
      displayRef.current = targetText;
      setDisplayText(targetText);
      return;
    }

    const fromText = displayRef.current;
    const toText = targetText;
    const revealing = showReal;
    const fromLen = fromText.length;
    const toLen = toText.length;
    const maxLen = Math.max(fromLen, toLen, 1);

    const isNumericOnly = /^[\d\s•·*-]+$/.test(revealing ? toText : fromText);
    const glyphs = isNumericOnly ? NUMERIC_GLYPHS : CRYPTO_GLYPHS;
    const durationMs = Math.min(620, Math.max(440, 380 + maxLen * 10));
    const bandWidth = Math.max(2.6, Math.min(4.8, maxLen * 0.24));
    const tickIntervalMs = 34;

    let rafId = 0;
    let startTime = 0;
    let lastTick = -tickIntervalMs;

    const renderFrame = (now: number) => {
      if (startTime === 0) startTime = now;
      const elapsed = now - startTime;
      const rawProgress = Math.min(1, elapsed / durationMs);

      if (rawProgress >= 1) {
        displayRef.current = toText;
        setDisplayText(toText);
        return;
      }

      if (elapsed - lastTick >= tickIntervalMs) {
        lastTick = elapsed;
        const p = easeInOutCubic(rawProgress);
        const curLen = Math.max(1, Math.round(fromLen + (toLen - fromLen) * p));
        const waveFront = p * (curLen + bandWidth);

        let next = '';
        for (let i = 0; i < curLen; i++) {
          const toCh = toText[i] ?? '';
          const fromCh = fromText[i] ?? '•';

          // Keep target spaces & already-visible characters (e.g. card last4) rock-steady
          if (toCh === ' ') {
            next += ' ';
            continue;
          }
          if (fromCh === toCh && toCh !== '•' && toCh !== '*') {
            next += toCh;
            continue;
          }

          const pos = revealing ? i : curLen - 1 - i;
          if (pos < waveFront - bandWidth) {
            next += toCh;
          } else if (pos < waveFront) {
            next += glyphs[Math.floor(Math.random() * glyphs.length)] ?? '•';
          } else {
            next += fromCh;
          }
        }

        displayRef.current = next;
        setDisplayText(next);
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [showReal, targetText, prefersReduced, instantHide]);

  const renderedText = instantHide && !showReal ? maskedText : displayText;

  return (
    <span
      className={`k-mono relative inline-block shrink-0 min-w-[36px] align-middle whitespace-nowrap transition-opacity duration-200 ease-[var(--k-ease-out)] ${
        showReal ? 'opacity-100 select-text' : 'opacity-90'
      } ${className}`}
    >
      {renderedText}
    </span>
  );
};
