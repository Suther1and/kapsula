import React from 'react';

interface Props {
  size?: number;
  className?: string;
}

/**
 * Architectural flat minimal Kapsula monogram mark.
 * Open enclosing capsule shell (currentColor) surrounding the solid core pill (var(--k-accent)).
 */
export const KapsulaEmblem: React.FC<Props> = ({ size = 20, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className={`shrink-0 select-none ${className}`}
  >
    <g transform="rotate(-45 12 12)">
      {/* Open outer capsule shell with precision gap on lower-right side */}
      <path
        d="M11.15 17.5H8.5A5.5 5.5 0 0 1 8.5 6.5H15.5A5.5 5.5 0 0 1 15.5 17.5H12.85"
        stroke="currentColor"
        strokeWidth="2.7"
        strokeLinecap="butt"
      />
      {/* Solid accent inner core capsule */}
      <rect x="5.5" y="8.95" width="13" height="6.1" rx="3.05" fill="var(--k-accent)" />
    </g>
  </svg>
);
