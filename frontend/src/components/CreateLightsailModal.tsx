/**
 * Create Lightsail instance(s).
 *
 * Bundles + blueprints are pulled live from `/lightsail/catalog` (cached
 * per-region by both backend and React Query) so price / SKU changes —
 * like the Apr 2024 `_2_0` → `_3_0` transition — don't require redeploys.
 *
 * Bundle taxonomy after the catalog refresh:
 *   - family:   general / memory / compute
 *   - platform: linux / windows
 *   - has_public_ipv4: true (regular bundle) | false (IPv6-only bundle)
 *
 * Form choices map to AWS as:
 *   - 单栈 IPv4       → regular bundle (has_public_ipv4=true) + ipAddressType=ipv4
 *   - 双栈 IPv4+IPv6  → regular bundle (has_public_ipv4=true) + ipAddressType=dualstack
 *   - 单栈 IPv6       → ipv6-only bundle (has_public_ipv4=false) + ipAddressType=ipv6
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { REGIONS, regionDisplay } from '@/lib/regions';
import { LIGHTSAIL_REGIONS } from '@/lib/lightsailCatalog';
import { api } from '@/lib/api';
import type {
  LightsailBlueprintInfo,
  LightsailBundleInfo,
  LightsailCreateInput,
} from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  defaultRegion: string;
  onSubmit: (input: LightsailCreateInput) => Promise<void>;
}

type IpStack = 'ipv4' | 'dualstack' | 'ipv6';
type Family = 'general' | 'memory' | 'compute';
type Platform = 'linux' | 'windows';

const FAMILY_LABELS: Record<Family, string> = {
  general: '通用型',
  memory: '内存优化',
  compute: '计算优化',
};

export function CreateLightsailModal({
  open,
  onClose,
  accountId,
  defaultRegion,
  onSubmit,
}: Props) {
  // Lightsail-supported regions only.
  const lsRegionSet = useMemo(() => new Set(LIGHTSAIL_REGIONS), []);
  const availableRegions = useMemo(
    () => REGIONS.filter((r) => lsRegionSet.has(r.code)),
    [lsRegionSet],
  );
  const initialRegion = lsRegionSet.has(defaultRegion)
    ? defaultRegion
    : availableRegions[0]?.code ?? 'us-east-1';

  // ---- Form state ------------------------------------------------------
  const [region, setRegion] = useState(initialRegion);
  const [ipStack, setIpStack] = useState<IpStack>('ipv4');
  const [family, setFamily] = useState<Family>('general');
  const [platform, setPlatform] = useState<Platform>('linux');
  const [blueprintId, setBlueprintId] = useState<string>('');
  const [bundleId, setBundleId] = useState<string>('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset region when modal re-opens for a new account.
  useEffect(() => {
    if (!open) return;
    setRegion(initialRegion);
  }, [open, initialRegion]);

  // ---- Catalog (per region) -------------------------------------------
  const catalogQ = useQuery({
    queryKey: ['lightsail-catalog', accountId, region],
    enabled: open && !!region,
    staleTime: 60 * 60 * 1000, // 1 hour
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.lightsailCatalog(creds, region, false, signal);
    },
  });

  const allBundles = catalogQ.data?.bundles ?? [];
  const allBlueprints = catalogQ.data?.blueprints ?? [];

  // Filter blueprints by current OS choice.
  const visibleBlueprints = useMemo(
    () => allBlueprints.filter((bp) => bp.platform === platform),
    [allBlueprints, platform],
  );

  // Filter bundles by current OS + family + network choice.
  // - ipv4 / dualstack → bundle must HAVE public IPv4
  // - ipv6            → bundle must NOT have public IPv4 (IPv6-only SKU)
  const visibleBundles = useMemo(() => {
    return allBundles.filter((b) => {
      if (b.platform !== platform) return false;
      if (b.family !== family) return false;
      if (ipStack === 'ipv6') return !b.has_public_ipv4;
      return b.has_public_ipv4;
    });
  }, [allBundles, platform, family, ipStack]);

  // Whenever the visible blueprint list changes, snap selection to the
  // first item (or clear if the list is empty).
  useEffect(() => {
    if (visibleBlueprints.length === 0) {
      setBlueprintId('');
      return;
    }
    if (!visibleBlueprints.some((bp) => bp.blueprint_id === blueprintId)) {
      setBlueprintId(visibleBlueprints[0].blueprint_id);
    }
  }, [visibleBlueprints, blueprintId]);

  // Same for bundles.
  useEffect(() => {
    if (visibleBundles.length === 0) {
      setBundleId('');
      return;
    }
    if (!visibleBundles.some((b) => b.bundle_id === bundleId)) {
      setBundleId(visibleBundles[0].bundle_id);
    }
  }, [visibleBundles, bundleId]);

  const isWindows = platform === 'windows';

  function handlePlatformChange(next: Platform) {
    setPlatform(next);
    // Windows + compute optimized has very limited options — most users
    // pick General when on Windows. Reset family to general if Windows.
    if (next === 'windows' && family !== 'general') {
      setFamily('general');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!region) {
      setError('请选择区域');
      return;
    }
    if (!bundleId || !blueprintId) {
      setError('请选择套餐和系统镜像');
      return;
    }
    if (password && (password.length < 6 || password.length > 128)) {
      setError('密码长度必须在 6 到 128 个字符之间');
      return;
    }
    if (count < 1 || count > 10) {
      setError('机器数量必须在 1 到 10 之间');
      return;
    }
    if (name) {
      if (name.length < 2 || name.length > 255) {
        setError('实例名长度必须在 2 到 255 个字符之间');
        return;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        setError('实例名只能包含字母 / 数字 / 连字符 / 点 / 下划线,且需以字母或数字开头');
        return;
      }
    }
    setSubmitting(true);
    try {
      await onSubmit({
        region,
        bundle_id: bundleId,
        blueprint_id: blueprintId,
        name: name.trim() || undefined,
        password: password || undefined,
        count,
        ip_address_type: ipStack,
      });
    } catch (err) {
      setError((err as Error).message ?? '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  const catalogLoading = catalogQ.isLoading || catalogQ.isFetching;

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="创建 Lightsail 实例"
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="区域">
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="glass-input h-9 w-full px-2 text-sm"
              disabled={submitting}
            >
              {availableRegions.map((r) => (
                <option key={r.code} value={r.code} className="bg-[var(--color-bg-elev)]">
                  {regionDisplay(r.code)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="系统">
            <div className="flex h-9 items-center gap-1">
              <Pill
                active={platform === 'linux'}
                onClick={() => handlePlatformChange('linux')}
                disabled={submitting}
              >
                Linux
              </Pill>
              <Pill
                active={platform === 'windows'}
                onClick={() => handlePlatformChange('windows')}
                disabled={submitting}
              >
                Windows
              </Pill>
            </div>
          </Field>
        </div>

        <Field label="网络">
          <div className="flex h-9 items-center gap-1">
            <Pill
              active={ipStack === 'ipv4'}
              onClick={() => setIpStack('ipv4')}
              disabled={submitting}
              title="只分配公网 IPv4 地址 (经典模式)"
            >
              单栈 IPv4
            </Pill>
            <Pill
              active={ipStack === 'dualstack'}
              onClick={() => setIpStack('dualstack')}
              disabled={submitting}
              title="同时分配公网 IPv4 + IPv6 地址"
            >
              双栈 IPv4+IPv6
            </Pill>
            <Pill
              active={ipStack === 'ipv6'}
              onClick={() => setIpStack('ipv6')}
              disabled={submitting}
              title="只分配 IPv6 地址 (无 IPv4,价格更低)"
            >
              IPv6 Only
            </Pill>
          </div>
        </Field>

        <Field label="类型">
          <div className="flex h-9 items-center gap-1">
            <Pill
              active={family === 'general'}
              onClick={() => setFamily('general')}
              disabled={submitting}
            >
              通用
            </Pill>
            <Pill
              active={family === 'memory'}
              onClick={() => setFamily('memory')}
              disabled={submitting}
              title={isWindows ? 'Windows 通常无内存优化套餐' : '内存优化套餐'}
            >
              内存优化
            </Pill>
            <Pill
              active={family === 'compute'}
              onClick={() => setFamily('compute')}
              disabled={submitting}
              title={isWindows ? 'Windows 通常无计算优化套餐' : '计算优化套餐'}
            >
              计算优化
            </Pill>
          </div>
        </Field>

        <Field label="系统镜像">
          <select
            value={blueprintId}
            onChange={(e) => setBlueprintId(e.target.value)}
            className="glass-input h-9 w-full px-2 text-sm"
            disabled={submitting || visibleBlueprints.length === 0}
          >
            {catalogLoading && (
              <option className="bg-[var(--color-bg-elev)]">加载中…</option>
            )}
            {!catalogLoading && visibleBlueprints.length === 0 && (
              <option className="bg-[var(--color-bg-elev)]">该系统无可用镜像</option>
            )}
            {!catalogLoading &&
              visibleBlueprints.map((bp) => (
                <option
                  key={bp.blueprint_id}
                  value={bp.blueprint_id}
                  className="bg-[var(--color-bg-elev)]"
                >
                  {blueprintDisplay(bp)}
                </option>
              ))}
          </select>
        </Field>

        <Field
          label={`套餐 (${FAMILY_LABELS[family]})`}
        >
          <select
            value={bundleId}
            onChange={(e) => setBundleId(e.target.value)}
            className="glass-input h-9 w-full px-2 text-sm"
            disabled={submitting || visibleBundles.length === 0}
          >
            {catalogLoading && (
              <option className="bg-[var(--color-bg-elev)]">加载中…</option>
            )}
            {!catalogLoading && visibleBundles.length === 0 && (
              <option className="bg-[var(--color-bg-elev)]">
                此组合无可用套餐 (试换 系统 / 类型 / 网络)
              </option>
            )}
            {!catalogLoading &&
              visibleBundles.map((b) => (
                <option
                  key={b.bundle_id}
                  value={b.bundle_id}
                  className="bg-[var(--color-bg-elev)]"
                >
                  {bundleDisplay(b)}
                </option>
              ))}
          </select>
        </Field>

        <Field label="登录密码">
          <div className="glass-input flex h-9 items-center gap-2 px-2">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6 - 128 字符,留空则不设置密码"
              minLength={6}
              maxLength={128}
              autoComplete="new-password"
              disabled={submitting}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-fg-muted)]"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              tabIndex={-1}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              title={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-tight text-[var(--color-fg-muted)]">
            {isWindows
              ? '首次启动通过 PowerShell 关闭密码复杂度策略并设置 Administrator 密码。'
              : '首次启动通过 cloud-init 设置 root 密码,开启 SSH 密码登录与 root 登录。'}
          </p>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="机器数量">
            <input
              type="number"
              value={String(count)}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
              min={1}
              max={10}
              disabled={submitting}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </Field>
          <Field label={count > 1 ? '名称前缀' : '实例名'}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={count > 1 ? 'web → web-01, web-02 …' : 'my-server'}
              maxLength={255}
              disabled={submitting}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </Field>
        </div>

        {catalogQ.isLoading && (
          <p className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
            <Loader2 size={11} className="animate-spin" />
            正在加载该区域的套餐目录…
          </p>
        )}
        {catalogQ.isError && (
          <p className="text-[11px] text-[var(--color-status-error)]">
            套餐目录加载失败: {(catalogQ.error as Error).message}
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" size="sm" loading={submitting} disabled={catalogLoading}>
            {submitting ? '创建中…' : count > 1 ? `创建 ${count} 台` : '创建实例'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function blueprintDisplay(bp: LightsailBlueprintInfo): string {
  if (bp.version) return `${bp.name} ${bp.version}`;
  return bp.name ?? bp.blueprint_id;
}

function bundleDisplay(b: LightsailBundleInfo): string {
  const cpu = b.cpu ?? '?';
  const ram = b.ram_gb ?? '?';
  const disk = b.disk_gb ?? '?';
  const transfer =
    b.transfer_gb != null
      ? b.transfer_gb >= 1024
        ? `${(b.transfer_gb / 1024).toFixed(0)} TB`
        : `${b.transfer_gb} GB`
      : '?';
  const price = b.price_per_month != null ? `$${b.price_per_month.toFixed(2)}/月` : '';
  return `${cpu} vCPU · ${ram} GB · ${disk} GB SSD · ${transfer}流量 · ${price}`;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium tracking-wide text-[var(--color-fg-secondary)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Pill({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        'flex-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
        (active
          ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)]/15 text-[var(--color-accent-300)]'
          : 'border-[var(--color-border-glass)] bg-transparent text-[var(--color-fg-secondary)] hover:border-white/30')
      }
    >
      {children}
    </button>
  );
}
