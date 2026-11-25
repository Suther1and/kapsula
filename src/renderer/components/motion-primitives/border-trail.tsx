import React from 'react';
import { cn } from '../../lib/cn';
import type { Transition } from 'motion/react';

export type BorderTrailProps = {
  className?: string;
  size?: number;
  borderRadius?: number;
  thickness?: number;
  glow?: boolean;
  dual?: boolean;
  surfaceBg?: string;
  transition?: Transition;
  onAnimationComplete?: () => void;
  style?: React.CSSProperties;
};

const SINGLE_BEAM_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 256deg, color-mix(in srgb, var(--k-accent) 14%, transparent) 284deg, color-mix(in srgb, var(--k-accent) 38%, transparent) 312deg, color-mix(in srgb, var(--k-accent) 76%, transparent) 334deg, var(--k-accent) 347deg, color-mix(in srgb, white 56%, var(--k-accent)) 354deg, transparent 360deg)';

const DUAL_BEAM_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 88deg, color-mix(in srgb, var(--k-accent) 14%, transparent) 114deg, color-mix(in srgb, var(--k-accent) 56%, transparent) 146deg, var(--k-accent) 166deg, color-mix(in srgb, white 56%, var(--k-accent)) 175deg, transparent 180deg, transparent 268deg, color-mix(in srgb, var(--k-accent) 14%, transparent) 294deg, color-mix(in srgb, var(--k-accent) 56%, transparent) 326deg, var(--k-accent) 346deg, color-mix(in srgb, white 56%, var(--k-accent)) 355deg, transparent 360deg)';

export function BorderTrail({
  className,
  borderRadius = 16,
  glow = false,
  dual = false,
  surfaceBg = 'var(--k-bg-surface-1)',
  transition,
  onAnimationComplete,
  style,
}: BorderTrailProps) {
  const durationSec =
    transition && typeof transition === 'object' && 'duration' in transition && typeof transition.duration === 'number'
      ? transition.duration
      : 6.5;

  const isOneShot =
    transition && typeof transition === 'object' && 'repeat' in transition && transition.repeat === 0;

  const spinAnimation = `k-border-trail-spin ${durationSec}s linear ${isOneShot ? '1 forwards' : 'infinite'}`;
  const insetPx = glow ? 1.75 : 1.5;

  const rotorStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '104%',
    minWidth: '104%',
    aspectRatio: '1 / 1',
    background: dual ? DUAL_BEAM_CONIC : SINGLE_BEAM_CONIC,
    animation: spinAnimation,
    willChange: 'transform',
    contain: 'strict',
    ...style,
  };

  return (
    <div className="pointer-events-none absolute -inset-[1px] z-0 rounded-[inherit] overflow-hidden">
      <div
        className={cn('k-border-trail-rotor', className)}
        style={rotorStyle}
        onAnimationEnd={isOneShot ? onAnimationComplete : undefined}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: `${insetPx}px`,
          borderRadius: `${Math.max(4, borderRadius - 1)}px`,
          background: surfaceBg,
        }}
      />
    </div>
  );
}
