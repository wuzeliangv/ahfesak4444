/**
 * Free Tier credit balance modal.
 *
 * Shows the new ($200 credit) plan state, including the remaining balance,
 * plan expiration, and status. Old 12-month-tier accounts get a clean
 * "no credit plan" message.
 */

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Coins, Loader2, XCircle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, type FreeTierState } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: '使用中',
  EXPIRED: '已过期',
  NOT_STARTED: '未启动',
  UNKNOWN: '未知',
};

const PLAN_LABELS: Record<string, string> = {
  PAID: '付费 ($200 信用)',
  FREE: '永久免费层',
  UNKNOWN: '未知',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('zh-CN');
  } catch {
    return iso;
  }
}

export function FreeTierModal({ open, onClose, accountId, accountAlias }: Props) {
  const [result, setResult] = useState<FreeTierState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const creds = await getAccountCredentials(accountId);
      return api.freeTierState(creds);
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

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    mutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  const busy = mutation.isPending;
  const remaining = result?.remaining_credits;
  const isActive = result?.status === 'ACTIVE';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="免费套餐"
      description={accountAlias}
      size="sm"
    >
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {busy && !result && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-fg-muted)]">
            <Loader2 size={14} className="animate-spin" />
            正在查询 Free Tier 计划…
          </div>
        )}

        {result && (
          <>
            {/* Big remaining balance card */}
            <div className="rounded-lg bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-secondary)]">
                <Coins size={14} className="text-[var(--color-accent-300)]" />
                剩余额度
              </div>
              <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-fg-primary)]">
                {remaining ? (
                  <>
                    {remaining.unit === 'USD' ? '$' : ''}
                    {remaining.amount.toFixed(2)}
                    {remaining.unit !== 'USD' && ` ${remaining.unit}`}
                  </>
                ) : (
                  <span className="text-base text-[var(--color-fg-muted)]">—</span>
                )}
              </div>
              {result.note && (
                <p className="mt-2 text-[11px] text-[var(--color-fg-muted)]">{result.note}</p>
              )}
            </div>

            {/* Plan details */}
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="计划类型"
                value={PLAN_LABELS[result.plan_type] ?? result.plan_type}
              />
              <Stat
                label="状态"
                value={STATUS_LABELS[result.status] ?? result.status}
                icon={
                  isActive ? (
                    <CheckCircle2 size={14} className="text-emerald-400" />
                  ) : result.status === 'EXPIRED' ? (
                    <XCircle size={14} className="text-[var(--color-status-error)]" />
                  ) : null
                }
              />
              <Stat label="账号 ID" value={result.account_id ?? '—'} mono />
              <Stat label="到期日" value={formatDate(result.expiration_date)} />
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
  label,
  value,
  icon,
  mono,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-secondary)]">
        {icon}
        {label}
      </div>
      <div
        className={
          'mt-1 text-sm font-medium text-[var(--color-fg-primary)] ' +
          (mono ? 'font-mono tabular-nums' : '')
        }
      >
        {value}
      </div>
    </div>
  );
}
