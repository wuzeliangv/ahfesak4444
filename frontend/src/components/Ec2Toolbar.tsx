/**
 * EC2 page toolbar.
 *
 * Layout (left → right):
 *   🔄  ➕ 创建   🔀 更换IP (N)   ⚡ 状态 ▾   ………   已选 N 台
 *
 * - "刷新" is icon-only on the far left, matching the user's spec.
 * - "创建" opens the new-instance modal.
 * - "更换IP" stops then restarts selected instances; only enabled when ≥1 is
 *   selected. Parent handles the actual flow (stop → poll → start).
 * - "状态" is a dropdown menu with 启动 / 停止 / 重启; enabled with ≥1 selected.
 */

import { useEffect, useRef, useState } from 'react';
import {
  RefreshCcw,
  Plus,
  Shuffle,
  Zap,
  Play,
  Square,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from './ui/Button';

export type BatchAction = 'start' | 'stop' | 'reboot';

interface Props {
  refreshing: boolean;
  selectedCount: number;
  /** True while a batch op (change-ip / batch start-stop-reboot / delete) is running. */
  busy: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onChangeIp: () => void;
  onBatchAction: (action: BatchAction) => void;
  onBatchDelete: () => void;
}

export function Ec2Toolbar({
  refreshing,
  selectedCount,
  busy,
  onRefresh,
  onCreate,
  onChangeIp,
  onBatchAction,
  onBatchDelete,
}: Props) {
  const hasSelection = selectedCount > 0;

  return (
    <div className="mb-4 flex items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        onClick={onRefresh}
        className="!size-8 !p-0"
        aria-label="刷新"
        title="刷新"
        loading={refreshing}
      >
        <RefreshCcw size={14} />
      </Button>

      <Button size="sm" onClick={onCreate} leadingIcon={<Plus size={14} />}>
        创建
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={onChangeIp}
        leadingIcon={<Shuffle size={14} />}
        disabled={!hasSelection || busy}
        title={hasSelection ? '停止再启动选中的实例,以获取新公网 IP' : '请先勾选至少一台实例'}
      >
        更换 IP
      </Button>

      <StatusMenu disabled={!hasSelection || busy} onAction={onBatchAction} />

      <Button
        size="sm"
        variant={hasSelection ? 'danger' : 'ghost'}
        onClick={onBatchDelete}
        leadingIcon={<Trash2 size={14} />}
        disabled={!hasSelection || busy}
        title={hasSelection ? '终止选中实例 (不可恢复)' : '请先勾选至少一台实例'}
      >
        删除
      </Button>

      <div className="ml-auto text-xs text-[var(--color-fg-muted)]">
        {hasSelection ? (
          <span>
            已选 <span className="font-mono text-[var(--color-accent-300)]">{selectedCount}</span>{' '}
            台
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status dropdown — 启动 / 停止 / 重启 batch actions
// ---------------------------------------------------------------------------

function StatusMenu({
  disabled,
  onAction,
}: {
  disabled: boolean;
  onAction: (action: BatchAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const itemCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ' +
    'text-[var(--color-fg-secondary)] hover:bg-white/5 hover:text-[var(--color-fg-primary)] ' +
    'disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        leadingIcon={<Zap size={14} />}
        disabled={disabled}
        title={disabled ? '请先勾选至少一台实例' : '批量启动/停止/重启选中的实例'}
      >
        状态
      </Button>
      {open && (
        <div
          className="absolute inset-x-0 top-10 z-30 rounded-xl border border-[var(--color-border-glass)] bg-[var(--color-bg-popover)] backdrop-blur-xl p-1 shadow-lg animate-[fadeIn_120ms_ease-out]"
        >
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              onAction('start');
              setOpen(false);
            }}
          >
            <Play size={12} /> 启动
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              onAction('stop');
              setOpen(false);
            }}
          >
            <Square size={12} /> 停止
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              onAction('reboot');
              setOpen(false);
            }}
          >
            <RotateCcw size={12} /> 重启
          </button>
        </div>
      )}
    </div>
  );
}
