/**
 * Account card — rebuilt to the structure in /root/md.txt.
 *
 *   Header : [☑ #idx  email…]                 [🇯🇵  11个月  ⚡16 vCPUs  ⌄]
 *   Body   : 分组  <group>
 *            备注  <note>
 *   Footer : [✏ 🗑]                            [EC2 实例] [Lightsail 实例] [⋮]
 *
 * Flat dark card (theme-token based so the light toggle still works), compact
 * text, rounded tags. The header ⌄ opens the all-region quota popover; the ⋮
 * menu holds secondary actions.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Pencil,
  Trash2,
  Server,
  Cloud,
  MoreVertical,
  Check,
  Globe,
  Receipt,
  Coins,
  ExternalLink,
  Bot,
  Network,
  KeyRound,
  Bell,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { getAccountCredentials, setAccountQuota, updateAccount } from '@/lib/vault';
import { type AccountRecord } from '@/lib/db';
import { countryName } from '@/lib/regions';
import { accountAge } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Button } from './ui/Button';
import { Flag } from './ui/Flag';
import { QuotaOrb } from './QuotaOrb';
import { BillingModal } from './BillingModal';
import { FreeTierModal } from './FreeTierModal';
import { RegionsAdminModal } from './RegionsAdminModal';
import { BedrockModal } from './BedrockModal';
import { IamSigninModal } from './IamSigninModal';
import { RotateKeyModal } from './RotateKeyModal';
import { PeeringModal } from './PeeringModal';

interface Props {
  account: AccountRecord;
  index: number;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenEc2: () => void;
  onOpenLightsail: () => void;
}

export function AccountCard({
  account,
  index,
  selected,
  onToggleSelect,
  onEdit,
  onDelete,
  onOpenEc2,
  onOpenLightsail,
}: Props) {
  const countryCode = account.verified?.countryCode ?? null;
  const age = accountAge(account.verified?.accountCreatedAt);

  // Live us-east-1 vCPU number — manual refresh only once cached data exists.
  const headlineQ = useQuery({
    queryKey: ['quota-headline', account.id, account.defaultRegion],
    staleTime: Infinity,
    initialData: account.quota?.usEast1 != null ? {
      region: account.defaultRegion,
      quota_code: 'L-1216C47A',
      value: account.quota.usEast1,
      name: 'Running On-Demand Standard (A, C, D, H, I, M, T, Z) instances',
    } : undefined,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(account.id);
      const data = await api.quotaRegion(creds, account.defaultRegion, signal);
      if (data.value != null) {
        await setAccountQuota(account.id, { usEast1: data.value });
        qc.invalidateQueries({ queryKey: ['accounts'] });
      }
      return data;
    },
  });

  const headline = headlineQ.data?.value ?? account.quota?.usEast1 ?? null;

  const qc = useQueryClient();
  const monitoring = account.monitorVcpu ?? false;
  const monitorMu = useMutation({
    mutationFn: (next: boolean) => updateAccount(account.id, { monitorVcpu: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
    onError: (e) => toast.error((e as Error).message, { title: '设置失败' }),
  });

  return (
    <article
      className={clsx(
        'glass-panel relative flex flex-col p-4 transition-all has-[[data-cardmenu-open]]:z-30',
        selected
          ? 'ring-2 ring-[var(--color-accent-500)]/60'
          : 'hover:-translate-y-0.5 hover:border-[var(--color-accent-500)]/40',
      )}
    >
      {/* ----- Header ----- */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label="选择账号"
            onClick={onToggleSelect}
            className={clsx(
              'flex size-4 shrink-0 items-center justify-center rounded border transition',
              selected
                ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)] text-white'
                : 'border-[var(--color-border-glass)] bg-transparent hover:border-[var(--color-accent-300)]',
            )}
          >
            {selected && <Check size={11} strokeWidth={3} />}
          </button>
          <span className="shrink-0 font-mono text-xs text-[var(--color-fg-muted)]">
            #{index}
          </span>
          <span className="truncate text-sm font-medium" title={account.alias}>
            {account.alias}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {countryCode && (
            <span
              className="inline-flex items-center rounded bg-white/5 px-1.5 py-1 leading-none"
              title={`注册地区:${countryName(countryCode)}`}
            >
              <Flag code={countryCode} className="text-[13px]" />
            </span>
          )}
          {age && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-[var(--color-fg-secondary)]">
              {age}
            </span>
          )}
          <button
            type="button"
            onClick={() => monitorMu.mutate(!monitoring)}
            disabled={monitorMu.isPending}
            aria-label="vCPU 配额监控"
            title={
              monitoring
                ? `已开启 vCPU 监控:每 ~45 分钟检测默认区配额,变化时 Telegram 通知${account.vcpuValue != null ? `(当前 ${account.vcpuValue})` : ''}`
                : '开启 vCPU 监控:定时检测默认区配额,变化时 Telegram 通知(需先在 Lambda 页配置 Telegram)'
            }
            className={clsx(
              'inline-flex size-6 items-center justify-center rounded transition',
              monitoring
                ? 'bg-[var(--color-accent-500)]/20 text-[var(--color-accent-300)]'
                : 'text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-fg-primary)]',
            )}
          >
            <Bell size={13} className={monitoring ? 'fill-current' : undefined} />
          </button>
          <QuotaOrb
            accountId={account.id}
            trigger="vcpu"
            vcpuValue={headline}
            vcpuLoading={headlineQ.isFetching}
            onRefreshVcpu={() => headlineQ.refetch()}
            defaultRegion={account.defaultRegion}
          />
        </div>
      </header>

      {/* ----- Body ----- */}
      <div className="mt-2 space-y-0.5 text-sm leading-tight">
        <p className="flex items-center gap-1.5 text-[var(--color-fg-muted)]">
          分组
          <span className="truncate text-[var(--color-fg-secondary)]">
            {account.group || ''}
          </span>
        </p>
        <p className="flex items-center gap-1.5 text-[var(--color-fg-muted)]">
          备注
          <span className="truncate text-[var(--color-fg-secondary)]">
            {account.note || ''}
          </span>
        </p>
      </div>

      {/* ----- Footer ----- */}
      <footer className="mt-4 flex items-center justify-between gap-2 pt-3">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            aria-label="编辑账号"
            className="!size-8 !p-0"
          >
            <Pencil size={14} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            aria-label="删除账号"
            className="!size-8 !p-0 hover:!text-[var(--color-status-error)]"
          >
            <Trash2 size={14} />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" leadingIcon={<Server size={14} />} onClick={onOpenEc2}>
            EC2 实例
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<Cloud size={14} />}
            onClick={onOpenLightsail}
          >
            Lightsail 实例
          </Button>
          <CardMenu
            localAccountId={account.id}
            accountAlias={account.alias}
            defaultRegion={account.defaultRegion}
          />
        </div>
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// "⋮" more menu — secondary per-card actions.
// ---------------------------------------------------------------------------

