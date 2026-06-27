/**
 * EC2 管理页 — flat grid of compact instance cards.
 *
 * URL: /account/:id/ec2 (typically opened in a new tab)
 *
 * Card structure (per /root/222.png + user spec):
 *
 *   Header :  [☑ name ✎]                    [🇯🇵]
 *   Body   :  所属账号  <alias>
 *             公网 IP   <ip> [动态|静态]
 *             机器型号  t3.micro (2 vCPUs, 1 GB 内存, …)
 *             地区      日本 东京 A (ap-northeast-1a)
 *             创建      Nx天/Nx个月/Nx年
 *   Footer :  [▶ ⏹ ↻ 🗑]                    [⌄ 详情]
 *
 * Expanded (when ⌄ pressed): instance ID, private IP, AMI, VPC / Subnet,
 * security groups, platform, key, exact launch time.
 *
 * The vault must be unlocked (the App-level <VaultGate/> guarantees that;
 * if the page is reloaded into a locked state, the gate intercepts).
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  Play,
  Square,
  RotateCcw,
  Shuffle,
  Trash2,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  Server,
  ChevronDown,
  Pencil,
  X,
  RefreshCcw,
  Zap,
  Activity,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import type { Ec2CreateInput, Ec2Instance } from '@/lib/api';
import { getAccountCredentials, listAccounts } from '@/lib/vault';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { Flag } from '@/components/ui/Flag';
import { Ec2Toolbar, type BatchAction } from '@/components/Ec2Toolbar';
import { CreateEc2Modal } from '@/components/CreateEc2Modal';
import { TrafficModal } from '@/components/TrafficModal';
import { regionInfo, countryName } from '@/lib/regions';
import { azNameDisplay } from '@/lib/zones';
import { instanceTypeDisplay } from '@/lib/instanceTypes';
import { accountAge } from '@/lib/format';
import { usePageTitle } from '@/hooks/usePageTitle';

// ---------------------------------------------------------------------------
// Page entry — resolve account, then render the inner page
// ---------------------------------------------------------------------------

export function Ec2Page() {
  const { id } = useParams<{ id: string }>();

  usePageTitle('EC2 实例');

  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: listAccounts });
  const account = accountsQ.data?.find((a) => a.id === id);

  if (accountsQ.isLoading) {
    return (
      <PageFrame>
        <p className="mt-16 text-center text-sm text-[var(--color-fg-muted)]">加载中…</p>
      </PageFrame>
    );
  }

  if (!account) {
    return (
      <PageFrame>
        <div className="mx-auto mt-16 max-w-md rounded-2xl border border-[var(--color-border-glass)] bg-[var(--color-bg-elev)] backdrop-blur-xl p-6 text-center">
          <p className="text-sm text-[var(--color-fg-secondary)]">账号不存在或已被删除。</p>
        </div>
      </PageFrame>
    );
  }

  return (
    <Ec2PageInner
      accountId={account.id}
      alias={account.alias}
      defaultRegion={account.defaultRegion}
    />
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner page (account guaranteed to exist)
// ---------------------------------------------------------------------------

interface InnerProps {
  accountId: string;
  alias: string;
  defaultRegion: string;
}

function Ec2PageInner({ accountId, alias, defaultRegion }: InnerProps) {
  const qc = useQueryClient();

  const ec2Q = useQuery({
    queryKey: ['ec2-list', accountId],
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.ec2List(creds, undefined, signal);
    },
    staleTime: 60 * 1000,
    // Transient-state polling is handled by a side-effect below — it only
    // describes the instances that are actually mid-transition (per region)
    // instead of re-scanning every opted-in region on a timer.
  });

  // ---------- Transient-state poller -------------------------------------
  //
  // Every 3s, scan the cached instance list for `pending` / `stopping` /
  // `shutting-down` rows, group them by region, and call /ec2/describe with
  // only those IDs. The result is merged back into the React Query cache so
  // the UI reflects state changes within seconds — without re-scanning every
  // region the way a full /ec2/list would.
  //
  // Skips the tick entirely when (a) there is nothing transient, or (b) a
  // full refetch is already in flight (to avoid races where our merge
  // overwrites fresher data).
  useEffect(() => {
    const interval = setInterval(async () => {
      const cached = qc.getQueryData<{ instances: Ec2Instance[] }>([
        'ec2-list',
        accountId,
      ]);
      if (!cached?.instances?.length) return;
      // Skip if a full refetch is already in flight to avoid overwriting
      // fresher data. `isFetching` returns the count of in-flight queries
      // matching the key, so any positive value means "wait".
      if (qc.isFetching({ queryKey: ['ec2-list', accountId] }) > 0) return;

      const transient = cached.instances.filter(
        (i) =>
          i.state === 'pending' ||
          i.state === 'stopping' ||
          i.state === 'shutting-down',
      );
      if (transient.length === 0) return;

      // Group transient instance IDs by region.
      const byRegion = new Map<string, string[]>();
      for (const i of transient) {
        const arr = byRegion.get(i.region) ?? [];
        arr.push(i.instance_id);
        byRegion.set(i.region, arr);
      }

      try {
        const creds = await getAccountCredentials(accountId);
        const results = await Promise.all(
          Array.from(byRegion.entries()).map(([region, ids]) =>
            api
              .ec2Describe(creds, region, ids)
              .then((r) => r.instances)
              .catch(() => [] as Ec2Instance[]),
          ),
        );
        const updates = results.flat();
        if (updates.length === 0) return;
        const updMap = new Map(updates.map((i) => [i.instance_id, i] as const));

        // Merge into the cached list — only replace by ID, never add/remove
        // rows. A full refetch (manual or stale-time-expiry) is what
        // reconciles the broader list.
        qc.setQueryData<Awaited<ReturnType<typeof api.ec2List>>>(
          ['ec2-list', accountId],
          (old) => {
            if (!old) return old;
            return {
              ...old,
              instances: old.instances.map((i) => updMap.get(i.instance_id) ?? i),
            };
          },
        );
      } catch {
        // Network/auth hiccup — silently skip, next tick will retry.
      }
    }, 3000);

    return () => clearInterval(interval);
    // We intentionally keep the dependency list tight: this effect should
    // mount once per account and read the freshest cache inside each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, qc]);

  // ---------- UI state ----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  /** When set, the traffic modal is open for this instance. */
  const [trafficTarget, setTrafficTarget] = useState<Ec2Instance | null>(null);

  // Per-row spinner key: `${action}:${instanceId}`. Tracks in-flight ops.
  const [pending, setPending] = useState<Set<string>>(new Set());
  function markPending(key: string, on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // Multi-select for upcoming batch ops (delete / change IP / shutdown).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const controlMu = useMutation({
    mutationFn: async ({
      action,
      region,
      instanceId,
    }: {
      action: 'start' | 'stop' | 'reboot' | 'terminate';
      region: string;
      instanceId: string;
    }) => {
      const creds = await getAccountCredentials(accountId);
      if (action === 'start') return api.ec2Start(creds, region, instanceId);
      if (action === 'stop') return api.ec2Stop(creds, region, instanceId);
      if (action === 'reboot') return api.ec2Reboot(creds, region, instanceId);
      return api.ec2Terminate(creds, region, instanceId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ec2-list', accountId] }),
  });

  const renameMu = useMutation({
    mutationFn: async ({
      region,
      instanceId,
      name,
    }: {
      region: string;
      instanceId: string;
      name: string;
    }) => {
      const creds = await getAccountCredentials(accountId);
      return api.ec2Rename(creds, region, instanceId, name);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ec2-list', accountId] }),
  });

  // ---------- Create instance --------------------------------------------
  const createMu = useMutation({
    mutationFn: async (input: Ec2CreateInput) => {
      const creds = await getAccountCredentials(accountId);
      return api.ec2Create(creds, input);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ec2-list', accountId] }),
  });

  // ---------- Batch start / stop / reboot --------------------------------
  async function handleBatchAction(action: BatchAction) {
    const targets = (ec2Q.data?.instances ?? []).filter((i) => selected.has(i.instance_id));
    if (targets.length === 0) return;
    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const fn =
        action === 'start' ? api.ec2Start : action === 'stop' ? api.ec2Stop : api.ec2Reboot;
      await Promise.allSettled(targets.map((i) => fn(creds, i.region, i.instance_id)));
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['ec2-list', accountId] });
    }
  }

  // ---------- Batch delete (terminate) -----------------------------------
  async function handleBatchDelete() {
    const targets = (ec2Q.data?.instances ?? []).filter(
      (i) => selected.has(i.instance_id) && i.state !== 'terminated',
    );
    if (targets.length === 0) return;

    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const results = await Promise.allSettled(
        targets.map((i) => api.ec2Terminate(creds, i.region, i.instance_id)),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const msg = failures
          .map((r) => (r as PromiseRejectedResult).reason?.message ?? '未知错误')
          .join('\n');
        toast.error(msg, { title: `${failures.length} 台终止失败` });
      }
      // Deselect terminated instances so the next click doesn't keep them in scope.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.delete(t.instance_id);
        return next;
      });
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['ec2-list', accountId] });
    }
  }

  // ---------- Change IP: dynamic detach + re-attach (no stop/start) ------
  async function handleChangeIp() {
    const all = ec2Q.data?.instances ?? [];
    const eligible = all.filter(
      (i) => selected.has(i.instance_id) && i.state === 'running',
    );
    if (eligible.length === 0) {
      toast.warning('选中的实例必须处于"运行中"状态才能换 IP。');
      return;
    }
    const staticOnes = eligible.filter((i) => i.public_ip_type === 'static');
    if (staticOnes.length > 0) {
      toast.error(
        '请先在 AWS 控制台手动操作 EIP,或仅勾选动态 IP 实例。',
        { title: `${staticOnes.length} 台实例使用了弹性 IP (EIP)` },
      );
      return;
    }

    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const results = await Promise.allSettled(
        eligible.map((i) => api.ec2ChangeIp(creds, i.region, i.instance_id)),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const msg = failures
          .map((r) => (r as PromiseRejectedResult).reason?.message ?? '未知错误')
          .join('\n');
        toast.error(msg, { title: `${failures.length} 台换 IP 失败` });
      }
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['ec2-list', accountId] });
    }
  }

  // ---------- Per-card actions ------------------------------------------
  async function handleCardRefresh(instanceId: string) {
    const key = `refresh:${instanceId}`;
    markPending(key, true);
    try {
      await ec2Q.refetch();
    } finally {
      markPending(key, false);
    }
  }

  async function handleCardChangeIp(region: string, instanceId: string) {
    const inst = (ec2Q.data?.instances ?? []).find((i) => i.instance_id === instanceId);
    if (!inst) return;
    if (inst.state !== 'running') {
      toast.warning('实例必须处于"运行中"状态才能换 IP。');
      return;
    }
    if (inst.public_ip_type === 'static') {
      toast.error('该实例使用了弹性 IP (EIP),无法用此方式换 IP。');
      return;
    }
    const key = `change-ip:${instanceId}`;
    markPending(key, true);
    try {
      const creds = await getAccountCredentials(accountId);
      await api.ec2ChangeIp(creds, region, instanceId);
      qc.invalidateQueries({ queryKey: ['ec2-list', accountId] });
    } catch (e) {
      toast.error((e as Error).message, { title: '换 IP 失败' });
    } finally {
      markPending(key, false);
    }
  }

  const opBusy = batchBusy || createMu.isPending;

  const data = ec2Q.data;
  // Keep instances grouped by region visually (stable region order, name
  // within), but render as a single flat grid without section headers.
  // Terminated instances linger in DescribeInstances output for ~1h after
  // termination — hide them so the user only sees live machines.
  const instances: Ec2Instance[] = (data?.instances ?? [])
    .filter((i) => i.state !== 'terminated')
    .sort((a, b) => {
      if (a.region !== b.region) return a.region.localeCompare(b.region);
      return (a.name ?? a.instance_id).localeCompare(b.name ?? b.instance_id);
    });
  const failedRegions = (data?.regions ?? []).filter((r) => !r.ok);

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">
        <Ec2Toolbar
          refreshing={ec2Q.isFetching}
          selectedCount={selected.size}
          busy={opBusy}
          onRefresh={() => ec2Q.refetch()}
          onCreate={() => setCreateOpen(true)}
          onChangeIp={handleChangeIp}
          onBatchAction={handleBatchAction}
          onBatchDelete={handleBatchDelete}
        />

        {ec2Q.isError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>查询失败:{(ec2Q.error as Error).message}</span>
          </div>
        )}

        {failedRegions.length > 0 && (
          <div className="mb-4 rounded-lg border border-[var(--color-status-warn)]/40 bg-[var(--color-status-warn)]/10 p-3 text-xs text-[var(--color-status-warn)]">
            <span className="font-medium">{failedRegions.length} 个区域查询失败:</span>{' '}
            {failedRegions.map((r) => `${r.region} (${r.error ?? '未知'})`).join(', ')}
          </div>
        )}

        {!ec2Q.isLoading && instances.length === 0 && !ec2Q.isError && (
          <div className="mx-auto mt-16 flex max-w-md flex-col items-center rounded-2xl border border-[var(--color-border-glass)] bg-[var(--color-bg-elev)] backdrop-blur-xl p-10 text-center">
            <div className="mb-3 grid place-items-center size-12 rounded-2xl bg-[var(--color-accent-500)]/15 text-[var(--color-accent-300)]">
              <Server size={22} />
            </div>
            <h2 className="text-lg font-semibold">该账号下没有 EC2 实例</h2>
            <p className="mt-1 text-sm text-[var(--color-fg-secondary)]">
              已扫描 {data?.summary.regions_scanned ?? 0} 个区域,全部为空。
            </p>
          </div>
        )}

        {ec2Q.isLoading && (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li
                key={i}
                className="h-[200px] animate-pulse rounded-md border border-[var(--color-border-glass)] bg-[var(--color-bg-elev)]"
                style={{ opacity: 1 - i * 0.15 }}
              />
            ))}
          </ul>
        )}

        {instances.length > 0 && (
          <ul className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 lg:grid-cols-3">
            {instances.map((inst) => (
              <li key={`${inst.region}/${inst.instance_id}`}>
                <InstanceCard
                  inst={inst}
                  accountAlias={alias}
                  selected={selected.has(inst.instance_id)}
                  onToggleSelect={() => toggleSelected(inst.instance_id)}
                  pending={pending}
                  onAction={(action, region, instanceId) => {
                    const key = `${action}:${instanceId}`;
                    markPending(key, true);
                    controlMu.mutate(
                      { action, region, instanceId },
                      { onSettled: () => markPending(key, false) },
                    );
                  }}
                  onRename={async (region, instanceId, name) => {
                    await renameMu.mutateAsync({ region, instanceId, name });
                  }}
                  onRefresh={() => handleCardRefresh(inst.instance_id)}
                  onChangeIp={() => handleCardChangeIp(inst.region, inst.instance_id)}
                  onTraffic={() => setTrafficTarget(inst)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      <CreateEc2Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        accountId={accountId}
        defaultRegion={defaultRegion}
        onSubmit={async (input) => {
          await createMu.mutateAsync(input);
          setCreateOpen(false);
        }}
      />

      <TrafficModal
        open={trafficTarget !== null}
        instance={trafficTarget}
        accountId={accountId}
        onClose={() => setTrafficTarget(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single instance card — compact, self-contained
// ---------------------------------------------------------------------------

function InstanceCard({
  inst,
  accountAlias,
  selected,
  onToggleSelect,
  pending,
  onAction,
  onRename,
  onRefresh,
  onChangeIp,
  onTraffic,
}: {
  inst: Ec2Instance;
  accountAlias: string;
  selected: boolean;
  onToggleSelect: () => void;
  pending: Set<string>;
  onAction: (action: 'start' | 'stop' | 'reboot' | 'terminate', region: string, id: string) => void;
  onRename: (region: string, instanceId: string, name: string) => Promise<void>;
  onRefresh: () => void;
  onChangeIp: () => void;
  onTraffic: () => void;
}) {
  const [copiedIp, setCopiedIp] = useState(false);
  const [copiedIpv6, setCopiedIpv6] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(inst.name ?? '');
  const [renaming, setRenaming] = useState(false);

  const region = regionInfo(inst.region);
  const isRunning = inst.state === 'running';
  const isStopped = inst.state === 'stopped';
  const isTransient =
    inst.state === 'pending' || inst.state === 'stopping' || inst.state === 'shutting-down';
  const age = accountAge(inst.launch_time);
  const typeLabel = instanceTypeDisplay(inst.type);

  function fire(action: 'start' | 'stop' | 'reboot' | 'terminate') {
    onAction(action, inst.region, inst.instance_id);
  }
  function isBusy(action: string) {
    return pending.has(`${action}:${inst.instance_id}`);
  }

  async function copy(text: string, set: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      set(true);
      setTimeout(() => set(false), 1200);
    } catch {
      /* ignore clipboard rejection */
    }
  }

  async function commitRename() {
    const trimmed = nameDraft.trim();
    if (trimmed === (inst.name ?? '')) {
      setEditingName(false);
      return;
    }
    setRenaming(true);
    try {
      await onRename(inst.region, inst.instance_id, trimmed);
      setEditingName(false);
    } catch (e) {
      toast.error((e as Error).message, { title: '重命名失败' });
    } finally {
      setRenaming(false);
    }
  }

  return (
    <article
      className={clsx(
        'glass-panel relative flex flex-col p-4 transition-all has-[[data-statusmenu-open]]:z-30',
        selected
          ? 'ring-2 ring-[var(--color-accent-500)]/60'
          : 'hover:-translate-y-0.5 hover:border-[var(--color-accent-500)]/40',
      )}
    >
      {/* ----- Header: select + name (+ edit) + region flag ----- */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label="选择实例"
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

          {editingName ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') {
                    setNameDraft(inst.name ?? '');
                    setEditingName(false);
                  }
                }}
                disabled={renaming}
                autoFocus
                maxLength={256}
                className="min-w-0 flex-1 rounded border border-[var(--color-border-glass)] bg-[var(--color-bg-base)] px-1.5 py-0.5 text-sm outline-none focus:border-[var(--color-accent-500)]"
                placeholder="实例名称"
              />
              <button
                type="button"
                onClick={commitRename}
                disabled={renaming}
                data-loading={renaming ? 'true' : undefined}
                className="shrink-0 text-[var(--color-fg-muted)] hover:text-green-500 disabled:opacity-50"
                aria-label="保存"
                title="保存"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setNameDraft(inst.name ?? '');
                  setEditingName(false);
                }}
                disabled={renaming}
                className="shrink-0 text-[var(--color-fg-muted)] hover:text-[var(--color-status-error)] disabled:opacity-50"
                aria-label="取消"
                title="取消"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <>
              <h3
                className="truncate text-sm font-semibold tracking-tight"
                title={inst.name ?? '(无 Name 标签)'}
              >
                {inst.name ?? '(无 Name 标签)'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setNameDraft(inst.name ?? '');
                  setEditingName(true);
                }}
                className="shrink-0 text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
                aria-label="编辑名称"
                title="编辑名称"
              >
                <Pencil size={11} />
              </button>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {age && (
            <span
              className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-[var(--color-fg-secondary)]"
              title="实例创建时长"
            >
              {age}
            </span>
          )}
          <span
            className="inline-flex items-center rounded bg-white/5 px-1.5 py-1 leading-none"
            title={`地区:${region.label}${countryName(region.country) ? ` (${countryName(region.country)})` : ''}`}
          >
            <Flag code={region.country} className="text-[13px]" />
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex size-5 items-center justify-center rounded text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
            aria-expanded={expanded}
            aria-label={expanded ? '收起详情' : '展开详情'}
            title={expanded ? '收起详情' : '展开详情'}
          >
            <ChevronDown
              size={13}
              className={clsx('transition-transform', expanded && 'rotate-180')}
            />
          </button>
        </div>
      </header>

      {/* ----- Body + expanded ----- */}
      <div>
        <div className="mt-2 space-y-0.5 text-sm leading-tight">
        <Row label="账号">
          <span className="truncate text-[var(--color-fg-secondary)]" title={accountAlias}>
            {accountAlias}
          </span>
        </Row>
        {inst.public_ip ? (
          <Row label="IPv4">
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => copy(inst.public_ip!, setCopiedIp)}
                className="inline-flex items-center gap-1 tabular-nums text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
                title="点击复制 IPv4 公网地址"
              >
                {inst.public_ip}
                {copiedIp ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
              </button>
              <IpTypeTag type={inst.public_ip_type} />
            </span>
          </Row>
        ) : null}
        {inst.ipv6_addresses.length > 0 ? (
          <Row label="IPv6" wrap>
            <span className="flex min-w-0 items-start gap-1.5">
              <button
                type="button"
                onClick={() => copy(inst.ipv6_addresses[0], setCopiedIpv6)}
                className="inline-flex min-w-0 items-baseline gap-1 text-left text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
                title={
                  inst.ipv6_addresses.length > 1
                    ? `共 ${inst.ipv6_addresses.length} 个 IPv6 地址,点击复制第一个\n${inst.ipv6_addresses.join('\n')}`
                    : '点击复制 IPv6 公网地址'
                }
              >
                <span className="break-all tabular-nums">{inst.ipv6_addresses[0]}</span>
                {copiedIpv6 ? (
                  <Check size={10} className="shrink-0 text-green-500" />
                ) : (
                  <Copy size={10} className="shrink-0" />
                )}
              </button>
              {inst.ipv6_addresses.length > 1 && (
                <span className="shrink-0 text-[10px] text-[var(--color-fg-muted)]">
                  +{inst.ipv6_addresses.length - 1}
                </span>
              )}
            </span>
          </Row>
        ) : null}
        {!inst.public_ip && inst.ipv6_addresses.length === 0 && (
          <Row label="公网 IP">
            <span className="text-[var(--color-fg-muted)]">无公网 IP</span>
          </Row>
        )}
        <Row label="配置">
          <span className="truncate text-[var(--color-fg-secondary)]" title={typeLabel}>
            {typeLabel}
          </span>
        </Row>
        <Row label="地区">
          <span
            className="truncate text-[var(--color-fg-secondary)]"
            title={azNameDisplay(inst.az, inst.region)}
          >
            {azNameDisplay(inst.az, inst.region) || inst.region}
          </span>
        </Row>
      </div>

      {/* ----- Expanded detail panel ----- */}
      {expanded && (
        <div className="mt-2 space-y-0.5 text-sm leading-tight">
          <Row label="实例 ID">
            <button
              type="button"
              onClick={() => copy(inst.instance_id, setCopiedId)}
              className="inline-flex items-center gap-1 font-mono text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
              title="点击复制实例 ID"
            >
              {inst.instance_id}
              {copiedId ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
            </button>
          </Row>
          {inst.private_ip && (
            <Row label="私有 IP">
              <span className="font-mono text-[var(--color-fg-secondary)]">{inst.private_ip}</span>
            </Row>
          )}
          {inst.key_name && (
            <Row label="密钥对">
              <span className="truncate text-[var(--color-fg-secondary)]">{inst.key_name}</span>
            </Row>
          )}
          <Row label="状态">
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
                STATE_TONES[inst.state] ?? 'bg-white/5 text-[var(--color-fg-muted)]',
              )}
            >
              {isTransient && <Loader2 size={9} className="animate-spin" />}
              {STATE_LABELS[inst.state] ?? inst.state}
            </span>
          </Row>
          {inst.platform && (
            <Row label="平台">
              <span className="truncate text-[var(--color-fg-secondary)]">
                {inst.platform}
                {inst.architecture && ` · ${inst.architecture}`}
              </span>
            </Row>
          )}
          {inst.image_id && (
            <Row label="AMI">
              <span className="truncate font-mono text-[var(--color-fg-secondary)]">
                {inst.image_id}
              </span>
            </Row>
          )}
          {(inst.vpc_id || inst.subnet_id) && (
            <Row label="网络">
              <span className="truncate font-mono text-[var(--color-fg-secondary)]">
                {[inst.vpc_id, inst.subnet_id].filter(Boolean).join(' · ')}
              </span>
            </Row>
          )}
          {inst.security_groups.length > 0 && (
            <Row label="安全组">
              <span
                className="truncate text-[var(--color-fg-secondary)]"
                title={inst.security_groups.join(', ')}
              >
                {inst.security_groups.join(', ')}
              </span>
            </Row>
          )}
          {inst.launch_time && (
            <Row label="启动时间">
              <span className="text-[var(--color-fg-secondary)]">
                {new Date(inst.launch_time).toLocaleString('zh-CN')}
              </span>
            </Row>
          )}
        </div>
      )}
      </div>

      {/* ----- Footer (actions: refresh / delete / change-ip / status / traffic) ----- */}
      <footer className="mt-4 flex items-center gap-0.5 pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="!size-7 !p-0"
          aria-label="刷新"
          title="刷新这台实例的信息"
          loading={isBusy('refresh')}
          onClick={onRefresh}
        >
          <RefreshCcw size={12} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="!size-7 !p-0 hover:!text-[var(--color-status-error)]"
          aria-label="删除"
          title="删除 (终止) 这台实例,不可恢复"
          disabled={inst.state === 'terminated'}
          loading={isBusy('terminate')}
          onClick={() => fire('terminate')}
        >
          <Trash2 size={12} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="!h-7 !px-2 !gap-1 text-[11px]"
          aria-label="更换 IP"
          title="更换公网 IP (不停机)"
          disabled={!isRunning || inst.public_ip_type === 'static'}
          loading={isBusy('change-ip')}
          onClick={onChangeIp}
        >
          <Shuffle size={12} />
          更换IP
        </Button>
        <CardStatusMenu
          disabled={isTransient || inst.state === 'terminated'}
          isRunning={isRunning}
          isStopped={isStopped}
          isBusy={isBusy}
          onStart={() => fire('start')}
          onStop={() => fire('stop')}
          onReboot={() => fire('reboot')}
        />
        <Button
          size="sm"
          variant="ghost"
          className="!h-7 !px-2 !gap-1 text-[11px]"
          aria-label="流量"
          title="查看流量使用情况"
          onClick={onTraffic}
        >
          <Activity size={12} />
          流量
        </Button>
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Label + value row used throughout the card body.
 *  Pass `wrap` to allow long values (e.g. uncompressed IPv6) to break onto
 *  a second line instead of getting clipped with an ellipsis. */
function Row({
  label,
  children,
  wrap,
}: {
  label: string;
  children: React.ReactNode;
  wrap?: boolean;
}) {
  return (
    <p
      className={clsx(
        'flex gap-2 text-[var(--color-fg-muted)]',
        wrap ? 'items-start' : 'items-center',
      )}
    >
      <span className="shrink-0 w-[60px]">{label}</span>
      <span className={clsx('min-w-0 flex-1', !wrap && 'truncate')}>{children}</span>
    </p>
  );
}

function IpTypeTag({ type }: { type: 'static' | 'dynamic' | 'carrier' | null }) {
  if (!type) return null;
  if (type === 'carrier') {
    return (
      <span
        className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--color-fg-secondary)]"
        title="Wavelength 运营商 IP (Carrier IP)"
      >
        运营商
      </span>
    );
  }
  const isStatic = type === 'static';
  return (
    <span
      className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--color-fg-secondary)]"
      title={isStatic ? '弹性 IP (EIP)：实例停止后保留' : '动态 IP：实例停止后释放'}
    >
      {isStatic ? '静态' : '动态'}
    </span>
  );
}

