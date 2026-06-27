/**
 * Small display formatters.
 */

/**
 * How long ago an account was registered, as a single coarse unit:
 *   < 1 month → "N天"
 *   < 1 year  → "N个月"
 *   otherwise → "N年"
 *
 * Returns null for missing/invalid input so callers can skip rendering.
 */
export function accountAge(iso?: string | null): string | null {
  if (!iso) return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;

  const now = new Date();
  if (start.getTime() > now.getTime()) return '刚刚';

  // Whole months elapsed, accounting for day-of-month.
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;

  if (months < 1) {
    const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
    return `${Math.max(days, 0)}天`;
  }
  if (months < 12) return `${months}个月`;
  return `${Math.floor(months / 12)}年`;
}


/**
 * Human-readable byte count: 1.5 GB / 980 MB / 12.3 KB / 512 B.
 *
 * Uses binary units (1024) which is what AWS reports for NetworkIn/Out.
 * Negative or NaN input is rendered as "0 B".
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // < 10 → 2 decimals, < 100 → 1 decimal, otherwise integer.
  const fixed = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(fixed)} ${units[i]}`;
}
