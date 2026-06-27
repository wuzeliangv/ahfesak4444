/**
 * Region & zone management modal.
 *
 * Top level lists every AWS region (flag + Chinese name + opt-in status).
 * Opt-in regions that aren't enabled show an "启用" button. Enabled regions
 * get an expand chevron — clicking lazily loads that region's zones
 * (Availability / Local / Wavelength) via `/zones/list`.
 *
 * Local & Wavelength zones can be opted into (enable-only — AWS doesn't
 * allow opting out via API). Standard AZs are display-only.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Globe,
  Loader2,
  Power,
} from 'lucide-react';
import clsx from 'clsx';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Flag } from './ui/Flag';
import { api, type RegionAdminRow, type RegionOptStatus, type ZoneRow } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';
import { regionDisplay, regionInfo } from '@/lib/regions';
import { zoneLabel, zoneTypeTag, zoneSortKey } from '@/lib/zones';
import { toast } from '@/lib/toast';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
}

const TRANSIENT: ReadonlySet<RegionOptStatus> = new Set(['ENABLING', 'DISABLING']);

export function RegionsAdminModal({ open, onClose, accountId, accountAlias }: Props) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const regionsQ = useQuery({
    queryKey: ['regions-all', accountId],
    enabled: open,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.regionsAll(creds, signal);
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasTransient = (data.regions ?? []).some((r: RegionAdminRow) =>
        TRANSIENT.has(r.status),
      );
      return hasTransient ? 10000 : false;
    },
  });

  const enableMu = useMutation({
    mutationFn: async (region: string) => {
      const creds = await getAccountCredentials(accountId);
      return api.regionEnable(creds, region);
    },
    onMutate: (region) => setPending((p) => ({ ...p, [region]: true })),
    onSettled: (_d, _e, region) => {
      setPending((p) => ({ ...p, [region]: false }));
      qc.invalidateQueries({ queryKey: ['regions-all', accountId] });
    },
    onSuccess: (data) =>
      toast.success(`${regionDisplay(data.region)} 已发起启用 (后台同步中)`),
    onError: (err) => toast.error((err as Error).message, { title: '启用失败' }),
  });

  useEffect(() => {
    if (!open) {
      setPending({});
      setExpanded(new Set());
    }
  }, [open]);

  function toggleExpand(region: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }

  const regions = regionsQ.data?.regions ?? [];
  const sorted = [...regions].sort((a, b) => {
    const aOptIn = a.opt_in_required ? 0 : 1;
    const bOptIn = b.opt_in_required ? 0 : 1;
    if (aOptIn !== bOptIn) return aOptIn - bOptIn;
    return a.region.localeCompare(b.region);
  });

  return (
    <Modal open={open} onClose={onClose} title="启用地区" description={accountAlias} size="sm">
      <div className="space-y-3">
        {regionsQ.isError && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{(regionsQ.error as Error).message}</span>
          </div>
        )}

        {regionsQ.isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-fg-muted)]">
            <Loader2 size={14} className="animate-spin" />
            正在加载区域列表…
          </div>
        )}

        {!regionsQ.isLoading && sorted.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto rounded-md">
            <div className="divide-y divide-[var(--color-border-glass)]/60">
              {sorted.map((r) => {
                const info = regionInfo(r.region);
                const isPending = pending[r.region];
                const isTransient = TRANSIENT.has(r.status);
                const isEnabled =
                  r.status === 'ENABLED' || r.status === 'ENABLED_BY_DEFAULT';
                const isDisabled = r.status === 'DISABLED';
                const isOpen = expanded.has(r.region);

                return (
                  <div key={r.region}>
                    {/* Region row */}
                    <div
                      className={clsx(
                        'flex items-center gap-2 px-2 py-2',
                        isEnabled && 'cursor-pointer hover:bg-white/[0.03]',
                      )}
                      onClick={isEnabled ? () => toggleExpand(r.region) : undefined}
                    >
                      <ChevronRight
                        size={14}
                        className={clsx(
                          'shrink-0 transition-transform',
                          isEnabled
                            ? 'text-[var(--color-fg-muted)]'
                            : 'text-transparent',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <Flag code={info.country} className="text-[15px]" />
                      <span className="flex-1 truncate text-xs text-[var(--color-fg-primary)]">
                        {regionDisplay(r.region)}
                      </span>

                      {/* Region-level status / action */}
                      <span onClick={(e) => e.stopPropagation()}>
                        {isEnabled ? (
                          <span className="inline-flex items-center gap-1 rounded bg-[var(--color-status-running)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-status-running)]">
                            <CheckCircle2 size={11} />
                            已启用
                          </span>
                        ) : isDisabled ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="!h-7 !px-2 !gap-1 text-[11px]"
                            loading={isPending}
                            disabled={isPending || isTransient}
                            onClick={() => enableMu.mutate(r.region)}
                          >
                            <Power size={12} />
                            启用
                          </Button>
                        ) : r.status === 'ENABLING' ? (
                          <span className="inline-flex items-center gap-1 rounded bg-[var(--color-status-warn)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-status-warn)]">
                            <Loader2 size={11} className="animate-spin" />
                            启用中
                          </span>
                        ) : r.status === 'DISABLING' ? (
                          <span className="inline-flex items-center gap-1 rounded bg-[var(--color-status-warn)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-status-warn)]">
                            <Loader2 size={11} className="animate-spin" />
                            禁用中
                          </span>
                        ) : (
                          <span className="text-[11px] text-[var(--color-fg-muted)]">
                            {r.status}
                          </span>
                        )}
                      </span>
                    </div>

                    {/* Zones (lazy) */}
                    {isOpen && isEnabled && (
                      <RegionZones region={r.region} accountId={accountId} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!regionsQ.isLoading && sorted.length === 0 && !regionsQ.isError && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-fg-muted)]">
            <Globe size={14} />
            未获取到区域数据
          </div>
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

// ---------------------------------------------------------------------------
// Per-region zone list — lazily fetched when a region is expanded.
// ---------------------------------------------------------------------------

function RegionZones({ region, accountId }: { region: string; accountId: string }) {
  const qc = useQueryClient();
  const [pendingGroup, setPendingGroup] = useState<Record<string, boolean>>({});

  const zonesQ = useQuery({
    queryKey: ['zones', accountId, region],
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.zonesList(creds, region, signal);
    },
  });

  const enableMu = useMutation({
    mutationFn: async (groupName: string) => {
      const creds = await getAccountCredentials(accountId);
      return api.zoneEnable(creds, region, groupName);
    },
    onMutate: (groupName) => setPendingGroup((p) => ({ ...p, [groupName]: true })),
    onSettled: (_d, _e, groupName) => {
      setPendingGroup((p) => ({ ...p, [groupName]: false }));
      qc.invalidateQueries({ queryKey: ['zones', accountId, region] });
    },
    onSuccess: () => toast.success('已发起启用 (后台同步中,可能需要几分钟)'),
    onError: (err) => toast.error((err as Error).message, { title: '启用失败' }),
  });

  if (zonesQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 pl-8 text-[11px] text-[var(--color-fg-muted)]">
        <Loader2 size={12} className="animate-spin" />
        正在加载可用区…
      </div>
    );
  }

  if (zonesQ.isError) {
    return (
      <div className="flex items-start gap-1.5 py-2 pl-8 pr-2 text-[11px] text-[var(--color-status-error)]">
        <AlertCircle size={12} className="mt-0.5 shrink-0" />
        <span>{(zonesQ.error as Error).message}</span>
      </div>
    );
  }

  const zones = [...(zonesQ.data?.zones ?? [])].sort((a, b) =>
    zoneSortKey(a).localeCompare(zoneSortKey(b)),
  );

  if (zones.length === 0) {
    return (
      <div className="py-2 pl-8 text-[11px] text-[var(--color-fg-muted)]">无可用区数据</div>
    );
  }

  return (
    <div className="bg-white/[0.02]">
      {zones.map((z: ZoneRow) => {
        const tag = zoneTypeTag(z.zone_type);
        const isAZ = z.zone_type === 'availability-zone';
        const optedIn = z.opt_in_status === 'opted-in';
        const canEnable = !isAZ && z.opt_in_status === 'not-opted-in';
        const groupPending = z.group_name ? pendingGroup[z.group_name] : false;

        return (
          <div
            key={z.zone_name}
            className="flex items-center gap-2 py-1.5 pl-8 pr-2 text-[11px]"
          >
            <Flag code={regionInfo(region).country} className="shrink-0 text-[12px]" />
            <span className="flex-1 truncate text-[var(--color-fg-secondary)]">
              {zoneLabel(z, region)}{' '}
              <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
                ({z.zone_name})
              </span>
              {tag && (
                <span className="ml-1 text-[10px] text-[var(--color-fg-muted)]">{tag}</span>
              )}
            </span>

            {isAZ ? null : optedIn ? (
              <span className="inline-flex items-center gap-1 rounded bg-[var(--color-status-running)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-status-running)]">
                <CheckCircle2 size={10} />
                已启用
              </span>
            ) : canEnable ? (
              <Button
                size="sm"
                variant="ghost"
                className="!h-6 !px-2 !gap-1 text-[10px]"
                loading={groupPending}
                disabled={groupPending || !z.group_name}
                onClick={() => z.group_name && enableMu.mutate(z.group_name)}
              >
                <Power size={11} />
                启用
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
