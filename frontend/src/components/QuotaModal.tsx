/**
 * 全区域 vCPU 配额 — full-screen centered modal (replaces the old card-anchored
 * popover). Structure per spec:
 *
 *   Backdrop : fixed inset-0 z-50, bg-black/70, flex center
 *   Box      : fixed width, SOLID dark surface (opaque token, never glass),
 *              rounded-lg, shadow-2xl, subtle border
 *   Header   : "vCPUs 详情" + refresh + close (X), border-b
 *   Sub-head : column labels (地区 / On-Demand vCPU 配额)
 *   Body     : max-h-[60vh] overflow-y-auto list of regions
 *   Footer   : total summary
 *
 * Each region row shows one number — the account's On-Demand Standard vCPU
 * quota (L-1216C47A) for that region — in an attention-grabbing amber.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { X, RefreshCcw, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { getAccountCredentials, setAccountQuota } from '@/lib/vault';
import { regionInfo, regionDisplay } from '@/lib/regions';
import { Flag } from './ui/Flag';

interface Props {
  accountId: string;
  open: boolean;
  onClose: () => void;
}

export function QuotaModal({ accountId, open, onClose }: Props) {
  const q = useQuery({
    queryKey: ['quota-all', accountId],
    enabled: open,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      const data = await api.quotaAll(creds, undefined, signal);
      // Cache the headline + total back onto the account record.
      await setAccountQuota(accountId, {
        usEast1: data.regions.find((r) => r.region === 'us-east-1')?.value ?? undefined,
        totalAcrossRegions: data.summary.total_vcpu,
      });
      return data;
    },
  });

  // ESC to close + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop — dims the page; click to close */}
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/70"
      />

      {/* Box — SOLID surface (opaque token, no transparency).
          Fixed height so loading/loaded states share the same footprint —
          no resize from "square skeleton" to "tall list". The list area
          scrolls internally to absorb the difference. */}
      <div
        className={clsx(
          'relative flex h-[min(640px,85vh)] w-full max-w-[400px] flex-col overflow-hidden rounded-2xl',
          'border border-[var(--color-border-glass)] bg-[var(--color-bg-popover)] backdrop-blur-2xl shadow-2xl',
          'animate-[fadeIn_120ms_ease-out]',
        )}
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-[var(--color-border-glass)] p-4">
          <h2 className="text-base font-semibold tracking-tight">vCPUs 详情</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => q.refetch()}
              className="rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
              aria-label="刷新"
            >
              {q.isFetching ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RefreshCcw size={15} />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Column labels */}
        <div className="flex items-center justify-between px-4 py-2 text-xs text-[var(--color-fg-muted)]">
          <span>地区</span>
          <span>On-Demand Spot (已用/全部)</span>
        </div>

        {/* Scrollable list — flex-1 absorbs height so the footer stays
            anchored at the bottom regardless of loading state. */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {q.isError && (
            <p className="px-2 py-3 text-sm text-[var(--color-status-error)]">
              {(q.error as Error).message}
            </p>
          )}

          {!q.data && q.isLoading && (
            <ul className="space-y-1.5 px-2 py-1">
              {Array.from({ length: 14 }).map((_, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between"
                >
                  <span
                    className="h-4 animate-pulse rounded bg-white/5"
                    style={{ width: `${50 + ((i * 11) % 35)}%` }}
                  />
                  <span className="flex gap-1.5">
                    <span className="h-4 w-12 animate-pulse rounded bg-white/5" />
                    <span className="h-4 w-12 animate-pulse rounded bg-white/5" />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {q.data && (
            <ul>
              {q.data.regions.map((r) => {
                const info = regionInfo(r.region);
                return (
                  <li
                    key={r.region}
                    className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-white/5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Flag code={info.country} className="text-[15px]" />
                      <span className="truncate text-sm text-[var(--color-fg-secondary)]">
                        {regionDisplay(r.region)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <QuotaBlock used={r.used} total={r.value} />
                      <QuotaBlock used={r.used_spot} total={r.spot} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer total — always rendered (placeholders during load) so the
            box height never shifts between states. */}
        <footer className="border-t border-[var(--color-border-glass)] px-4 py-2.5 text-xs text-[var(--color-fg-muted)]">
          {q.data ? (
            <>
              共 {q.data.summary.regions_with_quota} 个区 · On-Demand{' '}
              <span className="font-mono text-[var(--color-fg-primary)]">
                {q.data.summary.total_used}/{q.data.summary.total_vcpu}
              </span>{' '}
              · Spot{' '}
              <span className="font-mono text-[var(--color-fg-primary)]">
                {q.data.summary.total_used_spot}/{q.data.summary.total_spot}
              </span>{' '}
              vCPU
            </>
          ) : (
            <span className="text-[var(--color-fg-muted)]">查询中…</span>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// One quota tag block — "已用/全部", colored by total:
//   total === 0  → yellow (warning: can't launch here)
//   total >= 1   → green  (ok / keep-alive)
//   total null   → muted  (unknown / not applicable)
// ---------------------------------------------------------------------------

function QuotaBlock({ used, total }: { used: number | null; total: number | null }) {
  const tone =
    total == null
      ? 'bg-white/5 text-[var(--color-fg-muted)]'
      : total >= 1
        ? 'bg-green-500/20 text-green-500'
        : 'bg-yellow-500/20 text-yellow-500';
  return (
    <span className={clsx('rounded px-2 py-0.5 text-xs font-mono tabular-nums', tone)}>
      {used == null ? '—' : used}/{total == null ? '—' : total}
    </span>
  );
}
