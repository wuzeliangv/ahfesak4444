/**
 * Lambda 节点部署页 (/lambda)
 *
 * Multi-account × multi-region deployment of the panel's worker Lambda, for
 * source-IP diversity of management API calls. Talks to the local deployer
 * daemon (Caddy → 127.0.0.1:8787) which drives `sam`; progress streams back
 * as SSE and is rendered live.
 *
 * The worker endpoints created here are public but each carries its own
 * generated x-api-key (stored in the daemon's local registry) and is locked
 * to this panel's origin via CORS.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Server,
  RefreshCcw,
  Trash2,
  Loader2,
  Check,
  Copy,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Rocket,
  Plus,
  Radar,
} from 'lucide-react';
import clsx from 'clsx';
import { listDeployerAccounts, getDeployerAccountCredentials, deleteDeployerAccount } from '@/lib/vault';
import type { DeployerAccountRecord } from '@/lib/db';
import { REGIONS, regionInfo, regionDisplay } from '@/lib/regions';
import { Flag } from '@/components/ui/Flag';
import { Button } from '@/components/ui/Button';
import { DeployerAccountModal } from '@/components/DeployerAccountModal';
import { TelegramSettings } from '@/components/TelegramSettings';
import { toast } from '@/lib/toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  deploy,
  destroy,
  scan,
  redeploy,
  listDeployments,
  probeNodes,
  type DeployTarget,
  type DeployerEvent,
  type DeploymentEntry,
  type NodeHealth,
  type ScanFound,
} from '@/lib/deployer';
import { refreshEndpoints } from '@/lib/endpoints';

// Spread-out preset for quick "good IP variety" selection.
const RECOMMENDED = [
  'us-east-1',
  'us-west-2',
  'eu-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'sa-east-1',
];

type TargetStatus = 'pending' | 'running' | 'done' | 'error';
interface TargetState {
  region: string;
  alias?: string;
  status: TargetStatus;
  url?: string;
  error?: string;
}
interface LogLine {
  target: string;
  line: string;
  stream?: string;
}

function targetLabel(alias: string | undefined, region: string): string {
  return `${alias || 'account'} / ${region}`;
}

export function LambdaDeployPage() {
  usePageTitle('Lambda 节点部署');
  const navigate = useNavigate();
  const qc = useQueryClient();

  const accountsQ = useQuery({ queryKey: ['deployer-accounts'], queryFn: listDeployerAccounts });
  const accounts = accountsQ.data ?? [];

  const deploymentsQ = useQuery({
    queryKey: ['deployments'],
    queryFn: ({ signal }) => listDeployments(signal),
    refetchOnWindowFocus: false,
    refetchInterval: 60000, // keep health badges fresh
  });

  const [selAccounts, setSelAccounts] = useState<Set<string>>(new Set());
  const [selRegions, setSelRegions] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [destroyingId, setDestroyingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [foundNodes, setFoundNodes] = useState<ScanFound[]>([]);
  const [probing, setProbing] = useState(false);
  const [redeploying, setRedeploying] = useState(false);

  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, TargetState>>({});
  const [log, setLog] = useState<LogLine[]>([]);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const targetCount = selAccounts.size * selRegions.size;

  // ---------- selection helpers ------------------------------------------
  function toggleAccount(id: string) {
    setSelAccounts((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleRegion(code: string) {
    setSelRegions((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }

  async function handleProbeRefresh() {
    setProbing(true);
    try {
      const reg = await probeNodes();
      qc.setQueryData(['deployments'], reg);
    } catch {
      // fall back to a plain refetch (cached health)
      deploymentsQ.refetch();
    } finally {
      setProbing(false);
    }
  }

  async function handleDeleteAccount(id: string) {
    if (!window.confirm('删除这个部署账号?(不影响已部署的节点,凭证仅从本地移除)')) return;
    try {
      await deleteDeployerAccount(id);
      setSelAccounts((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ['deployer-accounts'] });
    } catch (e) {
      toast.error((e as Error).message, { title: '删除失败' });
    }
  }

  // ---------- SSE event handling -----------------------------------------
  function handleEvent(ev: DeployerEvent) {
    const d = ev.data || {};
    switch (ev.event) {
      case 'phase':
        if (d.phase === 'build') setBuildMsg(d.ok === false ? 'sam build 失败' : d.message || '构建中…');
        break;
      case 'log':
        if (d.target === '_build') {
          // build logs: keep the latest as build status, don't flood the list
          setBuildMsg(`构建中… ${String(d.line).slice(0, 80)}`);
        }
        setLog((prev) => {
          const next = prev.concat({ target: d.target, line: d.line, stream: d.stream });
          return next.length > 600 ? next.slice(-600) : next;
        });
        break;
      case 'target-start':
        setStatuses((prev) => ({
          ...prev,
          [d.target]: { ...(prev[d.target] || { region: d.region }), status: 'running' },
        }));
        break;
      case 'target-done':
        setStatuses((prev) => ({
          ...prev,
          [d.target]: { ...(prev[d.target] || { region: d.region }), status: 'done', url: d.url },
        }));
        break;
      case 'target-error':
        setStatuses((prev) => ({
          ...prev,
          [d.target]: { ...(prev[d.target] || { region: d.region }), status: 'error', error: d.error },
        }));
        break;
      default:
        break;
    }
  }

  // ---------- deploy ------------------------------------------------------
  async function runDeploy(targets: DeployTarget[]) {
    if (targets.length === 0) return;
    setBusy(true);
    setBuildMsg(null);
    setLog([]);

    const seed: Record<string, TargetState> = {};
    for (const t of targets) {
      seed[targetLabel(t.alias, t.region)] = { region: t.region, alias: t.alias, status: 'pending' };
    }
    setStatuses(seed);

    try {
      let summary: any = null;
      await deploy(
        targets,
        (ev) => {
          if (ev.event === 'done') summary = ev.data;
          else handleEvent(ev);
        },
        { corsOrigin: window.location.origin }
      );
      const ok = summary?.okCount ?? 0;
      const total = summary?.total ?? targets.length;
      if (ok === total) toast.success(`${ok}/${total} 个节点部署成功`);
      else toast.warning(`${ok}/${total} 个成功,其余失败,见下方日志`, { title: '部分部署失败' });
    } catch (e) {
      toast.error((e as Error).message, { title: '部署失败' });
    } finally {
      setBusy(false);
      setBuildMsg(null);
      qc.invalidateQueries({ queryKey: ['deployments'] });
      void refreshEndpoints();
    }
  }

  async function handleDeploy() {
    const accs = accounts.filter((a) => selAccounts.has(a.id));
    const regions = [...selRegions];
    if (accs.length === 0 || regions.length === 0) return;

    // Build targets (decrypt each account's creds once).
    const targets: DeployTarget[] = [];
    try {
      for (const a of accs) {
        const creds = await getDeployerAccountCredentials(a.id);
        for (const r of regions) {
          targets.push({
            alias: a.alias,
            accountRef: a.id,
            region: r,
            accessKey: creds.accessKey,
            secretKey: creds.secretKey,
          });
        }
      }
    } catch (e) {
      toast.error((e as Error).message, { title: '读取账号凭证失败' });
      return;
    }
    await runDeploy(targets);
  }

  // ---------- scan / re-adopt existing nodes -----------------------------
  async function handleScan() {
    if (accounts.length === 0) {
      toast.warning('请先添加部署账号');
      return;
    }
    setScanning(true);
    setFoundNodes([]);
    setScanMsg('准备扫描…');
    try {
      const scanAccounts = [];
      for (const a of accounts) {
        const creds = await getDeployerAccountCredentials(a.id);
        scanAccounts.push({
          accountRef: a.id,
          alias: a.alias,
          accessKey: creds.accessKey,
          secretKey: creds.secretKey,
        });
      }
      const collected: ScanFound[] = [];
      await scan(scanAccounts, (ev) => {
        const d = ev.data || {};
        if (ev.event === 'scan-account-start') setScanMsg(`扫描账号 ${d.accountId}(已开通 ${d.regions} 个区)…`);
        else if (ev.event === 'scan-progress') setScanMsg(`扫描 ${d.accountId} / ${d.region}…`);
        else if (ev.event === 'scan-found') collected.push(d as ScanFound);
        else if (ev.event === 'scan-account-error') toast.warning(`${d.alias || '账号'}: ${d.error}`);
      });
      setFoundNodes(collected);
      if (collected.length === 0) toast.info('未发现已有节点');
      else toast.success(`发现 ${collected.length} 个已有节点`);
    } catch (e) {
      toast.error((e as Error).message, { title: '扫描失败' });
    } finally {
      setScanning(false);
      setScanMsg(null);
    }
  }

  async function handleReadopt(nodes: ScanFound[]) {
    const targets: DeployTarget[] = [];
    for (const f of nodes) {
      if (!f.accountRef) continue;
      try {
        const creds = await getDeployerAccountCredentials(f.accountRef);
        targets.push({
          alias: f.alias ?? undefined,
          accountRef: f.accountRef,
          region: f.region,
          accessKey: creds.accessKey,
          secretKey: creds.secretKey,
        });
      } catch {
        /* account creds missing — skip */
      }
    }
    if (targets.length === 0) {
      toast.warning('无法获取这些节点对应账号的凭证(账号可能已删除)');
      return;
    }
    await runDeploy(targets);
    setFoundNodes([]);
  }

  // ---------- redeploy (hot update) --------------------------------------
  async function handleRedeploy() {
    if (deployments.length === 0) return;
    if (!window.confirm('确认重新部署所有节点?\n这将拉取最新后端代码构建，并就地更新所有已部署节点的 API 和 Lambda 代码（不会删除原节点，API 地址和密钥不变）。')) {
      return;
    }
    setBusy(true);
    setRedeploying(true);
    setBuildMsg(null);
    setLog([]);

    const seed: Record<string, TargetState> = {};
    for (const d of deployments) {
      seed[targetLabel(d.alias ?? undefined, d.region)] = { region: d.region, alias: d.alias ?? undefined, status: 'pending' };
    }
    setStatuses(seed);

    try {
      let summary: any = null;
      await redeploy((ev) => {
        if (ev.event === 'done') summary = ev.data;
        else handleEvent(ev);
      });
      const ok = summary?.okCount ?? 0;
      const total = summary?.total ?? deployments.length;
      if (ok === total) toast.success(`成功更新全部 ${ok} 个节点`);
      else toast.warning(`${ok}/${total} 个节点更新成功, 其余失败, 见日志`, { title: '部分更新失败' });
    } catch (e) {
      toast.error((e as Error).message, { title: '更新失败' });
    } finally {
      setBusy(false);
      setRedeploying(false);
      setBuildMsg(null);
      qc.invalidateQueries({ queryKey: ['deployments'] });
      void refreshEndpoints();
    }
  }

  // ---------- destroy -----------------------------------------------------
  async function handleDestroy(d: DeploymentEntry) {
    if (!window.confirm(`确认销毁 ${d.alias || d.accountId} / ${d.region} 的 Lambda 节点?\n将删除该区的 CloudFormation 栈 (API 网关 + Lambda),不可恢复。`)) {
      return;
    }
    // Resolve credentials: prefer the vault account id recorded at deploy time,
    // else match by AWS account id against verified accounts.
    let creds: { accessKey: string; secretKey: string } | null = null;
    try {
      if (d.accountRef) creds = await getDeployerAccountCredentials(d.accountRef);
    } catch {
      creds = null;
    }
    if (!creds) {
      const match = accounts.find((a) => a.verified?.accountId === d.accountId);
      if (match) {
        try {
          creds = await getDeployerAccountCredentials(match.id);
        } catch {
          creds = null;
        }
      }
    }
    if (!creds) {
      toast.error('本地找不到该部署账号的凭证,无法销毁。请确保对应账号仍在「选择账号」列表中。', {
        title: '缺少凭证',
      });
      return;
    }

    setDestroyingId(d.id);
    setBuildMsg(null);
    setLog([]);
    setStatuses({ [`${d.accountId} / ${d.region}`]: { region: d.region, status: 'running' } });
    try {
      let summary: any = null;
      await destroy(
        { region: d.region, accountId: d.accountId, accessKey: creds.accessKey, secretKey: creds.secretKey },
        (ev) => {
          if (ev.event === 'done') summary = ev.data;
          else handleEvent(ev);
        },
      );
      if (summary?.ok) toast.success(`已销毁 ${d.region} 节点`);
      else toast.warning('销毁可能未完全成功,见日志', { title: '销毁' });
    } catch (e) {
      toast.error((e as Error).message, { title: '销毁失败' });
    } finally {
      setDestroyingId(null);
      qc.invalidateQueries({ queryKey: ['deployments'] });
      void refreshEndpoints();
    }
  }

  const statusEntries = useMemo(() => Object.entries(statuses), [statuses]);
  const deployments = deploymentsQ.data?.deployments ?? [];
  // Scanned nodes that aren't in the local registry yet (the re-adopt targets).
  const newFound = useMemo(
    () =>
      foundNodes.filter(
        (f) => !deployments.some((d) => d.accountId === f.accountId && d.region === f.region),
      ),
    [foundNodes, deployments],
  );

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">
        {/* ---------- Top bar ---------- */}
        <div className="mb-5 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="!size-8 !p-0"
            onClick={() => navigate('/')}
            aria-label="返回"
            title="返回账号列表"
          >
            <ArrowLeft size={16} />
          </Button>
          <div className="flex items-center gap-2">
            <Server size={18} className="text-[var(--color-accent-400)]" />
            <h1 className="text-lg font-semibold tracking-tight">Lambda 节点部署</h1>
          </div>
          <span className="text-xs text-[var(--color-fg-muted)]">
            多账号 / 多区域部署后端,分散管理调用的出口 IP
          </span>
        </div>

        {/* ---------- Info banner ---------- */}
        <div className="mb-5 flex items-start gap-2 rounded-2xl border border-[var(--color-accent-500)]/30 bg-[var(--color-accent-500)]/10 p-3 text-xs text-[var(--color-fg-secondary)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-accent-400)]" />
          <div className="space-y-1">
            <p>
              将在所选账号的所选区创建 <span className="font-medium text-[var(--color-fg-primary)]">API 网关 + Lambda</span>
              (各带独立密钥、锁定本面板域名)。部署在本机执行,目标账号 AK/SK 不经过任何云端端点。
            </p>
            <p>
              需要账号具备 IAM / Lambda / API Gateway / CloudFormation / S3 权限(root key 可用),并会产生少量 AWS 费用。
              多个目标按顺序部署,每个约 1-2 分钟。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ---------- Account selection ---------- */}
          <section className="glass-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">选择账号</h2>
              <div className="flex items-center gap-2 text-xs">
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Plus size={13} />}
                  onClick={() => setAddOpen(true)}
                  className="!h-7 !px-2 text-xs"
                >
                  添加账号
                </Button>
                {accounts.length > 0 && (
                  <>
                    <button
                      className="text-[var(--color-accent-400)] hover:underline"
                      onClick={() => setSelAccounts(new Set(accounts.map((a) => a.id)))}
                    >
                      全选
                    </button>
                    <button
                      className="text-[var(--color-fg-muted)] hover:underline"
                      onClick={() => setSelAccounts(new Set())}
                    >
                      清空
                    </button>
                  </>
                )}
              </div>
            </div>
            {accounts.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">
                还没有部署账号,点右上角「添加账号」。
                <br />
                <span className="text-[11px]">这套账号独立于主账号列表,专用于部署节点。</span>
              </p>
            ) : (
              <ul className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
                {accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    selected={selAccounts.has(a.id)}
                    onToggle={() => toggleAccount(a.id)}
                    onDelete={() => handleDeleteAccount(a.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* ---------- Region selection ---------- */}
          <section className="glass-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">选择区域</h2>
              <div className="flex items-center gap-2 text-xs">
                <button
                  className="text-[var(--color-accent-400)] hover:underline"
                  onClick={() => setSelRegions(new Set(RECOMMENDED))}
                >
                  推荐分散
                </button>
                <button
                  className="text-[var(--color-accent-400)] hover:underline"
                  onClick={() => setSelRegions(new Set(REGIONS.map((r) => r.code)))}
                >
                  全选
                </button>
                <button
                  className="text-[var(--color-fg-muted)] hover:underline"
                  onClick={() => setSelRegions(new Set())}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="flex max-h-[320px] flex-wrap gap-1.5 overflow-y-auto pr-1">
              {REGIONS.map((r) => {
                const on = selRegions.has(r.code);
                return (
                  <button
                    key={r.code}
                    onClick={() => toggleRegion(r.code)}
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition',
                      on
                        ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)]/15 text-[var(--color-fg-primary)]'
                        : 'border-[var(--color-border-glass)] text-[var(--color-fg-secondary)] hover:border-[var(--color-accent-300)]',
                    )}
                    title={r.code}
                  >
                    <Flag code={r.country} className="text-[13px]" />
                    <span>{r.label}</span>
                    <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">{r.code}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        {/* ---------- Deploy action ---------- */}
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={handleDeploy}
            leadingIcon={busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />}
            disabled={busy || targetCount === 0 || !!destroyingId}
          >
            {busy ? '部署中…' : '部署'}
          </Button>
          <span className="text-xs text-[var(--color-fg-muted)]">
            {targetCount > 0
              ? `将部署 ${targetCount} 个目标 (${selAccounts.size} 账号 × ${selRegions.size} 区)`
              : '请至少选择 1 个账号和 1 个区域'}
          </span>
        </div>

        {/* ---------- Progress panel ---------- */}
        {(statusEntries.length > 0 || log.length > 0 || buildMsg) && (
          <section className="glass-panel mt-4 p-4">
            <h2 className="mb-3 text-sm font-semibold">进度</h2>
            {buildMsg && (
              <p className="mb-2 flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]">
                <Loader2 size={12} className="animate-spin" />
                <span className="truncate">{buildMsg}</span>
              </p>
            )}
            {statusEntries.length > 0 && (
              <ul className="mb-3 space-y-1">
                {statusEntries.map(([label, st]) => (
                  <li key={label} className="flex items-center gap-2 text-xs">
                    <StatusIcon status={st.status} />
                    <span className="font-medium">{label}</span>
                    {st.url && (
                      <span className="truncate font-mono text-[var(--color-fg-muted)]">{st.url}</span>
                    )}
                    {st.error && <span className="text-[var(--color-status-error)]">{st.error}</span>}
                  </li>
                ))}
              </ul>
            )}
            {log.length > 0 && (
              <div
                ref={logRef}
                className="max-h-64 overflow-y-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-[var(--color-fg-secondary)]"
              >
                {log.map((l, i) => (
                  <div
                    key={i}
                    className={clsx('whitespace-pre-wrap break-all', l.stream === 'stderr' && 'text-[var(--color-status-warn)]')}
                  >
                    {l.target !== '_build' && l.target ? `[${l.target}] ` : ''}
                    {l.line}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ---------- Deployed endpoints table ---------- */}
        <section className="glass-panel mt-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              已部署节点{' '}
              <span className="text-[var(--color-fg-muted)]">({deployments.length})</span>
            </h2>
            <div className="flex items-center gap-1.5">
              {deployments.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="!h-8 !px-2.5 text-xs text-[var(--color-accent-400)] hover:text-[var(--color-accent-300)]"
                  onClick={handleRedeploy}
                  loading={redeploying}
                  disabled={busy || scanning || redeploying}
                  leadingIcon={<RefreshCcw size={13} />}
                  title="重新构建后端并一键部署更新全部节点的代码(热更新,不删除节点,API地址与API Key不变)"
                >
                  更新全部节点代码
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="!h-8 !px-2.5 text-xs"
                onClick={handleScan}
                loading={scanning}
                disabled={busy || scanning || accounts.length === 0}
                leadingIcon={<Radar size={13} />}
                title="扫描各部署账号的所有区域,找出已存在但本地未登记的节点(用于重装后恢复)"
              >
                扫描已有节点
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="!size-8 !p-0"
                onClick={handleProbeRefresh}
                loading={deploymentsQ.isFetching || probing}
                aria-label="刷新"
                title="立即探测所有节点健康并刷新"
              >
                <RefreshCcw size={13} />
              </Button>
            </div>
          </div>

          {scanMsg && (
            <p className="mb-2 flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]">
              <Loader2 size={12} className="animate-spin" />
              <span className="truncate">{scanMsg}</span>
            </p>
          )}

          {newFound.length > 0 && (
            <div className="mb-3 rounded-xl border border-[var(--color-status-warn)]/40 bg-[var(--color-status-warn)]/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs text-[var(--color-fg-secondary)]">
                  发现 <span className="font-medium text-[var(--color-fg-primary)]">{newFound.length}</span> 个本地未登记的已有节点。
                  重新接管会幂等更新它们并刷新密钥,补回本地记录。
                </p>
                <Button
                  size="sm"
                  className="!h-7 shrink-0 !px-2.5 text-xs"
                  onClick={() => handleReadopt(newFound)}
                  disabled={busy || scanning}
                  loading={busy}
                >
                  全部接管
                </Button>
              </div>
              <ul className="space-y-1">
                {newFound.map((f) => (
                  <li key={`${f.accountId}:${f.region}`} className="flex items-center gap-2 text-[11px]">
                    <Flag code={regionInfo(f.region).country} className="text-[13px]" />
                    <span className="font-medium">{f.alias || f.accountId}</span>
                    <span className="font-mono text-[var(--color-fg-muted)]">{f.region}</span>
                    <span className="text-[var(--color-fg-muted)]">· {f.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {deployments.length > 0 && (
            <p className="mb-2 text-[11px] text-[var(--color-fg-muted)]">
              业务请求(创建 / 换 IP / 列表等)会自动路由到目标区域的节点,从该区 IP 出口;无节点的区域走主区。
            </p>
          )}

          {deploymentsQ.isError && (
            <p className="flex items-center gap-2 py-3 text-sm text-[var(--color-status-error)]">
              <AlertCircle size={14} /> 读取失败:{(deploymentsQ.error as Error).message}
            </p>
          )}

          {deployments.length === 0 && !deploymentsQ.isError ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">还没有部署任何节点。</p>
          ) : (
            <ul className="space-y-1.5">
              {deployments.map((d) => (
                <EndpointRow
                  key={d.id}
                  d={d}
                  destroying={destroyingId === d.id}
                  disabled={busy || (destroyingId !== null && destroyingId !== d.id)}
                  onDestroy={() => handleDestroy(d)}
                />
              ))}
            </ul>
          )}
        </section>

        <TelegramSettings />
      </main>

      <DeployerAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AccountRow({
  account,
  selected,
  onToggle,
  onDelete,
}: {
  account: DeployerAccountRecord;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={clsx(
        'flex items-center gap-1 rounded-lg border transition',
        selected
          ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)]/10'
          : 'border-[var(--color-border-glass)] hover:border-[var(--color-accent-300)]',
      )}
    >
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
        <span
          className={clsx(
            'flex size-4 shrink-0 items-center justify-center rounded border',
            selected
              ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)] text-white'
              : 'border-[var(--color-border-glass)]',
          )}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{account.alias}</span>
            {account.verified?.isRoot && (
              <span className="shrink-0 rounded bg-[var(--color-status-warn)]/15 px-1 py-0.5 text-[10px] text-[var(--color-status-warn)]">
                root
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
            {account.verified?.accountId && (
              <>
                <span className="font-mono">{account.verified.accountId}</span>
                <span>·</span>
              </>
            )}
            <span>{regionInfo(account.defaultRegion).label}</span>
          </div>
        </div>
      </button>
      <button
        onClick={onDelete}
        className="mr-1.5 shrink-0 rounded p-1 text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-status-error)]"
        aria-label="删除账号"
        title="从部署账号中删除(不影响已部署节点)"
      >
        <Trash2 size={13} />
      </button>
    </li>
  );
}

function StatusIcon({ status }: { status: TargetStatus }) {
  if (status === 'running') return <Loader2 size={13} className="shrink-0 animate-spin text-[var(--color-accent-400)]" />;
  if (status === 'done') return <CheckCircle2 size={13} className="shrink-0 text-[var(--color-status-running)]" />;
  if (status === 'error') return <XCircle size={13} className="shrink-0 text-[var(--color-status-error)]" />;
  return <span className="size-3 shrink-0 rounded-full border border-[var(--color-fg-muted)]" />;
}

function EndpointRow({
  d,
  destroying,
  disabled,
  onDestroy,
}: {
  d: DeploymentEntry;
  destroying: boolean;
  disabled: boolean;
  onDestroy: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const region = regionInfo(d.region);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(d.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border border-[var(--color-border-glass)] px-3 py-2">
      <span className="inline-flex items-center" title={regionDisplay(d.region)}>
        <Flag code={region.country} className="text-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{d.alias || d.accountId}</span>
          <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">{d.region}</span>
        </div>
        <button
          onClick={copyUrl}
          className="flex items-center gap-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-secondary)]"
          title="点击复制 URL"
        >
          <span className="truncate">{d.url}</span>
          {copied ? <Check size={10} className="shrink-0 text-green-500" /> : <Copy size={10} className="shrink-0" />}
        </button>
      </div>
      <HealthBadge health={d.health} />
      <span className="hidden shrink-0 font-mono text-[10px] text-[var(--color-fg-muted)] sm:inline">
        {d.accountId}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="!size-8 !p-0 hover:!text-[var(--color-status-error)]"
        onClick={onDestroy}
        disabled={disabled}
        loading={destroying}
        aria-label="销毁"
        title="销毁这个节点 (删除 CloudFormation 栈)"
      >
        <Trash2 size={13} />
      </Button>
    </li>
  );
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

function HealthBadge({ health }: { health?: NodeHealth }) {
  const status = health?.status ?? 'unknown';
  const tone =
    status === 'up'
      ? 'text-[var(--color-status-running)]'
      : status === 'down'
        ? 'text-[var(--color-status-error)]'
        : 'text-[var(--color-fg-muted)]';
  const dot =
    status === 'up'
      ? 'bg-[var(--color-status-running)]'
      : status === 'down'
        ? 'bg-[var(--color-status-error)]'
        : 'bg-[var(--color-fg-muted)]';
  const label = status === 'up' ? '在线' : status === 'down' ? '离线' : '未知';
  const detail =
    status === 'up'
      ? health?.latencyMs != null
        ? `${health.latencyMs}ms`
        : ''
      : health?.lastOkAt
        ? `最近 ${timeAgo(health.lastOkAt)}`
        : '从未在线';
  const title =
    status === 'down' && health?.lastOkAt
      ? `最近在线:${new Date(health.lastOkAt).toLocaleString('zh-CN')}`
      : health?.lastCheckAt
        ? `最近探测:${new Date(health.lastCheckAt).toLocaleString('zh-CN')}`
        : '尚未探测';
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 text-[11px]', tone)} title={title}>
      <span className={clsx('size-1.5 rounded-full', dot, status === 'up' && 'animate-pulse')} />
      {label}
      {detail && <span className="text-[var(--color-fg-muted)]">· {detail}</span>}
    </span>
  );
}
