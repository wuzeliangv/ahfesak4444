/**
 * Trigger for the all-region vCPU quota view. Renders one of three button
 * styles and opens the centered <QuotaModal/> when clicked.
 *
 *   'vcpu'    — the compact "⚡ N vCPUs" tag used in the card header
 *   'chevron' — a plain ⌄ icon button
 *   'orb'     — the original glowing globe
 *
 * All quota fetching/rendering now lives in QuotaModal.
 */

import { useState } from 'react';
import { Globe, ChevronDown, Zap, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { QuotaModal } from './QuotaModal';

interface Props {
  accountId: string;
  trigger?: 'orb' | 'chevron' | 'vcpu';
  /** For the 'vcpu' trigger: the headline us-east-1 vCPU number. */
  vcpuValue?: number | null;
  vcpuLoading?: boolean;
  onRefreshVcpu?: () => void;
  defaultRegion?: string;
}

export function QuotaOrb({
  accountId,
  trigger = 'orb',
  vcpuValue = null,
  vcpuLoading = false,
  onRefreshVcpu,
  defaultRegion,
}: Props) {
  const [open, setOpen] = useState(false);

  const vcpuTone =
    vcpuValue == null
      ? 'bg-white/5 text-[var(--color-fg-muted)]'
      : vcpuValue <= 0
        ? 'bg-[var(--color-status-warn)]/15 text-[var(--color-status-warn)]'
        : 'bg-[var(--color-accent-500)]/15 text-[var(--color-accent-300)]';
  const vcpuDisplay = vcpuLoading && vcpuValue == null ? '…' : (vcpuValue ?? '?');

  return (
    <>
      {trigger === 'vcpu' ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRefreshVcpu}
            disabled={vcpuLoading}
            className={clsx(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition',
              vcpuTone,
              'hover:brightness-110 disabled:opacity-75',
            )}
            title={defaultRegion ? `点击刷新默认区域 (${defaultRegion}) vCPU 配额` : '点击刷新默认区域 vCPU 配额'}
            aria-label="刷新默认区域配额"
          >
            {vcpuLoading ? (
              <Loader2 size={11} className="shrink-0 animate-spin" />
            ) : (
              <Zap size={11} className="shrink-0" />
            )}
            <span>{vcpuDisplay} vCPUs</span>
          </button>

          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex size-6 items-center justify-center rounded bg-white/5 border border-white/[0.08] text-[var(--color-fg-muted)] hover:bg-[var(--color-accent-500)]/20 hover:text-[var(--color-accent-300)] hover:border-[var(--color-accent-500)]/30 transition-all duration-200"
            title="点击查看/查询全区域 vCPU 配额"
            aria-label="查看全区域配额"
          >
            <Globe size={13} />
          </button>
        </div>
      ) : trigger === 'chevron' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex size-7 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
          aria-label="查看全区域配额"
        >
          <ChevronDown size={16} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={clsx(
            'inline-flex items-center justify-center size-7 rounded-full',
            'bg-gradient-to-br from-[var(--color-accent-500)]/40 to-[var(--color-accent-600)]/20',
            'border border-[var(--color-accent-500)]/40 text-[var(--color-accent-300)]',
            'hover:from-[var(--color-accent-500)]/60 transition',
            'shadow-[0_0_12px_-2px_oklch(0.70_0.16_250/0.5)]',
          )}
          aria-label="查看全区域配额"
        >
          <Globe size={14} />
        </button>
      )}

      <QuotaModal accountId={accountId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
