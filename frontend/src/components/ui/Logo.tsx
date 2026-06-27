/**
 * AWS 管理助手 brand mark.
 *
 * Three slider tracks with thumbs at different positions — a control-panel
 * metaphor on a blue rounded-square tile. Mirrors `public/favicon.svg`
 * pixel-for-pixel so the in-app logo and the favicon stay visually
 * identical at every size.
 *
 * `useId()` namespaces the gradient ID so multiple <Logo> instances in the
 * same page don't clash on the SVG `<defs>` lookup.
 */

import { useId } from 'react';

interface Props {
  size?: number;
  className?: string;
}

export function Logo({ size = 24, className }: Props) {
  const gradId = `logo-bg-${useId().replace(/:/g, '')}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      role="img"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5B8FFF" />
          <stop offset="100%" stopColor="#2D5BFF" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${gradId})`} />
      {/* Three slider tracks */}
      <g
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.45"
        fill="none"
      >
        <line x1="13" y1="22" x2="51" y2="22" />
        <line x1="13" y1="32" x2="51" y2="32" />
        <line x1="13" y1="42" x2="51" y2="42" />
      </g>
      {/* Slider thumbs at varied positions */}
      <g fill="#ffffff">
        <circle cx="22" cy="22" r="4.8" />
        <circle cx="42" cy="32" r="4.8" />
        <circle cx="30" cy="42" r="4.8" />
      </g>
    </svg>
  );
}
