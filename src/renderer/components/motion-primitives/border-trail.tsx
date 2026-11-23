import { cn } from '../../lib/cn';
import { motion, type Transition } from 'motion/react';

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

const DEFAULT_BEAM_GRADIENT =
  'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--k-accent) 14%, transparent) 28%, color-mix(in srgb, var(--k-accent) 56%, transparent) 66%, var(--k-accent) 85%, color-mix(in srgb, white 52%, var(--k-accent)) 94%, transparent 100%)';

const DEFAULT_HALO_GRADIENT =
  'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--k-accent) 26%, transparent) 55%, color-mix(in srgb, var(--k-accent) 70%, white 20%) 88%, transparent 100%)';

export function BorderTrail({
  className,
  size = 180,
  borderRadius = 16,
  thickness = 28,
  glow = false,
  dual = false,
  transition,
  onAnimationComplete,
  style,
}: BorderTrailProps) {
  const resolvedTransition: Transition = transition ?? {
    repeat: Infinity,
    duration: 6.5,
    ease: 'linear',
  };

  const durationSec =
    typeof resolvedTransition === 'object' && 'duration' in resolvedTransition && typeof resolvedTransition.duration === 'number'
      ? resolvedTransition.duration
      : 6.5;

  const path = `rect(0 auto auto 0 round ${borderRadius}px)`;
  const useDefaultBeam = !className || !className.includes('bg-');

  const beamBaseStyle: React.CSSProperties = {
    width: size,
    height: thickness,
    borderRadius: 999,
    offsetPath: path,
    offsetRotate: 'auto',
    offsetAnchor: 'center',
    ...(useDefaultBeam ? { background: DEFAULT_BEAM_GRADIENT } : {}),
    ...style,
  };

  return (
    <>
      {/* Crisp 1.5px optical specular rim light */}
      <div className="pointer-events-none absolute -inset-[1px] rounded-[inherit] border-[1.5px] border-transparent [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]">
        <motion.div
          className={cn('absolute', className)}
          style={beamBaseStyle}
          initial={{ offsetDistance: '0%' }}
          animate={{ offsetDistance: ['0%', '100%'] }}
          transition={resolvedTransition}
          onAnimationComplete={onAnimationComplete}
        />
        {dual ? (
          <motion.div
            className={cn('absolute opacity-55', className)}
            style={{ ...beamBaseStyle, width: Math.round(size * 0.72) }}
            initial={{ offsetDistance: '0%' }}
            animate={{ offsetDistance: ['0%', '100%'] }}
            transition={{ ...resolvedTransition, delay: -(durationSec / 2) }}
          />
        ) : null}
      </div>

      {/* Whisper-soft localized edge bloom synced with the leading tip */}
      {glow ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[1px] rounded-[inherit] border-[2.5px] border-transparent blur-[3.5px] opacity-35 [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]"
        >
          <motion.div
            className="absolute"
            style={{
              width: Math.round(size * 0.78),
              height: Math.round(thickness * 1.05),
              borderRadius: 999,
              offsetPath: path,
              offsetRotate: 'auto',
              offsetAnchor: 'center',
              background: DEFAULT_HALO_GRADIENT,
            }}
            initial={{ offsetDistance: '0%' }}
            animate={{ offsetDistance: ['0%', '100%'] }}
            transition={resolvedTransition}
          />
        </div>
      ) : null}
    </>
  );
}
