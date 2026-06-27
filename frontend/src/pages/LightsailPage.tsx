/**
 * Lightsail 管理页 — mirrors Ec2Page layout, adapted for Lightsail's API.
 *
 * URL: /account/:id/lightsail (typically opened in a new tab)
 *
 * Scope: list + status (start/stop/reboot) + delete + rename (via Name tag)
 * + create + change IP (Static IP juggle) + traffic. Newly-created instances
 * have their firewall opened automatically once they reach 'running' (see
 * the pendingOpenPortsRef poller below).
 *
 * Key adaptations vs Ec2Page:
 *   - `instance_name` is the immutable primary key. The "rename" UX writes
 *     a `Name` tag and surfaces it as `display_name`.
 *   - State machine: pending → starting → running → stopping → stopped.
 *     Transient (poll-worthy) states: pending, starting, stopping.
 *   - No security groups, no key pairs at card level; bundle is displayed
 *     using cpu_count + ram_gb + disk_gb fields.
 *   - Lightsail regions are a fixed subset of 14 (not opt-in), so we just
 *     pass `undefined` and let the backend hit the canonical list.
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
  ChevronDown,
  Pencil,
  X,
  RefreshCcw,
  Zap,
  Activity,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import type { LightsailCreateInput, LightsailInstance, LightsailState } from '@/lib/api';
import { getAccountCredentials, listAccounts } from '@/lib/vault';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import { Flag } from '@/components/ui/Flag';
import {
  LightsailToolbar,
  type LightsailBatchAction,
} from '@/components/LightsailToolbar';
import { CreateLightsailModal } from '@/components/CreateLightsailModal';
import { LightsailTrafficModal } from '@/components/LightsailTrafficModal';
import { regionInfo, azDisplay, countryName } from '@/lib/regions';
import { accountAge } from '@/lib/format';
import { usePageTitle } from '@/hooks/usePageTitle';

// ---------------------------------------------------------------------------
// State badge tokens
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  pending: '创建中',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  terminated: '已终止',
  unknown: '未知',
};

const STATE_TONES: Record<string, string> = {
  running: 'bg-[var(--color-status-running)]/15 text-[var(--color-status-running)]',
  stopped: 'bg-white/5 text-[var(--color-fg-secondary)]',
  pending: 'bg-[var(--color-status-warn)]/15 text-[var(--color-status-warn)]',
  starting: 'bg-[var(--color-status-warn)]/15 text-[var(--color-status-warn)]',
  stopping: 'bg-[var(--color-status-warn)]/15 text-[var(--color-status-warn)]',
  terminated: 'bg-[var(--color-status-error)]/15 text-[var(--color-status-error)]',
};

const TRANSIENT_STATES: ReadonlySet<LightsailState> = new Set([
  'pending',
  'starting',
  'stopping',
]);

function isTransientState(state: LightsailState): boolean {
  return TRANSIENT_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Bundle display: bundle_id alone isn't human-friendly so we synthesize a
// compact spec line from cpu/ram/disk fields. (Phase 2 will replace this
// with a richer bundle catalog including the monthly price.)
// ---------------------------------------------------------------------------

function bundleSpec(inst: LightsailInstance): string {
  const parts: string[] = [];
  if (inst.bundle_id) parts.push(inst.bundle_id);
  if (inst.cpu_count) parts.push(`${inst.cpu_count} vCPU`);
  if (inst.ram_gb) parts.push(`${inst.ram_gb} GB RAM`);
  if (inst.disk_gb) parts.push(`${inst.disk_gb} GB SSD`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Page entry — resolve account, then render the inner page
// ---------------------------------------------------------------------------

export function LightsailPage() {
  const { id } = useParams<{ id: string }>();

  usePageTitle('Lightsail 实例');

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

  return <LightsailPageInner accountId={account.id} alias={account.alias} defaultRegion={account.defaultRegion} />;
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

function LightsailPageInner({ accountId, alias, defaultRegion }: InnerProps) {
  const qc = useQueryClient();

  const lsQ = useQuery({
    queryKey: ['lightsail-list', accountId],
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.lightsailList(creds, undefined, signal);
    },
    staleTime: 60 * 1000,
  });

  // Instances created in THIS session that still need their firewall opened
  // once they reach 'running'. At create time the instance is 'pending' and
  // Lightsail rejects the firewall change, so we finish the job here.
  // Maps instance_name -> region.
  const pendingOpenPortsRef = useRef<Map<string, string>>(new Map());

  // ---------- Transient-state poller -------------------------------------
  // Mirrors the EC2 page: every 3s, scan the cache for transient instances,
  // group by region, and call /lightsail/describe to merge fresh state back
  // in. Lightsail has fewer regions and far smaller per-region lists than
  // EC2, but the bandwidth savings still matter (Lightsail get_instances is
  // un-cached and surprisingly slow).
  useEffect(() => {
    const interval = setInterval(async () => {
      const cached = qc.getQueryData<{ instances: LightsailInstance[] }>([
        'lightsail-list',
        accountId,
      ]);
      if (!cached?.instances?.length) return;

      // (A) Auto-open ports on freshly-created instances that just reached
      // 'running'. Fire-and-forget, idempotent backend call; remove from the
      // tracking map first so we only fire once per instance.
      if (pendingOpenPortsRef.current.size > 0) {
        const ready = cached.instances.filter(
          (i) =>
            i.region &&
            i.state === 'running' &&
            pendingOpenPortsRef.current.has(i.instance_name),
        );
        for (const i of ready) {
          pendingOpenPortsRef.current.delete(i.instance_name);
          void (async () => {
            try {
              const creds = await getAccountCredentials(accountId);
              await api.lightsailOpenPorts(creds, i.region!, i.instance_name);
            } catch {
              /* best-effort: instance is usable even if this fails */
            }
          })();
        }
      }

      // (B) Transient-state refresh.
      if (qc.isFetching({ queryKey: ['lightsail-list', accountId] }) > 0) return;

      const transient = cached.instances.filter((i) => isTransientState(i.state));
      if (transient.length === 0) return;

      const byRegion = new Map<string, string[]>();
      for (const i of transient) {
        if (!i.region) continue;
        const arr = byRegion.get(i.region) ?? [];
        arr.push(i.instance_name);
        byRegion.set(i.region, arr);
      }
      if (byRegion.size === 0) return;

      try {
        const creds = await getAccountCredentials(accountId);
        const results = await Promise.all(
          Array.from(byRegion.entries()).map(([region, names]) =>
            api
              .lightsailDescribe(creds, region, names)
              .then((r) => r.instances)
              .catch(() => [] as LightsailInstance[]),
          ),
        );
        const updates = results.flat();
        if (updates.length === 0) return;
        const updMap = new Map(updates.map((i) => [i.instance_name, i] as const));

        qc.setQueryData<Awaited<ReturnType<typeof api.lightsailList>>>(
          ['lightsail-list', accountId],
          (old) => {
            if (!old) return old;
            return {
              ...old,
              instances: old.instances.map((i) => updMap.get(i.instance_name) ?? i),
            };
          },
        );
      } catch {
        /* silently retry next tick */
      }
    }, 3000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, qc]);

  // ---------- UI state ----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  /** When set, the traffic modal is open for this instance. */
  const [trafficTarget, setTrafficTarget] = useState<LightsailInstance | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  function markPending(key: string, on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---------- Per-instance control ---------------------------------------
  type Action = 'start' | 'stop' | 'reboot' | 'delete';

  const controlMu = useMutation({
    mutationFn: async ({
      action,
      region,
      instanceName,
    }: {
      action: Action;
      region: string;
      instanceName: string;
    }) => {
      const creds = await getAccountCredentials(accountId);
      if (action === 'start') return api.lightsailStart(creds, region, instanceName);
      if (action === 'stop') return api.lightsailStop(creds, region, instanceName);
      if (action === 'reboot') return api.lightsailReboot(creds, region, instanceName);
      return api.lightsailDelete(creds, region, instanceName);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] }),
  });

  const renameMu = useMutation({
    mutationFn: async ({
      region,
      instanceName,
      displayName,
    }: {
      region: string;
      instanceName: string;
      displayName: string;
    }) => {
      const creds = await getAccountCredentials(accountId);
      return api.lightsailRename(creds, region, instanceName, displayName);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] }),
  });

  // ---------- Create instance --------------------------------------------
  const createMu = useMutation({
    mutationFn: async (input: LightsailCreateInput) => {
      const creds = await getAccountCredentials(accountId);
      return api.lightsailCreate(creds, input);
    },
    onSuccess: (data) => {
      // Track the new instances so the poller opens their ports once they
      // transition pending -> running.
      for (const inst of data.instances) {
        if (inst.region && inst.state !== 'terminated') {
          pendingOpenPortsRef.current.set(inst.instance_name, inst.region);
        }
      }
      qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] });
    },
  });

  // ---------- Batch start / stop / reboot --------------------------------
  async function handleBatchAction(action: LightsailBatchAction) {
    const targets = (lsQ.data?.instances ?? []).filter((i) =>
      selected.has(i.instance_name),
    );
    if (targets.length === 0) return;
    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const fn =
        action === 'start'
          ? api.lightsailStart
          : action === 'stop'
            ? api.lightsailStop
            : api.lightsailReboot;
      await Promise.allSettled(
        targets.map((i) => i.region && fn(creds, i.region, i.instance_name)),
      );
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] });
    }
  }

  // ---------- Batch delete -----------------------------------------------
  async function handleBatchDelete() {
    const targets = (lsQ.data?.instances ?? []).filter(
      (i) => selected.has(i.instance_name) && i.state !== 'terminated',
    );
    if (targets.length === 0) return;

    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const results = await Promise.allSettled(
        targets.map(
          (i) => i.region && api.lightsailDelete(creds, i.region, i.instance_name),
        ),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const msg = failures
          .map((r) => (r as PromiseRejectedResult).reason?.message ?? '未知错误')
          .join('\n');
        toast.error(msg, { title: `${failures.length} 台删除失败` });
      }
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of targets) next.delete(t.instance_name);
        return next;
      });
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] });
    }
  }

  // ---------- Per-card actions ------------------------------------------
  async function handleCardRefresh(instanceName: string) {
    const key = `refresh:${instanceName}`;
    markPending(key, true);
    try {
      await lsQ.refetch();
    } finally {
      markPending(key, false);
    }
  }

  // ---------- Change IP: Static IP juggle (allocate → attach → detach → release)
  //
  // Lightsail can't do EC2-style dynamic detach + reattach; instead we
  // borrow a fresh Static IP from the AWS pool, swap the instance onto it,
  // then drop it, leaving the instance with a brand-new dynamic IPv4.
  // Backend rejects non-running, static-IP-attached, and IPv6-only
  // instances; we duplicate those guards client-side for clearer error
  // messaging before the API call.
  function isEligibleForChangeIp(inst: LightsailInstance): string | null {
    if (inst.state !== 'running') return '实例必须处于"运行中"状态才能换 IP';
    if (inst.is_static_ip) return '实例已绑定 Static IP, 无法用此方式换 IP';
    if (!inst.public_ip) return '实例无公网 IPv4 (IPv6-only 不支持换 IP)';
    return null;
  }

  async function handleChangeIp() {
    const all = lsQ.data?.instances ?? [];
    const eligible: LightsailInstance[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const i of all) {
      if (!selected.has(i.instance_name)) continue;
      const why = isEligibleForChangeIp(i);
      if (why) skipped.push({ name: i.display_name, reason: why });
      else eligible.push(i);
    }
    if (eligible.length === 0) {
      if (skipped.length > 0) {
        toast.warning(
          skipped.map((s) => `${s.name}: ${s.reason}`).join('\n'),
          { title: '没有可换 IP 的实例' },
        );
      } else {
        toast.warning('请先勾选至少一台实例');
      }
      return;
    }

    setBatchBusy(true);
    try {
      const creds = await getAccountCredentials(accountId);
      const results = await Promise.allSettled(
        eligible.map(
          (i) => i.region && api.lightsailChangeIp(creds, i.region, i.instance_name),
        ),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const msg = failures
          .map((r) => (r as PromiseRejectedResult).reason?.message ?? '未知错误')
          .join('\n');
        toast.error(msg, { title: `${failures.length} 台换 IP 失败` });
      }
      if (skipped.length > 0) {
        toast.warning(
          skipped.map((s) => `${s.name}: ${s.reason}`).join('\n'),
          { title: `${skipped.length} 台被跳过` },
        );
      }
    } finally {
      setBatchBusy(false);
      qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] });
    }
  }

  async function handleCardChangeIp(region: string, instanceName: string) {
    const inst = (lsQ.data?.instances ?? []).find((i) => i.instance_name === instanceName);
    if (!inst) return;
    const why = isEligibleForChangeIp(inst);
    if (why) {
      toast.warning(why);
      return;
    }
    const key = `change-ip:${instanceName}`;
    markPending(key, true);
    try {
      const creds = await getAccountCredentials(accountId);
      await api.lightsailChangeIp(creds, region, instanceName);
      qc.invalidateQueries({ queryKey: ['lightsail-list', accountId] });
    } catch (e) {
      toast.error((e as Error).message, { title: '换 IP 失败' });
    } finally {
      markPending(key, false);
    }
  }

  const opBusy = batchBusy || createMu.isPending;

  const data = lsQ.data;
  const instances: LightsailInstance[] = (data?.instances ?? [])
    .filter((i) => i.state !== 'terminated')
    .sort((a, b) => {
      if ((a.region ?? '') !== (b.region ?? '')) {
        return (a.region ?? '').localeCompare(b.region ?? '');
      }
      return a.display_name.localeCompare(b.display_name);
    });
  const failedRegions = (data?.regions ?? []).filter((r) => !r.ok);

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">
        <LightsailToolbar
          refreshing={lsQ.isFetching}
          selectedCount={selected.size}
          busy={opBusy}
          onRefresh={() => lsQ.refetch()}
          onCreate={() => setCreateOpen(true)}
          onChangeIp={handleChangeIp}
          onBatchAction={handleBatchAction}
          onBatchDelete={handleBatchDelete}
        />

        {lsQ.isError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>查询失败:{(lsQ.error as Error).message}</span>
          </div>
        )}

        {failedRegions.length > 0 && (
          <div className="mb-4 rounded-lg border border-[var(--color-status-warn)]/40 bg-[var(--color-status-warn)]/10 p-3 text-xs text-[var(--color-status-warn)]">
            <span className="font-medium">{failedRegions.length} 个区域查询失败:</span>{' '}
            {failedRegions
              .map((r) => `${r.region} (${r.error ?? '未知'})`)
              .join(', ')}
          </div>
        )}

        {!lsQ.isLoading && instances.length === 0 && !lsQ.isError && null}

        {lsQ.isLoading && (
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
              <li key={`${inst.region}/${inst.instance_name}`}>
                <InstanceCard
                  inst={inst}
                  accountAlias={alias}
                  selected={selected.has(inst.instance_name)}
                  onToggleSelect={() => toggleSelected(inst.instance_name)}
                  pending={pending}
                  onAction={(action, region, instanceName) => {
                    const key = `${action}:${instanceName}`;
                    markPending(key, true);
                    controlMu.mutate(
                      { action, region, instanceName },
                      { onSettled: () => markPending(key, false) },
                    );
                  }}
                  onRename={async (region, instanceName, displayName) => {
                    await renameMu.mutateAsync({ region, instanceName, displayName });
                  }}
                  onRefresh={() => handleCardRefresh(inst.instance_name)}
                  onChangeIp={() =>
                    inst.region && handleCardChangeIp(inst.region, inst.instance_name)
                  }
                  onTraffic={() => setTrafficTarget(inst)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      <CreateLightsailModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        accountId={accountId}
        defaultRegion={defaultRegion}
        onSubmit={async (input) => {
          await createMu.mutateAsync(input);
          setCreateOpen(false);
        }}
      />

      <LightsailTrafficModal
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
  inst: LightsailInstance;
  accountAlias: string;
  selected: boolean;
  onToggleSelect: () => void;
  pending: Set<string>;
  onAction: (
    action: 'start' | 'stop' | 'reboot' | 'delete',
    region: string,
    instanceName: string,
  ) => void;
  onRename: (region: string, instanceName: string, displayName: string) => Promise<void>;
  onRefresh: () => void;
  onChangeIp: () => void;
  onTraffic: () => void;
}) {
  const [copiedIp, setCopiedIp] = useState(false);
  const [copiedIpv6, setCopiedIpv6] = useState(false);
  const [copiedName, setCopiedName] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(inst.display_name);
  const [renaming, setRenaming] = useState(false);

  const region = regionInfo(inst.region ?? '');
  const isRunning = inst.state === 'running';
  const isStopped = inst.state === 'stopped';
  const isTransient = isTransientState(inst.state);
  const age = accountAge(inst.created_at);
  const spec = bundleSpec(inst);

  function fire(action: 'start' | 'stop' | 'reboot' | 'delete') {
    if (!inst.region) return;
    onAction(action, inst.region, inst.instance_name);
  }
  function isBusy(action: string) {
    return pending.has(`${action}:${inst.instance_name}`);
  }

  async function copy(text: string, set: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      set(true);
      setTimeout(() => set(false), 1200);
    } catch {
      /* ignore */
    }
  }

  async function commitRename() {
    const trimmed = nameDraft.trim();
    if (trimmed === inst.display_name) {
      setEditingName(false);
      return;
    }
    if (!inst.region) {
      toast.error('实例缺少 region 字段,无法重命名');
      return;
    }
    setRenaming(true);
    try {
      await onRename(inst.region, inst.instance_name, trimmed);
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
      {/* ----- Header: select + display_name (+ edit) + region flag ----- */}
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
                    setNameDraft(inst.display_name);
                    setEditingName(false);
                  }
                }}
                disabled={renaming}
                autoFocus
                maxLength={256}
                className="min-w-0 flex-1 rounded border border-[var(--color-border-glass)] bg-[var(--color-bg-base)] px-1.5 py-0.5 text-sm outline-none focus:border-[var(--color-accent-500)]"
                placeholder="显示名称"
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
                  setNameDraft(inst.display_name);
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
                title={inst.display_name}
              >
                {inst.display_name}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setNameDraft(inst.display_name);
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
              <IpTypeTag isStatic={inst.is_static_ip} />
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
          <span className="truncate text-[var(--color-fg-secondary)]" title={spec}>
            {spec || '—'}
          </span>
        </Row>
        <Row label="地区">
          <span className="truncate text-[var(--color-fg-secondary)]" title={azDisplay(inst.az)}>
            {azDisplay(inst.az) || inst.region || '—'}
          </span>
        </Row>
      </div>

      {/* ----- Expanded detail panel ----- */}
      {expanded && (
        <div className="mt-2 space-y-0.5 text-sm leading-tight">
          <Row label="实例名">
            <button
              type="button"
              onClick={() => copy(inst.instance_name, setCopiedName)}
              className="inline-flex items-center gap-1 font-mono text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)]"
              title="点击复制实例名 (Lightsail 主键,不可修改)"
            >
              {inst.instance_name}
              {copiedName ? (
                <Check size={10} className="text-green-500" />
              ) : (
                <Copy size={10} />
              )}
            </button>
          </Row>
          {inst.private_ip && (
            <Row label="私有 IP">
              <span className="font-mono text-[var(--color-fg-secondary)]">
                {inst.private_ip}
              </span>
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
          {inst.blueprint_name && (
            <Row label="系统">
              <span
                className="truncate text-[var(--color-fg-secondary)]"
                title={inst.blueprint_id ?? undefined}
              >
                {inst.blueprint_name}
              </span>
            </Row>
          )}
          {inst.username && (
            <Row label="默认用户">
              <span className="font-mono text-[var(--color-fg-secondary)]">{inst.username}</span>
            </Row>
          )}
          {inst.ssh_key_name && (
            <Row label="SSH 密钥">
              <span className="truncate text-[var(--color-fg-secondary)]">
                {inst.ssh_key_name}
              </span>
            </Row>
          )}
          {inst.monthly_transfer_gb != null && (
            <Row label="月流量">
              <span className="text-[var(--color-fg-secondary)]">
                {inst.monthly_transfer_gb} GB
              </span>
            </Row>
          )}
          {inst.created_at && (
            <Row label="创建时间">
              <span className="text-[var(--color-fg-secondary)]">
                {new Date(inst.created_at).toLocaleString('zh-CN')}
              </span>
            </Row>
          )}
        </div>
      )}
      </div>

      {/* ----- Footer (5 buttons: refresh / delete / change-ip / status / traffic) ----- */}
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
          title="删除这台实例,不可恢复"
          disabled={inst.state === 'terminated'}
          loading={isBusy('delete')}
          onClick={() => fire('delete')}
        >
          <Trash2 size={12} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="!h-7 !px-2 !gap-1 text-[11px]"
          aria-label="更换 IP"
          title={
            !isRunning
              ? '实例必须运行中才能换 IP'
              : inst.is_static_ip
                ? '实例已绑定 Static IP, 无法用此方式换 IP'
                : !inst.public_ip
                  ? 'IPv6-only 实例不支持换 IP'
                  : '通过 Static IP 摘挂换一个新的动态 IPv4 (不停机)'
          }
          disabled={!isRunning || inst.is_static_ip || !inst.public_ip}
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

function IpTypeTag({ isStatic }: { isStatic: boolean }) {
  return (
    <span
      className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-medium leading-none text-[var(--color-fg-secondary)]"
      title={isStatic ? 'Static IP：实例停止后保留' : '动态 IP：实例停止后释放'}
    >
      {isStatic ? '静态' : '动态'}
    </span>
  );
}

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
