/**
 * Account billing query modal.
 *
 * Pulls Cost Explorer data (UnblendedCost, grouped by SERVICE) for a single
 * calendar month. The user picks a month; we default to the current one.
 *
 * Cost Explorer data lags by 24–48 hours, so figures for the in-progress
 * month are flagged as estimates in the UI.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Loader2, Receipt } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, type MonthlyBillData } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
}

function ymKey(d: Date): { year: number; month: number } {
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** Build a list of recent months from `now` going back `count` months. */
function recentMonths(count: number): Array<{ year: number; month: number; label: string }> {
  const out: Array<{ year: number; month: number; label: string }> = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    });
  }
  return out;
}

function formatMoney(amount: number, currency: string): string {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}

export function BillingModal({ open, onClose, accountId, accountAlias }: Props) {
  const months = useMemo(() => recentMonths(12), []);
  const current = ymKey(new Date());

  const [selected, setSelected] = useState<{ year: number; month: number }>(current);
  const [result, setResult] = useState<MonthlyBillData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal re-opens for a different account.
  useEffect(() => {
    if (!open) return;
    setSelected(current);
    setResult(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  const mutation = useMutation({
    mutationFn: async (vars: { year: number; month: number }) => {
      const creds = await getAccountCredentials(accountId);
      return api.billingMonthly(creds, vars.year, vars.month);
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err) => {
      setError((err as Error).message ?? '查询失败');
      setResult(null);
    },
  });

  // Auto-fire once when modal first opens.
  useEffect(() => {
    if (!open) return;
    mutation.mutate(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  const busy = mutation.isPending;

  function handleSelectMonth(year: number, month: number) {
    setSelected({ year, month });
    mutation.mutate({ year, month });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="账单费用"
      description={accountAlias}
      size="sm"
    >
      <div className="space-y-4">
        {/* Month picker */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="mr-1 text-[var(--color-fg-muted)]">月份:</span>
          {months.map((m) => {
            const active = m.year === selected.year && m.month === selected.month;
            return (
              <button
                key={`${m.year}-${m.month}`}
                type="button"
                onClick={() => handleSelectMonth(m.year, m.month)}
                disabled={busy}
                className={
                  'rounded-md border px-2 py-0.5 tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                  (active
                    ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)]/15 text-[var(--color-accent-300)]'
                    : 'border-[var(--color-border-glass)] bg-white/[0.02] text-[var(--color-fg-secondary)] hover:border-white/30 hover:text-[var(--color-fg-primary)]')
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {busy && !result && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-fg-muted)]">
            <Loader2 size={14} className="animate-spin" />
            正在查询账单数据…
          </div>
        )}

        {result && (
          <>
            {/* Total card */}
            <div className="rounded-lg bg-white/[0.02] p-3">
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-secondary)]">
                <Receipt size={14} className="text-[var(--color-accent-300)]" />
                {result.year}-{String(result.month).padStart(2, '0')} 总额
                {result.is_estimate && (
                  <span className="rounded bg-[var(--color-status-warn)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-status-warn)]">
                    本月进行中,数据为估算
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-[var(--color-fg-primary)]">
                {formatMoney(result.total, result.currency)}
              </div>
              {result.note && (
                <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">{result.note}</p>
              )}
            </div>

            {/* Services table */}
            <div className="rounded-lg bg-white/[0.02]">
              <div className="flex items-center justify-between px-3 py-2 text-[11px] font-medium text-[var(--color-fg-secondary)]">
                <span>按服务拆分</span>
                <span className="text-[var(--color-fg-muted)]">
                  共 {result.services.length} 个服务
                </span>
              </div>
              {result.services.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-[var(--color-fg-muted)]">
                  所选月份无消费记录。
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full table-fixed text-xs">
                    <thead className="sticky top-0 bg-[var(--color-bg-elev)]/95 backdrop-blur text-[var(--color-fg-muted)]">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">服务</th>
                        <th className="w-[80px] px-3 py-1.5 text-right font-medium">金额</th>
                        <th className="w-[52px] px-3 py-1.5 text-right font-medium">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.services.map((row) => {
                        const pct =
                          result.total > 0 ? (row.amount / result.total) * 100 : 0;
                        return (
                          <tr
                            key={row.service}
                            className="border-t border-[var(--color-border-glass)]/60"
                          >
                            <td
                              className="truncate px-3 py-1.5 text-[var(--color-fg-primary)]"
                              title={row.service}
                            >
                              {row.service}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {formatMoney(row.amount, result.currency)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-fg-muted)]">
                              {pct.toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex items-center justify-end pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
