/**
 * Lightsail traffic query modal.
 *
 * Mirrors TrafficModal (EC2) — same UI, default range, quick-select chips,
 * and daily breakdown — but talks to `/lightsail/traffic` which uses
 * Lightsail's own `GetInstanceMetricData` under the hood. Lightsail uses
 * `instance_name` as the primary key instead of EC2's `i-…` ID and
 * `created_at` instead of `launch_time`.
 *
 * Date inputs convert to UTC ISO windows: start = 00:00:00Z of the start
 * day, end = 23:59:59Z of the end day.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, ArrowDown, ArrowUp, Loader2, Sigma } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, type LightsailInstance, type LightsailTrafficData } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';
import { formatBytes } from '@/lib/format';

interface Props {
  open: boolean;
  instance: LightsailInstance | null;
  accountId: string;
  onClose: () => void;
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoToUtcDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function LightsailTrafficModal({ open, instance, accountId, onClose }: Props) {
  const today = useMemo(() => toDateInputValue(new Date()), []);
  const launchDate = useMemo(() => isoToUtcDate(instance?.created_at), [instance?.created_at]);

  const [startDate, setStartDate] = useState<string>(launchDate ?? today);
  const [endDate, setEndDate] = useState<string>(today);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LightsailTrafficData | null>(null);

  useEffect(() => {
    if (!open) return;
    setStartDate(launchDate ?? today);
    setEndDate(today);
    setError(null);
    setResult(null);
  }, [open, launchDate, today, instance?.instance_name]);

  const mutation = useMutation({
    mutationFn: async (vars: { start: string; end: string }) => {
      if (!instance || !instance.region) throw new Error('未选择实例');
      const creds = await getAccountCredentials(accountId);
      const startIso = `${vars.start}T00:00:00.000Z`;
      const endIso = `${vars.end}T23:59:59.999Z`;
      return api.lightsailTraffic(
        creds,
        instance.region,
        instance.instance_name,
        startIso,
        endIso,
      );
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

  function handleQuery() {
    setError(null);
    if (!startDate || !endDate) {
      setError('请选择起止日期');
      return;
    }
    if (endDate < startDate) {
      setError('结束日期不能早于开始日期');
      return;
    }
    mutation.mutate({ start: startDate, end: endDate });
  }

  // Auto-fire on first open per instance.
  useEffect(() => {
    if (!open || !instance) return;
    if (!startDate || !endDate) return;
    mutation.mutate({ start: startDate, end: endDate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.instance_name]);

  const busy = mutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="流量查询"
      description={
        instance ? (
          <span>
            {instance.display_name}
            <span className="ml-2 text-[var(--color-fg-muted)]">
              · {instance.region} · {instance.instance_name}
            </span>
          </span>
        ) : undefined
      }
      size="lg"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-wide text-[var(--color-fg-secondary)]">
              开始日期
            </span>
            <input
              type="date"
              value={startDate}
              max={endDate || today}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={busy}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-wide text-[var(--color-fg-secondary)]">
              结束日期
            </span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={today}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={busy}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </label>
          <Button type="button" size="sm" onClick={handleQuery} loading={busy}>
            {busy ? '查询中…' : '查询'}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <RangeChip
            label="今日"
            disabled={busy}
            onClick={() => {
              setStartDate(today);
              setEndDate(today);
            }}
          />
          <RangeChip
            label="近 7 天"
            disabled={busy}
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() - 6);
              setStartDate(toDateInputValue(d));
              setEndDate(today);
            }}
          />
          <RangeChip
            label="近 30 天"
            disabled={busy}
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() - 29);
              setStartDate(toDateInputValue(d));
              setEndDate(today);
            }}
          />
          {launchDate && (
            <RangeChip
              label="开机至今"
              disabled={busy}
              onClick={() => {
                setStartDate(launchDate);
                setEndDate(today);
              }}
            />
          )}
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
            正在查询 Lightsail 流量数据…
          </div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat
                icon={<ArrowDown size={14} className="text-emerald-400" />}
                label="入站"
                value={formatBytes(result.in_bytes)}
              />
              <Stat
                icon={<ArrowUp size={14} className="text-sky-400" />}
                label="出站"
                value={formatBytes(result.out_bytes)}
              />
              <Stat
                icon={<Sigma size={14} className="text-[var(--color-accent-300)]" />}
                label="总计"
                value={formatBytes(result.total_bytes)}
              />
            </div>

            <div className="rounded-lg border border-[var(--color-border-glass)] bg-white/[0.02]">
              <div className="flex items-center justify-between px-3 py-2 text-[11px] font-medium text-[var(--color-fg-secondary)]">
                <span>按日明细</span>
                <span className="text-[var(--color-fg-muted)]">
                  采样粒度: {periodLabel(result.period_seconds)}
                </span>
              </div>
              {result.daily.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-[var(--color-fg-muted)]">
                  所选区间内无指标数据。
                  <span className="ml-1">
                    (实例需处于运行状态才会上报；停机期间无指标。)
                  </span>
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-[var(--color-bg-elev)]/95 backdrop-blur text-[var(--color-fg-muted)]">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">日期 (UTC)</th>
                        <th className="px-3 py-1.5 text-right font-medium">入站</th>
                        <th className="px-3 py-1.5 text-right font-medium">出站</th>
                        <th className="px-3 py-1.5 text-right font-medium">合计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.daily.map((row) => {
                        const total = row.in_bytes + row.out_bytes;
                        return (
                          <tr
                            key={row.date}
                            className="border-t border-[var(--color-border-glass)]/60"
                          >
                            <td className="px-3 py-1.5 tabular-nums text-[var(--color-fg-primary)]">
                              {row.date}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {formatBytes(row.in_bytes)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {formatBytes(row.out_bytes)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                              {formatBytes(total)}
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

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-glass)] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-secondary)]">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-[var(--color-fg-primary)]">
        {value}
      </div>
    </div>
  );
}

function RangeChip({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-[var(--color-border-glass)] bg-white/[0.02] px-2 py-0.5 text-[var(--color-fg-secondary)] transition-colors hover:border-white/30 hover:text-[var(--color-fg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function periodLabel(seconds: number): string {
  if (seconds <= 60) return '1 分钟';
  if (seconds <= 300) return '5 分钟';
  if (seconds <= 3600) return '1 小时';
  if (seconds <= 86400) return '1 天';
  return `${seconds}s`;
}
