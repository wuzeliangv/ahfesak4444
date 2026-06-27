/**
 * Country flag as an SVG (via the `flag-icons` set), keyed by ISO-3166
 * alpha-2 code. Replaces flag emoji, which don't render on Windows
 * (Segoe UI Emoji ships no flag glyphs).
 *
 * Size follows the surrounding font-size (the `.fi` class is em-based);
 * pass a text-* class to scale. Falls back to a globe emoji (which *does*
 * render cross-platform) for missing/invalid codes.
 */

import clsx from 'clsx';

interface Props {
  code?: string | null;
  className?: string;
  title?: string;
}

export function Flag({ code, className, title }: Props) {
  const cc = code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;

  if (!cc) {
    return (
      <span className={clsx('leading-none', className)} title={title}>
        🌐
      </span>
    );
  }

  return (
    <span
      className={clsx('fi', `fi-${cc}`, 'rounded-[2px] align-middle', className)}
      title={title}
      role="img"
      aria-label={code ?? undefined}
    />
  );
}
