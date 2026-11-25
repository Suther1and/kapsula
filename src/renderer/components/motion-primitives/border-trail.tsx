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
  transition?: Transition;
  onAnimationComplete?: () => void;
  style?: React.CSSProperties;
};

const SINGLE_BEAM_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 274deg, color-mix(in srgb, var(--k-accent) 16%, transparent) 298deg, color-mix(in srgb, var(--k-accent) 58%, transparent) 330deg, var(--k-accent) 346deg, color-mix(in srgb, white 52%, var(--k-accent)) 354deg, transparent 360deg)';

const DUAL_BEAM_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 100deg, color-mix(in srgb, var(--k-accent) 16%, transparent) 124deg, color-mix(in srgb, var(--k-accent) 58%, transparent) 152deg, var(--k-accent) 168deg, color-mix(in srgb, white 52%, var(--k-accent)) 175deg, transparent 180deg, transparent 280deg, color-mix(in srgb, var(--k-accent) 16%, transparent) 304deg, color-mix(in srgb, var(--k-accent) 58%, transparent) 332deg, var(--k-accent) 348deg, color-mix(in srgb, white 52%, var(--k-accent)) 355deg, transparent 360deg)';

const SINGLE_HALO_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 286deg, color-mix(in srgb, var(--k-accent) 26%, transparent) 318deg, color-mix(in srgb, var(--k-accent) 70%, white 20%) 350deg, transparent 360deg)';

const DUAL_HALO_CONIC =
  'conic-gradient(from 0deg, transparent 0deg, transparent 110deg, color-mix(in srgb, var(--k-accent) 26%, transparent) 142deg, color-mix(in srgb, var(--k-accent) 70%, white 20%) 172deg, transparent 180deg, transparent 290deg, color-mix(in srgb, var(--k-accent) 26%, transparent) 322deg, color-mix(in srgb, var(--k-accent) 70%, white 20%) 352deg, transparent 360deg)';

export function BorderTrail({
  className,
  glow = false,
  dual = false,
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

  const rotorStyle: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 'max(160%, 960px)',
    aspectRatio: '1 / 1',
    background: dual ? DUAL_BEAM_CONIC : SINGLE_BEAM_CONIC,
    animation: spinAnimation,
    willChange: 'transform',
    ...style,
  };

  return (
    <>
      {/* Crisp 1.5px optical specular rim light (100% GPU compositor rotation) */}
      <div className="pointer-events-none absolute -inset-[1px] rounded-[inherit] overflow-hidden border-[1.5px] border-transparent [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]">
        <div
          className={cn(className)}
          style={rotorStyle}
          onAnimationEnd={isOneShot ? onAnimationComplete : undefined}
        />
      </div>

      {/* Whisper-soft localized edge bloom synced with the leading tip */}
      {glow ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[1px] rounded-[inherit] overflow-hidden border-[2.5px] border-transparent blur-[3px] opacity-35 [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]"
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 'max(160%, 960px)',
              aspectRatio: '1 / 1',
              background: dual ? DUAL_HALO_CONIC : SINGLE_HALO_CONIC,
              animation: spinAnimation,
              willChange: 'transform',
            }}
          />
        </div>
      ) : null}
    </>
  );
}
