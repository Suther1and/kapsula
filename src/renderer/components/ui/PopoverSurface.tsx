import React from 'react';
import { Popover } from '@animate-ui/react/primitives/base-ui/popover';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

interface PopoverSurfaceProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactElement;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  widthClass?: string;
}

export const PopoverSurface: React.FC<PopoverSurfaceProps> = ({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  widthClass = 'w-72',
}) => {
  const scopedAccentStyle = useScopedAccentStyle();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-[130]"
        >
          <Popover.Popup
            data-k-popup="true"
            transition={{ type: 'spring', stiffness: 620, damping: 38, mass: 0.55 }}
            exitTransition={{ duration: 0.09 }}
            style={scopedAccentStyle}
            className={`${widthClass} rounded-2xl border border-[var(--k-border-strong)] bg-[var(--k-bg-elevated)] p-3.5 text-[var(--k-ink-primary)] shadow-[var(--k-shadow-popover)] backdrop-blur-xl outline-none`}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