/** Per-card status dropdown — start / stop / reboot for one instance. */
function CardStatusMenu({
  disabled,
  isRunning,
  isStopped,
  isBusy,
  onStart,
  onStop,
  onReboot,
}: {
  disabled: boolean;
  isRunning: boolean;
  isStopped: boolean;
  isBusy: (action: string) => boolean;
  onStart: () => void;
  onStop: () => void;
  onReboot: () => void;
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
    'disabled:opacity-40 disabled:cursor-not-allowed';
  const anyBusy = isBusy('start') || isBusy('stop') || isBusy('reboot');

  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="!h-7 !px-2 !gap-1 text-[11px]"
        aria-label="状态"
        title="启动 / 停止 / 重启"
        disabled={disabled}
        loading={anyBusy}
        onClick={() => setOpen((v) => !v)}
      >
        <Zap size={12} />
        状态
      </Button>
      {open && (
        <div data-statusmenu-open className="absolute bottom-9 left-0 z-30 min-w-[88px] rounded-xl border border-[var(--color-border-glass)] bg-[var(--color-bg-popover)] backdrop-blur-xl p-1 shadow-lg animate-[fadeIn_120ms_ease-out]">
          <button
            type="button"
            className={itemCls}
            disabled={!isStopped}
            onClick={() => {
              onStart();
              setOpen(false);
            }}
          >
            <Play size={12} /> 启动
          </button>
          <button
            type="button"
            className={itemCls}
            disabled={!isRunning}
            onClick={() => {
              onStop();
              setOpen(false);
            }}
          >
            <Square size={12} /> 停止
          </button>
          <button
            type="button"
            className={itemCls}
            disabled={!isRunning}
            onClick={() => {
              onReboot();
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

const STATE_TONES: Record<Ec2Instance['state'], string> = {
  running: 'bg-green-500/15 text-green-500',
  stopped: 'bg-white/5 text-[var(--color-fg-secondary)]',
  pending: 'bg-yellow-500/15 text-yellow-500',
  stopping: 'bg-yellow-500/15 text-yellow-500',
  'shutting-down': 'bg-orange-500/15 text-orange-500',
  terminated: 'bg-[var(--color-status-error)]/15 text-[var(--color-status-error)]',
};

const STATE_LABELS: Record<Ec2Instance['state'], string> = {
  running: '运行中',
  stopped: '已停止',
  pending: '启动中',
  stopping: '停止中',
  'shutting-down': '关闭中',
  terminated: '已终止',
};
