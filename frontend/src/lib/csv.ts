/**
 * Tiny CSV / TSV helpers.
 *
 * CSV quoting follows RFC 4180:
 *   - any value containing  "  ,  \n  or  \r  is wrapped in double quotes
 *   - internal "  is escaped as ""
 *
 * Files are written with a UTF-8 BOM so Excel opens 中文 correctly.
 *
 * TSV (tab-separated) output is provided as a plain-text alternative for
 * users without Excel. It uses LF line endings and replaces tabs/newlines
 * inside cell values with spaces (so the format stays one-row-per-line).
 */

function escapeCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function tsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  // Tab/newline inside a cell would break TSV row parsing — strip them.
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

/** Build a CSV string from a header row + array of row objects. */
export function buildCSV<T extends Record<string, unknown>>(
  columns: { key: keyof T; label: string }[],
  rows: T[],
): string {
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => escapeCell(r[c.key])).join(',')).join('\r\n');
  return `${header}\r\n${body}\r\n`;
}

/** Build a TSV (tab-separated) plain-text dump — opens cleanly in Notepad. */
export function buildTSV<T extends Record<string, unknown>>(
  columns: { key: keyof T; label: string }[],
  rows: T[],
): string {
  const header = columns.map((c) => tsvCell(c.label)).join('\t');
  const body = rows.map((r) => columns.map((c) => tsvCell(r[c.key])).join('\t')).join('\n');
  return `${header}\n${body}\n`;
}

/**
 * Trigger a browser download of `content` as `filename`.
 *
 * `bom` defaults to true so Excel detects UTF-8 for non-ASCII CSV. Pass
 * `false` for JSON — a leading U+FEFF makes `JSON.parse` throw on re-import.
 */
export function downloadText(
  filename: string,
  content: string,
  mime = 'text/csv;charset=utf-8',
  bom = true,
): void {
  const prefix = bom ? '\uFEFF' : '';
  const blob = new Blob([prefix + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** YYYY-MM-DD for inclusion in export filenames. */
export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
