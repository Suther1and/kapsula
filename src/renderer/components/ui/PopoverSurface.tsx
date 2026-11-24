import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { useScopedAccentStyle } from '../../lib/scoped-accent';

interface PopoverSurfaceProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactElement;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  widthClass?: string;
  /** Keep keyboard/editor focus untouched when opening/closing (critical for editor format pickers). */
  preserveFocus?: boolean;
}

export const PopoverSurface: React.FC<PopoverSurfaceProps> = ({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  widthClass = 'w-72',
  preserveFocus = false,
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
            initialFocus={preserveFocus ? false : undefined}
            finalFocus={preserveFocus ? false : undefined}
            style={scopedAccentStyle}
            className={`${widthClass} k-popover-card k-popover-slide p-3.5 text-[var(--k-ink-primary)] outline-none`}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
