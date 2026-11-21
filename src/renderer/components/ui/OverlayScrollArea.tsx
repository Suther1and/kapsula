import React from 'react';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';

interface OverlayScrollAreaProps {
  className?: string;
  children: React.ReactNode;
}

export const OverlayScrollArea: React.FC<OverlayScrollAreaProps> = ({
  className = '',
  children,
}) => (
  <OverlayScrollbarsComponent
    defer
    options={{
      scrollbars: {
        theme: 'os-theme-kapsula',
        autoHide: 'leave',
        autoHideDelay: 350,
      },
      overflow: {
        x: 'hidden',
        y: 'scroll',
      },
    }}
    className={className}
  >
    {children}
  </OverlayScrollbarsComponent>
);