function CardMenu({
  localAccountId,
  accountAlias,
  defaultRegion,
}: {
  localAccountId: string;
  accountAlias: string;
  defaultRegion: string;
}) {
  const [open, setOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [freeTierOpen, setFreeTierOpen] = useState(false);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [bedrockOpen, setBedrockOpen] = useState(false);
  const [iamSigninOpen, setIamSigninOpen] = useState(false);
  const [rotateKeyOpen, setRotateKeyOpen] = useState(false);
  const [peeringOpen, setPeeringOpen] = useState(false);
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
    'disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="!size-8 !p-0"
        aria-label="更多操作"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreVertical size={14} />
      </Button>
      {open && (
        <div
          data-cardmenu-open
          className={
            'absolute right-0 top-10 z-30 w-44 rounded-2xl border p-1 shadow-lg ' +
            'border-[var(--color-border-glass)] bg-[var(--color-bg-popover)] backdrop-blur-xl ' +
            'animate-[fadeIn_120ms_ease-out]'
          }
        >
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setRegionsOpen(true);
              setOpen(false);
            }}
          >
            <Globe size={13} /> 启用地区
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setBillingOpen(true);
              setOpen(false);
            }}
          >
            <Receipt size={13} /> 账单费用
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setFreeTierOpen(true);
              setOpen(false);
            }}
          >
            <Coins size={13} /> 免费套餐
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setIamSigninOpen(true);
              setOpen(false);
            }}
          >
            <ExternalLink size={13} /> IAM 登录
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setBedrockOpen(true);
              setOpen(false);
            }}
          >
            <Bot size={13} /> Bedrock 权限
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setPeeringOpen(true);
              setOpen(false);
            }}
          >
            <Network size={13} /> VPC 对等连接
          </button>
          <button
            type="button"
            className={itemCls}
            onClick={() => {
              setRotateKeyOpen(true);
              setOpen(false);
            }}
          >
            <KeyRound size={13} /> 重置密钥
          </button>
        </div>
      )}

      <BillingModal
        open={billingOpen}
        onClose={() => setBillingOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <FreeTierModal
        open={freeTierOpen}
        onClose={() => setFreeTierOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <RegionsAdminModal
        open={regionsOpen}
        onClose={() => setRegionsOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <BedrockModal
        open={bedrockOpen}
        onClose={() => setBedrockOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <IamSigninModal
        open={iamSigninOpen}
        onClose={() => setIamSigninOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <RotateKeyModal
        open={rotateKeyOpen}
        onClose={() => setRotateKeyOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
      />
      <PeeringModal
        open={peeringOpen}
        onClose={() => setPeeringOpen(false)}
        accountId={localAccountId}
        accountAlias={accountAlias}
        defaultRegion={defaultRegion}
      />
    </div>
  );
}
