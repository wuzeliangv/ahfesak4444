/**
 * Create EC2 instance(s) — compact form.
 *
 * Defaults:
 *   - Amazon Linux 2023 (latest, looked up by backend via DescribeImages)
 *   - 8 GB gp3 root volume
 *   - Default VPC + default security group
 *
 * The login flow uses a password (cloud-init script injected via user_data
 * enables PasswordAuthentication and sets root + ec2-user passwords) rather
 * than SSH key pairs, matching the user's existing workflow with other
 * panels.
 *
 * Batch mode: setting `count > 1` launches N instances and names them
 * `<name>-01`, `<name>-02`, … using the Name tag.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { REGIONS, regionDisplay } from '@/lib/regions';
import { zoneLabel } from '@/lib/zones';
import { INSTANCE_TYPES, instanceArch, instanceTypeDisplay } from '@/lib/instanceTypes';
import { imageInfo, imagesForArch, IMAGES } from '@/lib/images';
import { getAccountCredentials } from '@/lib/vault';
import { api } from '@/lib/api';
import type { Ec2CreateInput } from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Account whose AK/SK will create the instance — also used to detect opted-in regions. */
  accountId: string;
  /** Initial region (account's default). User can change. */
  defaultRegion: string;
  /** Called with form values; should throw on failure (caller shows error). */
  onSubmit: (input: Ec2CreateInput) => Promise<void>;
}

type Arch = 'x86_64' | 'arm64';

