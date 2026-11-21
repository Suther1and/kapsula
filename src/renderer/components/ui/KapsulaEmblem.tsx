import React from 'react';

interface Props {
  size?: number;
  className?: string;
}

/**
 * Architectural flat minimal Kapsula monogram mark.
 * Designed to sit natively in flat dark/light chrome without 3D raster noise.
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
    {/* Outer minimal rounded capsule contour tilted cleanly at 45° */}
    <g transform="rotate(-45 12 12)">
      <rect
        x="3.25"
        y="7.25"
        width="17.5"
        height="9.5"
        rx="4.75"
        stroke="currentColor"
        strokeOpacity="0.26"
        strokeWidth="1.5"
      />
      {/* Active accent half-pill */}
      <path
        d="M8 7.25H12V16.75H8C5.37665 16.75 3.25 14.6234 3.25 12C3.25 9.37665 5.37665 7.25 8 7.25Z"
        fill="var(--k-accent)"
      />
      {/* Subtle geometric split hairline */}
      <line
        x1="12"
        y1="7.75"
        x2="12"
        y2="16.25"
        stroke="var(--k-bg-rail)"
        strokeWidth="1.25"
      />
      {/* Minimal center dot */}
      <circle cx="15.75" cy="12" r="1.4" fill="currentColor" fillOpacity="0.55" />
    </g>
  </svg>
);
