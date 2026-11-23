import React from 'react';
import { Tooltip } from '@animate-ui/react/primitives/base-ui/tooltip';

interface TooltipHintProps {
  label?: string;
  content?: string;
  disabled?: boolean;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export const TooltipHint: React.FC<TooltipHintProps> = ({
  label,
  content,
  disabled = false,
  children,
  side = 'bottom',
}) => {
  const text = label || content || '';
  if (!text) return children;
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={10} className="z-[150]">
          <Tooltip.Popup
            transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.65 }}
            exitTransition={{ duration: 0.1 }}
            className="rounded-lg border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] backdrop-blur-md"
          >
            {text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
};