export function CreateEc2Modal({ open, onClose, accountId, defaultRegion, onSubmit }: Props) {
  // Opted-in regions for this account — long staleTime since opt-in changes are rare.
  const optedInQ = useQuery({
    queryKey: ['regions-opted-in', accountId],
    enabled: open,
    staleTime: 60 * 60 * 1000, // 1h
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      const data = await api.regionsList(creds, signal);
      return new Set(data.regions);
    },
  });

  const availableRegions = useMemo(() => {
    if (!optedInQ.data) return REGIONS;
    return REGIONS.filter((r) => optedInQ.data!.has(r.code));
  }, [optedInQ.data]);

  const [region, setRegion] = useState(defaultRegion);
  const [availabilityZone, setAvailabilityZone] = useState(''); // '' = 自动
  const [arch, setArch] = useState<Arch>('x86_64');

  // Zones of the selected region — lazily loaded. Standard AZs + opted-in
  // Wavelength zones are offered in the 可用区 selector.
  const zonesQ = useQuery({
    queryKey: ['ec2-zones', accountId, region],
    enabled: open && !!region,
    staleTime: 60 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      const data = await api.zonesList(creds, region, signal);
      return data.zones;
    },
  });

  const standardAZs = useMemo(
    () =>
      (zonesQ.data ?? [])
        .filter((z) => z.zone_type === 'availability-zone')
        .map((z) => z.zone_name)
        .sort(),
    [zonesQ.data],
  );
  const wavelengthZones = useMemo(
    () =>
      (zonesQ.data ?? []).filter(
        (z) => z.zone_type === 'wavelength-zone' && z.opt_in_status === 'opted-in',
      ),
    [zonesQ.data],
  );

  const [image, setImage] = useState('al2023');
  const [instanceType, setInstanceType] = useState('t3.micro');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [storageGb, setStorageGb] = useState(8);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentImage = imageInfo(image);
  const isWindows = currentImage?.os === 'windows';
  const arm64Supported = currentImage?.archs.includes('arm64') ?? true;

  // If the account's default region isn't opted-in, snap to the first one that is.
  useEffect(() => {
    if (!optedInQ.data) return;
    if (optedInQ.data.has(region)) return;
    const first = availableRegions[0]?.code;
    if (first) setRegion(first);
  }, [optedInQ.data, region, availableRegions]);

  // Reset AZ choice back to 自动 whenever the region changes.
  useEffect(() => {
    setAvailabilityZone('');
  }, [region]);

  function handleArchChange(next: Arch) {
    setArch(next);
    if (instanceArch(instanceType) !== next) {
      setInstanceType(next === 'arm64' ? 't4g.micro' : 't3.micro');
    }
    // If current image doesn't ship for the new arch, snap to the first one
    // in the catalog that does.
    const img = imageInfo(image);
    if (img && !img.archs.includes(next)) {
      const alt = imagesForArch(next)[0];
      if (alt) setImage(alt.slug);
    }
  }

  function handleImageChange(nextSlug: string) {
    setImage(nextSlug);
    const info = imageInfo(nextSlug);
    if (!info) return;
    // If the new image doesn't support the current arch (Windows → x86_64
    // only), flip arch + instance type to keep the form internally valid.
    if (!info.archs.includes(arch)) {
      const newArch = info.archs[0];
      setArch(newArch);
      if (instanceArch(instanceType) !== newArch) {
        setInstanceType(newArch === 'arm64' ? 't4g.micro' : 't3.micro');
      }
    }
  }

  const typesForArch = useMemo(
    () => INSTANCE_TYPES.filter((t) => instanceArch(t) === arch),
    [arch],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!region || !instanceType) {
      setError('请选择区域和实例型号');
      return;
    }
    if (password && (password.length < 6 || password.length > 128)) {
      setError('密码长度必须在 6 到 128 个字符之间');
      return;
    }
    if (storageGb < 8 || storageGb > 1000) {
      setError('存储容量必须在 8 到 1000 GB 之间');
      return;
    }
    if (count < 1 || count > 10) {
      setError('机器数量必须在 1 到 10 之间');
      return;
    }
    setSubmitting(true);
    try {
      // 可用区 selector encodes the choice: '' = auto, 'az:<zone>' = standard
      // AZ, 'wl:<zone>' = Wavelength zone (backend builds the carrier setup).
      const az = availabilityZone.startsWith('az:') ? availabilityZone.slice(3) : undefined;
      const wl = availabilityZone.startsWith('wl:') ? availabilityZone.slice(3) : undefined;
      await onSubmit({
        region,
        instance_type: instanceType,
        architecture: arch,
        image,
        name: name.trim() || undefined,
        password: password || undefined,
        storage_gb: storageGb,
        count: wl ? 1 : count,
        availability_zone: az,
        wavelength_zone: wl,
      });
      // success — caller closes the modal
    } catch (err) {
      setError((err as Error).message ?? '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="创建 EC2 实例"
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="区域">
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="glass-input h-9 w-full px-2 text-sm"
              disabled={submitting || optedInQ.isLoading}
            >
              {availableRegions.map((r) => (
                <option key={r.code} value={r.code} className="bg-[var(--color-bg-elev)]">
                  {regionDisplay(r.code)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="可用区">
            <select
              value={availabilityZone}
              onChange={(e) => setAvailabilityZone(e.target.value)}
              className="glass-input h-9 w-full px-2 text-sm"
              disabled={submitting || zonesQ.isLoading}
            >
              <option value="" className="bg-[var(--color-bg-elev)]">
                {zonesQ.isLoading ? '加载中…' : '自动 (推荐)'}
              </option>
              {standardAZs.map((az) => (
                <option key={az} value={`az:${az}`} className="bg-[var(--color-bg-elev)]">
                  {az}
                </option>
              ))}
              {wavelengthZones.map((z) => (
                <option
                  key={z.zone_name}
                  value={`wl:${z.zone_name}`}
                  className="bg-[var(--color-bg-elev)]"
                >
                  {zoneLabel(z, region)} (wavelength)
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="架构">
          <div className="flex h-9 items-center gap-1">
            <ArchPill
              active={arch === 'x86_64'}
              onClick={() => handleArchChange('x86_64')}
              disabled={submitting}
            >
              x86_64
            </ArchPill>
            <ArchPill
              active={arch === 'arm64'}
              onClick={() => handleArchChange('arm64')}
              disabled={submitting || !arm64Supported}
              title={arm64Supported ? undefined : '当前镜像不支持 arm64'}
            >
              arm64
            </ArchPill>
          </div>
        </Field>

        {availabilityZone.startsWith('wl:') && (
          <div className="rounded-lg bg-[var(--color-status-warn)]/10 p-2.5 text-[11px] leading-relaxed text-[var(--color-status-warn)]">
            Wavelength 实例使用运营商 IP(Carrier IP),无法从公网直连。将自动创建 Carrier
            Gateway / 子网 / 路由,创建后需在「VPC 对等连接」开启 Lightsail 跳板才能访问。仅支持单台创建。
          </div>
        )}

        <Field label="镜像">
          <select
            value={image}
            onChange={(e) => handleImageChange(e.target.value)}
            className="glass-input h-9 w-full px-2 text-sm"
            disabled={submitting}
          >
            {/* Show all images but disable the ones that don't support current arch */}
            {IMAGES.map((img) => {
              const supports = img.archs.includes(arch);
              return (
                <option
                  key={img.slug}
                  value={img.slug}
                  disabled={!supports && img.archs.length === 1}
                  className="bg-[var(--color-bg-elev)]"
                >
                  {img.display}
                  {!supports ? '  (需 x86_64)' : ''}
                </option>
              );
            })}
          </select>
        </Field>

        <Field label="实例型号">
          <select
            value={instanceType}
            onChange={(e) => setInstanceType(e.target.value)}
            className="glass-input h-9 w-full px-2 text-sm"
            disabled={submitting}
          >
            {typesForArch.map((t) => (
              <option key={t} value={t} className="bg-[var(--color-bg-elev)]">
                {instanceTypeDisplay(t)}
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
              ? `首次启动通过 PowerShell 关闭密码复杂度策略并设置 ${currentImage?.user ?? 'Administrator'} 密码。`
              : '首次启动通过 cloud-init 设置 root 密码,开启 SSH 密码登录与 root 登录。'}
          </p>
        </Field>

        <div className="grid grid-cols-3 gap-3">
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
          <Field label="存储 (GB)">
            <input
              type="number"
              value={String(storageGb)}
              onChange={(e) => setStorageGb(Number(e.target.value) || 0)}
              min={8}
              max={1000}
              disabled={submitting}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </Field>
          <Field label={count > 1 ? '名称前缀' : '机器名称'}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={count > 1 ? 'web → web-01, web-02 …' : 'my-server'}
              maxLength={256}
              disabled={submitting}
              className="glass-input h-9 w-full px-2 text-sm"
            />
          </Field>
        </div>

        {optedInQ.isLoading && (
          <p className="inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
            <Loader2 size={11} className="animate-spin" />
            正在加载已开通的区域…
          </p>
        )}
        {optedInQ.isError && (
          <p className="text-[11px] text-[var(--color-status-error)]">
            区域列表加载失败,已显示全部区域
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
          <Button type="submit" size="sm" loading={submitting}>
            {submitting ? '创建中…' : count > 1 ? `创建 ${count} 台` : '创建实例'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

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

function ArchPill({
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
