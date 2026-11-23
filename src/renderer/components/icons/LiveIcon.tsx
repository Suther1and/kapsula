import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export type LucideAnimatedComponent = React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLDivElement> & { size?: number } & React.RefAttributes<AnimatedIconHandle>
>;

const HoverDriveContext = createContext<boolean | null>(null);

/**
 * Provides parent-driven hover state to any nested <LiveIcon /> so hovering
 * a whole button, tab, or sidebar row animates the SVG icon cleanly.
 */
export const HoverIconProvider: React.FC<{ hovered: boolean; children: React.ReactNode }> = ({
  hovered,
  children,
}) => <HoverDriveContext.Provider value={hovered}>{children}</HoverDriveContext.Provider>;

interface LiveIconProps {
  icon: LucideAnimatedComponent;
  size?: number;
  active?: boolean;
  className?: string;
}

export const LiveIcon: React.FC<LiveIconProps> = ({
  icon: IconComp,
  size = 16,
  active,
  className = '',
}) => {
  const iconRef = useRef<AnimatedIconHandle | null>(null);
  const ctxHover = useContext(HoverDriveContext);
  const prefersReduced = useReducedMotion();
  const driven = active !== undefined ? active : ctxHover;

  useEffect(() => {
    if (prefersReduced || driven === null || driven === undefined) return;
    if (driven) {
      iconRef.current?.startAnimation();
    } else {
      iconRef.current?.stopAnimation();
    }
  }, [driven, prefersReduced]);

  // If neither active prop nor HoverIconProvider is active, render uncontrolled so self-hover still animates!
  if (driven === null || driven === undefined) {
    return (
      <IconComp
        size={size}
        className={`inline-flex items-center justify-center shrink-0 ${className}`}
      />
    );
  }

  return (
    <IconComp
      ref={iconRef}
      size={size}
      className={`inline-flex items-center justify-center shrink-0 pointer-events-none ${className}`}
    />
  );
};
