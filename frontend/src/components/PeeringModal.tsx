/**
 * VPC peering modal — enable Lightsail VPC peering so a Lightsail jump box
 * can reach instances (especially Wavelength) in the account's default VPC
 * over private IPs.
 *
 * Peering is per-region: pick the region where your Wavelength instances
 * live (and where you have/want a Lightsail box), check status, then
 * one-click setup. The setup is idempotent — re-run it after creating new
 * Wavelength instances to wire their subnet route tables too.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, Network, Link2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';
import { REGIONS, regionDisplay } from '@/lib/regions';
import { toast } from '@/lib/toast';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
  defaultRegion: string;
}

export function PeeringModal({ open, onClose, accountId, accountAlias, defaultRegion }: Props) {
  const qc = useQueryClient();
  const [region, setRegion] = useState(defaultRegion);

  useEffect(() => {
    if (open) setRegion(defaultRegion);
  }, [open, defaultRegion]);

  const statusQ = useQuery({
    queryKey: ['peering-status', accountId, region],
    enabled: open && !!region,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.peeringStatus(creds, region, signal);
    },
  });

  const setupMu = useMutation({
    mutationFn: async () => {
      const creds = await getAccountCredentials(accountId);
      return api.peeringSetup(creds, region);
    },
    onSuccess: (data) => {
      toast.success(`对等连接已配置 (新增 ${data.added} 条路由)`);
      qc.invalidateQueries({ queryKey: ['peering-status', accountId, region] });
    },
    onError: (err) => toast.error((err as Error).message, { title: '配置失败' }),
  });

  const s = statusQ.data;
  const ready = s && s.ls_peered && s.routes_ok;
  const needsLightsail = s && !s.no_default_vpc && !s.has_lightsail;

  return (
    <Modal open={open} onClose={onClose} title="VPC 对等连接" description={accountAlias} size="sm">
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--color-fg-secondary)]">
          开启 Lightsail VPC 对等连接后,Lightsail 机器可作为跳板,通过私网访问同区域的
          Wavelength 实例。
        </p>

        {/* Region selector */}
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-wide text-[var(--color-fg-secondary)]">
            区域
          </span>
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="glass-input h-9 w-full px-2 text-sm"
            disabled={setupMu.isPending}
          >
            {REGIONS.map((r) => (
              <option key={r.code} value={r.code} className="bg-[var(--color-bg-elev)]">
                {regionDisplay(r.code)}
              </option>
            ))}
          </select>
        </label>

        {/* Status */}
        {statusQ.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--color-fg-muted)]">
            <Loader2 size={14} className="animate-spin" />
            正在检查状态…
          </div>
        ) : statusQ.isError ? (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-xs text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{(statusQ.error as Error).message}</span>
          </div>
        ) : s?.no_default_vpc ? (
          <div className="rounded-lg bg-[var(--color-status-warn)]/10 p-2.5 text-xs text-[var(--color-status-warn)]">
            该区域没有默认 VPC,请先在 AWS 控制台创建默认 VPC。
          </div>
        ) : s ? (
          <div className="space-y-2 rounded-md bg-white/[0.02] p-3">
            <StatusRow
              label="Lightsail 对等连接"
              ok={s.ls_peered}
              okText="已开启"
              badText="未开启"
            />
            <StatusRow
              label="回程路由"
              ok={s.routes_ok}
              okText={`已配置 (${s.route_tables_with_route}/${s.route_tables_total})`}
              badText={
                s.ls_cidr
                  ? `待配置 (${s.route_tables_with_route}/${s.route_tables_total})`
                  : '待配置'
              }
            />
            {s.ls_cidr && (
              <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
                <Network size={11} />
                Lightsail 网段: <span className="font-mono">{s.ls_cidr}</span>
              </div>
            )}
            {ready && (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-status-running)]">
                <CheckCircle2 size={12} />
                对等连接已就绪,Lightsail 可访问本区 Wavelength 实例
              </div>
            )}
          </div>
        ) : null}

        {needsLightsail && (
          <div className="rounded-lg bg-[var(--color-status-warn)]/10 p-2.5 text-xs leading-relaxed text-[var(--color-status-warn)]">
            该区域还没有 Lightsail 机器。Lightsail 对等连接要求本区至少有一台 Lightsail
            机器,请先创建一台再回来开启对等连接。
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={setupMu.isPending}>
            关闭
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setupMu.mutate()}
            loading={setupMu.isPending}
            disabled={
              setupMu.isPending ||
              statusQ.isLoading ||
              s?.no_default_vpc ||
              needsLightsail
            }
            leadingIcon={<Link2 size={12} />}
          >
            {ready ? '重新同步' : '一键配置'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function StatusRow({
  label,
  ok,
  okText,
  badText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-[var(--color-fg-secondary)]">{label}</span>
      <span
        className={
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ' +
          (ok
            ? 'bg-[var(--color-status-running)]/15 text-[var(--color-status-running)]'
            : 'bg-[var(--color-status-warn)]/15 text-[var(--color-status-warn)]')
        }
      >
        {ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
        {ok ? okText : badText}
      </span>
    </div>
  );
}
